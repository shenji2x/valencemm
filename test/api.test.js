// End-to-end tests: a real server on a random port, real HTTP requests.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const { createStripe } = require("../src/stripe");
const { createFakeStripe } = require("./fakestripe");

async function start(opts = {}) {
  const clock = { t: Date.parse("2026-10-17T00:00:00Z") };
  // Every server gets its own fake Stripe, so the money routes are exercised for real.
  const fake = opts.noStripe ? null : createFakeStripe();
  const apiBase = fake ? await fake.listen() : null;
  const stripe = fake
    ? createStripe({ secretKey: "sk_test_api", webhookSecret: fake.webhookSecret, apiBase, log: { error() {} } })
    : createStripe({ log: { error() {} } });
  const server = createApp({ now: () => clock.t, stripe, skipTimers: true, powDifficulty: 0, ...opts });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { key, body, headers, raw } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...headers,
      },
      body: body === undefined ? raw : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  const agent = async (name) => (await call("POST", "/v1/agents/register", { body: { name } })).json;
  const human = async (username, password = "password-123") => (await call("POST", "/v1/humans/signup", { body: { username, password } })).json;
  const close = async () => {
    await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
    if (fake) await fake.close();
  };

  // Takes a seller through Stripe onboarding, which every deal needs before it can be funded.
  async function onboard(key) {
    const r = await ctx.call("POST", "/v1/payouts/onboarding-link", { key, body: {} });
    const me = await ctx.call("GET", "/v1/payouts", { key });
    const acct = [...fake.state.accounts.keys()].pop();
    fake.finishOnboarding(acct);
    await ctx.call("POST", "/v1/payouts/refresh", { key, body: {} });
    return { link: r.json, before: me.json, acct };
  }

  // Creates a deal, joins it, and puts a hold on the buyer's card.
  async function fundedDeal({ buyerKey, sellerKey, amount = 50000, body = {} }) {
    const d = await ctx.call("POST", "/v1/deals", { key: buyerKey, body: { title: "Job", amount, ...body } });
    await ctx.call("POST", "/v1/deals/join", { key: sellerKey, body: { inviteCode: d.json.inviteCode } });
    const started = await ctx.call("POST", `/v1/deals/${d.json.id}/fund`, { key: buyerKey });
    fake.authorize(fake.lastIntent().id);
    const confirmed = await ctx.call("POST", `/v1/deals/${d.json.id}/funded`, { key: buyerKey, body: {} });
    return { id: d.json.id, deal: d.json, started: started.json, confirmed: confirmed.json };
  }

  const ctx = { call, agent, human, clock, server, close, fake, stripe, onboard, fundedDeal };
  return ctx;
}

async function withServer(opts, fn) {
  if (typeof opts === "function") { fn = opts; opts = {}; }
  const ctx = await start(opts);
  try { await fn(ctx); } finally { await ctx.close(); }
}

test("AI to AI deal over HTTP, end to end", () => withServer(async (ctx) => {
  const buyer = await ctx.agent("buyer-bot");
  const seller = await ctx.agent("seller-bot");
  assert.match(buyer.apiKey, /^vlc_[0-9a-f]{48}$/);
  // An account is not a wallet: registering grants nothing to spend.
  assert.equal(buyer.balance, undefined);
  assert.equal(buyer.currency, "usd");

  // A deal can't be funded until the seller can actually be paid.
  const early = await ctx.call("POST", "/v1/deals", { key: buyer.apiKey, body: { title: "Job", amount: 50000, type: "ai-ai" } });
  await ctx.call("POST", "/v1/deals/join", { key: seller.apiKey, body: { inviteCode: early.json.inviteCode } });
  const blocked = await ctx.call("POST", `/v1/deals/${early.json.id}/fund`, { key: buyer.apiKey });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error.code, "seller_not_ready");
  assert.equal((await ctx.call("GET", `/v1/deals/${early.json.id}`, { key: seller.apiKey })).json.state, "awaiting_setup");

  await ctx.onboard(seller.apiKey);
  assert.equal((await ctx.call("GET", "/v1/payouts", { key: seller.apiKey })).json.ready, true);

  const { id, started, confirmed } = await ctx.fundedDeal({ buyerKey: buyer.apiKey, sellerKey: seller.apiKey, amount: 50000, body: { type: "ai-ai" } });
  assert.equal(started.quote.buyerTotal, 50500); // the deal plus Valence's 1%
  assert.equal(started.quote.platformFee, 500);
  assert.match(started.clientSecret, /_secret_test$/);
  assert.equal(confirmed.state, "funded");
  assert.equal(confirmed.payment.status, "held");

  const released = await ctx.call("POST", `/v1/deals/${id}/release`, { key: buyer.apiKey });
  assert.equal(released.json.state, "released");
  assert.equal(released.json.payment.status, "captured");
  assert.ok(released.json.payment.sellerNet > 0);
  assert.equal((await ctx.call("GET", "/health")).json.deals, "consistent");

  // The seller's history shows a payout against that deal, and no balance anywhere.
  const history = await ctx.call("GET", "/v1/payments", { key: seller.apiKey });
  assert.equal(history.json.events[0].event, "paid_out");
  assert.equal(history.json.events[0].dealId, id);
  assert.equal(JSON.stringify(history.json).includes('"balance"'), false);
}));

test("people: signup, login, session token works like an API key, logout ends it", () => withServer(async (ctx) => {
  const s = await ctx.human("Ann_Person");
  assert.match(s.token, /^vls_[0-9a-f]{48}$/);
  assert.equal(s.account.kind, "human");
  assert.equal(s.account.name, "ann_person");
  assert.equal((await ctx.call("GET", "/v1/me", { key: s.token })).json.balance, undefined);

  const login = await ctx.call("POST", "/v1/humans/login", { body: { username: "ANN_person", password: "password-123" } });
  assert.equal(login.status, 200);
  const bad = await ctx.call("POST", "/v1/humans/login", { body: { username: "ann_person", password: "nope-nope-1" } });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.code, "invalid_login");
  assert.equal(JSON.stringify(login.json).includes("password-123"), false);

  assert.equal((await ctx.call("POST", "/v1/logout", { key: login.json.token })).status, 200);
  assert.equal((await ctx.call("GET", "/v1/me", { key: login.json.token })).status, 401);
  assert.equal((await ctx.call("GET", "/v1/me", { key: s.token })).status, 200);
}));

test("a customer's colour theme is saved on their account and defaults to blue", () => withServer(async (ctx) => {
  const alice = await ctx.human("alice");
  assert.equal((await ctx.call("GET", "/v1/me", { key: alice.token })).json.palette, "blue");
  assert.equal((await ctx.call("POST", "/v1/account/palette", { key: alice.token, body: { palette: "violet" } })).status, 200);
  assert.equal((await ctx.call("GET", "/v1/me", { key: alice.token })).json.palette, "violet");
  const bad = await ctx.call("POST", "/v1/account/palette", { key: alice.token, body: { palette: "plaid" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "invalid_palette");
  assert.equal((await ctx.call("POST", "/v1/account/palette", { body: { palette: "teal" } })).status, 401);
}));

test("human to human and AI and human deals respect account types", () => withServer(async (ctx) => {
  const ann = await human("ann");
  async function human(name) { const r = await ctx.human(name); return { key: r.token }; }
  const bob = await human("bob");
  const bot = await ctx.agent("bot");

  const hh = await ctx.call("POST", "/v1/deals", { key: ann.key, body: { title: "swap", amount: 10000, type: "human-human" } });
  assert.equal(hh.status, 201);
  const botJoin = await ctx.call("POST", "/v1/deals/join", { key: bot.apiKey, body: { inviteCode: hh.json.inviteCode } });
  assert.equal(botJoin.status, 403);
  assert.equal(botJoin.json.error.code, "wrong_account_type");
  assert.equal((await ctx.call("POST", "/v1/deals/join", { key: bob.key, body: { inviteCode: hh.json.inviteCode } })).status, 200);

  const nope = await ctx.call("POST", "/v1/deals", { key: ann.key, body: { title: "x", amount: 5000, type: "ai-ai" } });
  assert.equal(nope.status, 403);

  // person pays an AI agent
  const ah = await ctx.call("POST", "/v1/deals", { key: ann.key, body: { title: "code", amount: 50000, type: "ai-human", role: "buyer" } });
  assert.equal(ah.json.joinKind, "agent");
  assert.equal((await ctx.call("POST", "/v1/deals/join", { key: bot.apiKey, body: { inviteCode: ah.json.inviteCode } })).status, 200);
  await ctx.onboard(bot.apiKey);
  assert.equal((await ctx.call("POST", `/v1/deals/${ah.json.id}/fund`, { key: ann.key })).status, 200);
  ctx.fake.authorize(ctx.fake.lastIntent().id);
  await ctx.call("POST", `/v1/deals/${ah.json.id}/funded`, { key: ann.key, body: {} });
  const done = await ctx.call("POST", `/v1/deals/${ah.json.id}/release`, { key: ann.key, body: {} });
  assert.equal(done.json.state, "released");
  // The agent is paid by Stripe, and Valence's 1% came off the buyer's side.
  assert.ok(done.json.payment.sellerNet > 0);
  assert.equal(done.json.payment.platformFee, 500);
  const seen = await ctx.call("GET", `/v1/deals/${ah.json.id}`, { key: bot.apiKey });
  assert.deepEqual([seen.json.buyer.kind, seen.json.seller.kind].sort(), ["agent", "human"]);
}));

test("with no Stripe configured, the money routes say so instead of half working", () => withServer({ noStripe: true }, async (ctx) => {
  const a = await ctx.agent("a");
  const health = await ctx.call("GET", "/health");
  assert.equal(health.json.payments, "off");
  assert.equal((await ctx.call("GET", "/v1/payouts", { key: a.apiKey })).json.enabled, false);
  const r = await ctx.call("POST", "/v1/payouts/onboarding-link", { key: a.apiKey, body: {} });
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, "payments_off");
}));

test("the Stripe webhook endpoint refuses anything it cannot verify", () => withServer(async (ctx) => {
  const unsigned = await ctx.call("POST", "/v1/webhooks/stripe", { raw: '{"id":"evt_1"}', headers: { "Content-Type": "application/json" } });
  assert.equal(unsigned.status, 400);
  assert.equal(unsigned.json.error.code, "bad_signature");

  const event = { id: "evt_2", type: "account.updated", data: { object: { id: "acct_nope", charges_enabled: true, payouts_enabled: true, details_submitted: true } } };
  const wrong = ctx.fake.sign(event, { secret: "whsec_not_ours" });
  assert.equal((await ctx.call("POST", "/v1/webhooks/stripe", { raw: wrong.payload, headers: { "Stripe-Signature": wrong.header } })).status, 400);

  // A properly signed event is accepted, and answered immediately.
  const good = ctx.fake.sign(event);
  const ok = await ctx.call("POST", "/v1/webhooks/stripe", { raw: good.payload, headers: { "Stripe-Signature": good.header } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { received: true });
}));

test("refund rules, and a retried request doesn't act twice", () => withServer(async (ctx) => {
  const a = await ctx.agent("a");
  const b = await ctx.agent("b");
  await ctx.onboard(b.apiKey);

  const d = await ctx.call("POST", "/v1/deals", { key: a.apiKey, body: { title: "t", amount: 30000, deadlineHours: 2 } });
  await ctx.call("POST", "/v1/deals/join", { key: b.apiKey, body: { inviteCode: d.json.inviteCode } });

  const h = { "Idempotency-Key": "fund-1" };
  const one = await ctx.call("POST", `/v1/deals/${d.json.id}/fund`, { key: a.apiKey, headers: h });
  const two = await ctx.call("POST", `/v1/deals/${d.json.id}/fund`, { key: a.apiKey, headers: h });
  assert.equal(one.status, 200);
  assert.equal(two.headers.get("idempotent-replay"), "true");
  // One hold, however many times the button is pressed.
  assert.equal(ctx.fake.state.intents.size, 1);

  ctx.fake.authorize(ctx.fake.lastIntent().id);
  await ctx.call("POST", `/v1/deals/${d.json.id}/funded`, { key: a.apiKey, body: {} });

  const early = await ctx.call("POST", `/v1/deals/${d.json.id}/refund`, { key: a.apiKey, body: {} });
  assert.equal(early.json.error.code, "deadline_not_reached");
  ctx.clock.t += 3 * 3600 * 1000;
  const refunded = await ctx.call("POST", `/v1/deals/${d.json.id}/refund`, { key: a.apiKey, body: {} });
  assert.equal(refunded.json.state, "refunded");
  // Cancelling a hold is not a refund: nothing had settled.
  assert.equal(refunded.json.payment.status, "canceled");
  assert.equal(ctx.fake.state.refunds.length, 0);

  assert.equal((await ctx.call("POST", "/v1/deals", { key: a.apiKey, headers: { "Idempotency-Key": "k".repeat(65) }, body: { title: "t", amount: 5000 } })).status, 400);
}));

test("delivery, auto-release copy and the payments CSV", () => withServer(async (ctx) => {
  const buyer = await ctx.agent("buyer");
  const seller = await ctx.agent("seller");
  await ctx.onboard(seller.apiKey);
  const { id } = await ctx.fundedDeal({ buyerKey: buyer.apiKey, sellerKey: seller.apiKey, amount: 20000 });

  assert.equal((await ctx.call("POST", `/v1/deals/${id}/deliver`, { key: buyer.apiKey, body: {} })).status, 403);
  const delivered = await ctx.call("POST", `/v1/deals/${id}/deliver`, { key: seller.apiKey, body: { note: "Three files in the shared folder" } });
  assert.equal(delivered.json.state, "delivered");
  assert.equal(delivered.json.deliveryNote, "Three files in the shared folder");

  await ctx.call("POST", `/v1/deals/${id}/release`, { key: buyer.apiKey, body: {} });
  const csv = await ctx.call("GET", "/v1/payments.csv", { key: seller.apiKey });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.match(csv.headers.get("content-disposition"), /attachment; filename="valence-payments-/);
  assert.match(csv.text.split("\r\n")[0], /^"date","event","deal"/);
  assert.match(csv.text, /"paid_out"/);
}));

test("either side can dispute a funded deal, which freezes it", () => withServer(async (ctx) => {
  const buyer = await ctx.agent("buyer");
  const seller = await ctx.agent("seller");
  await ctx.onboard(seller.apiKey);
  const { id } = await ctx.fundedDeal({ buyerKey: buyer.apiKey, sellerKey: seller.apiKey, amount: 20000 });

  assert.equal((await ctx.call("POST", `/v1/deals/${id}/dispute`, { key: buyer.apiKey, body: { reason: "no" } })).status, 400);
  const d = await ctx.call("POST", `/v1/deals/${id}/dispute`, { key: buyer.apiKey, body: { reason: "The files never arrived and they've stopped replying." } });
  assert.equal(d.json.state, "disputed");
  assert.equal(d.json.dispute.kind, "internal");
  // A frozen deal can't be released around the dispute.
  assert.equal((await ctx.call("POST", `/v1/deals/${id}/release`, { key: buyer.apiKey, body: {} })).status, 409);
}));

test("outsiders can't see or touch a deal; wrong keys are rejected", () => withServer(async (ctx) => {
  const a = await ctx.agent("a");
  const b = await ctx.agent("b");
  const outsider = await ctx.agent("outsider");
  const d = await ctx.call("POST", "/v1/deals", { key: a.apiKey, body: { title: "t", amount: 5000 } });
  await ctx.call("POST", "/v1/deals/join", { key: b.apiKey, body: { inviteCode: d.json.inviteCode } });
  assert.equal((await ctx.call("GET", `/v1/deals/${d.json.id}`, { key: outsider.apiKey })).status, 404);
  assert.equal((await ctx.call("POST", `/v1/deals/${d.json.id}/cancel`, { key: outsider.apiKey })).status, 404);
  assert.equal((await ctx.call("POST", `/v1/deals/${d.json.id}/fund`, { key: b.apiKey })).status, 403);
  assert.equal((await ctx.call("GET", "/v1/me")).status, 401);
  assert.equal((await ctx.call("GET", "/v1/me", { key: "vlc_nope" })).status, 401);
  assert.equal((await ctx.call("GET", "/v1/deals")).status, 401);
}));

test("bad requests get clear errors", () => withServer(async (ctx) => {
  const a = await ctx.agent("a");
  const bad = (body) => ctx.call("POST", "/v1/deals", { key: a.apiKey, body });
  assert.equal((await bad({ title: "t", amount: 0 })).json.error.code, "invalid_amount");
  assert.equal((await bad({ title: "t", amount: "5000" })).json.error.code, "invalid_amount");
  assert.equal((await bad({ title: "", amount: 5000 })).json.error.code, "invalid_title");
  assert.equal((await bad({ title: "t", amount: 5000, type: "nope" })).json.error.code, "invalid_type");
  assert.equal((await ctx.call("POST", "/v1/agents/register", { body: {} })).json.error.code, "invalid_name");
  assert.equal((await ctx.call("POST", "/v1/agents/register", { body: "{not json" })).json.error.code, "invalid_json");
  assert.equal((await ctx.call("POST", "/v1/agents/register", { body: "[1,2]" })).json.error.code, "invalid_json");
  assert.equal((await ctx.call("POST", "/v1/agents/register", { raw: "name=x", headers: { "Content-Type": "text/plain" } })).status, 415);
  const huge = await ctx.call("POST", "/v1/agents/register", { body: JSON.stringify({ name: "x".repeat(20000) }) });
  assert.equal(huge.status, 413);
  assert.equal((await ctx.call("GET", "/v1/nothing", { key: a.apiKey })).status, 404);
  const wrongMethod = await ctx.call("DELETE", "/v1/me", { key: a.apiKey });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET");
}));

test("rate limits: registration, login and joins", async () => {
  await withServer({ registerLimit: 3 }, async (ctx) => {
    for (let i = 0; i < 3; i++) assert.equal((await ctx.call("POST", "/v1/agents/register", { body: { name: "n" + i } })).status, 201);
    const blocked = await ctx.call("POST", "/v1/agents/register", { body: { name: "n4" } });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get("retry-after"));
  });
  await withServer({ loginLimit: 3 }, async (ctx) => {
    await ctx.human("limited");
    for (let i = 0; i < 2; i++) assert.equal((await ctx.call("POST", "/v1/humans/login", { body: { username: "limited", password: "wrong-pass-1" } })).status, 401);
    assert.equal((await ctx.call("POST", "/v1/humans/login", { body: { username: "limited", password: "wrong-pass-2" } })).status, 401);
    assert.equal((await ctx.call("POST", "/v1/humans/login", { body: { username: "limited", password: "password-123" } })).status, 429);
  });
  await withServer({ joinLimit: 2 }, async (ctx) => {
    const a = await ctx.agent("a");
    const join = () => ctx.call("POST", "/v1/deals/join", { key: a.apiKey, body: { inviteCode: "AAAA-AAAA" } });
    assert.equal((await join()).status, 404);
    assert.equal((await join()).status, 404);
    assert.equal((await join()).status, 429);
  });
});

test("pages, security headers and no leaked secrets", () => withServer(async (ctx) => {
  for (const [path, needle] of [["/", "automated escrow"], ["/docs", "Idempotency-Key"], ["/login", "Don't have an account\\? <a href=\"/signup\""], ["/signup", "Already have an account\\? <a href=\"/login\""], ["/dashboard", "Active deals"], ["/deal", "Opening your deal"]]) {
    const r = await ctx.call("GET", path);
    assert.equal(r.status, 200, path);
    assert.match(r.text, new RegExp(needle), path);
    assert.match(r.headers.get("content-type"), /text\/html/);
  }
  const css = await ctx.call("GET", "/style.css");
  assert.match(css.headers.get("content-type"), /text\/css/);
  const js = await ctx.call("GET", "/app.js");
  assert.match(js.headers.get("content-type"), /javascript/);
  const home = await ctx.call("GET", "/");
  assert.equal(home.headers.get("x-content-type-options"), "nosniff");
  assert.equal(home.headers.get("x-frame-options"), "DENY");
  assert.match(home.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal((await ctx.call("GET", "/docs/")).status, 200); // trailing slash tolerated
  assert.equal((await ctx.call("GET", "/nope")).status, 404);
  assert.equal((await ctx.call("GET", "/../package.json")).status, 404);
  assert.equal((await ctx.call("GET", "/%2e%2e/package.json")).status, 404);
  assert.equal((await ctx.call("GET", "/src/store.js")).status, 404);
  assert.equal((await ctx.call("POST", "/docs", { body: {} })).status, 405);
  assert.equal(home.headers.get("x-powered-by"), null);
  // no inline scripts or styles anywhere, which is what the CSP relies on
  for (const p of ["/", "/docs", "/login", "/signup", "/dashboard"]) {
    const t0 = (await ctx.call("GET", p)).text;
    assert.ok(t0.includes('id="theme-toggle"'), p + " is missing the theme toggle");
    assert.ok(t0.indexOf('src="/theme.js"') < t0.indexOf("</head>"), p + " must load theme.js in <head>");
  }
  for (const p of ["/", "/docs", "/login", "/signup", "/dashboard", "/deal"]) {
    const t = (await ctx.call("GET", p)).text;
    assert.equal(/<script(?![^>]*\bsrc=)/i.test(t), false, p + " has an inline script");
    assert.equal(/<style/i.test(t), false, p + " has an inline style block");
    assert.equal(/\sstyle=/i.test(t), false, p + " has a style attribute");
  }
}));

test("an agent can hold at most 20 unfinished deals", () => withServer(async (ctx) => {
  const a = await ctx.agent("a");
  for (let i = 0; i < 20; i++) {
    assert.equal((await ctx.call("POST", "/v1/deals", { key: a.apiKey, body: { title: "d" + i, amount: 5000 } })).status, 201);
  }
  assert.equal((await ctx.call("POST", "/v1/deals", { key: a.apiKey, body: { title: "one too many", amount: 5000 } })).status, 429);
}));

test("extra domains redirect to valencemm.com, keeping the path and method", () => withServer(async (ctx) => {
  // fetch() refuses to set a custom Host header, so use the low-level http module.
  const http = require("http");
  const port = ctx.server.address().port;
  const hit = (host, path = "/", method = "GET") => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { Host: host } }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location }));
    });
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
  for (const host of ["ai-mm.org", "www.ai-mm.org", "WWW.AI-MM.ORG:443", "www.valencemm.com"]) {
    const r = await hit(host, "/docs?x=1");
    assert.equal(r.status, 308, host);
    assert.equal(r.location, "https://valencemm.com/docs?x=1", host);
  }
  assert.equal((await hit("ai-mm.org", "/v1/agents/register", "POST")).status, 308);
  // the main domain, the Cloud Run URL and lookalike names are served normally
  for (const host of ["valencemm.com", "valencemm-208222471840.us-central1.run.app", "evil-ai-mm.org", "ai-mm.org.evil.com"]) {
    assert.equal((await hit(host)).status, 200, host);
  }
}));

test("logo, icons, manifest and SEO files are served with the right types", () => withServer(async (ctx) => {
  const want = {
    "/favicon.ico": /image\/x-icon/, "/favicon.svg": /image\/svg\+xml/, "/logo.svg": /image\/svg\+xml/,
    "/apple-touch-icon.png": /image\/png/, "/icon-192.png": /image\/png/, "/icon-512.png": /image\/png/, "/og-image.png": /image\/png/,
    "/site.webmanifest": /application\/manifest\+json/, "/robots.txt": /text\/plain/, "/sitemap.xml": /application\/xml/, "/llms.txt": /text\/plain/,
  };
  for (const [path, type] of Object.entries(want)) {
    const r = await ctx.call("GET", path);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get("content-type"), type, path);
  }
  const png = await fetch(`http://127.0.0.1:${ctx.server.address().port}/og-image.png`);
  const bytes = Buffer.from(await png.arrayBuffer());
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  assert.match(png.headers.get("cache-control"), /max-age=86400/);
  assert.match((await ctx.call("GET", "/robots.txt")).text, /Sitemap: https:\/\/valencemm\.com\/sitemap\.xml/);
  assert.equal(JSON.parse((await ctx.call("GET", "/site.webmanifest")).text).name, "Valence MM");
  const home = (await ctx.call("GET", "/")).text;
  for (const tag of ['rel="icon"', 'rel="canonical" href="https://valencemm.com/"', 'property="og:image" content="https://valencemm.com/og-image.png?v=2"', 'name="twitter:card"', 'rel="manifest"']) {
    assert.ok(home.includes(tag), "home page missing " + tag);
  }
  assert.ok((await ctx.call("GET", "/dashboard")).text.includes('name="robots" content="noindex"'));
  assert.match((await ctx.call("GET", "/")).headers.get("content-security-policy"), /manifest-src 'self'/);
}));

test("vendored GSAP, Lenis and self-hosted fonts are served from our own origin", () => withServer(async (ctx) => {
  for (const path of ["/vendor/gsap.min.js", "/vendor/ScrollTrigger.min.js", "/vendor/lenis.min.js", "/vendor/qrcode.js", "/theme.js"]) {
    const r = await ctx.call("GET", path);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get("content-type"), /javascript/, path);
  }
  for (const path of ["/fonts/ibm-plex-sans-400.woff2", "/fonts/ibm-plex-sans-700.woff2", "/fonts/jetbrains-mono-500.woff"]) {
    const r = await ctx.call("GET", path);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get("content-type"), /font\/woff2?/, path);
  }
  assert.match((await ctx.call("GET", "/")).headers.get("content-security-policy"), /font-src 'self'/);
  // subfolder pages are not exposed without their extension, and folders aren't listed
  assert.equal((await ctx.call("GET", "/vendor")).status, 404);
  assert.equal((await ctx.call("GET", "/vendor/lenis.min")).status, 404);
}));
