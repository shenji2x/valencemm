const { ApiError } = require("./errors");
const { clientIp, bearer, sendJson, readJson, readRaw, limiter } = require("./http");
const { createSupport } = require("./support");
const { memoryBlobs, MAX_BYTES, MAX_FILES_PER_MESSAGE } = require("./files");

const DEFAULT_INVITE = "https://discord.gg/eVYyxbyy22";

// Builds the /v1 request handler. Routes are plain data: method, path pattern, options, handler.
function createApi(store, opts = {}) {
  const handleApiRef = opts.exports || {};
  const routes = [];
  const idempotencyCache = new Map(); // "accountId|METHOD path|key" -> { status, body }
  const MAX_IDEMPOTENCY_ENTRIES = 10000;
  const globalLimit = limiter({ windowMs: 60 * 1000, max: opts.globalLimit || 300 });

  function add(method, pattern, cfg, handler) {
    const keys = [];
    const re = new RegExp("^" + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
    routes.push({ method, re, keys, auth: false, mutate: false, limit: null, raw: false, send: false, ...cfg, handler });
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
    body: { ...store.security(account), emailAvailable: Boolean(mailer.enabled), discordLinking: discord.hasInteractions, discordInvite: opts.discordInvite || DEFAULT_INVITE },
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
  const noDiscord = {
    mode: "off", hasInteractions: false,
    async open() { return null; }, async post() { return null; }, async note() {}, async markClosed() {},
    async fetchReplies() { return null; }, async postTranscript() { return null; }, async inviteCustomer() { return false; },
    roleOrDefault() { return "Support"; }, verify() { return false; },
  };
  const discord = opts.discord || noDiscord;
  const blobs = opts.blobs || memoryBlobs();
  const support = opts.support || createSupport({ store, discord, blobs, persistence: opts.persistence, siteUrl: opts.siteUrl });
  const ticketLimit = limiter({ windowMs: 3600 * 1000, max: opts.ticketLimit || 6, code: "ticket_rate_limited" });
  const messageLimit = limiter({ windowMs: 10 * 60 * 1000, max: opts.messageLimit || 60, code: "message_rate_limited" });
  const uploadLimit = limiter({ windowMs: 10 * 60 * 1000, max: opts.uploadLimit || 40, code: "upload_rate_limited" });

  // Images are uploaded one at a time and held here until a message claims them.
  const pendingUploads = new Map(); // attachment id -> { accountId, record, at }
  const UPLOAD_TTL_MS = 30 * 60 * 1000;
  function holdUpload(account, record) {
    const t = Date.now();
    for (const [id, u] of pendingUploads) if (t - u.at > UPLOAD_TTL_MS) pendingUploads.delete(id);
    if (pendingUploads.size > 5000) pendingUploads.delete(pendingUploads.keys().next().value);
    pendingUploads.set(record.id, { accountId: account.id, record, at: t });
  }
  function claimUploads(account, ids) {
    if (ids === undefined || ids === null) return [];
    if (!Array.isArray(ids)) throw new ApiError(400, "invalid_attachments", "attachmentIds must be a list");
    if (ids.length > MAX_FILES_PER_MESSAGE) throw new ApiError(400, "too_many_attachments", `You can attach up to ${MAX_FILES_PER_MESSAGE} images to a message`);
    const out = [];
    for (const id of ids) {
      const u = pendingUploads.get(id);
      if (!u || u.accountId !== account.id) throw new ApiError(400, "unknown_attachment", "That image is no longer available. Upload it again.");
      pendingUploads.delete(id);
      out.push(u.record);
    }
    return out;
  }

  add("GET", "/support", {}, () => ({
    body: {
      discordInvite: opts.discordInvite || DEFAULT_INVITE,
      liveReplies: discord.mode === "bot",
      relay: discord.mode,
      attachments: { maxFiles: MAX_FILES_PER_MESSAGE, maxBytes: MAX_BYTES, types: ["image/png", "image/jpeg", "image/gif", "image/webp"] },
      discordLinking: discord.hasInteractions,
    },
  }));

  // Raw image upload: the body is the file itself, the name comes from a header.
  add("POST", "/uploads", { auth: true, limit: uploadLimit, raw: true }, async ({ account, raw, req }) => {
    let name = req.headers["x-file-name"] || "image";
    try { name = decodeURIComponent(String(name)); } catch { /* keep as sent */ }
    let record;
    try {
      record = await support.storeAttachment({ buf: raw, name });
    } catch (err) {
      throw new ApiError(400, "invalid_image", err.message);
    }
    holdUpload(account, record);
    return { status: 201, body: record };
  });

  add("GET", "/tickets", { auth: true }, async ({ account }) => {
    const open = store.listTickets(account).filter((t) => t.status === "open").slice(0, 5);
    await Promise.all(open.map((v) => support.sync(store.ticketForRelay(v.id))));
    return { body: { tickets: store.listTickets(account), liveReplies: discord.mode === "bot" } };
  });
  add("POST", "/tickets", { auth: true, limit: ticketLimit }, async ({ account, body }) => {
    const attachments = claimUploads(account, body.attachmentIds);
    const view = store.createTicket(account, { ...body, attachments });
    await support.openRelay(store.ticketForRelay(view.id));
    return { status: 201, body: store.getTicket(account, view.id) };
  });
  add("GET", "/tickets/:id", { auth: true }, async ({ account, params }) => {
    store.getTicket(account, params.id); // 404 before touching Discord
    await support.sync(store.ticketForRelay(params.id));
    return { body: store.getTicket(account, params.id) };
  });
  add("POST", "/tickets/:id/messages", { auth: true, limit: messageLimit }, async ({ account, params, body }) => {
    const attachments = claimUploads(account, body.attachmentIds);
    const { ticket } = store.addTicketMessage(account, params.id, body.text, attachments);
    const t = store.ticketForRelay(ticket.id);
    await support.postRelay(t, store.ticketOwnerName(t), ticket.messages[ticket.messages.length - 1].text, attachments);
    return { status: 201, body: store.getTicket(account, params.id) };
  });
  add("POST", "/tickets/:id/close", { auth: true }, async ({ account, params }) => {
    const before = store.getTicket(account, params.id).status;
    const view = store.closeTicket(account, params.id);
    if (before === "open" && discord.mode !== "off") await support.closeAndLog(store.ticketForRelay(view.id), "the customer");
    return { body: view };
  });

  // An attachment, served from our own origin so it is only visible to the ticket's owner.
  add("GET", "/tickets/:id/attachments/:attId", { auth: true, send: true }, async ({ account, params, res }) => {
    const att = store.ticketAttachment(account, params.id, params.attId);
    const blob = await blobs.get(att.id);
    if (!blob) throw new ApiError(404, "attachment_not_found", "That image is no longer stored");
    res.writeHead(200, {
      "Content-Type": blob.contentType,
      "Content-Length": blob.buf.length,
      "Content-Disposition": `inline; filename="${att.name.replace(/[^\w.-]/g, "_")}"`,
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(blob.buf);
  });

  // The full conversation as a page the customer can save or print.
  add("GET", "/tickets/:id/transcript", { auth: true, send: true }, async ({ account, params, res }) => {
    store.getTicket(account, params.id); // 404 unless it's theirs
    const { html, data } = await support.transcriptFor(params.id);
    const body = Buffer.from(html, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": body.length,
      "Content-Disposition": `inline; filename="valence-ticket-${data.number}.html"`,
      "Cache-Control": "no-store",
    });
    res.end(body);
  });

  // ---- linking a Discord account ----
  add("POST", "/account/discord/link-code", { auth: true, limit: loginLimit }, ({ account }) => {
    if (!discord.hasInteractions) throw new ApiError(503, "linking_unavailable", "Discord linking isn't switched on for this server yet");
    return { body: { ...store.startDiscordLink(account), invite: opts.discordInvite || DEFAULT_INVITE } };
  });
  add("POST", "/account/discord/unlink", { auth: true }, ({ account }) => ({ body: store.unlinkDiscord(account) }));

  handleApiRef.support = support;
  handleApiRef.discord = discord;

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

    let body = {};
    let raw = null;
    if (req.method === "POST") {
      if (r.raw) raw = await readRaw(req, MAX_BYTES);
      else body = await readJson(req);
    }
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

    const result = await r.handler({ account, token, params, body, raw, req, res });
    if (r.send) return; // the handler wrote the response itself
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
