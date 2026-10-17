const http = require("http");
const fs = require("fs");
const path = require("path");
const { createStore, parseTestCodes } = require("./store");
const { createApi } = require("./api");
const { sendJson } = require("./http");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

// Reads everything in public/ once at startup. index.html is served at "/", and
// other pages without their extension (docs.html -> /docs).
function loadStatic() {
  const files = new Map();
  for (const name of fs.readdirSync(PUBLIC_DIR)) {
    const ext = path.extname(name);
    const type = CONTENT_TYPES[ext];
    if (!type) continue;
    const body = fs.readFileSync(path.join(PUBLIC_DIR, name));
    const urlPath = name === "index.html" ? "/" : ext === ".html" ? "/" + name.slice(0, -5) : "/" + name;
    files.set(urlPath, { body, type });
  }
  return files;
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=15552000",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; " +
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
  const handleApi = createApi(store, opts);
  const statics = loadStatic();

  async function handle(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
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
        ledger: store.audit().ok ? "balanced" : "UNBALANCED",
      });
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendError(res, { status: 405, code: "method_not_allowed", message: "Method not allowed", headers: { Allow: "GET, HEAD" } }, false);
    }
    const file = statics.get(pathname);
    if (!file) return sendError(res, { status: 404, code: "not_found", message: "Not found" }, false);
    res.writeHead(200, { "Content-Type": file.type, "Content-Length": file.body.length, "Cache-Control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : file.body);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => sendError(res, err, false));
  });
  server.headersTimeout = 20 * 1000;
  server.requestTimeout = 30 * 1000;
  server.store = store;
  server.testCodesEnabled = testCodes.size > 0;
  return server;
}

module.exports = { createApp };
