// Two-factor helpers: authenticator-app codes (TOTP, RFC 6238), one-time codes and recovery codes.
// Works with Google Authenticator, Microsoft Authenticator, Authy, 1Password and similar apps.

const crypto = require("crypto");

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function newTotpSecret() {
  return base32Encode(crypto.randomBytes(20)); // 160-bit secret, the RFC's recommendation for SHA-1
}

function hotp(secretBuf, counter, digits = DIGITS) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac("sha1", secretBuf).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

function totpStep(ms) {
  return Math.floor(ms / 1000 / STEP_SECONDS);
}

function totpCode(secretB32, ms, digits = DIGITS) {
  return hotp(base32Decode(secretB32), totpStep(ms), digits);
}

const safeEqual = (a, b) => {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

// Accepts the current code or one step either side (phone clocks drift).
// Returns the matched step, or null. Steps at or before `lastStep` are refused, so a code can't be reused.
function verifyTotp(secretB32, code, ms, lastStep = -1) {
  const given = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(given)) return null;
  const secret = base32Decode(secretB32);
  const now = totpStep(ms);
  let match = null;
  for (const step of [now - 1, now, now + 1]) {
    if (safeEqual(hotp(secret, step), given) && step > lastStep && match === null) match = step;
  }
  return match;
}

function otpauthUrl({ secret, account, issuer = "Valence MM" }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// 6-digit code for email, with leading zeros kept.
function newNumericCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

// Recovery codes look like "k7m2-9xq4": easy to type, ~41 bits each.
const RC_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
function newRecoveryCodes(n = 10) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    let s = "";
    for (const b of crypto.randomBytes(8)) s += RC_ALPHABET[b % RC_ALPHABET.length];
    codes.push(`${s.slice(0, 4)}-${s.slice(4)}`);
  }
  return codes;
}
const normalizeRecovery = (code) => String(code || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const hashCode = (salt, code) => crypto.createHash("sha256").update(salt + ":" + code).digest("hex");

module.exports = {
  base32Encode, base32Decode, newTotpSecret, hotp, totpCode, verifyTotp, otpauthUrl,
  newNumericCode, newRecoveryCodes, normalizeRecovery, hashCode, safeEqual, STEP_SECONDS,
};
