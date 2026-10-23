// Two-factor sign-in: authenticator app (TOTP), email codes, recovery codes, email verification.
const test = require("node:test");
const assert = require("node:assert/strict");
const sec = require("../src/security");
const { createApp } = require("../src/app");
const { fileBackend } = require("../src/persist");
const fs = require("fs");
const os = require("os");
const path = require("path");

test("TOTP matches the RFC 6238 test vectors and the base32 round trip", () => {
  const secret = sec.base32Encode(Buffer.from("12345678901234567890"));
  assert.equal(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  // RFC 6238 appendix B (SHA-1), 8 digits
  assert.equal(sec.totpCode(secret, 59 * 1000, 8), "94287082");
  assert.equal(sec.totpCode(secret, 1111111109 * 1000, 8), "07081804");
  assert.equal(sec.totpCode(secret, 1234567890 * 1000, 8), "89005924");
  assert.equal(sec.totpCode(secret, 20000000000 * 1000, 8), "65353130");
  assert.deepEqual(sec.base32Decode(secret), Buffer.from("12345678901234567890"));
  // window of one step either side, and no reuse
  const t = 1_800_000_000_000;
  const now = sec.totpCode(secret, t);
  const step = sec.verifyTotp(secret, now, t);
  assert.notEqual(step, null);
  assert.equal(sec.verifyTotp(secret, now, t, step), null, "same code can't be used twice");
  assert.notEqual(sec.verifyTotp(secret, sec.totpCode(secret, t - 30000), t), null);
  assert.equal(sec.verifyTotp(secret, sec.totpCode(secret, t - 90000), t), null);
  assert.equal(sec.verifyTotp(secret, "12345", t), null);
  assert.match(sec.otpauthUrl({ secret, account: "alice" }), /^otpauth:\/\/totp\/Valence%20MM%3Aalice\?secret=GEZ.*&issuer=Valence%20MM/);
  const codes = sec.newRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.match(codes[0], /^[a-z2-9]{4}-[a-z2-9]{4}$/);
});

function fakeMailer() {
  const sent = [];
  return { sent, mailer: { enabled: true, kind: "test", async send(m) { sent.push(m); } }, lastCode: () => sent[sent.length - 1].subject.slice(0, 6) };
}

async function start(opts = {}) {
  const clock = { t: Date.parse("2026-10-19T00:00:00Z") };
  const server = createApp({ now: () => clock.t, loginLimit: 1000, powDifficulty: 0, ...opts });
  await server.ready;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, p, { key, body } = {}) {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, headers: res.headers };
  }
  const close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return { server, call, clock, close };
}
async function withServer(opts, fn) {
  const ctx = await start(opts);
  try { await fn(ctx); } finally { await ctx.close(); }
}
const login = (ctx, u = "alice", p = "password-123") => ctx.call("POST", "/v1/humans/login", { body: { username: u, password: p } });

test("authenticator app: set up with a code, then sign-in needs a code; recovery codes work once", async () => {
  await withServer({}, async (ctx) => {
    const { token } = (await ctx.call("POST", "/v1/humans/signup", { body: { username: "alice", password: "password-123" } })).json;
    let s = (await ctx.call("GET", "/v1/account/security", { key: token })).json;
    assert.deepEqual(s.twoFactor, { app: false, email: false, recoveryCodesLeft: 0 });

    const setup = (await ctx.call("POST", "/v1/account/2fa/app/setup", { key: token })).json;
    assert.match(setup.secret, /^[A-Z2-7]{32}$/);
    assert.match(setup.otpauthUrl, /^otpauth:\/\/totp\//);
    const wrong = await ctx.call("POST", "/v1/account/2fa/app/enable", { key: token, body: { code: "000000" } });
    assert.equal(wrong.status, 401);
    const on = await ctx.call("POST", "/v1/account/2fa/app/enable", { key: token, body: { code: sec.totpCode(setup.secret, ctx.clock.t) } });
    assert.equal(on.status, 200);
    assert.equal(on.json.twoFactor.app, true);
    assert.equal(on.json.recoveryCodes.length, 10);
    assert.equal(on.json.twoFactor.recoveryCodesLeft, 10, "the summary counts the new codes");
    const recovery = on.json.recoveryCodes;
    assert.equal((await ctx.call("GET", "/v1/me", { key: token })).json.security.twoFactor.recoveryCodesLeft, 10);
    assert.equal((await ctx.call("GET", "/v1/me", { key: token })).json.security.secret, undefined);

    // password alone no longer signs in
    const step1 = (await login(ctx)).json;
    assert.equal(step1.twoFactorRequired, true);
    assert.equal(step1.token, undefined);
    assert.deepEqual(step1.methods, ["app", "recovery"]);
    assert.equal((await ctx.call("POST", "/v1/humans/login/verify", { body: { challenge: step1.challenge, method: "app", code: "123456" } })).status, 401);
    ctx.clock.t += 31_000; // next 30-second window
    const done = await ctx.call("POST", "/v1/humans/login/verify", { body: { challenge: step1.challenge, method: "app", code: sec.totpCode(setup.secret, ctx.clock.t) } });
    assert.equal(done.status, 200);
    assert.match(done.json.token, /^vls_/);
    assert.equal((await ctx.call("POST", "/v1/humans/login/verify", { body: { challenge: step1.challenge, method: "app", code: "000000" } })).status, 401, "challenge is single use");

    // the same code can't be replayed on a new login
    const again = (await login(ctx)).json;
    assert.equal((await ctx.call("POST", "/v1/humans/login/verify", { body: { challenge: again.challenge, method: "app", code: sec.totpCode(setup.secret, ctx.clock.t) } })).status, 401);
    // recovery code works, once
    const viaRecovery = await ctx.call("POST", "/v1/humans/login/verify", { body: { challenge: again.challenge, method: "recovery", code: recovery[0].toUpperCase() } });
    assert.equal(viaRecovery.status, 200);
    assert.equal(viaRecovery.json.recoveryCodesLeft, 9);
    const third = (await login(ctx)).json;
    assert.equal((await ctx.call("POST", "/v1/humans/login/verify", { body: { challenge: third.challenge, method: "recovery", code: recovery[0] } })).status, 401);

    // five wrong guesses and the challenge is gone
    for (let i = 0; i < 4; i++) await ctx.call("POST", "/v1/humans/login/verify", { body: { challenge: third.challenge, method: "app", code: "000000" } });
    assert.equal((await ctx.call("POST", "/v1/humans/login/verify", { body: { challenge: third.challenge, method: "app", code: "000000" } })).status, 429);

    // challenges expire after 10 minutes
    const late = (await login(ctx)).json;
    ctx.clock.t += 11 * 60_000;
    assert.equal((await ctx.call("POST", "/v1/humans/login/verify", { body: { challenge: late.challenge, method: "recovery", code: recovery[1] } })).status, 401);

    // turning it off needs the password
    const t2 = done.json.token;
    assert.equal((await ctx.call("POST", "/v1/account/2fa/app/disable", { key: t2, body: { password: "nope-nope" } })).status, 401);
    const off = await ctx.call("POST", "/v1/account/2fa/app/disable", { key: t2, body: { password: "password-123" } });
    assert.deepEqual(off.json.twoFactor, { app: false, email: false, recoveryCodesLeft: 0 });
    assert.match((await login(ctx)).json.token, /^vls_/);
  });
});

test("email: verify an address with a code, then use email codes to sign in", async () => {
  const m = fakeMailer();
  await withServer({ mailer: m.mailer, emailLimit: 1000 }, async (ctx) => {
    const { token } = (await ctx.call("POST", "/v1/humans/signup", { body: { username: "alice", password: "password-123" } })).json;
    const sec0 = (await ctx.call("GET", "/v1/account/security", { key: token })).json;
    assert.equal(sec0.emailAvailable, true);
    assert.equal(sec0.discordLinking, false, "no bot set up in this test");
    assert.equal((await ctx.call("POST", "/v1/account/email", { key: token, body: { email: "not-an-email" } })).status, 400);
    const add = await ctx.call("POST", "/v1/account/email", { key: token, body: { email: "Alice@Example.com" } });
    assert.equal(add.status, 200);
    assert.equal(add.json.pendingEmail, "alice@example.com");
    assert.equal(add.json.code, undefined, "the code is only ever emailed");
    assert.equal(m.sent[0].to, "alice@example.com");
    assert.match(m.sent[0].text, /\d{6}/);
    assert.equal((await ctx.call("POST", "/v1/account/email", { key: token, body: { email: "alice@example.com" } })).status, 429, "no instant resend");
    assert.equal((await ctx.call("POST", "/v1/account/2fa/email", { key: token, body: { enable: true, password: "password-123" } })).status, 400, "must verify first");
    assert.equal((await ctx.call("POST", "/v1/account/email/verify", { key: token, body: { code: "000000" } })).status, 401);
    const ok = await ctx.call("POST", "/v1/account/email/verify", { key: token, body: { code: m.lastCode() } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.email, "alice@example.com");
    assert.equal(ok.json.emailVerified, true);

    // nobody else can claim a verified address
    const bob = (await ctx.call("POST", "/v1/humans/signup", { body: { username: "bob", password: "password-123" } })).json;
    assert.equal((await ctx.call("POST", "/v1/account/email", { key: bob.token, body: { email: "alice@example.com" } })).status, 409);

    const on = await ctx.call("POST", "/v1/account/2fa/email", { key: token, body: { enable: true, password: "password-123" } });
    assert.equal(on.json.twoFactor.email, true);
    assert.equal(on.json.recoveryCodes.length, 10);

    const step1 = (await login(ctx)).json;
    assert.deepEqual(step1.methods, ["email", "recovery"]);
    assert.equal(step1.emailHint, "al***@example.com");
    const send = await ctx.call("POST", "/v1/humans/login/email-code", { body: { challenge: step1.challenge } });
    assert.equal(send.status, 200);
    assert.match(m.sent[m.sent.length - 1].subject, /sign-in code/);
    const done = await ctx.call("POST", "/v1/humans/login/verify", { body: { challenge: step1.challenge, method: "email", code: m.lastCode() } });
    assert.equal(done.status, 200);
    assert.match(done.json.token, /^vls_/);

    // expired email code
    const s2 = (await login(ctx)).json;
    await ctx.call("POST", "/v1/humans/login/email-code", { body: { challenge: s2.challenge } });
    const code = m.lastCode();
    ctx.clock.t += 9 * 60_000;
    const s3 = await ctx.call("POST", "/v1/humans/login/verify", { body: { challenge: s2.challenge, method: "email", code: "999999" } });
    assert.equal(s3.status, 401);
    ctx.clock.t += 2 * 60_000;
    assert.equal((await ctx.call("POST", "/v1/humans/login/verify", { body: { challenge: s2.challenge, method: "email", code } })).status, 401, "whole challenge expired");

    // new recovery codes need the password and replace the old set
    const t = done.json.token;
    const fresh = await ctx.call("POST", "/v1/account/2fa/recovery-codes", { key: t, body: { password: "password-123" } });
    assert.equal(fresh.json.recoveryCodes.length, 10);
    assert.equal(fresh.json.twoFactor.recoveryCodesLeft, 10);
    // removing the email turns email codes off
    const removed = await ctx.call("POST", "/v1/account/email/remove", { key: t, body: { password: "password-123" } });
    assert.equal(removed.json.email, null);
    assert.equal(removed.json.twoFactor.email, false);
    assert.match((await login(ctx)).json.token, /^vls_/);
  });
});

test("email sends are limited to five requests per 12 hours per IP", async () => {
  const m = fakeMailer();
  await withServer({ mailer: m.mailer }, async (ctx) => {
    const { token } = (await ctx.call("POST", "/v1/humans/signup", { body: { username: "limitedemail", password: "password-123" } })).json;
    for (let i = 0; i < 5; i++) {
      const sent = await ctx.call("POST", "/v1/account/email", { key: token, body: { email: `user${i}@example.com` } });
      assert.equal(sent.status, 200, `send ${i + 1} should be allowed`);
    }
    const blocked = await ctx.call("POST", "/v1/account/email", { key: token, body: { email: "user5@example.com" } });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json.error.code, "email_rate_limited");
    const retryAfter = Number(blocked.headers.get("retry-after"));
    assert.ok(retryAfter >= 43190 && retryAfter <= 43200, `expected a 12-hour retry window, got ${retryAfter}s`);
  });
});

test("email features say so clearly when email isn't set up, and agents can't use them", async () => {
  await withServer({}, async (ctx) => {
    const { token } = (await ctx.call("POST", "/v1/humans/signup", { body: { username: "carol", password: "password-123" } })).json;
    assert.equal((await ctx.call("GET", "/v1/account/security", { key: token })).json.emailAvailable, false);
    const r = await ctx.call("POST", "/v1/account/email", { key: token, body: { email: "c@example.com" } });
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, "email_unavailable");
    const agent = (await ctx.call("POST", "/v1/agents/register", { body: { name: "bot" } })).json;
    assert.equal((await ctx.call("POST", "/v1/account/2fa/app/setup", { key: agent.apiKey })).status, 403);
    assert.equal((await ctx.call("GET", "/v1/me", { key: agent.apiKey })).json.security, undefined);
  });
});

test("two-factor settings survive a restart", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "valence-")), "state.json");
  let secret;
  await withServer({ backend: fileBackend(file) }, async (ctx) => {
    const { token } = (await ctx.call("POST", "/v1/humans/signup", { body: { username: "dana", password: "password-123" } })).json;
    secret = (await ctx.call("POST", "/v1/account/2fa/app/setup", { key: token })).json.secret;
    await ctx.call("POST", "/v1/account/2fa/app/enable", { key: token, body: { code: sec.totpCode(secret, ctx.clock.t) } });
  });
  await withServer({ backend: fileBackend(file) }, async (ctx) => {
    ctx.clock.t += 60_000;
    const step1 = (await login(ctx, "dana")).json;
    assert.equal(step1.twoFactorRequired, true);
    const done = await ctx.call("POST", "/v1/humans/login/verify", { body: { challenge: step1.challenge, method: "app", code: sec.totpCode(secret, ctx.clock.t) } });
    assert.equal(done.status, 200);
  });
});

