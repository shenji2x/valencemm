// End-to-end tests: a real server on a random port, real HTTP requests.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const { parseTestCodes } = require("../src/store");

async function start(opts = {}) {
  const clock = { t: Date.parse("2026-10-17T00:00:00Z") };
  const server = createApp({ now: () => clock.t, ...opts });
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
  const close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return { call, agent, human, clock, server, close };
}

const balance = async (ctx, key) => (await ctx.call("GET", "/v1/me", { key })).json.balance;

async function withServer(opts, fn) {
  if (typeof opts === "function") { fn = opts; opts = {}; }
  const ctx = await start(opts);
  try { await fn(ctx); } finally { await ctx.close(); }
}

test("AI to AI deal over HTTP, end to end", () => withServer(async (ctx) => {
  const buyer = await ctx.agent("buyer-bot");
  const seller = await ctx.agent("seller-bot");
  assert.match(buyer.apiKey, /^vlc_[0-9a-f]{48}$/);
  assert.equal(buyer.balance, 100);

  const d = await ctx.call("POST", "/v1/deals", { key: buyer.apiKey, body: { title: "Job", amount: 100, type: "ai-ai" } });
  assert.equal(d.status, 201);
  assert.equal(d.json.type, "ai-ai");
  const j = await ctx.call("POST", "/v1/deals/join", { key: seller.apiKey, body: { inviteCode: d.json.inviteCode } });
  assert.equal(j.status, 200);
  assert.equal((await ctx.call("POST", `/v1/deals/${d.json.id}/fund`, { key: buyer.apiKey })).json.state, "funded");
  assert.equal(await balance(ctx, buyer.apiKey), 0);
  const r = await ctx.call("POST", `/v1/deals/${d.json.id}/release`, { key: buyer.apiKey });
  assert.equal(r.json.state, "released");
  assert.equal(await balance(ctx, seller.apiKey), 199); // 100 + 100 - 1% fee
  assert.equal((await ctx.call("GET", "/health")).json.ledger, "balanced");
}));

test("people: signup, login, session token works like an API key, logout ends it", () => withServer(async (ctx) => {
  const s = await ctx.human("Ann_Person");
  assert.match(s.token, /^vls_[0-9a-f]{48}$/);
  assert.equal(s.account.kind, "human");
  assert.equal(s.account.name, "ann_person");
  assert.equal((await ctx.call("GET", "/v1/me", { key: s.token })).json.balance, 100);

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

test("human to human and AI and human deals respect account types", () => withServer(async (ctx) => {
  const ann = await human("ann");
  async function human(name) { const r = await ctx.human(name); return { key: r.token }; }
  const bob = await human("bob");
  const bot = await ctx.agent("bot");

  const hh = await ctx.call("POST", "/v1/deals", { key: ann.key, body: { title: "swap", amount: 10, type: "human-human" } });
  assert.equal(hh.status, 201);
  const botJoin = await ctx.call("POST", "/v1/deals/join", { key: bot.apiKey, body: { inviteCode: hh.json.inviteCode } });
  assert.equal(botJoin.status, 403);
  assert.equal(botJoin.json.error.code, "wrong_account_type");
  assert.equal((await ctx.call("POST", "/v1/deals/join", { key: bob.key, body: { inviteCode: hh.json.inviteCode } })).status, 200);

  const nope = await ctx.call("POST", "/v1/deals", { key: ann.key, body: { title: "x", amount: 5, type: "ai-ai" } });
  assert.equal(nope.status, 403);

  // person pays an AI agent
  const ah = await ctx.call("POST", "/v1/deals", { key: ann.key, body: { title: "code", amount: 50, type: "ai-human", role: "buyer" } });
  assert.equal(ah.json.joinKind, "agent");
  assert.equal((await ctx.call("POST", "/v1/deals/join", { key: bot.apiKey, body: { inviteCode: ah.json.inviteCode } })).status, 200);
  assert.equal((await ctx.call("POST", `/v1/deals/${ah.json.id}/fund`, { key: ann.key })).status, 200);
  assert.equal((await ctx.call("POST", `/v1/deals/${ah.json.id}/release`, { key: ann.key })).status, 200);
  assert.equal(await balance(ctx, bot.apiKey), 150);
  const seen = await ctx.call("GET", `/v1/deals/${ah.json.id}`, { key: bot.apiKey });
  assert.deepEqual([seen.json.buyer.kind, seen.json.seller.kind].sort(), ["agent", "human"]);
}));

test("test credits: off by default, on with a code from the environment", async () => {
  await withServer(async (ctx) => {
    const a = await ctx.agent("a");
    const r = await ctx.call("POST", "/v1/credits/redeem", { key: a.apiKey, body: { code: "whatever-code" } });
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, "redeem_disabled");
    assert.equal((await ctx.call("GET", "/health")).json.testCredits, false);
  });
  await withServer({ testCodes: parseTestCodes("secret-test-code=250") }, async (ctx) => {
    const p = await ctx.human("tester");
    assert.equal((await ctx.call("GET", "/health")).json.testCredits, true);
    const bad = await ctx.call("POST", "/v1/credits/redeem", { key: p.token, body: { code: "wrong-code-1" } });
    assert.equal(bad.status, 400);
    const ok = await ctx.call("POST", "/v1/credits/redeem", { key: p.token, body: { code: "secret-test-code" } });
    assert.deepEqual(ok.json, { added: 250, balance: 350 });
    assert.equal((await ctx.call("POST", "/v1/credits/redeem", { body: { code: "secret-test-code" } })).status, 401);
    assert.equal((await ctx.call("GET", "/health")).json.ledger, "balanced");
    assert.equal((await ctx.call("GET", "/health")).text.includes("secret-test-code"), false);
  });
});

test("refund rules and idempotency keys", () => withServer(async (ctx) => {
  const a = await ctx.agent("a");
  const b = await ctx.agent("b");
  const d = await ctx.call("POST", "/v1/deals", { key: a.apiKey, body: { title: "t", amount: 30, deadlineHours: 2 } });
  await ctx.call("POST", "/v1/deals/join", { key: b.apiKey, body: { inviteCode: d.json.inviteCode } });
  const h = { "Idempotency-Key": "fund-1" };
  const one = await ctx.call("POST", `/v1/deals/${d.json.id}/fund`, { key: a.apiKey, headers: h });
  const two = await ctx.call("POST", `/v1/deals/${d.json.id}/fund`, { key: a.apiKey, headers: h });
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.equal(two.headers.get("idempotent-replay"), "true");
  assert.equal(await balance(ctx, a.apiKey), 70);
  assert.equal((await ctx.call("POST", `/v1/deals/${d.json.id}/fund`, { key: a.apiKey })).status, 409);

  const early = await ctx.call("POST", `/v1/deals/${d.json.id}/refund`, { key: a.apiKey });
  assert.equal(early.json.error.code, "deadline_not_reached");
  ctx.clock.t += 3 * 3600 * 1000;
  assert.equal((await ctx.call("POST", `/v1/deals/${d.json.id}/refund`, { key: a.apiKey })).json.state, "refunded");
  assert.equal(await balance(ctx, a.apiKey), 100);
  assert.equal((await ctx.call("POST", "/v1/deals", { key: a.apiKey, headers: { "Idempotency-Key": "k".repeat(65) }, body: { title: "t", amount: 1 } })).status, 400);
}));

test("outsiders can't see or touch a deal; wrong keys are rejected", () => withServer(async (ctx) => {
  const a = await ctx.agent("a");
  const b = await ctx.agent("b");
  const outsider = await ctx.agent("outsider");
  const d = await ctx.call("POST", "/v1/deals", { key: a.apiKey, body: { title: "t", amount: 5 } });
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
  assert.equal((await bad({ title: "t", amount: "5" })).json.error.code, "invalid_amount");
  assert.equal((await bad({ title: "", amount: 5 })).json.error.code, "invalid_title");
  assert.equal((await bad({ title: "t", amount: 5, type: "nope" })).json.error.code, "invalid_type");
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
    assert.equal((await ctx.call("POST", "/v1/deals", { key: a.apiKey, body: { title: "d" + i, amount: 1 } })).status, 201);
  }
  assert.equal((await ctx.call("POST", "/v1/deals", { key: a.apiKey, body: { title: "one too many", amount: 1 } })).status, 429);
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
  for (const tag of ['rel="icon"', 'rel="canonical" href="https://valencemm.com/"', 'property="og:image" content="https://valencemm.com/og-image.png"', 'name="twitter:card"', 'rel="manifest"']) {
    assert.ok(home.includes(tag), "home page missing " + tag);
  }
  assert.ok((await ctx.call("GET", "/dashboard")).text.includes('name="robots" content="noindex"'));
  assert.match((await ctx.call("GET", "/")).headers.get("content-security-policy"), /manifest-src 'self'/);
}));

test("vendored GSAP, Lenis and self-hosted fonts are served from our own origin", () => withServer(async (ctx) => {
  for (const path of ["/vendor/gsap.min.js", "/vendor/ScrollTrigger.min.js", "/vendor/lenis.min.js", "/theme.js"]) {
    const r = await ctx.call("GET", path);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get("content-type"), /javascript/, path);
  }
  for (const path of ["/fonts/inter-400.woff", "/fonts/inter-display-700.woff", "/fonts/ibm-plex-mono-400.woff"]) {
    const r = await ctx.call("GET", path);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get("content-type"), /font\/woff/, path);
  }
  assert.match((await ctx.call("GET", "/")).headers.get("content-security-policy"), /font-src 'self'/);
  // subfolder pages are not exposed without their extension, and folders aren't listed
  assert.equal((await ctx.call("GET", "/vendor")).status, 404);
  assert.equal((await ctx.call("GET", "/vendor/lenis.min")).status, 404);
}));
