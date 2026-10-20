// Proof-of-work challenges ("hashcash"), used to make scripted sign-ups and password guessing expensive.
//
// The server hands out a signed, single-use challenge. The client has to find a number n such that
// SHA-256(challenge + ":" + n) starts with `difficulty` zero bits. A person's browser does that in about
// a second, once. A script claiming hundreds of usernames has to pay it hundreds of times, on top of
// the per-IP caps. Nothing is stored until a challenge is redeemed, and redeemed ones are remembered
// only until they would have expired anyway.
//
// No third-party CAPTCHA: nothing leaves this server, it works for AI agents calling the API, and it
// fits the site's CSP (no outside scripts beyond Stripe).
const crypto = require("crypto");
const { ApiError } = require("./errors");

const TTL_MS = 5 * 60 * 1000;
const MAX_USED = 50000;

function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

function hashOf(challenge, solution) {
  return crypto.createHash("sha256").update(`${challenge}:${solution}`).digest();
}

// For tests and for AI agents written in Node: finds a valid solution.
function solve(challenge, difficulty) {
  for (let n = 0; ; n++) {
    if (leadingZeroBits(hashOf(challenge, n)) >= difficulty) return String(n);
  }
}

function createPow({ secret = crypto.randomBytes(32), now = () => Date.now(), ttlMs = TTL_MS } = {}) {
  const used = new Map(); // signature -> expiry (insertion-ordered, so the oldest come first)

  const sign = (payload) => crypto.createHmac("sha256", secret).update(payload).digest("base64url");

  function issue(scope, difficulty) {
    const payload = Buffer.from(JSON.stringify({
      s: scope, d: difficulty, e: now() + ttlMs, r: crypto.randomBytes(12).toString("base64url"),
    })).toString("base64url");
    return { challenge: `${payload}.${sign(payload)}`, difficulty, algorithm: "SHA-256", expiresInSeconds: Math.round(ttlMs / 1000) };
  }

  function forget() {
    const t = now();
    for (const [k, exp] of used) if (exp <= t) used.delete(k);
    // Still huge (a flood of valid solutions)? Drop the oldest; they are close to expiry anyway.
    if (used.size > MAX_USED) {
      let extra = used.size - MAX_USED;
      for (const k of used.keys()) { if (extra-- <= 0) break; used.delete(k); }
    }
  }

  // Throws unless `solution` solves an unexpired, unused challenge for this scope that is at least
  // as hard as `minDifficulty` (so an easy challenge from a quiet moment can't be spent in a busy one).
  function verify(challenge, solution, scope, minDifficulty) {
    if (challenge == null || solution == null || challenge === "" || solution === "") {
      const err = new ApiError(428, "challenge_required", "Solve a challenge first: GET /v1/challenge?scope=" + scope);
      err.extra = { scope, difficulty: minDifficulty };
      throw err;
    }
    const bad = (code = "challenge_invalid", msg = "That challenge answer isn't valid. Get a new challenge and try again.") => new ApiError(400, code, msg);
    if (typeof challenge !== "string" || challenge.length > 400) throw bad();
    if (!/^\d{1,16}$/.test(String(solution))) throw bad();
    const dot = challenge.indexOf(".");
    if (dot < 1) throw bad();
    const payload = challenge.slice(0, dot);
    const sig = challenge.slice(dot + 1);
    const expected = sign(payload);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw bad();
    let data;
    try { data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw bad(); }
    if (data.s !== scope) throw bad();
    if (!(data.e > now())) throw bad("challenge_expired", "That challenge expired. Get a new one and try again.");
    if (!(data.d >= minDifficulty)) throw bad("challenge_too_easy", "Sign-ups are busier now, so a harder challenge is needed. Get a new one.");
    if (used.has(sig)) throw bad("challenge_used", "That challenge was already used. Get a new one.");
    if (leadingZeroBits(hashOf(challenge, String(solution))) < data.d) throw bad();
    used.set(sig, data.e);
    if (used.size > 1000) forget();
  }

  return { issue, verify, size: () => used.size };
}

module.exports = { createPow, solve, leadingZeroBits };
