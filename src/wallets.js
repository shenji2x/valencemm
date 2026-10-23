// Crypto wallets and address checks.
//
// Deposits for crypto deals go to the owner's wallets below. The server only ever knows these
// public addresses: it can see money arrive, but it holds no private keys, so it cannot send
// anything. Payouts are sent by the owner by hand (see crypto-escrow.js).
//
// Every address that money is sent to is checked here first: the owner's, every seller's payout
// address and every buyer's refund address. Bitcoin, Litecoin and Ethereum addresses carry a
// checksum, so a mistyped character is caught instead of sending funds into nowhere.
const crypto = require("crypto");

const DEFAULT_WALLETS = {
  BTC: "bc1qrq87dzf6z7y5w9vz9hj5aqgjvseuk7xzl99cfp",
  LTC: "LSUUnp7qm1CpyzQoT89figXNYtpLiBySNN",
  ETH: "0x8c4951021512b45d86D0a17604C601A768204550",
  SOL: "EKmnULtPoQx5MxHszM8ZcfyVvgkHQC1feKNJNsfJiWKB",
};

// ---------- base58 ----------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (n === 0n) hex = "";
  if (hex.length % 2) hex = "0" + hex;
  const zeros = s.length - s.replace(/^1+/, "").length;
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, "hex")]);
}
const sha256d = (b) => crypto.createHash("sha256").update(crypto.createHash("sha256").update(b).digest()).digest();
function base58check(s) {
  const raw = b58decode(s);
  if (!raw || raw.length < 5) return null;
  const body = raw.subarray(0, -4);
  return sha256d(body).subarray(0, 4).equals(raw.subarray(-4)) ? body : null;
}

// ---------- bech32 / bech32m (BIP 173 / 350) ----------
const CS = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= G[i];
  }
  return chk >>> 0;
}
function segwit(addr, hrp) {
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return false;
  const a = addr.toLowerCase();
  if (!a.startsWith(hrp + "1") || a.length > 90) return false;
  const data = [...a.slice(hrp.length + 1)].map((c) => CS.indexOf(c));
  if (data.length < 7 || data.some((d) => d < 0)) return false;
  const expand = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const pm = polymod(expand.concat(data));
  const version = data[0];
  if (version === 0 ? pm !== 1 : pm !== 0x2bc830a3) return false; // v0 uses bech32, v1+ bech32m
  const progBits = (data.length - 7) * 5;
  const progLen = Math.floor(progBits / 8);
  if (progLen < 2 || progLen > 40) return false;
  if (version === 0 && progLen !== 20 && progLen !== 32) return false;
  return version <= 16;
}

// ---------- keccak-256 (Ethereum's checksum hash; not the NIST SHA3) ----------
const RC = [0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
const ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
const M64 = (1n << 64n) - 1n;
const rol = (x, n) => (n ? ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64 : x);
function keccak256(input) {
  const rate = 136;
  const p = Buffer.concat([Buffer.from(input), Buffer.from([0x01])]);
  const padded = Buffer.concat([p, Buffer.alloc((rate - (p.length % rate)) % rate)]);
  padded[padded.length - 1] |= 0x80;
  let A = Array.from({ length: 5 }, () => Array(5).fill(0n));
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) A[i % 5][Math.floor(i / 5)] ^= padded.readBigUInt64LE(off + 8 * i);
    for (const rc of RC) {
      const C = A.map((col) => col[0] ^ col[1] ^ col[2] ^ col[3] ^ col[4]);
      const D = C.map((_, x) => C[(x + 4) % 5] ^ rol(C[(x + 1) % 5], 1));
      A = A.map((col, x) => col.map((v) => v ^ D[x]));
      const B = Array.from({ length: 5 }, () => Array(5).fill(0n));
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y][(2 * x + 3 * y) % 5] = rol(A[x][y], ROT[x][y]);
      A = B.map((col, x) => col.map((v, y) => v ^ (~B[(x + 1) % 5][y] & M64 & B[(x + 2) % 5][y])));
      A[0][0] ^= rc;
    }
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(A[i % 5][Math.floor(i / 5)], 8 * i);
  return out;
}
function eip55(addr) {
  const lower = addr.slice(2).toLowerCase();
  const h = keccak256(Buffer.from(lower)).toString("hex");
  return "0x" + [...lower].map((c, i) => (/[a-f]/.test(c) && parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join("");
}

// ---------- per-coin rules ----------
const CHECKS = {
  BTC(a) {
    if (/^bc1/i.test(a)) return segwit(a, "bc");
    const body = base58check(a);
    return !!body && body.length === 21 && (body[0] === 0x00 || body[0] === 0x05); // 1... or 3...
  },
  LTC(a) {
    if (/^ltc1/i.test(a)) return segwit(a, "ltc");
    const body = base58check(a);
    return !!body && body.length === 21 && (body[0] === 0x30 || body[0] === 0x32 || body[0] === 0x05); // L..., M..., 3...
  },
  ETH(a) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return false;
    const hex = a.slice(2);
    if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return true; // no checksum given
    return eip55(a) === a; // mixed case = checksum, and it must match
  },
  SOL(a) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return false;
    const raw = b58decode(a);
    return !!raw && raw.length === 32;
  },
};

const NAMES = { BTC: "Bitcoin", LTC: "Litecoin", ETH: "Ethereum", SOL: "Solana" };

// Returns the cleaned address, or throws with a message a person can act on.
function checkAddress(asset, raw, { ApiError } = {}) {
  const a = typeof raw === "string" ? raw.trim() : "";
  const fail = (msg) => {
    if (ApiError) throw new ApiError(400, "invalid_address", msg);
    throw new Error(msg);
  };
  if (!CHECKS[asset]) fail(`Unsupported coin: ${asset}`);
  if (!a) fail(`Enter a ${NAMES[asset]} address.`);
  if (!CHECKS[asset](a)) {
    fail(`That isn't a valid ${NAMES[asset]} (${asset}) address. Copy it again from your wallet; a single wrong character would send the money to nobody.`);
  }
  return a;
}

// The owner's deposit wallets: these defaults, overridable per coin with WALLET_BTC etc.
// Any address that fails its checksum stops the server from offering that coin.
function walletsFromEnv(env = process.env) {
  const out = {};
  for (const asset of Object.keys(DEFAULT_WALLETS)) {
    const addr = env[`WALLET_${asset}`] || DEFAULT_WALLETS[asset];
    try { out[asset] = checkAddress(asset, addr); } catch (err) { console.error(`Wallet for ${asset} rejected:`, err.message); }
  }
  return out;
}

module.exports = { checkAddress, walletsFromEnv, keccak256, eip55, DEFAULT_WALLETS, NAMES };
