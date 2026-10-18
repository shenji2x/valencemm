const http = require("http");
const fs = require("fs");
const path = require("path");
const { createStore, parseTestCodes } = require("./store");
const { createApi } = require("./api");
const { sendJson } = require("./http");
const { createPersistence, backendFromEnv } = require("./persist");
const { discordFromEnv } = require("./discord");
const { mailerFromEnv } = require("./email");

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
  "Strict-Transport-Security": "max-age=15552000",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function sendError(res, err, isApi) {
  const known = err && err.status && err.code;
  const status = known ? err.status : 500;
  if (!known) console.error(err);
  if (res.headersSent) return res.end();
  if (isApi) {
    const message = known ? err.message : "Something went wrong";
    return sendJson(res, status, { error: { code: known ? err.code : "internal", message } }, err.headers);
  }
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...(err.headers || {}) });
  res.end(known ? err.message : "Something went wrong");
}

function createApp(opts = {}) {
  const testCodes = opts.testCodes || parseTestCodes(process.env.TEST_CREDIT_CODES);
  const store = createStore({ now: opts.now, testCodes });
  const persistence = createPersistence(store, opts.backend || backendFromEnv(), { onFatal: opts.onFatal });
  const discord = opts.discord || discordFromEnv();
  const mailer = opts.mailer || mailerFromEnv();
  const handleApi = createApi(store, { ...opts, persistence, discord, mailer });
  const statics = loadStatic();

  async function handle(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

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

    if (pathname === "/health") {
      return sendJson(res, 200, {
        service: "Valence",
        status: "online",
        mode: "play-credits",
        testCredits: testCodes.size > 0,
        storage: persistence.kind === "memory" ? "memory (not saved)" : "saved",
        email: mailer.enabled ? "on" : "off",
        support: discord.mode === "bot" ? "discord (two-way)" : discord.mode === "webhook" ? "discord (notifications only)" : "website only",
        ledger: store.audit().ok ? "balanced" : "UNBALANCED",
      });
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendError(res, { status: 405, code: "method_not_allowed", message: "Method not allowed", headers: { Allow: "GET, HEAD" } }, false);
    }
    const file = statics.get(pathname);
    if (!file) return sendError(res, { status: 404, code: "not_found", message: "Not found" }, false);
    res.writeHead(200, { "Content-Type": file.type, "Content-Length": file.body.length, "Cache-Control": file.cache });
    res.end(req.method === "HEAD" ? undefined : file.body);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => sendError(res, err, false));
  });
  server.headersTimeout = 20 * 1000;
  server.requestTimeout = 30 * 1000;
  server.store = store;
  server.persistence = persistence;
  server.discord = discord;
  server.mailer = mailer;
  // Load the saved snapshot before taking traffic. server.js waits for this.
  server.ready = persistence.load();
  server.testCodesEnabled = testCodes.size > 0;
  return server;
}

module.exports = { createApp };
