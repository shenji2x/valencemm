const { ApiError } = require("./errors");

// Cloud Run puts Google's own proxy in front of the app and appends the real client address to the
// END of X-Forwarded-For, so the last entry is the one we can trust.
function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    const parts = String(xff).split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return (req.socket && req.socket.remoteAddress) || "unknown";
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

module.exports = { clientIp, bearer, sendJson, readJson, readRaw, readBody, limiter };
