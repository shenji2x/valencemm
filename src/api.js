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

  // ---- people: two-factor sign-in and security settings ----
  const mailer = opts.mailer || { enabled: false, async send() { throw new Error("off"); } };
  const emailLimit = limiter({ windowMs: 3600 * 1000, max: opts.emailLimit || 12, code: "email_rate_limited" });
  const { codeEmail } = require("./email");
  async function sendCode(purpose, { to, code, username }) {
    if (!mailer.enabled) throw new ApiError(503, "email_unavailable", "Email isn't set up on this server yet");
    try {
      await mailer.send({ to, ...codeEmail({ code, purpose, username }) });
    } catch (err) {
      console.error("Email send failed:", err && err.message);
      throw new ApiError(502, "email_failed", "We couldn't send the email. Try again in a minute.");
    }
  }

  add("POST", "/humans/login/email-code", { limit: emailLimit }, async ({ body }) => {
    if (!mailer.enabled) throw new ApiError(503, "email_unavailable", "Email isn't set up on this server yet");
    const r = store.loginEmailCode(body.challenge);
    await sendCode("login", r);
    return { body: { sent: true, emailHint: r.emailHint } };
  });
  add("POST", "/humans/login/verify", { limit: loginLimit }, ({ body }) => ({
    body: store.completeLogin(body.challenge, body.method, body.code),
  }));

  add("GET", "/account/security", { auth: true }, ({ account }) => ({
    body: { ...store.security(account), emailAvailable: Boolean(mailer.enabled) },
  }));
  add("POST", "/account/email", { auth: true, limit: emailLimit }, async ({ account, body }) => {
    if (!mailer.enabled) throw new ApiError(503, "email_unavailable", "Email isn't set up on this server yet");
    const r = store.startEmailVerification(account, body.email);
    await sendCode("verify", r);
    return { body: { sent: true, ...store.security(account) } };
  });
  add("POST", "/account/email/verify", { auth: true, limit: loginLimit }, ({ account, body }) => ({ body: store.confirmEmail(account, body.code) }));
  add("POST", "/account/email/remove", { auth: true, limit: loginLimit }, async ({ account, body }) => ({ body: await store.removeEmail(account, body.password) }));
  add("POST", "/account/2fa/app/setup", { auth: true }, ({ account }) => ({ body: store.totpSetup(account) }));
  add("POST", "/account/2fa/app/enable", { auth: true, limit: loginLimit }, ({ account, body }) => ({ body: store.totpEnable(account, body.code) }));
  add("POST", "/account/2fa/app/disable", { auth: true, limit: loginLimit }, async ({ account, body }) => ({ body: await store.totpDisable(account, body.password) }));
  add("POST", "/account/2fa/email", { auth: true, limit: loginLimit }, async ({ account, body }) => ({
    body: await store.setEmailTwoFactor(account, body.enable === true, body.password),
  }));
  add("POST", "/account/2fa/recovery-codes", { auth: true, limit: loginLimit }, async ({ account, body }) => ({
    body: await store.newRecoveryCodes(account, body.password),
  }));

  // ---- people: password ----
  add("POST", "/humans/password", { auth: true, limit: loginLimit }, async ({ account, token, body }) => ({
    body: await store.changePassword(account, token, body.currentPassword, body.newPassword),
  }));

  // ---- deals: preview an invite before joining, and stats ----
  add("GET", "/deals/invite/:code", { auth: true, limit: joinLimit }, ({ account, params }) => ({
    body: store.invitePreview(account, params.code),
  }));
  add("GET", "/stats", { auth: true }, ({ account }) => ({ body: store.stats(account) }));

  // ---- support tickets, relayed to Discord ----
  const discord = opts.discord || { mode: "off", async open() { return null; }, async post() { return null; }, async markClosed() {}, async fetchReplies() { return null; } };
  const ticketLimit = limiter({ windowMs: 3600 * 1000, max: opts.ticketLimit || 6, code: "ticket_rate_limited" });
  const messageLimit = limiter({ windowMs: 10 * 60 * 1000, max: opts.messageLimit || 60, code: "message_rate_limited" });
  const relayError = (what, err) => console.error(`Discord ${what} failed:`, err && err.message ? err.message : err);

  async function relayOpen(t) {
    try {
      const d = await discord.open(t, store.ticketOwnerName(t));
      if (d) store.setTicketDiscord(t, { ...d, error: null });
    } catch (err) {
      relayError("open", err);
      store.setTicketDiscord(t, { error: "open_failed" });
    }
  }

  async function relayPost(t, author, text, title) {
    if (discord.mode === "off") return;
    const opened = t.discord && (t.discord.channelId || t.discord.threadId || (discord.mode === "webhook" && !t.discord.error));
    if (!opened) return relayOpen(t); // first attempt failed earlier: open now (posts the history's first message)
    try {
      await discord.post(t, author, text, title);
    } catch (err) {
      relayError("post", err);
    }
  }

  // Pulls staff replies from Discord into the ticket, and saves if anything arrived.
  async function syncTicket(t) {
    if (t.status !== "open") return;
    try {
      const r = await discord.fetchReplies(t);
      if (!r) return;
      const added = store.addStaffMessages(t, r.messages);
      const moved = r.lastMessageId && r.lastMessageId !== t.discord.lastMessageId;
      if (moved) store.setTicketDiscord(t, { lastMessageId: r.lastMessageId });
      if ((added || moved) && opts.persistence) await opts.persistence.commit();
    } catch (err) {
      relayError("sync", err);
    }
  }

  add("GET", "/support", {}, () => ({
    body: { discordInvite: opts.discordInvite || "https://discord.gg/eVYyxbyy22", liveReplies: discord.mode === "bot", relay: discord.mode },
  }));
  add("GET", "/tickets", { auth: true }, async ({ account }) => {
    const open = store.listTickets(account).filter((t) => t.status === "open").slice(0, 5);
    await Promise.all(open.map((v) => syncTicket(store.ticketForRelay(v.id))));
    return { body: { tickets: store.listTickets(account), liveReplies: discord.mode === "bot" } };
  });
  add("POST", "/tickets", { auth: true, limit: ticketLimit }, async ({ account, body }) => {
    const view = store.createTicket(account, body);
    await relayOpen(store.ticketForRelay(view.id));
    return { status: 201, body: store.getTicket(account, view.id) };
  });
  add("GET", "/tickets/:id", { auth: true }, async ({ account, params }) => {
    store.getTicket(account, params.id); // 404 before touching Discord
    await syncTicket(store.ticketForRelay(params.id));
    return { body: store.getTicket(account, params.id) };
  });
  add("POST", "/tickets/:id/messages", { auth: true, limit: messageLimit }, async ({ account, params, body }) => {
    const { ticket } = store.addTicketMessage(account, params.id, body.text);
    const t = store.ticketForRelay(ticket.id);
    await relayPost(t, store.ticketOwnerName(t), ticket.messages[ticket.messages.length - 1].text);
    return { status: 201, body: store.getTicket(account, params.id) };
  });
  add("POST", "/tickets/:id/close", { auth: true }, async ({ account, params }) => {
    const before = store.getTicket(account, params.id).status;
    const view = store.closeTicket(account, params.id);
    if (before === "open" && discord.mode !== "off") {
      try { await discord.markClosed(store.ticketForRelay(view.id), "the customer"); } catch (err) { relayError("close", err); }
    }
    return { body: view };
  });

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
    // Every POST changes something. Don't answer until it's saved, so a success response
    // always means the change survives a restart.
    if (req.method === "POST" && opts.persistence) {
      try {
        await opts.persistence.commit();
      } catch {
        throw new ApiError(503, "storage_unavailable", "Couldn't save the change. Please try again in a moment.");
      }
    }
    const status = result.status || 200;
    if (cacheKey) {
      idempotencyCache.set(cacheKey, { status, body: result.body });
      if (idempotencyCache.size > MAX_IDEMPOTENCY_ENTRIES) idempotencyCache.delete(idempotencyCache.keys().next().value);
    }
    sendJson(res, status, result.body);
  };
}

module.exports = { createApi };
