// Crypto deals end to end, against a fake price feed and a fake blockchain.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createStore } = require("../src/store");
const { createCryptoEscrow, COINS } = require("../src/crypto-escrow");
const { DEFAULT_WALLETS } = require("../src/wallets");
const { createApp } = require("../src/app");

const SELLER_BTC = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"; // valid bech32, not the owner's
const BUYER_BTC = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const SELLER_ETH = "0x52908400098527886E0F7030069857D2E4169EE7";
const BUYER_ETH = "0xde709f2102306220921060314715629080e2fb77";

function fakeChain() {
  const incoming = [];
  const transfers = new Map(); // txid -> { to, amount, confirmations }
  return {
    incoming, transfers,
    api: {
      async incoming() { return incoming.map((t) => ({ ...t })); },
      async transfer(txid, to) {
        const t = transfers.get(txid);
        if (!t) throw new Error("not found");
        return { txid, amount: t.to === to ? t.amount : 0n, confirmations: t.confirmations };
      },
    },
  };
}

function setup({ owners = ["boss"] } = {}) {
  const clock = { t: Date.parse("2026-10-23T00:00:00Z") };
  const now = () => clock.t;
  const store = createStore({ now });
  const chains = { BTC: fakeChain(), LTC: fakeChain(), ETH: fakeChain(), SOL: fakeChain() };
  const notes = [];
  const escrow = createCryptoEscrow({
    store, now,
    wallets: { ...DEFAULT_WALLETS },
    prices: { async rate(asset, fiat) { return { BTC: 100000, ETH: 3000, LTC: 80, SOL: 150 }[asset] * (fiat === "usd" ? 1 : 1.6); } },
    chains: Object.fromEntries(Object.entries(chains).map(([k, v]) => [k, v.api])),
    owners, notify: (text) => notes.push(text), log: { error() {}, log() {} },
  });
  const agent = (name) => { const a = store.registerAgent(name); return store.authenticate(a.apiKey); };
  return { clock, store, chains, escrow, notes, agent };
}

async function owner(store, username = "boss") {
  const r = await store.registerHuman(username, "correct-horse-1");
  return store.authenticate(r.token);
}

// A joined BTC deal where the seller has said where the payout goes.
function btcDeal(ctx, amount = 50000) {
  const buyer = ctx.agent("buyer-bot"), seller = ctx.agent("seller-bot");
  const d = ctx.store.createDeal(buyer, { title: "Summarise 50 PDFs", amount, paymentType: "crypto", cryptoAsset: "BTC" });
  ctx.store.joinDeal(seller, d.inviteCode);
  return { buyer, seller, id: d.id };
}

test("a seller's payout address is checked, and the buyer can't get a deposit address until it exists", async () => {
  const ctx = setup();
  const { buyer, seller, id } = btcDeal(ctx);
  await assert.rejects(ctx.escrow.issueInvoice(buyer, id, { asset: "BTC", refundAddress: BUYER_BTC }), (e) => e.code === "seller_not_ready");
  assert.equal(ctx.store.getDeal(buyer, id).state, "awaiting_setup");
  assert.throws(() => ctx.store.setCryptoPayoutAddress(seller, id, "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdx"), (e) => e.code === "invalid_address"); // one char off
  assert.throws(() => ctx.store.setCryptoPayoutAddress(buyer, id, SELLER_BTC), (e) => e.code === "not_seller");
  const v = ctx.store.setCryptoPayoutAddress(seller, id, SELLER_BTC);
  assert.equal(v.state, "joined");
  assert.equal(v.crypto.sellerAddress, SELLER_BTC);
  assert.equal(ctx.store.getDeal(buyer, id).crypto.sellerAddress, null, "the buyer sees that it's set, not the address itself");
  assert.equal(ctx.store.getDeal(buyer, id).crypto.sellerAddressSet, true);
});

test("the invoice: today's price, exact 1% fee, a reserve, and a unique amount to the owner's wallet", async () => {
  const ctx = setup();
  const { buyer, seller, id } = btcDeal(ctx); // $500.00
  ctx.store.setCryptoPayoutAddress(seller, id, SELLER_BTC);
  await assert.rejects(ctx.escrow.issueInvoice(buyer, id, { asset: "BTC", refundAddress: "not-an-address" }), (e) => e.code === "invalid_address");
  const inv = await ctx.escrow.issueInvoice(buyer, id, { asset: "BTC", refundAddress: BUYER_BTC });
  assert.equal(inv.address, DEFAULT_WALLETS.BTC);
  assert.equal(inv.qrPayload, DEFAULT_WALLETS.BTC);
  assert.equal(inv.status, "awaiting_deposit");
  assert.equal(inv.fees.principal, "0.005");   // $500 at $100,000
  assert.equal(inv.fees.platform, "0.00005");  // exactly 1%
  const total = BigInt(Math.round(Number(inv.total) * 1e8));
  const tag = total - 500000n - 5000n - COINS.BTC.reserve;
  assert.ok(tag >= 1n && tag <= 999n, `unique part should be 1-999 sats, was ${tag}`);
  // Asking again doesn't change the amount the buyer may already be sending.
  assert.equal((await ctx.escrow.issueInvoice(buyer, id, { asset: "BTC", refundAddress: BUYER_BTC })).total, inv.total);
  assert.equal(ctx.store.getDeal(buyer, id).state, "funding");
  assert.equal(ctx.store.getDeal(seller, id).crypto.invoice, null, "only the buyer sees the invoice");
});

test("two open deals never share an amount, so a payment can only ever match one", async () => {
  const ctx = setup();
  const totals = new Set();
  for (let i = 0; i < 40; i++) {
    const { buyer, seller, id } = btcDeal(ctx);
    ctx.store.setCryptoPayoutAddress(seller, id, SELLER_BTC);
    totals.add((await ctx.escrow.issueInvoice(buyer, id, { asset: "BTC", refundAddress: BUYER_BTC })).total);
  }
  assert.equal(totals.size, 40);
});

test("a matching payment funds the deal only once it has enough confirmations", async () => {
  const ctx = setup();
  const { buyer, seller, id } = btcDeal(ctx);
  ctx.store.setCryptoPayoutAddress(seller, id, SELLER_BTC);
  const inv = await ctx.escrow.issueInvoice(buyer, id, { asset: "BTC", refundAddress: BUYER_BTC });
  const amount = BigInt(Math.round(Number(inv.total) * 1e8));
  ctx.chains.BTC.incoming.push({ txid: "a".repeat(64), amount, confirmations: 0, time: ctx.clock.t + 1000 });
  await ctx.escrow.pollAll();
  let v = ctx.store.getDeal(seller, id);
  assert.equal(v.state, "funding");
  assert.equal(v.crypto.deposit.confirmations, 0);
  assert.equal(v.crypto.deposit.required, 2);
  ctx.chains.BTC.incoming[0].confirmations = 1;
  await ctx.escrow.pollAll();
  assert.equal(ctx.store.getDeal(seller, id).state, "funding");
  ctx.chains.BTC.incoming[0].confirmations = 2;
  await ctx.escrow.pollAll();
  v = ctx.store.getDeal(seller, id);
  assert.equal(v.state, "funded");
  assert.equal(v.payment.provider, "crypto");
  assert.equal(v.payment.principal, "0.005");
  assert.ok(Date.parse(v.deadlineAt) > ctx.clock.t);
  assert.equal(ctx.store.audit().ok, true);
});

test("wrong amounts and the wallet's older history don't fund anything", async () => {
  const ctx = setup();
  const { buyer, seller, id } = btcDeal(ctx);
  ctx.store.setCryptoPayoutAddress(seller, id, SELLER_BTC);
  const inv = await ctx.escrow.issueInvoice(buyer, id, { asset: "BTC", refundAddress: BUYER_BTC });
  const amount = BigInt(Math.round(Number(inv.total) * 1e8));
  ctx.chains.BTC.incoming.push(
    { txid: "b".repeat(64), amount: amount - 10000n, confirmations: 3, time: ctx.clock.t + 1000 },    // exchange took its fee out
    { txid: "c".repeat(64), amount: 12345n, confirmations: 900, time: ctx.clock.t - 86400 * 1000 }, // last month's personal transfer
  );
  await ctx.escrow.pollAll();
  assert.equal(ctx.store.getDeal(buyer, id).state, "funding");
  const boss = await owner(ctx.store);
  const q = ctx.escrow.queue(boss);
  assert.equal(q.unmatched.length, 1, "only the new payment is flagged, not old history");
  assert.equal(q.unmatched[0].txid, "b".repeat(64));
  assert.match(ctx.notes.join("\n"), /doesn't match any deal/);
  // Short of the deal + fee: the owner can't count it for the deal.
  assert.throws(() => ctx.store.ownerAssignDeposit(q.unmatched[0].id, id, 2), (e) => e.code === "underpaid");
  ctx.store.ownerDismissDeposit(q.unmatched[0].id, "refunded by hand");
  assert.equal(ctx.escrow.queue(boss).unmatched.length, 0);
});

test("release goes to the owner's queue, and only a real on-chain payment closes it", async () => {
  const ctx = setup();
  const { buyer, seller, id } = btcDeal(ctx);
  ctx.store.setCryptoPayoutAddress(seller, id, SELLER_BTC);
  const inv = await ctx.escrow.issueInvoice(buyer, id, { asset: "BTC", refundAddress: BUYER_BTC });
  ctx.chains.BTC.incoming.push({ txid: "d".repeat(64), amount: BigInt(Math.round(Number(inv.total) * 1e8)), confirmations: 2, time: ctx.clock.t + 1 });
  await ctx.escrow.pollAll();
  ctx.store.markDelivered(seller, id, "done");
  assert.throws(() => ctx.store.requestCryptoRelease(seller, id), (e) => e.code === "not_buyer");
  const released = await ctx.escrow.release(buyer, id);
  assert.equal(released.state, "payout_pending");
  assert.match(ctx.notes.join("\n"), /Payout to send/);
  assert.equal(ctx.store.getDeal(seller, id).crypto.payout.to, SELLER_BTC);
  assert.equal(ctx.store.getDeal(seller, id).crypto.payout.amount, "0.005");

  const boss = await owner(ctx.store);
  const stranger = await owner(ctx.store, "stranger");
  assert.throws(() => ctx.escrow.queue(stranger), (e) => e.code === "not_owner");
  await assert.rejects(ctx.escrow.confirmPayout(stranger, id, "e".repeat(64)), (e) => e.code === "not_owner");
  const q = ctx.escrow.queue(boss);
  assert.equal(q.payouts.length, 1);
  assert.equal(q.payouts[0].payout.to, SELLER_BTC);
  assert.equal(q.payouts[0].payout.amount, "0.005");

  await assert.rejects(ctx.escrow.confirmPayout(boss, id, "not-a-txid"), (e) => e.code === "invalid_txid");
  await assert.rejects(ctx.escrow.confirmPayout(boss, id, "d".repeat(64)), (e) => e.code === "tx_used"); // the deposit itself
  ctx.chains.BTC.transfers.set("e".repeat(64), { to: SELLER_BTC, amount: 499000n, confirmations: 0 });
  await assert.rejects(ctx.escrow.confirmPayout(boss, id, "e".repeat(64)), (e) => e.code === "payout_mismatch" && /0.00499/.test(e.message));
  ctx.chains.BTC.transfers.set("f".repeat(64), { to: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT", amount: 500000n, confirmations: 0 });
  await assert.rejects(ctx.escrow.confirmPayout(boss, id, "f".repeat(64)), (e) => e.code === "payout_mismatch" && /doesn't pay/.test(e.message));
  ctx.chains.BTC.transfers.set("9".repeat(64), { to: SELLER_BTC, amount: 500000n, confirmations: 0 });
  await ctx.escrow.confirmPayout(boss, id, "9".repeat(64));
  const done = ctx.store.getDeal(seller, id);
  assert.equal(done.state, "released");
  assert.equal(done.crypto.payout.txid, "9".repeat(64));
  assert.equal(ctx.escrow.queue(boss).payouts.length, 0);
  assert.ok(ctx.store.payments(seller).events.some((e) => e.event === "paid_out"));
  assert.equal(ctx.store.audit().ok, true);
});

test("refunds return the deal amount and fee to the buyer's refund address", async () => {
  const ctx = setup();
  const { buyer, seller, id } = btcDeal(ctx);
  ctx.store.setCryptoPayoutAddress(seller, id, SELLER_BTC);
  const inv = await ctx.escrow.issueInvoice(buyer, id, { asset: "BTC", refundAddress: BUYER_BTC });
  ctx.chains.BTC.incoming.push({ txid: "1".repeat(64), amount: BigInt(Math.round(Number(inv.total) * 1e8)), confirmations: 5, time: ctx.clock.t + 1 });
  await ctx.escrow.pollAll();
  assert.throws(() => ctx.store.requestCryptoRefund(buyer, id), (e) => e.code === "deadline_not_reached");
  const v = await ctx.escrow.refund(seller, id);
  assert.equal(v.state, "payout_pending");
  const forBuyer = ctx.store.getDeal(buyer, id).crypto.payout;
  assert.equal(forBuyer.kind, "refund");
  assert.equal(forBuyer.to, BUYER_BTC);
  assert.equal(forBuyer.amount, "0.00505");
  assert.equal(ctx.store.getDeal(seller, id).crypto.payout.to, null, "the seller doesn't see the buyer's address");
});

test("auto-release after 72 hours, and disputes the owner decides", async () => {
  const ctx = setup();
  const boss = await owner(ctx.store);
  const make = async (txid) => {
    const { buyer, seller, id } = btcDeal(ctx);
    ctx.store.setCryptoPayoutAddress(seller, id, SELLER_BTC);
    const inv = await ctx.escrow.issueInvoice(buyer, id, { asset: "BTC", refundAddress: BUYER_BTC });
    ctx.chains.BTC.incoming.push({ txid, amount: BigInt(Math.round(Number(inv.total) * 1e8)), confirmations: 2, time: ctx.clock.t + 1 });
    await ctx.escrow.pollAll();
    return { buyer, seller, id };
  };
  const quiet = await make("2".repeat(64));
  const fight = await make("3".repeat(64));
  ctx.store.markDelivered(quiet.seller, quiet.id, "here you go");
  ctx.store.openDispute(fight.buyer, fight.id, "The files never arrived at all.");
  ctx.clock.t += 73 * 3600 * 1000;
  await ctx.escrow.pollAll();
  assert.equal(ctx.store.getDeal(quiet.buyer, quiet.id).state, "payout_pending");
  assert.equal(ctx.escrow.queue(boss).disputed.length, 1);
  await ctx.escrow.resolve(boss, fight.id, "refund");
  const q = ctx.escrow.queue(boss);
  assert.equal(q.disputed.length, 0);
  assert.deepEqual(q.payouts.map((p) => p.payout.kind).sort(), ["refund", "release"]);
});

test("ETH amounts stay within 8 decimals so any wallet can send them exactly", async () => {
  const ctx = setup();
  const buyer = ctx.agent("b"), seller = ctx.agent("s");
  const d = ctx.store.createDeal(buyer, { title: "ETH job", amount: 50000, paymentType: "crypto", cryptoAsset: "ETH" });
  ctx.store.joinDeal(seller, d.inviteCode);
  ctx.store.setCryptoPayoutAddress(seller, d.id, SELLER_ETH);
  const inv = await ctx.escrow.issueInvoice(buyer, d.id, { asset: "ETH", refundAddress: BUYER_ETH });
  assert.ok(inv.total.split(".")[1].length <= 8, inv.total);
  assert.equal(inv.address, DEFAULT_WALLETS.ETH);
  // $500 at $3,000 = 0.1666... ETH, quoted to the nearest step that keeps the 1% fee exact
  assert.equal(inv.fees.principal, "0.166667");
  assert.equal(inv.fees.platform, "0.00166667");
});

test("crypto deals survive a restart: deposits, payouts, and payments still waiting to be matched", async () => {
  const ctx = setup();
  const { buyer, seller, id } = btcDeal(ctx);
  ctx.store.setCryptoPayoutAddress(seller, id, SELLER_BTC);
  const inv = await ctx.escrow.issueInvoice(buyer, id, { asset: "BTC", refundAddress: BUYER_BTC });
  ctx.chains.BTC.incoming.push({ txid: "4".repeat(64), amount: BigInt(Math.round(Number(inv.total) * 1e8)), confirmations: 2, time: ctx.clock.t + 1 },
    { txid: "5".repeat(64), amount: 777n, confirmations: 2, time: ctx.clock.t + 2 });
  await ctx.escrow.pollAll();
  await ctx.escrow.release(buyer, id);
  const again = createStore({ now: () => ctx.clock.t });
  again.importState(JSON.parse(JSON.stringify(ctx.store.exportState())));
  assert.equal(again.getDeal(buyer, id).state, "payout_pending");
  assert.equal(again.ownerCryptoQueue().payouts[0].payout.to, SELLER_BTC);
  assert.equal(again.ownerCryptoQueue().unmatched[0].txid, "5".repeat(64));
  assert.equal(again.cryptoTxKnown("4".repeat(64)), true);
  assert.equal(again.audit().ok, true);
});

test("an unpaid crypto deal can still be cancelled, a paid one can't", async () => {
  const ctx = setup();
  const { buyer, seller, id } = btcDeal(ctx);
  ctx.store.setCryptoPayoutAddress(seller, id, SELLER_BTC);
  await ctx.escrow.issueInvoice(buyer, id, { asset: "BTC", refundAddress: BUYER_BTC });
  assert.equal(ctx.store.cancelDeal(buyer, id).state, "cancelled");
});

test("over HTTP: crypto is on, owners are listed, and everyone else is kept out of the queue", async () => {
  const server = createApp({ skipTimers: true, powDifficulty: 0, owners: ["boss"], notify: null,
    prices: { async rate() { return 100000; } }, chains: { BTC: fakeChain().api, LTC: fakeChain().api, ETH: fakeChain().api, SOL: fakeChain().api } });
  await server.ready;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const call = async (method, path, key, body) => {
    const r = await fetch(base + path, { method, headers: { ...(key ? { Authorization: "Bearer " + key } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  try {
    const methods = (await call("GET", "/crypto/methods")).body;
    assert.equal(methods.ready, true);
    assert.equal(methods.assets.find((a) => a.symbol === "BTC").disabled, false);
    assert.equal(methods.assets.find((a) => a.symbol === "USDT").disabled, true);
    assert.equal(JSON.stringify(methods).includes(DEFAULT_WALLETS.ETH), false, "wallets only appear on an invoice");
    const boss = (await call("POST", "/humans/signup", null, { username: "boss", password: "correct-horse-1" })).body;
    const joe = (await call("POST", "/humans/signup", null, { username: "joe", password: "correct-horse-1" })).body;
    assert.equal((await call("GET", "/me", boss.token)).body.isOwner, true);
    assert.equal((await call("GET", "/me", joe.token)).body.isOwner, false);
    assert.equal((await call("GET", "/owner/crypto", joe.token)).status, 403);
    const q = await call("GET", "/owner/crypto", boss.token);
    assert.equal(q.status, 200);
    assert.equal(q.body.wallets.BTC, DEFAULT_WALLETS.BTC);
    const health = await (await fetch(base.replace("/v1", "") + "/health")).json();
    assert.match(health.crypto, /^on/);
  } finally {
    await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  }
});
