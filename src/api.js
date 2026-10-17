const { ApiError } = require("./errors");
const { clientIp, bearer, sendJson, readJson, limiter } = require("./http");

// Builds the /v1 request handler. Routes are plain data: method, path pattern, options, handler.
function createApi(store, opts = {}) {
  const routes = [];
  const idempotencyCache = new Map(); // "accountId|METHOD path|key" -> { status, body }
  const MAX_IDEMPOTENCY_ENTRIES = 10000;
  const globalLimit = limiter({ windowMs: 60 * 1000, max: opts.globalLimit || 300 });

  function add(method, pattern, cfg, handler) {
    const keys = [];
    const re = new RegExp("^" + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
    routes.push({ method, re, keys, auth: false, mutate: false, limit: null, ...cfg, handler });
  }

  const registerLimit = limiter({ windowMs: 3600 * 1000, max: opts.registerLimit || 20, code: "register_rate_limited" });
  const loginLimit = limiter({ windowMs: 10 * 60 * 1000, max: opts.loginLimit || 30, code: "login_rate_limited" });
  const joinLimit = limiter({ windowMs: 60 * 1000, max: opts.joinLimit || 20, code: "join_rate_limited" });
  const redeemLimit = limiter({ windowMs: 10 * 60 * 1000, max: opts.redeemLimit || 20, code: "redeem_rate_limited" });

  // ---- accounts ----
  add("POST", "/agents/register", { limit: registerLimit }, ({ body }) => ({
    status: 201,
    body: {
      ...store.registerAgent(body.name),
      currency: "play-credits",
      notice: "Save your apiKey now. It is shown only once. Play credits have no real-world value.",
    },
  }));
  add("POST", "/humans/signup", { limit: registerLimit }, async ({ body }) => ({
    status: 201,
    body: await store.registerHuman(body.username, body.password),
  }));
  add("POST", "/humans/login", { limit: loginLimit }, async ({ body }) => ({
    body: await store.loginHuman(body.username, body.password),
  }));
  add("POST", "/logout", { auth: true }, ({ token }) => {
    store.logout(token);
    return { body: { ok: true } };
  });
  add("GET", "/me", { auth: true }, ({ account }) => ({ body: store.me(account) }));
  add("POST", "/credits/redeem", { auth: true, limit: redeemLimit }, ({ account, body }) => ({
    body: store.redeemCredits(account, body.code),
  }));

  // ---- deals ----
  add("GET", "/deals", { auth: true }, ({ account }) => ({ body: { deals: store.listDeals(account) } }));
  add("POST", "/deals", { auth: true, mutate: true }, ({ account, body }) => ({
    status: 201,
    body: store.createDeal(account, body),
  }));
  add("POST", "/deals/join", { auth: true, mutate: true, limit: joinLimit }, ({ account, body }) => ({
    body: store.joinDeal(account, body.inviteCode),
  }));
  add("GET", "/deals/:id", { auth: true }, ({ account, params }) => ({ body: store.getDeal(account, params.id) }));
  for (const action of ["fund", "release", "refund", "cancel"]) {
    add("POST", `/deals/:id/${action}`, { auth: true, mutate: true }, ({ account, params }) => ({
      body: store[action + "Deal"](account, params.id),
    }));
  }

  return async function handleApi(req, res, apiPath) {
    const ip = clientIp(req);
    globalLimit(ip);

    let found = null;
    const allowed = new Set();
    for (const r of routes) {
      const m = r.re.exec(apiPath);
      if (!m) continue;
      if (r.method === req.method) {
        found = { r, m };
        break;
      }
      allowed.add(r.method);
    }
    if (!found) {
      if (allowed.size) {
        const err = new ApiError(405, "method_not_allowed", "Method not allowed for this endpoint");
        err.headers = { Allow: [...allowed].join(", ") };
        throw err;
      }
      throw new ApiError(404, "not_found", "No such endpoint");
    }
    const { r, m } = found;

    const params = {};
    r.keys.forEach((k, i) => {
      try {
        params[k] = decodeURIComponent(m[i + 1]);
      } catch {
        throw new ApiError(400, "bad_request", "Malformed URL");
      }
    });

    const body = req.method === "POST" ? await readJson(req) : {};
    if (r.limit) r.limit(ip);

    let account = null;
    let token = null;
    if (r.auth) {
      token = bearer(req);
      account = token ? store.authenticate(token) : null;
      if (!account) throw new ApiError(401, "unauthorized", "Missing or invalid credentials. Send: Authorization: Bearer <apiKey or session token>");
    }

    // A retried request with the same Idempotency-Key returns the original result instead of acting twice.
    let cacheKey = null;
    if (r.mutate && req.headers["idempotency-key"] !== undefined) {
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string" || key.length === 0 || key.length > 64) {
        throw new ApiError(400, "invalid_idempotency_key", "Idempotency-Key must be 1-64 characters");
      }
      cacheKey = `${account.id}|${req.method} ${apiPath}|${key}`;
      const hit = idempotencyCache.get(cacheKey);
      if (hit) return sendJson(res, hit.status, hit.body, { "Idempotent-Replay": "true" });
    }

    const result = await r.handler({ account, token, params, body });
    const status = result.status || 200;
    if (cacheKey) {
      idempotencyCache.set(cacheKey, { status, body: result.body });
      if (idempotencyCache.size > MAX_IDEMPOTENCY_ENTRIES) idempotencyCache.delete(idempotencyCache.keys().next().value);
    }
    sendJson(res, status, result.body);
  };
}

module.exports = { createApi };
