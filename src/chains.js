// Reads the public blockchains: which payments have arrived at an address, how many
// confirmations each has, and what a given transaction paid to a given address.
// Read-only. Nothing here can move money, and no keys are involved.
//
//   BTC  mempool.space        (Esplora API)
//   LTC  litecoinspace.org    (the same API, for Litecoin)
//   ETH  eth.blockscout.com   (Blockscout API v2)
//   SOL  api.mainnet-beta.solana.com (Solana JSON-RPC)
//
// Every result is { txid, amount, confirmations } with `amount` a BigInt in the coin's smallest
// unit (satoshis, litoshis, wei, lamports) actually received by the address in that transaction.

const BASES = {
  BTC: "https://mempool.space/api",
  LTC: "https://litecoinspace.org/api",
  ETH: "https://eth.blockscout.com/api/v2",
  SOL: "https://api.mainnet-beta.solana.com",
};

function createChains({ fetchImpl = (...a) => fetch(...a), bases = BASES } = {}) {
  async function getJson(url) {
    const r = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`${url} answered ${r.status}`);
    return r.json();
  }
  async function getText(url) {
    const r = await fetchImpl(url, { headers: { accept: "text/plain" } });
    if (!r.ok) throw new Error(`${url} answered ${r.status}`);
    return (await r.text()).trim();
  }

  // ---- Bitcoin and Litecoin (Esplora) ----
  function esplora(base) {
    const received = (tx, address) =>
      (tx.vout || []).filter((o) => o.scriptpubkey_address === address).reduce((s, o) => s + BigInt(o.value), 0n);
    const confs = (tx, tip) => (tx.status && tx.status.confirmed ? tip - tx.status.block_height + 1 : 0);
    return {
      async incoming(address) {
        const [txs, tip] = await Promise.all([getJson(`${base}/address/${address}/txs`), getText(`${base}/blocks/tip/height`)]);
        const height = Number(tip);
        return txs.map((tx) => ({ txid: tx.txid, amount: received(tx, address), confirmations: confs(tx, height),
          time: tx.status && tx.status.block_time ? tx.status.block_time * 1000 : null }))
          .filter((t) => t.amount > 0n);
      },
      async transfer(txid, to) {
        const [tx, tip] = await Promise.all([getJson(`${base}/tx/${encodeURIComponent(txid)}`), getText(`${base}/blocks/tip/height`)]);
        return { txid: tx.txid, amount: received(tx, to), confirmations: confs(tx, Number(tip)) };
      },
    };
  }

  // ---- Ethereum (Blockscout v2). Plain ETH transfers only, not tokens. ----
  function blockscout(base) {
    const toThem = (tx, address) => tx.to && String(tx.to.hash).toLowerCase() === address.toLowerCase();
    const shape = (tx, address) => ({
      txid: tx.hash,
      amount: tx.status === "ok" && toThem(tx, address) ? BigInt(tx.value || "0") : 0n,
      confirmations: Number(tx.confirmations) || 0,
      time: tx.timestamp ? Date.parse(tx.timestamp) : null,
    });
    return {
      async incoming(address) {
        const page = await getJson(`${base}/addresses/${address}/transactions?filter=to`);
        return (page.items || []).map((tx) => shape(tx, address)).filter((t) => t.amount > 0n);
      },
      async transfer(txid, to) {
        return shape(await getJson(`${base}/transactions/${encodeURIComponent(txid)}`), to);
      },
    };
  }

  // ---- Solana (JSON-RPC). Native SOL only. "finalized" counts as 1 confirmation. ----
  function solana(endpoint) {
    let id = 0;
    async function rpc(method, params) {
      const r = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
      if (!r.ok) throw new Error(`Solana RPC ${method} answered ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(`Solana RPC ${method}: ${j.error.message}`);
      return j.result;
    }
    const seen = new Map(); // signature -> lamports received, once finalized (it can't change after that)
    async function receivedBy(signature, address) {
      if (seen.has(signature)) return seen.get(signature);
      const tx = await rpc("getTransaction", [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      if (!tx || !tx.meta || tx.meta.err) return 0n;
      const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
      const i = keys.indexOf(address);
      return i < 0 ? 0n : BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
    }
    return {
      async incoming(address) {
        const sigs = await rpc("getSignaturesForAddress", [address, { limit: 25, commitment: "confirmed" }]);
        const out = [];
        for (const s of sigs || []) {
          if (s.err) continue;
          const amount = await receivedBy(s.signature, address);
          const finalized = s.confirmationStatus === "finalized";
          if (finalized) seen.set(s.signature, amount);
          if (amount > 0n) out.push({ txid: s.signature, amount, confirmations: finalized ? 1 : 0, time: s.blockTime ? s.blockTime * 1000 : null });
        }
        return out;
      },
      async transfer(signature, to) {
        const amount = await receivedBy(signature, to);
        const st = await rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
        const status = st && st.value && st.value[0];
        return { txid: signature, amount, confirmations: status && status.confirmationStatus === "finalized" ? 1 : 0 };
      },
    };
  }

  return {
    BTC: esplora(bases.BTC),
    LTC: esplora(bases.LTC),
    ETH: blockscout(bases.ETH),
    SOL: solana(bases.SOL),
  };
}

const EXPLORERS = {
  BTC: "https://mempool.space/tx/",
  LTC: "https://litecoinspace.org/tx/",
  ETH: "https://etherscan.io/tx/",
  SOL: "https://solscan.io/tx/",
};

module.exports = { createChains, BASES, EXPLORERS };
