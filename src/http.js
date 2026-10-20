const net = require("net");
const { ApiError } = require("./errors");

// Cloudflare's published edge ranges (https://www.cloudflare.com/ips/). Only used when
// TRUST_CLOUDFLARE=1, i.e. when valencemm.com is proxied through Cloudflare.
const CLOUDFLARE_RANGES = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
  "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
  "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32",
  "2a06:98c0::/29", "2c0f:f248::/32",
];
let cloudflare = null;
function isCloudflare(ip) {
  if (!cloudflare) {
    cloudflare = new net.BlockList();
    for (const range of CLOUDFLARE_RANGES) {
      const [addr, bits] = range.split("/");
      cloudflare.addSubnet(addr, Number(bits), addr.includes(":") ? "ipv6" : "ipv4");
    }
  }
  const type = net.isIP(ip);
  return type ? cloudflare.check(ip, type === 6 ? "ipv6" : "ipv4") : false;
}

function unmap(ip) {
  const s = String(ip || "").trim().replace(/%.*$/, "");
  return /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(s) ? s.slice(7) : s;
}

// Cloud Run puts Google's own proxy in front of the app and appends the real client address to the
// END of X-Forwarded-For, so the last entry is the one we can trust. Behind Cloudflare that entry is a
// Cloudflare edge, and the visitor is in CF-Connecting-IP -- trusted only when the request really came
// from a Cloudflare address, so nobody can skip Cloudflare and claim to be someone else.
function clientIp(req) {
  let ip = "";
  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    const parts = String(xff).split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) ip = parts[parts.length - 1];
  }
  if (!ip) ip = (req.socket && req.socket.remoteAddress) || "unknown";
  ip = unmap(ip);
  if (process.env.TRUST_CLOUDFLARE === "1" && req.headers["cf-connecting-ip"] && isCloudflare(ip)) {
    const cf = unmap(req.headers["cf-connecting-ip"]);
    if (net.isIP(cf)) ip = cf;
  }
  return ip;
}

// The key rate limits are counted against. IPv4 addresses count individually. An IPv6 user normally
// holds a whole /64 and can rotate through billions of addresses in it, so IPv6 counts per /64.
function ipKey(ip) {
  const s = unmap(ip);
  if (net.isIP(s) !== 6) return s;
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? null : tail ? tail.split(":") : [];
  const fill = t === null ? 0 : 8 - h.length - t.length;
  if (fill < 0) return s;
  const groups = t === null ? h : [...h, ...Array(fill).fill("0"), ...t];
  return groups.slice(0, 4).map((g) => (g || "0").toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

function bearer(req) {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization || "");
  return m ? m[1] : null;
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

// Collects the request body as a Buffer. Anything past the limit is refused, and a wildly
// oversized upload has its connection cut rather than being read to the end.
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit * 2 + 1024) return req.destroy();
      if (tooLarge) return;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (tooLarge) reject(new ApiError(413, "too_large", "Request body too large"));
      else resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
    req.on("close", () => {
      if (!req.complete) reject(new ApiError(400, "aborted", "Request was cut off"));
    });
  });
}

async function readBody(req, limit) {
  return (await readRaw(req, limit)).toString("utf8");
}

// Returns the parsed JSON object, or {} for an empty body.
async function readJson(req, limit = 10 * 1024) {
  const text = (await readBody(req, limit)).trim();
  if (!text) return {};
  if (!/json/i.test(req.headers["content-type"] || "")) {
    throw new ApiError(415, "unsupported_media_type", "Send the body as JSON with Content-Type: application/json");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "Request body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "invalid_json", "Request body must be a JSON object");
  }
  return parsed;
}

// Fixed-window rate limiter keyed by client IP. In-memory, so it is per server instance.
function limiter({ windowMs, max, code = "rate_limited" }) {
  const hits = new Map(); // ip -> { count, resetAt }
  return (ip) => {
    const t = Date.now();
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
      // A flood from a huge number of addresses: shed the oldest windows so memory stays bounded.
      if (hits.size > 50000) {
        let extra = hits.size - 40000;
        for (const k of hits.keys()) { if (extra-- <= 0) break; hits.delete(k); }
      }
    }
    let h = hits.get(ip);
    if (!h || h.resetAt <= t) {
      h = { count: 0, resetAt: t + windowMs };
      hits.set(ip, h);
    }
    h.count++;
    if (h.count > max) {
      const err = new ApiError(429, code, "Too many requests, slow down");
      err.headers = { "Retry-After": String(Math.ceil((h.resetAt - t) / 1000)) };
      throw err;
    }
  };
}

// Counts successes, not attempts, per key over a fixed window. Someone who mistypes or picks a taken
// name isn't punished, but nobody can create more than `max` accounts from one network per window.
function quota({ windowMs, max, code, message }) {
  const used = new Map(); // key -> { count, resetAt }
  const entry = (key) => {
    const t = Date.now();
    let q = used.get(key);
    if (!q || q.resetAt <= t) {
      q = { count: 0, resetAt: t + windowMs };
      used.set(key, q);
    }
    if (used.size > 20000) for (const [k, v] of used) if (v.resetAt <= t) used.delete(k);
    return q;
  };
  return {
    check(key) {
      const q = entry(key);
      if (q.count >= max) {
        const err = new ApiError(429, code, message);
        err.headers = { "Retry-After": String(Math.ceil((q.resetAt - Date.now()) / 1000)) };
        throw err;
      }
    },
    add(key) { entry(key).count++; },
  };
}

module.exports = { clientIp, ipKey, isCloudflare, bearer, sendJson, readJson, readRaw, readBody, limiter, quota };
