// Abuse defences: proof-of-work on sign-up, reserved names, weak passwords, per-network quotas,
// the sign-up surge breaker, the login guard, the site-wide limit and the network helpers.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const { solve, createPow, leadingZeroBits } = require("../src/pow");
const { ipKey, clientIp } = require("../src/http");
const { reservedUsername, weakPassword } = require("../src/policy");

const BITS = 8; // tiny, so tests are fast; production uses 18

async function start(opts = {}) {
  const clock = { t: Date.parse("2026-10-20T00:00:00Z") };
  const server = createApp({ now: () => clock.t, skipTimers: true, powDifficulty: BITS, ...opts });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, path, { body, ip, key } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(ip ? { "X-Forwarded-For": ip } : {}),
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* page, not JSON */ }
    return { status: res.status, json, headers: res.headers };
  }
  async function puzzle(scope, ip) {
    const c = (await call("GET", `/v1/challenge?scope=${scope}`, { ip })).json;
    return { challenge: c.challenge, solution: solve(c.challenge, c.difficulty), difficulty: c.difficulty };
  }
  async function signup(username, { ip, password = "correct-horse-1" } = {}) {
    const p = await puzzle("signup", ip);
    return call("POST", "/v1/humans/signup", { ip, body: { username, password, challenge: p.challenge, solution: p.solution } });
  }
  const close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return { call, puzzle, signup, clock, server, close };
}

async function withServer(opts, fn) {
  if (typeof opts === "function") { fn = opts; opts = {}; }
  const ctx = await start(opts);
  try { await fn(ctx); } finally { await ctx.close(); }
}

test("sign-up needs a solved challenge, and each challenge works once", () => withServer(async (ctx) => {
  const bare = await ctx.call("POST", "/v1/humans/signup", { body: { username: "maya", password: "correct-horse-1" } });
  assert.equal(bare.status, 428);
  assert.equal(bare.json.error.code, "challenge_required");
  assert.equal(bare.json.error.scope, "signup");

  const c = await ctx.call("GET", "/v1/challenge?scope=signup");
  assert.equal(c.status, 200);
  assert.equal(c.json.difficulty, BITS);
  assert.equal(c.json.required, true);
  const solution = solve(c.json.challenge, c.json.difficulty);

  const ok = await ctx.call("POST", "/v1/humans/signup", { body: { username: "maya", password: "correct-horse-1", challenge: c.json.challenge, solution } });
  assert.equal(ok.status, 201);
  assert.ok(ok.json.token);

  const again = await ctx.call("POST", "/v1/humans/signup", { body: { username: "maya2", password: "correct-horse-1", challenge: c.json.challenge, solution } });
  assert.equal(again.json.error.code, "challenge_used");
}));

test("forged, mis-scoped, wrong and expired answers are refused", () => withServer(async (ctx) => {
  const p = await ctx.puzzle("signup");
  const send = (extra) => ctx.call("POST", "/v1/humans/signup", { body: { username: "nico", password: "correct-horse-1", ...extra } });

  const [payload, sig] = p.challenge.split(".");
  const forged = Buffer.from(JSON.stringify({ s: "signup", d: 0, e: ctx.clock.t + 1e6, r: "x" })).toString("base64url");
  assert.equal((await send({ challenge: `${forged}.${sig}`, solution: "0" })).json.error.code, "challenge_invalid");

  let wrong = 0;
  while (leadingZeroBits(require("crypto").createHash("sha256").update(`${p.challenge}:${wrong}`).digest()) >= BITS) wrong++;
  assert.equal((await send({ challenge: p.challenge, solution: String(wrong) })).json.error.code, "challenge_invalid");
  assert.equal((await send({ challenge: p.challenge, solution: "12; DROP" })).json.error.code, "challenge_invalid");

  const agentPuzzle = await ctx.puzzle("agent");
  assert.equal((await send({ challenge: agentPuzzle.challenge, solution: agentPuzzle.solution })).json.error.code, "challenge_invalid");

  ctx.clock.t += 6 * 60 * 1000;
  assert.equal((await send({ challenge: p.challenge, solution: p.solution })).json.error.code, "challenge_expired");
  assert.ok(payload); // the payload is opaque to clients; only its signature matters
}));

test("a taken or reserved name is refused before the challenge is spent", () => withServer(async (ctx) => {
  assert.equal((await ctx.signup("kai")).status, 201);
  const p = await ctx.puzzle("signup");
  const taken = await ctx.call("POST", "/v1/humans/signup", { body: { username: "kai", password: "correct-horse-1", challenge: p.challenge, solution: p.solution } });
  assert.equal(taken.json.error.code, "username_taken");
  const reserved = await ctx.call("POST", "/v1/humans/signup", { body: { username: "v4lence_supp0rt", password: "correct-horse-1", challenge: p.challenge, solution: p.solution } });
  assert.equal(reserved.json.error.code, "username_reserved");
  // The same solved challenge still works for a name that's free.
  const fine = await ctx.call("POST", "/v1/humans/signup", { body: { username: "kai_two", password: "correct-horse-1", challenge: p.challenge, solution: p.solution } });
  assert.equal(fine.status, 201);
}));

test("reserved and look-alike names, and easy passwords", () => {
  for (const name of ["admin", "support", "valence", "valencemm", "stripe", "the_admin", "adm1n", "supp0rt_team", "va1ence", "official_mia", "escrow_bot", "moderator1"]) {
    assert.equal(reservedUsername(name), true, `${name} should be reserved`);
  }
  for (const name of ["maya", "kai_two", "alice", "racer", "legacy", "ann_person", "design_lab", "mod_x9"]) {
    assert.equal(reservedUsername(name), false, `${name} should be allowed`);
  }
  for (const pw of ["password123", "PASSWORD1", "12345678", "qwertyuiop", "abcdefgh", "98765432", "zzzzzzzz"]) {
    assert.ok(weakPassword(pw, "someone"), `${pw} should be weak`);
  }
  assert.ok(weakPassword("maya", "maya"));
  assert.ok(weakPassword("maya2026", "maya"));
  assert.equal(weakPassword("correct-horse-1", "maya"), null);
  assert.equal(weakPassword("password-123", "alice"), null);
});

test("weak passwords are refused at sign-up and when changing password", () => withServer(async (ctx) => {
  const weak = await ctx.signup("tess", { password: "password123" });
  assert.equal(weak.json.error.code, "weak_password");
  const ok = await ctx.signup("tess");
  const changed = await ctx.call("POST", "/v1/humans/password", { key: ok.json.token, body: { currentPassword: "correct-horse-1", newPassword: "tess2026" } });
  assert.equal(changed.json.error.code, "weak_password");
}));

test("each network can only create so many accounts a day, but mistakes don't count", () => withServer({ signupDailyLimit: 2 }, async (ctx) => {
  const ip = "203.0.113.7";
  assert.equal((await ctx.signup("one_a", { ip })).status, 201);
  assert.equal((await ctx.signup("one_a", { ip })).json.error.code, "username_taken"); // doesn't use up the quota
  assert.equal((await ctx.signup("one_b", { ip })).status, 201);
  const third = await ctx.signup("one_c", { ip });
  assert.equal(third.status, 429);
  assert.equal(third.json.error.code, "signup_daily_limit");
  assert.ok(Number(third.headers.get("retry-after")) > 0);
  // Someone else on another network is unaffected.
  assert.equal((await ctx.signup("two_a", { ip: "198.51.100.9" })).status, 201);
}));

test("IPv6 users share one quota per /64, so rotating addresses doesn't help", () => withServer({ signupDailyLimit: 1 }, async (ctx) => {
  assert.equal((await ctx.signup("six_a", { ip: "2001:db8:abcd:12::1" })).status, 201);
  const rotated = await ctx.signup("six_b", { ip: "2001:db8:abcd:12:ffff:1:2:3" });
  assert.equal(rotated.json.error.code, "signup_daily_limit");
  assert.equal((await ctx.signup("six_c", { ip: "2001:db8:abcd:13::1" })).status, 201);
}));

test("a sign-up surge makes the puzzle harder, then pauses sign-ups", () => withServer({ surgeHarder: 2, surgeHardest: 4, surgePause: 5, signupDailyLimit: 100 }, async (ctx) => {
  const early = await ctx.puzzle("signup");
  assert.equal(early.difficulty, BITS);
  for (const n of ["s_one", "s_two"]) assert.equal((await ctx.signup(n)).status, 201);
  // Busy now: new puzzles are harder, and the easy one from earlier no longer counts.
  assert.equal((await ctx.puzzle("signup")).difficulty, BITS + 2);
  const stale = await ctx.call("POST", "/v1/humans/signup", { body: { username: "s_three", password: "correct-horse-1", challenge: early.challenge, solution: early.solution } });
  assert.equal(stale.json.error.code, "challenge_too_easy");
  for (const n of ["s_three", "s_four"]) assert.equal((await ctx.signup(n)).status, 201);
  assert.equal((await ctx.puzzle("signup")).difficulty, BITS + 4);
  assert.equal((await ctx.signup("s_five")).status, 201);
  const paused = await ctx.call("GET", "/v1/challenge?scope=signup");
  assert.equal(paused.status, 503);
  assert.equal(paused.json.error.code, "signups_paused");
  // Ten minutes later it's quiet again.
  ctx.clock.t += 11 * 60 * 1000;
  assert.equal((await ctx.puzzle("signup")).difficulty, BITS);
}));

test("the hidden honeypot field stops form-filling bots", () => withServer(async (ctx) => {
  const p = await ctx.puzzle("signup");
  const r = await ctx.call("POST", "/v1/humans/signup", { body: { username: "botty", password: "correct-horse-1", website: "http://spam.example", challenge: p.challenge, solution: p.solution } });
  assert.equal(r.json.error.code, "signup_refused");
}));

test("agents solve a challenge too", () => withServer(async (ctx) => {
  const bare = await ctx.call("POST", "/v1/agents/register", { body: { name: "helper" } });
  assert.equal(bare.json.error.code, "challenge_required");
  assert.equal((await ctx.call("POST", "/v1/agents/register", { body: {} })).json.error.code, "invalid_name");
  const p = await ctx.puzzle("agent");
  const ok = await ctx.call("POST", "/v1/agents/register", { body: { name: "helper", challenge: p.challenge, solution: p.solution } });
  assert.equal(ok.status, 201);
  assert.match(ok.json.apiKey, /^vlc_/);
}));

test("repeated wrong passwords make that username need a puzzle, then pause it", () => withServer({ loginPuzzleAfter: 3, loginLockAfter: 6 }, async (ctx) => {
  await ctx.signup("rosa");
  const login = (password, extra = {}) => ctx.call("POST", "/v1/humans/login", { body: { username: "rosa", password, ...extra } });
  for (let i = 0; i < 3; i++) assert.equal((await login("wrong-guess-" + i)).status, 401);
  const gated = await login("correct-horse-1");
  assert.equal(gated.status, 428);
  assert.equal(gated.json.error.code, "challenge_required");
  assert.equal(gated.json.error.scope, "login");

  // With a solved puzzle the real owner gets straight in, and that clears the count.
  let p = await ctx.puzzle("login");
  assert.equal((await login("correct-horse-1", p)).status, 200);
  assert.equal((await login("correct-horse-1")).status, 200);

  // A guesser keeps paying a puzzle per guess, and eventually the username pauses.
  for (let i = 0; i < 3; i++) await login("again-wrong-" + i);
  for (let i = 0; i < 3; i++) { p = await ctx.puzzle("login"); assert.equal((await login("still-wrong-" + i, p)).status, 401); }
  const paused = await login("correct-horse-1");
  assert.equal(paused.status, 429);
  assert.equal(paused.json.error.code, "login_paused");
  // Unknown usernames are treated exactly the same, so the guard can't be used to find accounts.
  for (let i = 0; i < 3; i++) await ctx.call("POST", "/v1/humans/login", { body: { username: "nobody_here", password: "x-wrong-" + i } });
  assert.equal((await ctx.call("POST", "/v1/humans/login", { body: { username: "nobody_here", password: "x" } })).json.error.code, "challenge_required");
  ctx.clock.t += 16 * 60 * 1000;
  assert.equal((await login("correct-horse-1")).status, 200);
}));

test("one address hammering the site is slowed down, pages included", () => withServer({ siteLimit: 3 }, async (ctx) => {
  for (let i = 0; i < 3; i++) assert.notEqual((await ctx.call("GET", "/", { ip: "192.0.2.50" })).status, 429);
  assert.equal((await ctx.call("GET", "/", { ip: "192.0.2.50" })).status, 429);
  assert.equal((await ctx.call("GET", "/v1/challenge?scope=signup", { ip: "192.0.2.50" })).json.error.code, "rate_limited");
  assert.notEqual((await ctx.call("GET", "/", { ip: "192.0.2.51" })).status, 429);
}));

test("responses carry the hardened security headers", () => withServer(async (ctx) => {
  const r = await ctx.call("GET", "/");
  assert.equal(r.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.match(r.headers.get("permissions-policy"), /camera=\(\)/);
  assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
}));

test("network helpers: IPv6 grouping and Cloudflare only when it's really Cloudflare", () => {
  assert.equal(ipKey("203.0.113.7"), "203.0.113.7");
  assert.equal(ipKey("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(ipKey("2001:db8:abcd:12::1"), "2001:db8:abcd:12::/64");
  assert.equal(ipKey("2001:0db8:abcd:0012:ffff:1:2:3"), "2001:db8:abcd:12::/64");
  assert.equal(ipKey("::1"), "0:0:0:0::/64");

  const req = (xff, cf) => ({ headers: { "x-forwarded-for": xff, ...(cf ? { "cf-connecting-ip": cf } : {}) }, socket: {} });
  const before = process.env.TRUST_CLOUDFLARE;
  try {
    delete process.env.TRUST_CLOUDFLARE;
    assert.equal(clientIp(req("1.2.3.4, 104.16.0.10", "9.9.9.9")), "104.16.0.10"); // off: header ignored
    process.env.TRUST_CLOUDFLARE = "1";
    assert.equal(clientIp(req("1.2.3.4, 104.16.0.10", "9.9.9.9")), "9.9.9.9");     // real Cloudflare edge
    assert.equal(clientIp(req("1.2.3.4, 8.8.8.8", "9.9.9.9")), "8.8.8.8");         // spoofed header, not Cloudflare
  } finally {
    if (before === undefined) delete process.env.TRUST_CLOUDFLARE; else process.env.TRUST_CLOUDFLARE = before;
  }
});

test("the puzzle engine itself", () => {
  const clock = { t: 1000 };
  const pow = createPow({ now: () => clock.t });
  const c = pow.issue("signup", 6);
  const s = solve(c.challenge, 6);
  pow.verify(c.challenge, s, "signup", 6);
  assert.throws(() => pow.verify(c.challenge, s, "signup", 6), /already used/);
  const d = pow.issue("signup", 6);
  assert.throws(() => pow.verify(d.challenge, solve(d.challenge, 6), "signup", 7), /harder challenge/);
  assert.throws(() => pow.verify(null, null, "signup", 6), /Solve a challenge/);
});
