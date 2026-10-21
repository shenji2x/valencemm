const assert = require("node:assert/strict");
const { test } = require("node:test");
const { cryptoMethods, nativeBreakdown, refuseUnconfiguredInvoice } = require("../src/crypto-checkout");
const { createApp } = require("../src/app");

test("USDT is disabled on every network; methods publish no payment destinations", () => {
  const policy = cryptoMethods();
  assert.equal(policy.ready, false); assert.equal(policy.platformBps, 100);
  assert.equal(policy.releaseRecipient, "seller"); assert.equal(policy.refundRecipient, "buyer");
  const usdt = policy.assets.find(a => a.symbol === "USDT");
  assert.equal(usdt.disabled, true); assert.match(usdt.reason, /native gas coin/); assert.match(usdt.reason, /ETH or BNB/);
  assert.equal(usdt.releaseFeeAcknowledgementRequired, true);
  assert.equal(JSON.stringify(policy).includes("0x8c495"), false);
  assert.throws(() => refuseUnconfiguredInvoice("USDT"), e => e.code === "usdt_disabled");
  assert.throws(() => refuseUnconfiguredInvoice("BTC"), e => e.code === "crypto_not_ready");
});

test("native deposit total conserves principal, exact 1%, and an explicit payout reserve", () => {
  const q = nativeBreakdown({ symbol: "BTC", principalAtomic: "100000", payoutReserveAtomic: "200" });
  assert.equal(q.platformFeeAtomic, "1000"); assert.equal(q.totalAtomic, "101200");
  assert.equal(q.total, "0.001012"); assert.equal(q.swapFee, "0");
  assert.match(q.senderNetworkFee, /separately/); assert.match(q.payoutFee, /Requoted/);
});

test("native quotes preserve precision above JavaScript's safe integer range", () => {
  const q = nativeBreakdown({ symbol: "ETH", principalAtomic: "123456789012345678900", payoutReserveAtomic: "1234" });
  assert.equal(q.principal, "123.4567890123456789");
  assert.equal(q.platformFee, "1.234567890123456789");
  assert.equal(BigInt(q.totalAtomic), BigInt(q.principalAtomic) + BigInt(q.platformFeeAtomic) + 1234n);
});

test("unknown reserves, lossy amounts, unsupported assets and all USDT quote attempts are refused", () => {
  for (const bad of [undefined, null, -1, "-1", "1.0", "1e8", "01"]) {
    assert.throws(() => nativeBreakdown({ symbol: "BTC", principalAtomic: "100000", payoutReserveAtomic: bad }));
  }
  for (const principalAtomic of ["0", "1", "101", 10000, "1e8"]) {
    assert.throws(() => nativeBreakdown({ symbol: "BTC", principalAtomic, payoutReserveAtomic: "0" }));
  }
  for (const symbol of ["USDT", "DAI", "btc"]) assert.throws(() => nativeBreakdown({ symbol, principalAtomic: "10000", payoutReserveAtomic: "0" }));
});

test("each native asset formats in its own atomic precision", () => {
  assert.equal(nativeBreakdown({ symbol: "SOL", principalAtomic: "1000000000", payoutReserveAtomic: "5000" }).total, "1.010005");
  assert.equal(nativeBreakdown({ symbol: "LTC", principalAtomic: "100000000", payoutReserveAtomic: "1000" }).total, "1.01001");
});

test("HTTP checkout refuses deposits without changing card state or exposing owner addresses", async () => {
  const server = createApp({ skipTimers: true, powDifficulty: 0 });
  await server.ready;
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, path, key, body) {
    const r = await fetch(base + "/v1" + path, { method, headers: { ...(key ? { Authorization: "Bearer " + key } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  }
  try {
    const policy = await call("GET", "/crypto/methods"); assert.equal(policy.status, 200); assert.equal(policy.body.ready, false);
    const buyer = (await call("POST", "/agents/register", null, { name: "checkout-buyer" })).body;
    const seller = (await call("POST", "/agents/register", null, { name: "checkout-seller" })).body;
    const outsider = (await call("POST", "/agents/register", null, { name: "checkout-outsider" })).body;
    const deal = (await call("POST", "/deals", buyer.apiKey, { title: "Checkout test", amount: 50000, type: "ai-ai", paymentType: "crypto", cryptoAsset: "BTC" })).body;
    await call("POST", "/deals/join", seller.apiKey, { inviteCode: deal.inviteCode });
    const path = `/deals/${deal.id}/crypto/invoice`;
    assert.equal((await call("POST", path, null, { asset: "BTC" })).status, 401);
    assert.equal((await call("POST", path, seller.apiKey, { asset: "BTC" })).status, 403);
    assert.equal((await call("POST", path, outsider.apiKey, { asset: "BTC" })).status, 404);
    for (const asset of ["BTC"]) {
      const r = await call("POST", path, buyer.apiKey, { asset, amount: "0.0001", address: "attacker-wallet" });
      assert.equal(r.status, 503); assert.equal(r.body.error.code, "crypto_not_ready");
      assert.equal(r.body.address, undefined); assert.equal(r.body.total, undefined);
    }
    const usdt = await call("POST", path, buyer.apiKey, { asset: "USDT", network: "ethereum" });
    assert.equal(usdt.status, 409); assert.equal(usdt.body.error.code, "usdt_disabled");
    const after = (await call("GET", `/deals/${deal.id}`, buyer.apiKey)).body;
    assert.equal(after.state, "joined"); assert.equal(after.payment, null);
    const page = await fetch(base + "/crypto-preview"); assert.equal(page.status, 200); assert.match(await page.text(), /No real deposits/);
  } finally { await new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }); }
});
