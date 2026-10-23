const { ApiError } = require("./errors");
const { clientIp, ipKey, bearer, sendJson, readJson, readRaw, limiter, quota } = require("./http");
const { createPow } = require("./pow");
const { createSupport } = require("./support");
const money = require("./money");
const { cryptoMethods } = require("./crypto-checkout");
const { memoryBlobs, MAX_BYTES, MAX_FILES_PER_MESSAGE } = require("./files");
const { installBiolink } = require('./biolink');

const { supportConfig, DEFAULT_INVITE } = require("./support-config");

// Builds the /v1 request handler. Routes are plain data: method, path pattern, options, handler.
function createApi(store, opts = {}) {
  const supportSettings = supportConfig(opts);
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
  const payLimit = limiter({ windowMs: 10 * 60 * 1000, max: opts.payLimit || 40, code: "payment_rate_limited" });
  const biolink = installBiolink(add, store, opts);

  // ---- anti-abuse ----
  // Sign-ups and agent registrations need a solved proof-of-work (see pow.js), and each network can
  // only create so many accounts a day. If sign-ups spike site-wide, the puzzle gets harder; if they
  // spike absurdly, sign-ups pause for a few minutes. Logins get a puzzle only for a username that
  // has just had several wrong passwords, so a guesser pays per guess but the real owner is never
  // locked out by someone else's typing.
  const clock = opts.now || Date.now;
  const pow = opts.powEngine || createPow({ now: clock, secret: opts.powSecret });
  const POW_BITS = opts.powDifficulty == null ? 18 : opts.powDifficulty; // 0 = not required (tests only)
  const powOn = POW_BITS > 0;
  const humanQuota = quota({ windowMs: 24 * 3600 * 1000, max: opts.signupDailyLimit || 6, code: "signup_daily_limit",
    message: "Too many accounts have been created from your network today. Try again tomorrow." });
  const agentQuota = quota({ windowMs: 24 * 3600 * 1000, max: opts.agentDailyLimit || 25, code: "agent_daily_limit",
    message: "Too many agents have been registered from your network today. Try again tomorrow." });
  const challengeLimit = limiter({ windowMs: 10 * 60 * 1000, max: opts.challengeLimit || 60, code: "challenge_rate_limited" });

  const SURGE_WINDOW_MS = 10 * 60 * 1000;
  const SURGE_HARDER = opts.surgeHarder || 40;   // sign-ups per 10 min before the puzzle gets 4x harder
  const SURGE_HARDEST = opts.surgeHardest || 120; // ... 16x harder
  const SURGE_PAUSE = opts.surgePause || 400;     // ... sign-ups pause
  const recentSignups = [];
  function signupBits() {
    const t = clock();
    while (recentSignups.length && recentSignups[0] <= t - SURGE_WINDOW_MS) recentSignups.shift();
    const n = recentSignups.length;
    if (n >= SURGE_PAUSE) {
      const err = new ApiError(503, "signups_paused", "Sign-ups are very busy right now. Try again in a few minutes.");
      err.headers = { "Retry-After": "300" };
      throw err;
    }
    return POW_BITS + (n >= SURGE_HARDEST ? 4 : n >= SURGE_HARDER ? 2 : 0);
  }
  const countSignup = () => recentSignups.push(clock());

  const LOGIN_WINDOW_MS = 15 * 60 * 1000;
  const PUZZLE_AFTER = opts.loginPuzzleAfter || 5; // wrong passwords for one username before a puzzle is needed
  // Wrong passwords before the username pauses for 15 minutes. High on purpose: a low number would let
  // anyone lock a real person out. 100 guesses per 15 minutes can't crack a reasonable password.
  const LOCK_AFTER = opts.loginLockAfter || 100;
  const loginFails = new Map(); // username -> timestamps of recent wrong passwords
  function failsFor(username) {
    const t = clock();
    const recent = (loginFails.get(username) || []).filter((x) => x > t - LOGIN_WINDOW_MS);
    if (recent.length) loginFails.set(username, recent);
    else loginFails.delete(username);
    return recent;
  }
  function recordFail(username) {
    const recent = failsFor(username);
    recent.push(clock());
    loginFails.set(username, recent.slice(-LOCK_AFTER - 5));
    if (loginFails.size > 20000) {
      for (const k of [...loginFails.keys()]) if (!failsFor(k).length) loginFails.delete(k);
      let extra = loginFails.size - 20000;
      for (const k of loginFails.keys()) { if (extra-- <= 0) break; loginFails.delete(k); }
    }
  }

  add("GET", "/challenge", { limit: challengeLimit }, ({ req }) => {
    const scope = new URL(req.url, "http://localhost").searchParams.get("scope");
    if (!["signup", "agent", "login"].includes(scope)) {
      throw new ApiError(400, "invalid_scope", 'scope must be "signup", "agent" or "login"');
    }
    const bits = scope === "login" ? POW_BITS : signupBits();
    return { body: { ...pow.issue(scope, Math.max(1, bits)), required: powOn } };
  });

  // ---- accounts ----
  add("POST", "/agents/register", { limit: registerLimit }, ({ body, ip }) => {
    store.checkAgentName(body.name);
    const bits = signupBits();
    agentQuota.check(ip);
    if (powOn) pow.verify(body.challenge, body.solution, "agent", bits);
    const agent = store.registerAgent(body.name);
    agentQuota.add(ip);
    countSignup();
    return {
      status: 201,
      body: { ...agent, currency: money.DEFAULT_CURRENCY, notice: "Save your apiKey now. It is shown only once." },
    };
  });
  add("POST", "/humans/signup", { limit: registerLimit }, async ({ body, ip }) => {
    // Hidden form field people never see. Browsers driven by bots tend to fill every input.
    if (typeof body.website === "string" && body.website.trim() !== "") {
      throw new ApiError(400, "signup_refused", "Sign-up couldn't be completed. Refresh the page and try again.");
    }
    store.checkSignup(body.username, body.password);
    const bits = signupBits();
    humanQuota.check(ip);
    if (powOn) pow.verify(body.challenge, body.solution, "signup", bits);
    const created = await store.registerHuman(body.username, body.password);
    humanQuota.add(ip);
    countSignup();
    return { status: 201, body: created };
  });
  add("POST", "/humans/login", { limit: loginLimit }, async ({ body }) => {
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase().slice(0, 40) : "";
    const fails = failsFor(username).length;
    if (fails >= LOCK_AFTER) {
      const err = new ApiError(429, "login_paused", "Too many wrong passwords for this username. Try again in 15 minutes.");
      err.headers = { "Retry-After": String(LOGIN_WINDOW_MS / 1000) };
      throw err;
    }
    if (powOn && fails >= PUZZLE_AFTER) pow.verify(body.challenge, body.solution, "login", POW_BITS);
    try {
      const result = await store.loginHuman(body.username, body.password);
      loginFails.delete(username);
      return { body: result };
    } catch (err) {
      if (err && err.code === "invalid_login") recordFail(username);
      throw err;
    }
  });
  add("POST", "/logout", { auth: true }, ({ token }) => {
    store.logout(token);
    return { body: { ok: true } };
  });
  add("GET", "/me", { auth: true }, ({ account }) => ({ body: { ...store.me(account), isOwner: Boolean(escrow && escrow.isOwner(account)) } }));

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
  add("POST", "/deals/:id/cancel", { auth: true, mutate: true }, ({ account, params }) => ({
    body: store.cancelDeal(account, params.id),
  }));

  // ---- money ----
  // Crypto: deposits to the owner's wallets, watched on chain; payouts sent by the owner and
  // checked on chain. See crypto-escrow.js.
  const escrow = opts.escrow || null;
  const needEscrow = () => {
    if (!escrow || !escrow.ready) throw new ApiError(503, "crypto_not_ready", cryptoMethods().reason);
    return escrow;
  };
  add("GET", "/crypto/methods", {}, () => ({ body: escrow ? escrow.methods() : cryptoMethods() }));
  // issueInvoice checks who's asking before whether crypto is switched on, so an outsider learns nothing.
  add("POST", "/deals/:id/crypto/invoice", { auth: true, limit: payLimit }, async ({ account, params, body }) => ({
    body: await (escrow || needEscrow()).issueInvoice(account, params.id, { asset: body.asset, refundAddress: body.refundAddress }),
  }));
  add("POST", "/deals/:id/crypto/payout-address", { auth: true, mutate: true }, ({ account, params, body }) => ({
    body: store.setCryptoPayoutAddress(account, params.id, body.address),
  }));
  add("POST", "/deals/:id/crypto/check", { auth: true, limit: payLimit }, async ({ account, params }) => ({
    body: await needEscrow().checkNow(account, params.id),
  }));

  // The owner's crypto payout queue. Only accounts named in OWNER_USERNAMES get past these.
  add("GET", "/owner/crypto", { auth: true }, ({ account }) => ({ body: needEscrow().queue(account) }));
  add("POST", "/owner/crypto/deals/:id/payout", { auth: true, limit: payLimit }, async ({ account, params, body }) => ({
    body: await needEscrow().confirmPayout(account, params.id, body.txid),
  }));
  add("POST", "/owner/crypto/deals/:id/resolve", { auth: true }, async ({ account, params, body }) => ({
    body: await needEscrow().resolve(account, params.id, body.outcome),
  }));
  add("POST", "/owner/crypto/deposits/:id/assign", { auth: true }, async ({ account, params, body }) => ({
    body: await needEscrow().assignDeposit(account, params.id, body.dealId),
  }));
  add("POST", "/owner/crypto/deposits/:id/dismiss", { auth: true }, async ({ account, params, body }) => ({
    body: await needEscrow().dismissDeposit(account, params.id, body.note),
  }));
  //
  // None of these routes move money themselves. They ask Stripe to, and record what it did.
  const payments = opts.payments;
  const needPayments = () => {
    if (!payments) throw new ApiError(503, "payments_off", "Card payments aren't switched on for this server yet.");
    return payments;
  };

  // Prices the deal and returns what the browser needs for Stripe's card form. The card details
  // go straight from the buyer's browser to Stripe; they never touch this server.
  add("POST", "/deals/:id/fund", { auth: true, mutate: true, limit: payLimit }, async ({ account, params }) => ({
    body: await needPayments().startFunding(account, params.id),
  }));

  // The buyer's browser reports that the card cleared. The webhook is authoritative, but we check
  // with Stripe here so the buyer isn't left refreshing.
  add("POST", "/deals/:id/funded", { auth: true, mutate: true, limit: payLimit }, async ({ account, params }) => ({
    body: await needPayments().confirmFunding(account, params.id),
  }));

  add("POST", "/deals/:id/deliver", { auth: true, mutate: true }, ({ account, params, body }) => ({
    body: store.markDelivered(account, params.id, body.note),
  }));

  // Card deals release through Stripe; crypto deals go to the owner's payout queue.
  const isCrypto = (account, id) => store.getDeal(account, id).rail === "crypto";
  add("POST", "/deals/:id/release", { auth: true, mutate: true }, async ({ account, params }) => ({
    body: isCrypto(account, params.id) ? await needEscrow().release(account, params.id) : await needPayments().release(account, params.id),
  }));

  add("POST", "/deals/:id/refund", { auth: true, mutate: true }, async ({ account, params, body }) => ({
    body: isCrypto(account, params.id) ? await needEscrow().refund(account, params.id) : await needPayments().refund(account, params.id, { reason: body.reason || null }),
  }));

  // ---- one-time pay links ----
  // The buyer (usually an AI agent) asks for a link and gives it to whoever will pay by card.
  // The link can only fund this one deal: no sign-in, no other access, dead once paid.
  const payLinkLimit = limiter({ windowMs: 10 * 60 * 1000, max: opts.payLinkLimit || 60, code: "pay_link_rate_limited" });
  add("POST", "/deals/:id/pay-link", { auth: true, mutate: true, limit: payLimit }, ({ account, params }) => {
    const { token, expiresAt } = store.createPayLink(account, params.id);
    return { status: 201, body: { url: `${opts.siteUrl || "https://valencemm.com"}/pay/${token}`, expiresAt,
      note: "Anyone with this link can pay this deal by card. It works once, for this deal only, and expires in 24 hours." } };
  });
  add("GET", "/pay-links/:token", { limit: payLinkLimit }, ({ params }) => ({
    body: { ...store.payLinkView(params.token), publishableKey: payments ? payments.publishableKey : null },
  }));
  add("POST", "/pay-links/:token/fund", { mutate: true, limit: payLimit }, async ({ params }) => {
    const { deal, buyer } = store.usePayLink(params.token);
    const started = await needPayments().startFunding(buyer, deal.id);
    // Only what Stripe's card form needs. Nothing about the buyer's account leaves this route.
    return { body: { clientSecret: started.clientSecret, stripeAccount: started.stripeAccount, quote: started.quote, alreadyFunded: Boolean(started.alreadyFunded) } };
  });
  add("POST", "/pay-links/:token/funded", { mutate: true, limit: payLimit }, async ({ params }) => {
    const { deal, buyer } = store.usePayLink(params.token);
    const after = await needPayments().confirmFunding(buyer, deal.id);
    return { body: { paid: ["funded", "delivered", "released"].includes(after.state) } };
  });

  add("POST", "/deals/:id/dispute", { auth: true, mutate: true }, ({ account, params, body }) => ({
    body: store.openDispute(account, params.id, body.reason),
  }));

  // ---- getting paid ----

  // Sends the seller to Stripe's own onboarding. Valence never sees their bank details or ID.
  add("POST", "/payouts/onboarding-link", { auth: true, mutate: true, limit: payLimit }, async ({ account }) => ({
    body: await needPayments().onboardingLink(account),
  }));

  add("POST", "/payouts/refresh", { auth: true, mutate: true, limit: payLimit }, async ({ account }) => ({
    body: await needPayments().refreshPayoutStatus(account),
  }));

  // Which rails this account can be paid on. Never a balance: there isn't one.
  add("GET", "/payouts", { auth: true }, ({ account }) => ({
    body: {
      ...store.payoutsStatus(account),
      enabled: Boolean(payments && payments.configured),
      publishableKey: payments ? payments.publishableKey : null,
      currency: money.DEFAULT_CURRENCY,
      holdDays: money.HOLD_DAYS,
      awaitingSetup: store.dealsAwaitingSetup(account.id),
    },
  }));

  // ---- history ----
  add("GET", "/payments", { auth: true }, ({ account }) => ({ body: store.payments(account) }));

  add("GET", "/payments.csv", { auth: true, send: true }, ({ account, res }) => {
    const { events } = store.payments(account, { limit: 5000 });
    const cell = (v) => (v == null ? "" : `"${String(v).replace(/"/g, '""')}"`);
    const rows = [["date", "event", "deal", "amount", "currency", "direction", "reference", "detail"]
      .map(cell).join(",")];
    for (const e of events) {
      rows.push([e.at, e.event, e.dealId, e.amount == null ? "" : (e.amount / 100).toFixed(2), e.currency, e.direction, e.ref, e.detail].map(cell).join(","));
    }
    const body = rows.join("\r\n") + "\r\n";
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="valence-payments-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
    });
    res.end(body);
    return {};
  });

  // ---- the webhook ----
  //
  // Stripe tells us what actually happened. Verify the signature first, answer immediately, and
  // treat every handler as something that may run more than once.
  add("POST", "/webhooks/stripe", { raw: true, send: true }, async ({ raw, req, res }) => {
    const p = opts.payments;
    let verified = opts.stripe
      ? opts.stripe.verifyWebhook(raw, req.headers["stripe-signature"])
      : { ok: false, reason: "stripe_off" };
    if (!verified.ok && opts.stripe?.acceptsPremiumWebhooks) verified = opts.stripe.verifyWebhook(raw, req.headers['stripe-signature'], { premium: true });
    if (!verified.ok) {
      console.error("Rejected a Stripe webhook:", verified.reason);
      return sendJson(res, 400, { error: { code: "bad_signature", message: "Signature check failed" } });
    }
    // Premium is persisted before acknowledging so Stripe retries failed fulfillment.
    if (await biolink.webhook(verified.event)) return sendJson(res, 200, { received: true });
    // Existing deal handlers manage their own reconciliation.
    sendJson(res, 200, { received: true });
    try {
      if (p) await p.handleWebhook(verified.event);
    } catch (err) {
      console.error("Stripe webhook handler failed:", err && err.message);
    }
    return {};
  });

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
    body: { ...store.security(account), emailAvailable: Boolean(mailer.enabled), discordLinking: supportSettings.ticketsEnabled && discord.hasInteractions, discordInvite: opts.discordInvite || DEFAULT_INVITE },
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
      discordInvite: supportSettings.discordInvite,
      ticketsEnabled: supportSettings.ticketsEnabled,
      message: supportSettings.ticketsEnabled ? null : "Website tickets are temporarily paused. Join our Discord server for support.",
      liveReplies: supportSettings.ticketsEnabled && discord.mode === "bot",
      relay: discord.mode,
      attachments: { maxFiles: MAX_FILES_PER_MESSAGE, maxBytes: MAX_BYTES, types: ["image/png", "image/jpeg", "image/gif", "image/webp"] },
      discordLinking: supportSettings.ticketsEnabled && discord.hasInteractions,
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
    if (supportSettings.ticketsEnabled) await Promise.all(open.map((v) => support.sync(store.ticketForRelay(v.id))));
    return { body: { tickets: store.listTickets(account), liveReplies: supportSettings.ticketsEnabled && discord.mode === "bot" } };
  });
  add("POST", "/tickets", { auth: true, limit: ticketLimit }, async ({ account, body }) => {
    const attachments = claimUploads(account, body.attachmentIds);
    const view = store.createTicket(account, { ...body, attachments });
    await support.openRelay(store.ticketForRelay(view.id));
    return { status: 201, body: store.getTicket(account, view.id) };
  });
  add("GET", "/tickets/:id", { auth: true }, async ({ account, params }) => {
    store.getTicket(account, params.id); // 404 before touching Discord
    if (supportSettings.ticketsEnabled) await support.sync(store.ticketForRelay(params.id));
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
  add("POST", "/account/palette", { auth: true }, ({ account, body }) => ({ body: store.setPalette(account, body.palette) }));

  handleApiRef.support = support;
  handleApiRef.discord = discord;

  return async function handleApi(req, res, apiPath) {
    const ip = ipKey(clientIp(req));
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

    // Reject paused ticket writes before reading uploads or calling relay code.
    if (!supportSettings.ticketsEnabled && req.method === "POST" &&
        (apiPath === "/uploads" || /^\/tickets(?:\/|$)/.test(apiPath))) {
      const err = new ApiError(503, "support_paused", "Website tickets are temporarily paused. Join our Discord server for support.");
      err.extra = { discordInvite: supportSettings.discordInvite };
      throw err;
    }

    let body = {};
    let raw = null;
    if (req.method === "POST") {
      if (r.raw) raw = await readRaw(req, MAX_BYTES);
      else body = await readJson(req, r.bodyLimit);
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
      cacheKey = `${account ? account.id : "anon:" + ip}|${req.method} ${apiPath}|${key}`;
      const hit = idempotencyCache.get(cacheKey);
      if (hit) return sendJson(res, hit.status, hit.body, { "Idempotent-Replay": "true" });
    }

    const result = await r.handler({ account, token, params, body, raw, req, res, ip });
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

