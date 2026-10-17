const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");

async function start(opts = {}) {
  const clock = { t: Date.parse("2026-10-17T00:00:00Z") };
  const app = createApp({ now: () => clock.t, ...opts });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, path, { key, body, headers } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...headers,
      },
      body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  }
  const register = async (name) => (await call("POST", "/v1/agents/register", { body: { name } })).json;
  return { call, register, clock, app, close: () => new Promise((r) => server.close(r)) };
}

async function fundedDeal(ctx, amount = 50, extra = {}) {
  const buyer = await ctx.register("buyer");
  const seller = await ctx.register("seller");
  const d = await ctx.call("POST", "/v1/deals", { key: buyer.apiKey, body: { title: "Job", amount, ...extra } });
  assert.equal(d.status, 201);
  const j = await ctx.call("POST", "/v1/deals/join", { key: seller.apiKey, body: { inviteCode: d.json.inviteCode } });
  assert.equal(j.status, 200);
  const f = await ctx.call("POST", `/v1/deals/${d.json.id}/fund`, { key: buyer.apiKey });
  assert.equal(f.status, 200);
  return { buyer, seller, dealId: d.json.id };
}

const balance = async (ctx, agent) => (await ctx.call("GET", "/v1/me", { key: agent.apiKey })).json.balance;

test("register gives an api key and 100 credits; key works", async () => {
  const ctx = await start();
  try {
    const a = await ctx.register("alpha");
    assert.match(a.apiKey, /^vlc_[0-9a-f]{48}$/);
    assert.equal(a.balance, 100);
    assert.equal(await balance(ctx, a), 100);
  } finally { await ctx.close(); }
});

test("happy path: create, join, fund, release pays seller minus 1% fee", async () => {
  const ctx = await start();
  try {
    const { buyer, seller, dealId } = await fundedDeal(ctx, 50);
    assert.equal(await balance(ctx, buyer), 50);
    const r = await ctx.call("POST", `/v1/deals/${dealId}/release`, { key: buyer.apiKey });
    assert.equal(r.status, 200);
    assert.equal(r.json.state, "released");
    assert.equal(await balance(ctx, seller), 150); // fee = floor(50 * 1%) = 0
    assert.equal(await balance(ctx, buyer), 50);
  } finally { await ctx.close(); }
});

test("fee is floor(amount * 1%) and credits are conserved", async () => {
  const ctx = await start();
  try {
    const { buyer, seller, dealId } = await fundedDeal(ctx, 99); // fee floor(0.99) = 0
    await ctx.call("POST", `/v1/deals/${dealId}/release`, { key: buyer.apiKey });
    assert.equal(await balance(ctx, seller), 199);

    // 100 credits -> fee 1
    const b2 = await ctx.register("b2");
    const s2 = await ctx.register("s2");
    const d = await ctx.call("POST", "/v1/deals", { key: b2.apiKey, body: { title: "x", amount: 100 } });
    await ctx.call("POST", "/v1/deals/join", { key: s2.apiKey, body: { inviteCode: d.json.inviteCode } });
    await ctx.call("POST", `/v1/deals/${d.json.id}/fund`, { key: b2.apiKey });
    await ctx.call("POST", `/v1/deals/${d.json.id}/release`, { key: b2.apiKey });
    assert.equal(await balance(ctx, b2), 0);
    assert.equal(await balance(ctx, s2), 100 + 99);
    assert.equal(ctx.app.locals.store.audit().ok, true);
    const health = await ctx.call("GET", "/health");
    assert.equal(health.json.ledger, "balanced");
  } finally { await ctx.close(); }
});

test("seller can refund any time; buyer can only after the deadline", async () => {
  const ctx = await start();
  try {
    const { buyer, seller, dealId } = await fundedDeal(ctx, 40, { deadlineHours: 2 });
    const early = await ctx.call("POST", `/v1/deals/${dealId}/refund`, { key: buyer.apiKey });
    assert.equal(early.status, 403);
    assert.equal(early.json.error.code, "deadline_not_reached");
    ctx.clock.t += 3 * 3600 * 1000;
    const late = await ctx.call("POST", `/v1/deals/${dealId}/refund`, { key: buyer.apiKey });
    assert.equal(late.status, 200);
    assert.equal(late.json.state, "refunded");
    assert.equal(await balance(ctx, buyer), 100);
    assert.equal(await balance(ctx, seller), 100);

    const second = await fundedDeal(ctx, 10);
    const sr = await ctx.call("POST", `/v1/deals/${second.dealId}/refund`, { key: second.seller.apiKey });
    assert.equal(sr.status, 200);
    assert.equal(await balance(ctx, second.buyer), 100);
    assert.equal(ctx.app.locals.store.audit().ok, true);
  } finally { await ctx.close(); }
});

test("only the buyer can fund or release; outsiders get 404", async () => {
  const ctx = await start();
  try {
    const { buyer, seller, dealId } = await fundedDeal(ctx, 20);
    const outsider = await ctx.register("outsider");
    assert.equal((await ctx.call("POST", `/v1/deals/${dealId}/release`, { key: seller.apiKey })).status, 403);
    assert.equal((await ctx.call("GET", `/v1/deals/${dealId}`, { key: outsider.apiKey })).status, 404);
    assert.equal((await ctx.call("POST", `/v1/deals/${dealId}/release`, { key: outsider.apiKey })).status, 404);
    assert.equal((await ctx.call("GET", `/v1/deals/${dealId}`, { key: seller.apiKey })).status, 200);
    // releasing twice is rejected and pays nothing extra
    assert.equal((await ctx.call("POST", `/v1/deals/${dealId}/release`, { key: buyer.apiKey })).status, 200);
    assert.equal((await ctx.call("POST", `/v1/deals/${dealId}/release`, { key: buyer.apiKey })).status, 409);
    assert.equal(await balance(ctx, seller), 120);
  } finally { await ctx.close(); }
});

test("invite codes are single use, hidden from non-creators, and can't be joined by the creator", async () => {
  const ctx = await start();
  try {
    const a = await ctx.register("a");
    const b = await ctx.register("b");
    const c = await ctx.register("c");
    const d = await ctx.call("POST", "/v1/deals", { key: a.apiKey, body: { title: "t", amount: 5, role: "seller" } });
    assert.ok(d.json.inviteCode);
    assert.equal((await ctx.call("POST", "/v1/deals/join", { key: a.apiKey, body: { inviteCode: d.json.inviteCode } })).status, 400);
    const j = await ctx.call("POST", "/v1/deals/join", { key: b.apiKey, body: { inviteCode: d.json.inviteCode.toLowerCase() } });
    assert.equal(j.status, 200);
    assert.equal(j.json.yourRole, "buyer");
    assert.equal(j.json.inviteCode, undefined);
    assert.equal((await ctx.call("POST", "/v1/deals/join", { key: c.apiKey, body: { inviteCode: d.json.inviteCode } })).status, 404);
    const again = await ctx.call("GET", `/v1/deals/${d.json.id}`, { key: a.apiKey });
    assert.equal(again.json.inviteCode, undefined);
  } finally { await ctx.close(); }
});

test("cannot fund without enough credits or before someone joins", async () => {
  const ctx = await start();
  try {
    const a = await ctx.register("a");
    const b = await ctx.register("b");
    const d = await ctx.call("POST", "/v1/deals", { key: a.apiKey, body: { title: "t", amount: 5 } });
    const early = await ctx.call("POST", `/v1/deals/${d.json.id}/fund`, { key: a.apiKey });
    assert.equal(early.status, 409);
    const big = await ctx.call("POST", "/v1/deals", { key: a.apiKey, body: { title: "big", amount: 5000 } });
    await ctx.call("POST", "/v1/deals/join", { key: b.apiKey, body: { inviteCode: big.json.inviteCode } });
    const poor = await ctx.call("POST", `/v1/deals/${big.json.id}/fund`, { key: a.apiKey });
    assert.equal(poor.status, 402);
    assert.equal(await balance(ctx, a), 100);
  } finally { await ctx.close(); }
});

test("cancel works before funding but not after", async () => {
  const ctx = await start();
  try {
    const a = await ctx.register("a");
    const d = await ctx.call("POST", "/v1/deals", { key: a.apiKey, body: { title: "t", amount: 5 } });
    const c = await ctx.call("POST", `/v1/deals/${d.json.id}/cancel`, { key: a.apiKey });
    assert.equal(c.json.state, "cancelled");
    assert.equal((await ctx.call("POST", "/v1/deals/join", { key: (await ctx.register("z")).apiKey, body: { inviteCode: d.json.inviteCode } })).status, 404);
    const { buyer, dealId } = await fundedDeal(ctx, 10);
    assert.equal((await ctx.call("POST", `/v1/deals/${dealId}/cancel`, { key: buyer.apiKey })).status, 409);
  } finally { await ctx.close(); }
});

test("idempotency key makes a retried fund request a no-op", async () => {
  const ctx = await start();
  try {
    const a = await ctx.register("a");
    const b = await ctx.register("b");
    const d = await ctx.call("POST", "/v1/deals", { key: a.apiKey, body: { title: "t", amount: 30 } });
    await ctx.call("POST", "/v1/deals/join", { key: b.apiKey, body: { inviteCode: d.json.inviteCode } });
    const h = { "Idempotency-Key": "fund-1" };
    const one = await ctx.call("POST", `/v1/deals/${d.json.id}/fund`, { key: a.apiKey, headers: h });
    const two = await ctx.call("POST", `/v1/deals/${d.json.id}/fund`, { key: a.apiKey, headers: h });
    assert.equal(one.status, 200);
    assert.equal(two.status, 200);
    assert.equal(two.headers.get("idempotent-replay"), "true");
    assert.equal(await balance(ctx, a), 70);
    // without the key, the same retry is rejected as a bad state
    assert.equal((await ctx.call("POST", `/v1/deals/${d.json.id}/fund`, { key: a.apiKey })).status, 409);
  } finally { await ctx.close(); }
});

test("auth and validation errors", async () => {
  const ctx = await start();
  try {
    assert.equal((await ctx.call("GET", "/v1/me")).status, 401);
    assert.equal((await ctx.call("GET", "/v1/me", { key: "vlc_nope" })).status, 401);
    const a = await ctx.register("a");
    const bad = (body) => ctx.call("POST", "/v1/deals", { key: a.apiKey, body });
    assert.equal((await bad({ title: "t", amount: 0 })).status, 400);
    assert.equal((await bad({ title: "t", amount: 1.5 })).status, 400);
    assert.equal((await bad({ title: "t", amount: "5" })).status, 400);
    assert.equal((await bad({ title: "t", amount: 10001 })).status, 400);
    assert.equal((await bad({ title: "", amount: 5 })).status, 400);
    assert.equal((await bad({ title: "t", amount: 5, role: "boss" })).status, 400);
    assert.equal((await bad({ title: "t", amount: 5, deadlineHours: 0 })).status, 400);
    assert.equal((await ctx.call("POST", "/v1/agents/register", { body: {} })).status, 400);
    assert.equal((await ctx.call("POST", "/v1/agents/register", { body: "{not json" })).json.error.code, "invalid_json");
    assert.equal((await ctx.call("GET", "/v1/nothing", { key: a.apiKey })).status, 404);
  } finally { await ctx.close(); }
});

test("registration is rate limited per IP", async () => {
  const ctx = await start({ registerLimit: 3 });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await ctx.call("POST", "/v1/agents/register", { body: { name: "n" + i } })).status, 201);
    const blocked = await ctx.call("POST", "/v1/agents/register", { body: { name: "n4" } });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get("retry-after"));
  } finally { await ctx.close(); }
});

test("an agent can't hold more than 20 unfinished deals", async () => {
  const ctx = await start();
  try {
    const a = await ctx.register("a");
    for (let i = 0; i < 20; i++) {
      assert.equal((await ctx.call("POST", "/v1/deals", { key: a.apiKey, body: { title: "d" + i, amount: 1 } })).status, 201);
    }
    assert.equal((await ctx.call("POST", "/v1/deals", { key: a.apiKey, body: { title: "one too many", amount: 1 } })).status, 429);
  } finally { await ctx.close(); }
});

test("pages are served and the api key is never stored in plain text", async () => {
  const ctx = await start();
  try {
    const home = await ctx.call("GET", "/");
    assert.equal(home.status, 200);
    assert.match(home.text, /Valence/);
    const docs = await ctx.call("GET", "/docs");
    assert.equal(docs.status, 200);
    assert.match(docs.text, /Idempotency-Key/);
    assert.equal(docs.headers.get("x-content-type-options"), "nosniff");
    const a = await ctx.register("a");
    assert.equal(JSON.stringify(ctx.app.locals.store.me({ id: a.agentId })).includes(a.apiKey), false);
    assert.equal((await ctx.call("GET", "/health")).json.status, "online");
  } finally { await ctx.close(); }
});
