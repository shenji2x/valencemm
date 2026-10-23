const test = require("node:test");
const assert = require("node:assert/strict");
const { createStore } = require("../src/store");
const { createPayments } = require("../src/payments");
const { createApp } = require("../src/app");

function setup() {
  const store = createStore();
  const register = name => { const a = store.registerAgent(name); return { key: a.apiKey, rec: store.authenticate(a.apiKey) }; };
  return { store, buyer: register("Buyer"), seller: register("Seller") };
}
test("agreed native coin and network survive restart and appear before joining; legacy deals remain Stripe", () => {
  const { store, buyer, seller } = setup();
  for (const [cryptoAsset, network] of [["BTC", "Bitcoin"], ["ETH", "Ethereum"], ["LTC", "Litecoin"], ["SOL", "Solana"]]) {
    const deal = store.createDeal(buyer.rec, { title: "Native payment", amount: 50000, paymentType: "crypto", cryptoAsset,
      payment: { status: "held" }, address: "attacker", platformBps: 0, state: "funded" });
    assert.equal(deal.paymentType, "crypto"); assert.equal(deal.cryptoNetwork, network); assert.equal(deal.state, "open"); assert.equal(deal.payment, null); assert.equal(deal.quote, null);
    const preview = store.invitePreview(seller.rec, deal.inviteCode);
    assert.equal(preview.cryptoAsset, cryptoAsset); assert.equal(preview.currency, "usd");
    store.joinDeal(seller.rec, deal.inviteCode);
    const restored = createStore(); restored.importState(JSON.parse(JSON.stringify(store.exportState())));
    assert.equal(restored.getDeal(buyer.rec, deal.id).cryptoAsset, cryptoAsset);
    assert.equal(JSON.stringify(restored.getDeal(buyer.rec, deal.id)).includes("attacker"), false);
  }
  const card = store.createDeal(buyer.rec, { title: "Old client", amount: 50000 });
  assert.equal(card.paymentType, "stripe"); assert.equal(card.rail, "card"); assert.equal(card.cryptoAsset, null);
});
test("server rejects USDT, unsupported rails, coins and cross-network substitutions", () => {
  const { store, buyer } = setup();
  for (const input of [{ paymentType: "paypal" }, { paymentType: "crypto", cryptoAsset: "USDT" },
    { paymentType: "crypto", cryptoAsset: "ETH", cryptoNetwork: "BNB" }, { paymentType: "crypto", cryptoAsset: "DOGE" },
    { paymentType: "stripe", cryptoAsset: "BTC" }, { rail: "crypto" }]) {
    assert.throws(() => store.createDeal(buyer.rec, { title: "Invalid selection", amount: 50000, ...input }));
  }
  assert.equal(store.listDeals(buyer.rec).length, 0);
});
test("no Stripe operation, webhook or timer can fund or pay a crypto deal", async () => {
  const { store, buyer, seller } = setup();
  const d = store.createDeal(buyer.rec, { title: "Crypto boundaries", amount: 50000, paymentType: "crypto", cryptoAsset: "ETH" });
  store.joinDeal(seller.rec, d.inviteCode);
  const raw = store.dealById(d.id);
  let calls = 0;
  const stripe = new Proxy({ configured: true }, { get(target, key) { if (key in target) return target[key]; return () => { calls++; throw Error("Provider must not be called"); }; } });
  const payments = createPayments({ store, stripe });
  for (const method of ["startFunding", "confirmFunding", "release", "refund"]) {
    await assert.rejects(payments[method](buyer.rec, d.id), e => e.code === "payment_type_mismatch");
  }
  for (const action of [() => store.attachIntent(raw, {}), () => store.markHeld(raw), () => store.markReleased(raw, buyer.rec.id), () => store.markRefunded(raw, buyer.rec.id)]) {
    assert.throws(action, e => e.code === "payment_type_mismatch");
  }
  assert.equal(calls, 0); assert.equal(raw.state, "joined"); assert.equal(raw.payment, null);
  // Even malformed persisted records cannot enter the card sweeps or webhook lookup.
  raw.state = "delivered"; raw.deliveredAt = Date.now() - 1e10;
  raw.payment = { provider: "stripe", intentId: "pi_wrong", status: "held", authorizedAt: Date.now() - 1e10 };
  assert.equal(store.dealByIntent("pi_wrong"), null);
  assert.deepEqual(await payments.runAutoRelease(), { considered: 0, released: 0 });
  assert.deepEqual(await payments.sweepExpiringHolds(), { considered: 0, cancelled: 0 });
  assert.equal((await payments.handleWebhook({ type: "payment_intent.succeeded", data: { object: { id: "pi_wrong" } } })).handled, false);
  assert.equal(calls, 0);
});
test("invoice API binds buyer, deal, coin and rail and never trusts browser funding claims", async t => {
  const server = createApp({ skipTimers: true, powDifficulty: 0 }); await server.ready;
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const { store } = server;
  const a = store.registerAgent("buyer"), b = store.registerAgent("seller"), c = store.registerAgent("outsider");
  const buyer = store.authenticate(a.apiKey), seller = store.authenticate(b.apiKey);
  async function invoice(id, asset, key = a.apiKey) {
    const r = await fetch(`${base}/deals/${id}/crypto/invoice`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ asset, address: "attacker", status: "confirmed", confirmations: 999, total: "1", network: "BNB" }) });
    return { status: r.status, body: await r.json() };
  }
  for (const [cryptoAsset, network] of [["BTC", "Bitcoin"], ["ETH", "Ethereum"], ["LTC", "Litecoin"], ["SOL", "Solana"]]) {
    const d = store.createDeal(buyer, { title: "Bound invoice", amount: 50000, paymentType: "crypto", cryptoAsset });
    store.joinDeal(seller, d.inviteCode);
    // Crypto is on, but the seller hasn't said where the payout goes, so no deposit address is issued
    // and nothing the browser sent (an address, a status, a total) is taken from the request.
    const first = await invoice(d.id, cryptoAsset);
    assert.equal(first.status, 409); assert.equal(first.body.error.code, "seller_not_ready");
    assert.equal(JSON.stringify(first.body).includes("attacker"), false);
    assert.equal((await invoice(d.id, cryptoAsset === "BTC" ? "ETH" : "BTC")).body.error.code, "payment_type_mismatch");
    assert.equal((await invoice(d.id, "USDT")).body.error.code, "usdt_disabled");
    assert.equal((await invoice(d.id, cryptoAsset, b.apiKey)).status, 403);
    assert.equal((await invoice(d.id, cryptoAsset, c.apiKey)).status, 404);
    const after = store.getDeal(buyer, d.id);
    assert.equal(after.state, "awaiting_setup"); assert.equal(after.payment, null); assert.equal(after.cryptoNetwork, network);
    assert.equal(after.crypto.invoice, null); assert.equal(after.crypto.deposit, null);
  }
  const card = store.createDeal(buyer, { title: "Card only", amount: 50000 }); store.joinDeal(seller, card.inviteCode);
  assert.equal((await invoice(card.id, "BTC")).body.error.code, "payment_type_mismatch");
});
