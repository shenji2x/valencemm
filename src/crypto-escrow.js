// Crypto deals: deposits into the owner's wallets, watched on the public blockchains, and
// payouts sent by the owner by hand and checked on the blockchain before a deal closes.
//
// Why the owner sends payouts by hand: the server only knows the wallets' public addresses. It
// never holds a private key, so even a fully compromised server can't move a single coin.
//
//   buyer asks to pay    -> an invoice: the deal's value in the coin at today's price, plus Valence's
//                           1%, plus a payout network-fee reserve, plus a tiny unique amount so the
//                           payment can be told apart from every other deal's
//   payment arrives      -> matched by that exact amount; the deal is funded once it has enough
//                           confirmations (BTC 2, LTC 6, ETH 12, SOL finalized)
//   release / refund     -> the deal waits in the owner's payout queue showing exactly what to send
//                           and where; the owner sends it and pastes the transaction ID, which is
//                           checked on the blockchain before the deal is marked paid

const crypto = require("crypto");
const { ApiError } = require("./errors");
const { cryptoMethods, coinAmount, ASSETS, enabledAsset, requireCryptoDeal } = require("./crypto-checkout");

const COINS = {
  // unit: the smallest step an amount is quoted in (so wallets that only take 8 or 6 decimals can send it)
  // tagMax: range of the unique matching amount, in units; reserve: payout network fee set aside
  BTC: { unit: 1n, tagMax: 999, reserve: 3000n, confirmations: 2 },                  // sats
  LTC: { unit: 1n, tagMax: 9999, reserve: 10000n, confirmations: 6 },                // litoshis
  ETH: { unit: 10n ** 10n, tagMax: 9999, reserve: 30000n * 10n ** 10n, confirmations: 12 }, // 8 decimals; 0.0003 ETH
  SOL: { unit: 1000n, tagMax: 999, reserve: 10000n, confirmations: 1 },              // 6 decimals; "1" = finalized
};
const INVOICE_TTL_MS = 30 * 60 * 1000;     // the price is locked for 30 minutes
const MATCH_WINDOW_MS = 24 * 3600 * 1000;  // a late payment of the exact amount still counts for a day
const POLL_MS = 60 * 1000;
const AUTO_RELEASE_MS = 72 * 3600 * 1000;
const TXID = {
  BTC: /^[0-9a-f]{64}$/i,
  LTC: /^[0-9a-f]{64}$/i,
  ETH: /^0x[0-9a-f]{64}$/i,
  SOL: /^[1-9A-HJ-NP-Za-km-z]{64,90}$/,
};

function createCryptoEscrow({ store, wallets = {}, prices, chains, persistence, owners = [], now = () => Date.now(), log = console, notify = null } = {}) {
  const save = () => (persistence ? persistence.commit() : Promise.resolve());
  const ready = Boolean(prices && chains && Object.keys(wallets).length);
  const ownerSet = new Set(owners.map((o) => String(o).trim().toLowerCase()).filter(Boolean));
  const tell = (text) => { if (notify) Promise.resolve().then(() => notify(text)).catch((e) => log.error?.("Owner notice failed:", e.message)); };

  const isOwner = (account) => Boolean(account && account.kind === "human" && ownerSet.has(String(account.username).toLowerCase()));
  function mustBeOwner(account) {
    if (!isOwner(account)) throw new ApiError(403, "not_owner", "Only the site owner can do that");
  }
  function mustBeReady(asset) {
    if (!ready || !wallets[asset]) throw new ApiError(503, "crypto_not_ready", "Crypto deposits aren't available for that coin right now.");
  }

  // The deal's agreed fiat value in the coin, rounded to a whole number of hundreds of units so the
  // 1% fee comes out exact.
  function principalFor(fiatCents, rate, asset) {
    const decimals = ASSETS.find((a) => a.symbol === asset).decimals;
    const c = COINS[asset];
    const units = (fiatCents / 100 / rate) * 10 ** decimals / Number(c.unit);
    const rounded = Math.round(units / 100) * 100;
    if (!(rounded > 0)) throw new ApiError(400, "amount_too_small", `This deal is too small to pay in ${asset}`);
    return BigInt(rounded) * c.unit;
  }

  async function issueInvoice(account, dealId, { asset, refundAddress } = {}) {
    // Who's asking and for what, before anything else (and before saying whether crypto is on).
    enabledAsset(asset);
    const seen = store.getDeal(account, dealId); // 404 for anyone not in the deal
    requireCryptoDeal(seen, asset);
    if (seen.yourRole !== "buyer") throw new ApiError(403, "not_buyer", "Only the buyer can request a deposit invoice");
    mustBeReady(asset);
    const deal = store.beginCryptoFunding(account, dealId, asset, refundAddress);
    const existing = store.currentCryptoInvoice(deal);
    if (existing) {
      await save(); // keeps the refund address they just confirmed
      return existing;
    }
    const c = COINS[asset];
    const rate = await prices.rate(asset, deal.currency);
    const principal = principalFor(deal.amount, rate, asset);
    const fee = principal / 100n;
    const taken = new Set(store.openCryptoInvoices(asset).map((x) => x.invoice.total));
    let tag, total;
    for (let i = 0; i < 100; i++) {
      tag = BigInt(1 + crypto.randomInt(c.tagMax)) * c.unit;
      total = principal + fee + c.reserve + tag;
      if (!taken.has(total.toString())) break;
      if (i === 99) throw new ApiError(503, "busy", "Too many deposits are open in this coin right now. Try again in a few minutes.");
    }
    const t = now();
    const invoice = {
      id: "inv_" + crypto.randomBytes(9).toString("hex"),
      asset, network: ASSETS.find((a) => a.symbol === asset).network, address: wallets[asset],
      principal: principal.toString(), fee: fee.toString(), reserve: c.reserve.toString(), tag: tag.toString(), total: total.toString(),
      rate, fiat: deal.currency, fiatAmount: deal.amount,
      createdAt: t, expiresAt: t + INVOICE_TTL_MS, matchUntil: t + MATCH_WINDOW_MS,
    };
    const out = store.addCryptoInvoice(deal, invoice);
    await save();
    return out;
  }

  // Looks at the owner's wallet for one coin and matches what arrived to open invoices.
  async function scan(asset) {
    const address = wallets[asset];
    const open = store.openCryptoInvoices(asset);
    const confirming = store.cryptoDealsConfirming(asset);
    if (!address || (!open.length && !confirming.length)) return false;
    const required = COINS[asset].confirmations;
    const txs = await chains[asset].incoming(address);
    // Only payments made after an invoice existed are candidates; the wallet's older history is not ours.
    const since = Math.min(...open.map((x) => x.invoice.createdAt), ...confirming.map((d) => d.crypto.deposit.seenAt), now()) - 10 * 60 * 1000;
    let changed = false;
    const seenNow = new Set();
    for (const tx of txs) {
      seenNow.add(tx.txid);
      const known = confirming.find((d) => d.crypto.deposit.txid === tx.txid);
      if (known) {
        store.updateCryptoConfirmations(known, tx.confirmations);
        changed = true;
        continue;
      }
      if (store.cryptoTxKnown(tx.txid)) continue;
      const match = open.find((x) => x.invoice.total === tx.amount.toString() && !x.deal.crypto.deposit);
      if (match) {
        store.recordCryptoDeposit(match.deal, { txid: tx.txid, amount: tx.amount, confirmations: tx.confirmations, invoiceId: match.invoice.id, required });
        store.updateCryptoConfirmations(match.deal, tx.confirmations);
        changed = true;
        log.log?.(`Crypto deposit matched: ${coinAmount(tx.amount.toString(), asset)} ${asset} -> ${match.deal.id}`);
      } else if (tx.time == null || tx.time >= since) {
        if (store.recordUnmatchedDeposit({ asset, txid: tx.txid, amount: tx.amount })) {
          changed = true;
          tell(`A ${coinAmount(tx.amount.toString(), asset)} ${asset} payment arrived that doesn't match any deal. Check the owner queue.`);
        }
      }
    }
    // A deposit we're tracking that fell off the address's recent list: ask about it directly.
    for (const d of confirming) {
      if (seenNow.has(d.crypto.deposit.txid)) continue;
      const t = await chains[asset].transfer(d.crypto.deposit.txid, address);
      store.updateCryptoConfirmations(d, t.confirmations);
      changed = true;
    }
    return changed;
  }

  let running = null;
  async function pollAll() {
    if (running) return running;
    running = (async () => {
      let changed = false;
      for (const asset of store.cryptoDealsToWatch()) {
        try {
          if (await scan(asset)) changed = true;
        } catch (err) {
          log.error?.(`Crypto scan for ${asset} failed:`, err.message);
        }
      }
      for (const d of store.cryptoDealsDueForAutoRelease(AUTO_RELEASE_MS)) {
        try {
          store.startCryptoPayout(d, "release", null);
          changed = true;
          tell(`Auto-release: send ${d.cryptoAsset} for "${d.title}" to the seller. Check the owner queue.`);
        } catch (err) {
          log.error?.(`Auto-release of ${d.id} failed:`, err.message);
        }
      }
      if (changed) await save();
    })().finally(() => { running = null; });
    return running;
  }

  // "I've sent it": look now instead of waiting for the next minute.
  async function checkNow(account, dealId) {
    const deal = store.getDeal(account, dealId);
    if (deal.rail !== "crypto") throw new ApiError(409, "payment_type_mismatch", "This is a card deal");
    try {
      if (await scan(deal.cryptoAsset)) await save();
    } catch (err) {
      log.error?.(`Crypto check for ${dealId} failed:`, err.message);
      throw new ApiError(502, "chain_unavailable", "Couldn't reach the blockchain just now. It's checked every minute anyway.");
    }
    return store.getDeal(account, dealId);
  }

  async function release(account, dealId) {
    const out = store.requestCryptoRelease(account, dealId);
    await save();
    tell(`Payout to send: ${out.cryptoAsset} for "${out.title}". Check the owner queue.`);
    return out;
  }

  async function refund(account, dealId) {
    const out = store.requestCryptoRefund(account, dealId);
    await save();
    tell(`Refund to send: ${out.cryptoAsset} for "${out.title}". Check the owner queue.`);
    return out;
  }

  // The owner pasted the transaction that pays the seller (or refunds the buyer). Check it on chain.
  async function confirmPayout(account, dealId, rawTxid) {
    mustBeOwner(account);
    const deal = store.ownerDeal(dealId);
    const po = deal.crypto && deal.crypto.payout;
    if (deal.state !== "payout_pending" || !po) throw new ApiError(409, "bad_state", "This deal isn't waiting for a payout");
    const txid = typeof rawTxid === "string" ? rawTxid.trim() : "";
    if (!TXID[deal.cryptoAsset].test(txid)) throw new ApiError(400, "invalid_txid", `That doesn't look like a ${deal.cryptoAsset} transaction ID`);
    if (store.cryptoTxKnown(txid)) throw new ApiError(409, "tx_used", "That transaction is already recorded against a deal");
    let sent;
    try {
      sent = await chains[deal.cryptoAsset].transfer(txid, po.to);
    } catch (err) {
      log.error?.(`Payout check ${txid} failed:`, err.message);
      throw new ApiError(502, "chain_unavailable", "Couldn't find that transaction on the blockchain yet. Wait a minute after sending, then try again.");
    }
    const want = BigInt(po.amount);
    if (sent.amount < want) {
      throw new ApiError(409, "payout_mismatch", sent.amount === 0n
        ? `That transaction doesn't pay ${po.to}. Check you sent to the address shown.`
        : `That transaction pays ${coinAmount(sent.amount.toString(), deal.cryptoAsset)} ${deal.cryptoAsset}, but ${coinAmount(po.amount, deal.cryptoAsset)} is due. Send the difference, then paste that transaction too.`);
    }
    store.completeCryptoPayout(deal, { txid, ownerId: account.id });
    await save();
    return store.ownerCryptoQueue();
  }

  async function resolve(account, dealId, outcome) {
    mustBeOwner(account);
    store.ownerResolveCryptoDispute(dealId, outcome, account.id);
    await save();
    return store.ownerCryptoQueue();
  }
  async function assignDeposit(account, depositId, dealId) {
    mustBeOwner(account);
    const deal = store.ownerAssignDeposit(depositId, dealId, COINS[store.ownerDeal(dealId).cryptoAsset].confirmations);
    await save();
    pollAll().catch(() => {});
    return { queue: store.ownerCryptoQueue(), dealId: deal.id };
  }
  async function dismissDeposit(account, depositId, note) {
    mustBeOwner(account);
    store.ownerDismissDeposit(depositId, note);
    await save();
    return store.ownerCryptoQueue();
  }
  function queue(account) {
    mustBeOwner(account);
    return { ...store.ownerCryptoQueue(), wallets };
  }

  let timer = null;
  function startTimers({ everyMs = POLL_MS } = {}) {
    if (timer || !ready) return;
    timer = setInterval(() => pollAll().catch(() => {}), everyMs);
    if (timer.unref) timer.unref();
  }
  function stopTimers() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    ready, wallets, isOwner, COINS,
    methods: () => cryptoMethods({ ready, wallets }),
    issueInvoice, scan, pollAll, checkNow, release, refund,
    confirmPayout, resolve, assignDeposit, dismissDeposit, queue,
    startTimers, stopTimers,
  };
}

module.exports = { createCryptoEscrow, COINS, INVOICE_TTL_MS, MATCH_WINDOW_MS };
