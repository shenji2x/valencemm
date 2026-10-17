const express = require("express");
const { ApiError } = require("./errors");

// Fixed-window rate limiter keyed by client IP. In-memory, so per server instance.
function rateLimiter({ windowMs, max, code = "rate_limited" }) {
  const hits = new Map(); // ip -> { count, resetAt }
  return (req, res, next) => {
    const t = Date.now();
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
    }
    const key = req.ip || "unknown";
    let h = hits.get(key);
    if (!h || h.resetAt <= t) {
      h = { count: 0, resetAt: t + windowMs };
      hits.set(key, h);
    }
    h.count++;
    if (h.count > max) {
      res.set("Retry-After", String(Math.ceil((h.resetAt - t) / 1000)));
      return next(new ApiError(429, code, "Too many requests, slow down"));
    }
    next();
  };
}

function createApi(store, opts = {}) {
  const router = express.Router();
  const idempotencyCache = new Map(); // "agentId|path|key" -> { status, body }
  const MAX_IDEMPOTENCY_ENTRIES = 10000;

  router.use(rateLimiter({ windowMs: 60 * 1000, max: opts.globalLimit || 300 }));

  function auth(req, res, next) {
    const header = req.get("authorization") || "";
    const match = /^Bearer (\S+)$/.exec(header);
    const agent = match ? store.authenticate(match[1]) : null;
    if (!agent) return next(new ApiError(401, "unauthorized", "Missing or invalid API key. Send: Authorization: Bearer <apiKey>"));
    req.agent = agent;
    next();
  }

  // Wraps a state-changing handler so a retried request with the same Idempotency-Key
  // returns the original result instead of acting twice.
  function mutate(fn) {
    return (req, res, next) => {
      try {
        const key = req.get("idempotency-key");
        if (key && key.length > 64) throw new ApiError(400, "invalid_idempotency_key", "Idempotency-Key must be 64 characters or fewer");
        const cacheKey = key ? `${req.agent.id}|${req.path}|${key}` : null;
        if (cacheKey && idempotencyCache.has(cacheKey)) {
          const hit = idempotencyCache.get(cacheKey);
          res.set("Idempotent-Replay", "true");
          return res.status(hit.status).json(hit.body);
        }
        const result = fn(req);
        const status = result.status || 200;
        if (cacheKey) {
          idempotencyCache.set(cacheKey, { status, body: result.body });
          if (idempotencyCache.size > MAX_IDEMPOTENCY_ENTRIES) {
            idempotencyCache.delete(idempotencyCache.keys().next().value);
          }
        }
        res.status(status).json(result.body);
      } catch (err) {
        next(err);
      }
    };
  }

  router.post(
    "/agents/register",
    rateLimiter({ windowMs: 60 * 60 * 1000, max: opts.registerLimit || 20, code: "register_rate_limited" }),
    (req, res, next) => {
      try {
        res.status(201).json({
          ...store.registerAgent(req.body && req.body.name),
          currency: "play-credits",
          notice: "Save your apiKey now. It is shown only once. Play credits have no real-world value.",
        });
      } catch (err) {
        next(err);
      }
    }
  );

  router.get("/me", auth, (req, res) => res.json(store.me(req.agent)));

  router.get("/deals", auth, (req, res) => res.json({ deals: store.listDeals(req.agent) }));

  router.post("/deals", auth, mutate((req) => ({ status: 201, body: store.createDeal(req.agent, req.body || {}) })));

  router.post(
    "/deals/join",
    rateLimiter({ windowMs: 60 * 1000, max: opts.joinLimit || 20, code: "join_rate_limited" }),
    auth,
    mutate((req) => ({ body: store.joinDeal(req.agent, req.body && req.body.inviteCode) }))
  );

  router.get("/deals/:id", auth, (req, res, next) => {
    try {
      res.json(store.getDeal(req.agent, req.params.id));
    } catch (err) {
      next(err);
    }
  });

  for (const action of ["fund", "release", "refund", "cancel"]) {
    router.post(`/deals/:id/${action}`, auth, mutate((req) => ({ body: store[action + "Deal"](req.agent, req.params.id) })));
  }

  router.use((req, res, next) => next(new ApiError(404, "not_found", "No such endpoint")));

  return router;
}

module.exports = { createApi };
