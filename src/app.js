const http = require("http");
const fs = require("fs");
const path = require("path");
const { createStore } = require("./store");
const { createApi } = require("./api");
const { sendJson, limiter, clientIp, ipKey } = require("./http");
const { createPersistence, backendFromEnv } = require("./persist");
const { discordFromEnv } = require("./discord");
const { blobsFromEnv } = require("./files");
const { readRaw } = require("./http");
const { mailerFromEnv } = require("./email");
const { stripeFromEnv } = require("./stripe");
const { createPayments } = require("./payments");
const { r2FromEnv, verifyMedia } = require('./profile-media');

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
const LONG_CACHE = new Set([".png", ".ico", ".svg", ".woff", ".woff2"]); // images and fonts rarely change

// Extra domains that should land on the main one. A permanent redirect keeps search
// engines from seeing duplicate copies of the site, so everything ranks under one name.
const CANONICAL_HOST = process.env.CANONICAL_HOST || "valencemm.com";
const REDIRECT_HOSTS = new Set(
  (process.env.REDIRECT_HOSTS || "www.valencemm.com,ai-mm.org,www.ai-mm.org")
    .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)
);

// Reads everything in public/ (and its subfolders, e.g. vendor/ and fonts/) once at startup.
// index.html is served at "/", and top-level pages without their extension (docs.html -> /docs).
function loadStatic(dir = PUBLIC_DIR, prefix = "/", files = new Map()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      loadStatic(path.join(dir, name), prefix + name + "/", files);
      continue;
    }
    const ext = path.extname(name);
    const type = CONTENT_TYPES[ext];
    if (!type) continue;
    const body = fs.readFileSync(path.join(dir, name));
    const isPage = ext === ".html" && prefix === "/";
    const urlPath = isPage && name === "index.html" ? "/" : isPage ? "/" + name.slice(0, -5) : prefix + name;
    files.set(urlPath, { body, type, cache: LONG_CACHE.has(ext) ? "public, max-age=86400" : "no-cache" });
  }
  return files;
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Permitted-Cross-Domain-Policies": "none",
  "Permissions-Policy": 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=(), payment=(self "https://js.stripe.com")',
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self' https://js.stripe.com; style-src 'self'; font-src 'self'; " +
    "connect-src 'self' https://api.stripe.com; img-src 'self' data: blob:; manifest-src 'self'; " +
    "frame-src https://js.stripe.com https://hooks.stripe.com; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function sendError(res, err, isApi) {
  const known = err && err.status && err.code;
  const status = known ? err.status : 500;
  if (!known) console.error(err);
  if (res.headersSent) return res.end();
  if (isApi) {
    const message = known ? err.message : "Something went wrong";
    const extra = known && err.extra ? err.extra : {};
    return sendJson(res, status, { error: { ...extra, code: known ? err.code : "internal", message } }, err.headers);
  }
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...(err.headers || {}) });
  res.end(known ? err.message : "Something went wrong");
}

function createApp(opts = {}) {
  const store = createStore({ now: opts.now });
  const persistence = createPersistence(store, opts.backend || backendFromEnv(), { onFatal: opts.onFatal });
  const discord = opts.discord || discordFromEnv();
  const mailer = opts.mailer || mailerFromEnv();
  const blobs = opts.blobs || blobsFromEnv();
  const stripe = opts.stripe || stripeFromEnv();
  const payments = opts.payments || createPayments({ store, stripe, persistence, siteUrl: opts.siteUrl || `https://${CANONICAL_HOST}` });
  const apiParts = {};
  const profileMedia = opts.profileMedia || r2FromEnv();
  const handleApi = createApi(store, { ...opts, persistence, discord, mailer, blobs, stripe, payments, profileMedia, mediaVerifier: opts.mediaVerifier || verifyMedia, exports: apiParts });
  const statics = loadStatic();
  // Every request counts, pages and files included, not just the API. A normal visit is a few dozen
  // requests; this only stops one address hammering the server.
  const siteLimit = limiter({ windowMs: 60 * 1000, max: opts.siteLimit || 900, code: "rate_limited" });

  async function handle(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    // Extend only the media directives for the configured private R2 account.
    if (profileMedia.origin) res.setHeader('Content-Security-Policy', SECURITY_HEADERS['Content-Security-Policy'].replace("connect-src 'self'", `connect-src 'self' ${profileMedia.origin}`).replace("img-src 'self'", `img-src 'self' ${profileMedia.origin}`) + `; media-src 'self' blob: ${profileMedia.origin}`);
    try {
      siteLimit(ipKey(clientIp(req)));
    } catch (err) {
      return sendError(res, err, String(req.url || "").startsWith("/v1"));
    }

    // ai-mm.org, www.* etc. -> https://valencemm.com, keeping the path. 308 keeps POST as POST for API callers.
    const host = String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "");
    if (REDIRECT_HOSTS.has(host)) {
      const target = "https://" + CANONICAL_HOST + (String(req.url || "/").startsWith("/") ? req.url : "/");
      res.writeHead(308, { Location: target, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" });
      return res.end("Moved to " + target);
    }

    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      pathname = "/";
    }
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);

    if (pathname === "/v1" || pathname.startsWith("/v1/")) {
      try {
        await handleApi(req, res, pathname.slice(3) || "/");
      } catch (err) {
        sendError(res, err, true);
      }
      return;
    }

    // Slash commands. Discord signs every request, and anything unsigned is refused.
    if (pathname === "/discord/interactions") {
      if (req.method !== "POST") {
        return sendError(res, { status: 405, code: "method_not_allowed", message: "Method not allowed", headers: { Allow: "POST" } }, true);
      }
      const signature = req.headers["x-signature-ed25519"];
      const timestamp = req.headers["x-signature-timestamp"];
      let raw;
      try {
        raw = await readRaw(req, 256 * 1024);
      } catch (err) {
        return sendError(res, err, true);
      }
      if (!signature || !timestamp || !discord.verify(signature, timestamp, raw)) {
        return sendError(res, { status: 401, code: "bad_signature", message: "invalid request signature" }, true);
      }
      let parsed;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        return sendError(res, { status: 400, code: "invalid_json", message: "Body is not valid JSON" }, true);
      }
      try {
        return sendJson(res, 200, await apiParts.support.handleInteraction(parsed));
      } catch (err) {
        console.error("Discord interaction failed:", err && err.message);
        return sendJson(res, 200, { type: 4, data: { content: "Something went wrong handling that command.", flags: 64 } });
      }
    }

    if (pathname === "/health") {
      return sendJson(res, 200, {
        service: "Valence",
        status: "online",
        payments: stripe.configured ? "stripe (cards, funds held at the provider)" : "off",
        webhooks: stripe.acceptsWebhooks ? "on" : "off",
        storage: persistence.kind === "memory" ? "memory (not saved)" : "saved",
        email: mailer.enabled ? "on" : "off",
        support: discord.mode === "bot" ? "discord (two-way)" : discord.mode === "webhook" ? "discord (notifications only)" : "website only",
        slashCommands: discord.hasInteractions ? "on" : "off",
        attachments: blobs.kind === "memory" ? "memory (not saved)" : "saved",
        deals: store.audit().ok ? "consistent" : "NEEDS ATTENTION",
      });
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendError(res, { status: 405, code: "method_not_allowed", message: "Method not allowed", headers: { Allow: "GET, HEAD" } }, false);
    }
    const isProfile = /^\/u\/[a-zA-Z0-9_-]{1,40}$/.test(pathname);
    if (isProfile && !store.profileOwner(pathname.slice(3))?.profile?.published) return sendError(res, { status: 404, code: 'not_found', message: 'This profile is not published' }, false);
    const file = statics.get(isProfile ? '/profile' : pathname);
    if (!file) return sendError(res, { status: 404, code: "not_found", message: "Not found" }, false);
    res.writeHead(200, { "Content-Type": file.type, "Content-Length": file.body.length, "Cache-Control": file.cache });
    res.end(req.method === "HEAD" ? undefined : file.body);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => sendError(res, err, false));
  });
  // Slow-request defences: a client must send its headers within 10s and the whole request within 30s,
  // with at most 64 headers, and an idle keep-alive connection is closed after 5s.
  server.headersTimeout = 10 * 1000;
  server.requestTimeout = 30 * 1000;
  server.keepAliveTimeout = 5 * 1000;
  server.maxHeadersCount = 64;
  server.store = store;
  server.persistence = persistence;
  server.discord = discord;
  server.mailer = mailer;
  server.blobs = blobs;
  server.stripe = stripe;
  server.payments = payments;
  server.support = apiParts.support;
  // Tell Discord which slash commands exist. Never blocks startup.
  server.commandsRegistered = discord.mode === "bot" && !opts.skipCommandRegistration
    ? discord.registerCommands().then(() => true).catch((err) => { console.error("Could not register Discord commands:", err.message); return false; })
    : Promise.resolve(false);
  // Load the saved snapshot before taking traffic. server.js waits for this.
  // Load the snapshot, then start the auto-release and hold-expiry sweeps.
  server.ready = persistence.load().then((r) => {
    if (!opts.skipTimers) payments.startTimers();
    return r;
  });
  const close = server.close.bind(server);
  server.close = (cb) => {
    payments.stopTimers();
    return close(cb);
  };
  return server;
}

module.exports = { createApp };

