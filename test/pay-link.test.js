// One-time pay links: an AI agent's owner pays its deal by card without the agent's API key.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../src/app");
const { createStripe } = require("../src/stripe");
const { createFakeStripe } = require("./fakestripe");
const { fileBackend } = require("../src/persist");

async function start(opts = {}) {
  const clock = opts.clock || { t: Date.parse("2026-10-23T00:00:00Z") };
  const fake = opts.fake || createFakeStripe();
  const apiBase = opts.apiBase || await fake.listen();
  const stripe = createStripe({ secretKey: "sk_test_pl", publishableKey: "pk_test_pl", webhookSecret: fake.webhookSecret, apiBase, log: { error() {} } });
  const server = createApp({ now: () => clock.t, stripe, skipTimers: true, powDifficulty: 0, siteUrl: "https://valencemm.test", ...opts.app });
  await server.ready;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, { key, body } = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(key ? { Authorization: "Bearer " + key } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, headers: r.headers };
  };
  const agent = async (name) => (await call("POST", "/v1/agents/register", { body: { name } })).json;
  const close = async (keepFake) => {
    await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
    if (!keepFake) await fake.close();
  };
  return { clock, fake, apiBase, server, base, call, agent, close };
}

// A joined card deal whose seller has finished Stripe onboarding.
async function joinedDeal(ctx, amount = 50000) {
  const buyer = await ctx.agent("shopping-bot");
  const seller = await ctx.agent("design-bot");
  await ctx.call("POST", "/v1/payouts/onboarding-link", { key: seller.apiKey, body: {} });
  ctx.fake.finishOnboarding([...ctx.fake.state.accounts.keys()].pop());
  await ctx.call("POST", "/v1/payouts/refresh", { key: seller.apiKey, body: {} });
  const d = await ctx.call("POST", "/v1/deals", { key: buyer.apiKey, body: { title: "Logo for a coffee cart", amount } });
  await ctx.call("POST", "/v1/deals/join", { key: seller.apiKey, body: { inviteCode: d.json.inviteCode } });
  return { buyer, seller, id: d.json.id };
}
const tokenOf = (url) => url.split("/pay/")[1];

test("only the buyer can make a pay link, and only once someone has joined", async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const buyer = await ctx.agent("buyer"), seller = await ctx.agent("seller"), other = await ctx.agent("other");
  const d = await ctx.call("POST", "/v1/deals", { key: buyer.apiKey, body: { title: "Some job", amount: 2000 } });
  assert.equal((await ctx.call("POST", `/v1/deals/${d.json.id}/pay-link`, { key: buyer.apiKey })).json.error.code, "bad_state");
  await ctx.call("POST", "/v1/deals/join", { key: seller.apiKey, body: { inviteCode: d.json.inviteCode } });
  assert.equal((await ctx.call("POST", `/v1/deals/${d.json.id}/pay-link`, { key: seller.apiKey })).status, 403);
  assert.equal((await ctx.call("POST", `/v1/deals/${d.json.id}/pay-link`, { key: other.apiKey })).status, 404);
  assert.equal((await ctx.call("POST", `/v1/deals/${d.json.id}/pay-link`)).status, 401);
  const r = await ctx.call("POST", `/v1/deals/${d.json.id}/pay-link`, { key: buyer.apiKey });
  assert.equal(r.status, 201);
  assert.match(r.json.url, /^https:\/\/valencemm\.test\/pay\/vpl_[0-9a-f]{48}$/);
  assert.match(r.json.note, /once/);
});

test("the link shows what's being paid, and leaks no IDs, keys or invite codes", async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const { buyer, seller, id } = await joinedDeal(ctx);
  const deal = (await ctx.call("GET", `/v1/deals/${id}`, { key: buyer.apiKey })).json;
  const url = (await ctx.call("POST", `/v1/deals/${id}/pay-link`, { key: buyer.apiKey })).json.url;
  const v = await ctx.call("GET", `/v1/pay-links/${tokenOf(url)}`);
  assert.equal(v.status, 200);
  assert.equal(v.json.deal.title, "Logo for a coffee cart");
  assert.equal(v.json.deal.amount, 50000);
  assert.equal(v.json.payable, true);
  assert.equal(v.json.paid, false);
  assert.equal(v.json.sellerReady, true);
  assert.ok("publishableKey" in v.json);
  for (const secret of [id, deal.inviteCode, buyer.apiKey, seller.apiKey, buyer.id, seller.id].filter(Boolean)) {
    assert.equal(v.text.includes(secret), false, `pay link view leaked ${secret}`);
  }
  // The page itself loads, and isn't indexed or leaked via Referer.
  const page = await fetch(ctx.base + "/pay/" + tokenOf(url));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /data-page="pay"/);
  assert.match(html, /noindex/);
});

test("paying through the link holds the card on the seller's account, then the link is spent", async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const { buyer, seller, id } = await joinedDeal(ctx);
  const token = tokenOf((await ctx.call("POST", `/v1/deals/${id}/pay-link`, { key: buyer.apiKey })).json.url);
  const f = await ctx.call("POST", `/v1/pay-links/${token}/fund`, { body: {} });
  assert.equal(f.status, 200);
  assert.deepEqual(Object.keys(f.json).sort(), ["alreadyFunded", "clientSecret", "quote", "stripeAccount"]);
  assert.match(f.json.clientSecret, /_secret_/);
  assert.equal(ctx.fake.lastIntent().capture_method, "manual");
  // Not paid yet: confirming early doesn't fund anything.
  assert.equal((await ctx.call("POST", `/v1/pay-links/${token}/funded`, { body: {} })).json.paid, false);
  ctx.fake.authorize(ctx.fake.lastIntent().id);
  assert.equal((await ctx.call("POST", `/v1/pay-links/${token}/funded`, { body: {} })).json.paid, true);
  assert.equal((await ctx.call("GET", `/v1/deals/${id}`, { key: seller.apiKey })).json.state, "funded");
  const after = (await ctx.call("GET", `/v1/pay-links/${token}`)).json;
  assert.equal(after.paid, true);
  assert.equal(after.payable, false);
  // Paying again can't put a second hold on anyone's card.
  const intents = ctx.fake.state.intents.size;
  const again = await ctx.call("POST", `/v1/pay-links/${token}/fund`, { body: {} });
  assert.ok(again.status === 409 || again.json.alreadyFunded === true, again.text);
  assert.equal(ctx.fake.state.intents.size, intents);
  // And the buyer can't make a fresh link for a paid deal.
  assert.equal((await ctx.call("POST", `/v1/deals/${id}/pay-link`, { key: buyer.apiKey })).json.error.code, "bad_state");
});

test("bad, replaced and expired links all fail the same way", async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const { buyer, id } = await joinedDeal(ctx);
  const first = tokenOf((await ctx.call("POST", `/v1/deals/${id}/pay-link`, { key: buyer.apiKey })).json.url);
  const second = tokenOf((await ctx.call("POST", `/v1/deals/${id}/pay-link`, { key: buyer.apiKey })).json.url);
  const code = async (tok) => (await ctx.call("GET", `/v1/pay-links/${tok}`)).json?.error?.code;
  assert.equal(await code(first), "pay_link_invalid", "a new link replaces the old one");
  assert.equal(await code("vpl_" + "0".repeat(48)), "pay_link_invalid");
  assert.equal(await code("not-a-token"), "pay_link_invalid");
  assert.equal((await ctx.call("POST", `/v1/pay-links/${first}/fund`, { body: {} })).status, 404);
  assert.equal((await ctx.call("GET", `/v1/pay-links/${second}`)).status, 200);
  ctx.clock.t += 25 * 3600 * 1000;
  assert.equal(await code(second), "pay_link_invalid");
  assert.equal((await fetch(ctx.base + "/pay/vpl_xyz")).status, 404);
});

test("crypto deals don't get card pay links", async (t) => {
  const ctx = await start();
  t.after(() => ctx.close());
  const buyer = await ctx.agent("b"), seller = await ctx.agent("s");
  const d = await ctx.call("POST", "/v1/deals", { key: buyer.apiKey, body: { title: "Coin job", amount: 2000, paymentType: "crypto", cryptoAsset: "BTC" } });
  await ctx.call("POST", "/v1/deals/join", { key: seller.apiKey, body: { inviteCode: d.json.inviteCode } });
  const r = await ctx.call("POST", `/v1/deals/${d.json.id}/pay-link`, { key: buyer.apiKey });
  assert.equal(r.status, 409);
});

test("a pay link still works after the server restarts", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vpl-"));
  const file = path.join(dir, "state.json");
  const clock = { t: Date.parse("2026-10-23T00:00:00Z") };
  const ctx = await start({ clock, app: { backend: fileBackend(file) } });
  const { buyer, id } = await joinedDeal(ctx);
  const token = tokenOf((await ctx.call("POST", `/v1/deals/${id}/pay-link`, { key: buyer.apiKey })).json.url);
  await ctx.close(true);
  const ctx2 = await start({ clock, fake: ctx.fake, apiBase: ctx.apiBase, app: { backend: fileBackend(file) } });
  t.after(() => ctx2.close());
  const v = await ctx2.call("GET", `/v1/pay-links/${token}`);
  assert.equal(v.status, 200, v.text);
  assert.equal(v.json.payable, true);
});
