// Store for the Valence prototype. PLAY CREDITS ONLY, no real money.
// The working copy lives in memory; persist.js saves a snapshot to durable storage after
// every change (Cloud Storage in production) and loads it back on startup.

const crypto = require("crypto");
const { promisify } = require("util");
const { ApiError } = require("./errors");
const sec = require("./security");

const scrypt = promisify(crypto.scrypt);

const STARTING_CREDITS = 100; // welcome grant of play credits; set to 0 to require a test code instead
const FEE_BPS = 100; // 1% platform fee, charged to the receiver's payout on release
const MAX_AMOUNT = 10000;
const MAX_ACCOUNTS = 5000;
const MAX_DEALS = 20000;
const MAX_OPEN_DEALS_PER_ACCOUNT = 20;
const MAX_LEDGER_ENTRIES = 200000;
const MAX_SESSIONS = 20000;
const MAX_REDEEMED_PER_ACCOUNT = 100000;
const SESSION_MS = 7 * 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const DEAL_TYPES = ["ai-ai", "ai-human", "human-human"];
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars, no 0/O/1/I
const OPEN_STATES = new Set(["open", "joined", "funded"]);
const SNAPSHOT_SCHEMA = 1;
const TICKET_CATEGORIES = ["deal", "account", "payments", "bug", "other"];
const MAX_TICKETS = 20000;
const MAX_OPEN_TICKETS_PER_ACCOUNT = 5;
const MAX_TICKET_MESSAGES = 300;
const DAY_MS = 24 * 3600 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000; // email codes and sign-in challenges
const TOTP_SETUP_TTL_MS = 15 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const RESEND_AFTER_MS = 30 * 1000;
const MAX_CHALLENGES = 20000;
const LINK_CODE_TTL_MS = 15 * 60 * 1000;
const MAX_LINK_CODES = 5000;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const sha256Buf = (s) => crypto.createHash("sha256").update(s).digest();
const randomId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString("hex")}`;

function newInviteCode() {
  let s = "";
  for (const byte of crypto.randomBytes(8)) s += INVITE_ALPHABET[byte % 32]; // 256 % 32 === 0, so unbiased
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function cleanText(value, field, { min = 1, max }) {
  if (typeof value !== "string") throw new ApiError(400, "invalid_" + field, `${field} must be a string`);
  const v = value.trim();
  if (v.length < min || v.length > max) {
    throw new ApiError(400, "invalid_" + field, `${field} must be ${min}-${max} characters`);
  }
  return v;
}

// TEST_CREDIT_CODES="secretcode1=500,anothercode=100" -> Map(code -> credits).
// Codes must be at least 8 characters. Unset or empty disables test credits entirely.
function parseTestCodes(text) {
  const codes = new Map();
  for (const part of String(text || "").split(",")) {
    const i = part.lastIndexOf("=");
    if (i < 1) continue;
    const code = part.slice(0, i).trim();
    const amount = Number(part.slice(i + 1).trim());
    if (code.length >= 8 && Number.isInteger(amount) && amount >= 1 && amount <= MAX_REDEEMED_PER_ACCOUNT) codes.set(code, amount);
  }
  return codes;
}

function createStore({ now = () => Date.now(), testCodes = new Map() } = {}) {
  const accounts = new Map(); // accountId -> account
  const byKeyHash = new Map(); // sha256(apiKey) -> account (AI agents)
  const byUsername = new Map(); // lowercase username -> account (people)
  const sessions = new Map(); // sha256(sessionToken) -> { accountId, expiresAt }
  const deals = new Map(); // dealId -> deal
  const dealsByInvite = new Map(); // inviteCode -> dealId
  const ledger = []; // append-only
  const tickets = new Map(); // ticketId -> support ticket
  const discordLinks = new Map(); // link code -> { accountId, expiresAt } (short-lived, memory only)
  let ticketSeq = 0; // human-friendly ticket numbers (#1, #2, ...)
  const platform = { balance: 0 };
  let minted = 0; // every credit ever created (welcome grants + test codes)
  const dummySalt = crypto.randomBytes(16); // used to keep login timing similar for unknown usernames
  const challenges = new Map(); // sha256(challenge token) -> pending two-factor sign-in (memory only, 10 minutes)

  function record(account, delta, dealId, memo) {
    ledger.push({ id: ledger.length + 1, at: now(), account, delta, dealId: dealId || null, memo });
    if (ledger.length > MAX_LEDGER_ENTRIES) ledger.splice(0, ledger.length - MAX_LEDGER_ENTRIES);
  }

  function mint(account, amount, memo) {
    account.balance += amount;
    minted += amount;
    record(account.id, amount, null, memo);
  }

  function newSession(account) {
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const token = "vls_" + crypto.randomBytes(24).toString("hex");
    sessions.set(sha256(token), { accountId: account.id, expiresAt: now() + SESSION_MS });
    return token;
  }

  function publicAccount(a) {
    const out = { accountId: a.id, kind: a.kind, name: a.name, balance: a.balance, currency: "play-credits" };
    if (a.username) out.username = a.username;
    return out;
  }

  function openDealCount(accountId) {
    let n = 0;
    for (const d of deals.values()) {
      if ((d.buyerId === accountId || d.sellerId === accountId) && OPEN_STATES.has(d.state)) n++;
    }
    return n;
  }

  function setState(deal, state, byId) {
    deal.state = state;
    deal.history.push({ at: now(), state, by: byId });
  }

  function party(id) {
    const a = id && accounts.get(id);
    return a ? { id: a.id, name: a.name, kind: a.kind } : null;
  }

  function view(deal, viewerId) {
    const role = deal.buyerId === viewerId ? "buyer" : deal.sellerId === viewerId ? "seller" : null;
    const out = {
      id: deal.id,
      type: deal.type,
      title: deal.title,
      description: deal.description,
      amount: deal.amount,
      feeBps: FEE_BPS,
      deadlineHours: deal.deadlineHours,
      state: deal.state,
      yourRole: role,
      buyerId: deal.buyerId,
      sellerId: deal.sellerId,
      buyer: party(deal.buyerId),
      seller: party(deal.sellerId),
      createdAt: new Date(deal.createdAt).toISOString(),
      fundedAt: deal.fundedAt ? new Date(deal.fundedAt).toISOString() : null,
      deadlineAt: deal.deadlineAt ? new Date(deal.deadlineAt).toISOString() : null,
      history: deal.history.map((h) => ({ at: new Date(h.at).toISOString(), state: h.state, by: h.by })),
    };
    if (deal.state === "open") out.joinKind = deal.joinKind; // who may join: "agent" or "human"
    // Only the creator sees the invite code, and only until someone joins.
    if (deal.state === "open" && deal.creatorId === viewerId) out.inviteCode = deal.inviteCode;
    return out;
  }

  function mustGetDeal(account, dealId) {
    const deal = deals.get(dealId);
    // Same error whether the deal is missing or belongs to others, so ids can't be probed.
    if (!deal || (deal.buyerId !== account.id && deal.sellerId !== account.id)) {
      throw new ApiError(404, "deal_not_found", "Deal not found");
    }
    return deal;
  }

  function ticketView(t) {
    return {
      id: t.id,
      number: t.number,
      category: t.category,
      subject: t.subject,
      dealId: t.dealId || null,
      status: t.status,
      createdAt: new Date(t.createdAt).toISOString(),
      updatedAt: new Date(t.updatedAt).toISOString(),
      // Customers see the role only; who it was is kept for the owner's records.
      claimedBy: t.claimedBy ? { role: t.claimedBy.role, at: new Date(t.claimedBy.at).toISOString() } : null,
      messages: t.messages.map((m) => ({
        id: m.id, from: m.from, author: m.author, text: m.text, at: new Date(m.at).toISOString(),
        attachments: (m.attachments || []).map((a) => ({ id: a.id, name: a.name, contentType: a.contentType, size: a.size })),
      })),
    };
  }

  function mustGetTicket(account, ticketId) {
    const t = tickets.get(ticketId);
    if (!t || t.accountId !== account.id) throw new ApiError(404, "ticket_not_found", "Ticket not found");
    return t;
  }

  function pushTicketMessage(t, from, author, text, extra = {}) {
    const msg = { id: t.messages.length + 1, from, author, text, at: now(), ...extra };
    t.messages.push(msg);
    if (t.messages.length > MAX_TICKET_MESSAGES) t.messages.splice(0, t.messages.length - MAX_TICKET_MESSAGES);
    t.updatedAt = msg.at;
    return msg;
  }

  function claim(t, who) {
    t.claimedBy = { discordUserId: who.discordUserId, name: who.author, role: who.role || "Support", at: now() };
    // Customers see the role, never the staff member's Discord name.
    pushTicketMessage(t, "system", "Valence", `${t.claimedBy.role === "Owner" ? "The owner" : "A support agent"} is handling this ticket.`);
    noteHandler(t, who);
  }
  function noteHandler(t, who) {
    if (!t.handlers) t.handlers = [];
    if (!t.handlers.some((h) => h.discordUserId === who.discordUserId)) {
      t.handlers.push({ discordUserId: who.discordUserId, name: who.author, role: who.role || "Support", at: now() });
    }
  }

  function releasedAt(deal) {
    for (let i = deal.history.length - 1; i >= 0; i--) if (deal.history[i].state === "released") return deal.history[i].at;
    return null;
  }

  // ---- two-factor helpers ----
  async function passwordMatches(a, password) {
    if (typeof password !== "string" || password.length > 128 || !a.salt) return false;
    const hash = await scrypt(password, a.salt, 64);
    return crypto.timingSafeEqual(hash, a.hash);
  }
  async function mustHavePassword(a, password) {
    if (!(await passwordMatches(a, password))) throw new ApiError(401, "invalid_login", "Your password isn't right");
  }
  function mustBeHuman(a) {
    if (a.kind !== "human") throw new ApiError(403, "wrong_account_type", "AI agents sign in with API keys, so these settings are for people only");
  }
  function twoFactorMethods(a) {
    const m = [];
    if (a.totp && a.totp.enabled) m.push("app");
    if (a.email2fa && a.emailVerified) m.push("email");
    if (m.length && (a.recovery || []).length) m.push("recovery");
    return m;
  }
  function maskEmail(email) {
    if (!email) return null;
    const [user, domain] = email.split("@");
    return `${user.slice(0, 2)}${"*".repeat(Math.max(1, Math.min(6, user.length - 2)))}@${domain}`;
  }
  function securityView(a) {
    return {
      discord: a.discord ? { username: a.discord.username, linkedAt: new Date(a.discord.linkedAt).toISOString() } : null,
      email: a.email || null,
      emailVerified: Boolean(a.emailVerified),
      pendingEmail: a.emailPending && a.emailPending.expiresAt > now() ? a.emailPending.email : null,
      twoFactor: { app: Boolean(a.totp && a.totp.enabled), email: Boolean(a.email2fa && a.emailVerified), recoveryCodesLeft: (a.recovery || []).length },
    };
  }
  function ensureRecoveryCodes(a) {
    if ((a.recovery || []).length) return null; // keep the ones they already saved
    const codes = sec.newRecoveryCodes();
    a.recovery = codes.map((c) => sec.hashCode(a.id, sec.normalizeRecovery(c)));
    return codes;
  }
  function useRecoveryCode(a, code) {
    const h = sec.hashCode(a.id, sec.normalizeRecovery(code));
    const i = (a.recovery || []).findIndex((x) => sec.safeEqual(x, h));
    if (i === -1) return false;
    a.recovery.splice(i, 1); // each code works once
    return true;
  }
  function mustGetChallenge(token) {
    const key = typeof token === "string" && token.startsWith("vlt_") ? sha256(token) : null;
    const c = key && challenges.get(key);
    if (!c || c.expiresAt <= now()) {
      if (key) challenges.delete(key);
      throw new ApiError(401, "challenge_expired", "Your sign-in timed out. Enter your password again.");
    }
    const a = accounts.get(c.accountId);
    if (!a) throw new ApiError(401, "challenge_expired", "Your sign-in timed out. Enter your password again.");
    return { c, a, key };
  }

  function checkCapacity() {
    if (accounts.size >= MAX_ACCOUNTS) throw new ApiError(503, "capacity", "Prototype is full, try again later");
  }

  return {
    registerAgent(rawName) {
      const name = cleanText(rawName, "name", { max: 50 });
      checkCapacity();
      const apiKey = "vlc_" + crypto.randomBytes(24).toString("hex");
      const agent = { id: randomId("agent"), kind: "agent", name, createdAt: now(), balance: 0, redeemed: 0, keyHash: sha256(apiKey) };
      accounts.set(agent.id, agent);
      byKeyHash.set(agent.keyHash, agent);
      mint(agent, STARTING_CREDITS, "play-credit welcome grant");
      return { agentId: agent.id, accountId: agent.id, kind: "agent", name: agent.name, apiKey, balance: agent.balance };
    },

    async registerHuman(rawUsername, password) {
      const username = typeof rawUsername === "string" ? rawUsername.trim().toLowerCase() : "";
      if (!/^[a-z0-9_]{3,20}$/.test(username)) {
        throw new ApiError(400, "invalid_username", "Username must be 3-20 letters, numbers or underscores");
      }
      if (typeof password !== "string" || password.length < 8 || password.length > 128) {
        throw new ApiError(400, "invalid_password", "Password must be 8-128 characters");
      }
      checkCapacity();
      if (byUsername.has(username)) throw new ApiError(409, "username_taken", "That username is taken");
      const salt = crypto.randomBytes(16);
      const hash = await scrypt(password, salt, 64);
      // re-check after the await: another signup may have claimed the name meanwhile
      if (byUsername.has(username)) throw new ApiError(409, "username_taken", "That username is taken");
      checkCapacity();
      const person = { id: randomId("user"), kind: "human", name: username, username, createdAt: now(), balance: 0, redeemed: 0, salt, hash };
      accounts.set(person.id, person);
      byUsername.set(username, person);
      mint(person, STARTING_CREDITS, "play-credit welcome grant");
      return { token: newSession(person), account: publicAccount(person) };
    },

    async loginHuman(rawUsername, password) {
      const fail = () => new ApiError(401, "invalid_login", "Wrong username or password");
      const username = typeof rawUsername === "string" ? rawUsername.trim().toLowerCase() : "";
      if (typeof password !== "string" || password.length > 128) throw fail();
      const person = byUsername.get(username);
      if (!person) {
        await scrypt(password, dummySalt, 64); // spend similar time so usernames can't be probed by timing
        throw fail();
      }
      if (!(await passwordMatches(person, password))) throw fail();
      const methods = twoFactorMethods(person);
      if (methods.length) {
        // Password was right, but a second step is needed before we hand out a session.
        if (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value);
        const challenge = "vlt_" + crypto.randomBytes(24).toString("hex");
        challenges.set(sha256(challenge), { accountId: person.id, expiresAt: now() + CODE_TTL_MS, attempts: 0, email: null });
        return { twoFactorRequired: true, challenge, methods, emailHint: person.email2fa ? maskEmail(person.email) : null };
      }
      return { token: newSession(person), account: publicAccount(person) };
    },

    // Step 2 of signing in with two-factor on: send an email code for this challenge.
    loginEmailCode(challengeToken) {
      const { c, a } = mustGetChallenge(challengeToken);
      if (!a.email2fa || !a.emailVerified) throw new ApiError(400, "method_unavailable", "Email codes aren't turned on for this account");
      if (c.email && now() - c.email.sentAt < RESEND_AFTER_MS) throw new ApiError(429, "too_soon", "Wait a few seconds before asking for another code");
      const code = sec.newNumericCode();
      c.email = { hash: sec.hashCode(a.id, code), sentAt: now(), expiresAt: now() + CODE_TTL_MS };
      return { to: a.email, code, username: a.name, emailHint: maskEmail(a.email) };
    },

    // Step 2 of signing in: check the code and hand out the session.
    completeLogin(challengeToken, method, rawCode) {
      const { c, a, key } = mustGetChallenge(challengeToken);
      c.attempts++;
      if (c.attempts > MAX_CODE_ATTEMPTS) {
        challenges.delete(key);
        throw new ApiError(429, "too_many_attempts", "Too many wrong codes. Log in again to get a new chance.");
      }
      const code = String(rawCode || "").trim();
      let ok = false;
      if (method === "app" && a.totp && a.totp.enabled) {
        const step = sec.verifyTotp(a.totp.secret, code, now(), a.totp.lastStep);
        if (step !== null) { a.totp.lastStep = step; ok = true; }
      } else if (method === "email" && a.email2fa && c.email) {
        ok = c.email.expiresAt > now() && sec.safeEqual(c.email.hash, sec.hashCode(a.id, code.replace(/\s+/g, "")));
        if (c.email.expiresAt <= now()) throw new ApiError(400, "code_expired", "That code has expired. Send a new one.");
      } else if (method === "recovery") {
        ok = useRecoveryCode(a, code);
      } else {
        throw new ApiError(400, "invalid_method", "Choose the authenticator app, an email code or a recovery code");
      }
      if (!ok) throw new ApiError(401, "invalid_code", "That code isn't right. Check it and try again.");
      challenges.delete(key);
      return { token: newSession(a), account: publicAccount(a), recoveryCodesLeft: (a.recovery || []).length };
    },

    // ---- people: email and two-factor settings ----
    security(account) {
      mustBeHuman(account);
      return securityView(account);
    },

    startEmailVerification(account, rawEmail) {
      mustBeHuman(account);
      const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
      if (!EMAIL_RE.test(email) || email.length > 254) throw new ApiError(400, "invalid_email", "Enter a valid email address");
      for (const other of accounts.values()) {
        if (other !== account && other.emailVerified && other.email === email) throw new ApiError(409, "email_in_use", "That email is already used by another account");
      }
      const p = account.emailPending;
      if (p && p.email === email && now() - p.sentAt < RESEND_AFTER_MS) throw new ApiError(429, "too_soon", "Wait a few seconds before asking for another code");
      const code = sec.newNumericCode();
      account.emailPending = { email, hash: sec.hashCode(account.id, code), sentAt: now(), expiresAt: now() + CODE_TTL_MS, attempts: 0 };
      return { to: email, code, username: account.name };
    },

    confirmEmail(account, rawCode) {
      mustBeHuman(account);
      const p = account.emailPending;
      if (!p) throw new ApiError(400, "no_pending_email", "Add an email address first");
      if (p.expiresAt <= now()) throw new ApiError(400, "code_expired", "That code has expired. Send a new one.");
      p.attempts++;
      if (p.attempts > MAX_CODE_ATTEMPTS) {
        delete account.emailPending;
        throw new ApiError(429, "too_many_attempts", "Too many wrong codes. Send a new one.");
      }
      const code = String(rawCode || "").replace(/\s+/g, "");
      if (!sec.safeEqual(p.hash, sec.hashCode(account.id, code))) throw new ApiError(401, "invalid_code", "That code isn't right. Check it and try again.");
      account.email = p.email;
      account.emailVerified = true;
      delete account.emailPending;
      return securityView(account);
    },

    async removeEmail(account, password) {
      mustBeHuman(account);
      await mustHavePassword(account, password);
      account.email = null;
      account.emailVerified = false;
      account.email2fa = false;
      delete account.emailPending;
      if (!twoFactorMethods(account).length) account.recovery = [];
      return securityView(account);
    },

    totpSetup(account) {
      mustBeHuman(account);
      if (account.totp && account.totp.enabled) throw new ApiError(409, "already_enabled", "The authenticator app is already set up. Turn it off first to switch phones.");
      const secret = sec.newTotpSecret();
      account.totpPending = { secret, expiresAt: now() + TOTP_SETUP_TTL_MS };
      return { secret, otpauthUrl: sec.otpauthUrl({ secret, account: account.username }) };
    },

    totpEnable(account, code) {
      mustBeHuman(account);
      const p = account.totpPending;
      if (!p || p.expiresAt <= now()) throw new ApiError(400, "setup_expired", "Setup timed out. Start again to get a new QR code.");
      const step = sec.verifyTotp(p.secret, code, now());
      if (step === null) throw new ApiError(401, "invalid_code", "That code doesn't match. Check your phone's clock and try the newest code.");
      account.totp = { secret: p.secret, enabled: true, lastStep: step, enabledAt: now() };
      delete account.totpPending;
      const recoveryCodes = ensureRecoveryCodes(account); // make the codes first so the counts below include them
      return { ...securityView(account), recoveryCodes };
    },

    async totpDisable(account, password) {
      mustBeHuman(account);
      await mustHavePassword(account, password);
      account.totp = null;
      if (!twoFactorMethods(account).length) account.recovery = [];
      return securityView(account);
    },

    async setEmailTwoFactor(account, enable, password) {
      mustBeHuman(account);
      await mustHavePassword(account, password);
      if (enable) {
        if (!account.emailVerified) throw new ApiError(400, "email_not_verified", "Verify your email address first");
        account.email2fa = true;
        const recoveryCodes = ensureRecoveryCodes(account); // make the codes first so the counts below include them
      return { ...securityView(account), recoveryCodes };
      }
      account.email2fa = false;
      if (!twoFactorMethods(account).length) account.recovery = [];
      return securityView(account);
    },

    async newRecoveryCodes(account, password) {
      mustBeHuman(account);
      await mustHavePassword(account, password);
      if (!twoFactorMethods(account).length) throw new ApiError(400, "two_factor_off", "Turn on two-factor first");
      account.recovery = [];
      const recoveryCodes = ensureRecoveryCodes(account); // make the codes first so the counts below include them
      return { ...securityView(account), recoveryCodes };
    },

    // Accepts an AI agent API key (vlc_...) or a person's session token (vls_...).
    authenticate(token) {
      if (typeof token !== "string" || token.length > 100) return null;
      if (token.startsWith("vlc_")) return byKeyHash.get(sha256(token)) || null;
      if (token.startsWith("vls_")) {
        const h = sha256(token);
        const s = sessions.get(h);
        if (!s) return null;
        if (s.expiresAt <= now()) {
          sessions.delete(h);
          return null;
        }
        return accounts.get(s.accountId) || null;
      }
      return null;
    },

    logout(token) {
      if (typeof token === "string" && token.startsWith("vls_")) sessions.delete(sha256(token));
    },

    me(account) {
      const recent = ledger.filter((e) => e.account === account.id).slice(-20).reverse();
      return {
        ...publicAccount(account),
        ...(account.kind === "human" ? { security: securityView(account) } : {}),
        recentLedger: recent.map((e) => ({ at: new Date(e.at).toISOString(), delta: e.delta, dealId: e.dealId, memo: e.memo })),
      };
    },

    // Test-only stand-in for depositing money: a secret code from the server's environment adds credits.
    redeemCredits(account, rawCode) {
      if (testCodes.size === 0) throw new ApiError(404, "redeem_disabled", "Test credits are not turned on for this server");
      const given = sha256Buf(typeof rawCode === "string" ? rawCode.trim() : "");
      let amount = null;
      for (const [code, credits] of testCodes) {
        if (crypto.timingSafeEqual(given, sha256Buf(code)) && amount === null) amount = credits;
      }
      if (amount === null) throw new ApiError(400, "invalid_code", "That code isn't valid");
      if (account.redeemed + amount > MAX_REDEEMED_PER_ACCOUNT) {
        throw new ApiError(409, "redeem_limit", "This account has reached the test credit limit");
      }
      account.redeemed += amount;
      mint(account, amount, "test credits (code redeemed)");
      return { added: amount, balance: account.balance };
    },

    createDeal(account, input) {
      const title = cleanText(input.title, "title", { max: 100 });
      const description = input.description == null ? "" : cleanText(input.description, "description", { min: 0, max: 500 });
      const amount = input.amount;
      if (!Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT) {
        throw new ApiError(400, "invalid_amount", `amount must be a whole number of credits from 1 to ${MAX_AMOUNT}`);
      }
      const role = input.role == null ? "buyer" : input.role;
      if (role !== "buyer" && role !== "seller") throw new ApiError(400, "invalid_role", 'role must be "buyer" or "seller"');
      const deadlineHours = input.deadlineHours == null ? 72 : input.deadlineHours;
      if (!Number.isInteger(deadlineHours) || deadlineHours < 1 || deadlineHours > 720) {
        throw new ApiError(400, "invalid_deadline", "deadlineHours must be a whole number from 1 to 720");
      }
      const type = input.type == null ? (account.kind === "agent" ? "ai-ai" : "human-human") : input.type;
      if (!DEAL_TYPES.includes(type)) throw new ApiError(400, "invalid_type", `type must be one of: ${DEAL_TYPES.join(", ")}`);
      if (type === "ai-ai" && account.kind !== "agent") {
        throw new ApiError(403, "wrong_account_type", "Only AI agents can create AI-to-AI deals");
      }
      if (type === "human-human" && account.kind !== "human") {
        throw new ApiError(403, "wrong_account_type", "Only people can create human-to-human deals");
      }
      const joinKind = type === "ai-ai" ? "agent" : type === "human-human" ? "human" : account.kind === "agent" ? "human" : "agent";
      if (deals.size >= MAX_DEALS) throw new ApiError(503, "capacity", "Prototype is full, try again later");
      if (openDealCount(account.id) >= MAX_OPEN_DEALS_PER_ACCOUNT) {
        throw new ApiError(429, "too_many_open_deals", `You can have at most ${MAX_OPEN_DEALS_PER_ACCOUNT} unfinished deals`);
      }
      let code;
      do code = newInviteCode(); while (dealsByInvite.has(code));
      const deal = {
        id: randomId("deal"), type, joinKind, title, description, amount, deadlineHours,
        state: "open", creatorId: account.id,
        buyerId: role === "buyer" ? account.id : null,
        sellerId: role === "seller" ? account.id : null,
        inviteCode: code, createdAt: now(), fundedAt: null, deadlineAt: null,
        history: [{ at: now(), state: "open", by: account.id }],
      };
      deals.set(deal.id, deal);
      dealsByInvite.set(code, deal.id);
      return view(deal, account.id);
    },

    joinDeal(account, rawCode) {
      const code = typeof rawCode === "string" ? rawCode.trim().toUpperCase() : "";
      const deal = deals.get(dealsByInvite.get(code));
      if (!deal) throw new ApiError(404, "invalid_invite", "Invite code not found or already used");
      if (deal.creatorId === account.id) throw new ApiError(400, "own_deal", "You can't join your own deal");
      if (account.kind !== deal.joinKind) {
        throw new ApiError(403, "wrong_account_type", `This deal is for ${deal.joinKind === "agent" ? "an AI agent" : "a person"} to join`);
      }
      if (openDealCount(account.id) >= MAX_OPEN_DEALS_PER_ACCOUNT) {
        throw new ApiError(429, "too_many_open_deals", `You can have at most ${MAX_OPEN_DEALS_PER_ACCOUNT} unfinished deals`);
      }
      if (deal.buyerId === null) deal.buyerId = account.id;
      else deal.sellerId = account.id;
      dealsByInvite.delete(code); // single use
      setState(deal, "joined", account.id);
      return view(deal, account.id);
    },

    getDeal(account, dealId) {
      return view(mustGetDeal(account, dealId), account.id);
    },

    listDeals(account) {
      return [...deals.values()]
        .filter((d) => d.buyerId === account.id || d.sellerId === account.id)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 100)
        .map((d) => view(d, account.id));
    },

    fundDeal(account, dealId) {
      const deal = mustGetDeal(account, dealId);
      if (deal.buyerId !== account.id) throw new ApiError(403, "not_buyer", "Only the buyer (sender) can fund the deal");
      if (deal.state !== "joined") throw new ApiError(409, "bad_state", `Deal is ${deal.state}; it must be "joined" to fund`);
      if (account.balance < deal.amount) throw new ApiError(402, "insufficient_credits", "Not enough play credits");
      account.balance -= deal.amount;
      record(account.id, -deal.amount, deal.id, "deposit into escrow");
      record("escrow:" + deal.id, deal.amount, deal.id, "escrow funded");
      deal.fundedAt = now();
      deal.deadlineAt = deal.fundedAt + deal.deadlineHours * HOUR_MS;
      setState(deal, "funded", account.id);
      return view(deal, account.id);
    },

    releaseDeal(account, dealId) {
      const deal = mustGetDeal(account, dealId);
      if (deal.buyerId !== account.id) throw new ApiError(403, "not_buyer", "Only the buyer (sender) can release the funds");
      if (deal.state !== "funded") throw new ApiError(409, "bad_state", `Deal is ${deal.state}; it must be "funded" to release`);
      const seller = accounts.get(deal.sellerId);
      const fee = Math.floor((deal.amount * FEE_BPS) / 10000);
      const payout = deal.amount - fee;
      record("escrow:" + deal.id, -deal.amount, deal.id, "escrow released");
      seller.balance += payout;
      record(seller.id, payout, deal.id, "deal payout");
      if (fee > 0) {
        platform.balance += fee;
        record("platform", fee, deal.id, "platform fee");
      }
      setState(deal, "released", account.id);
      return view(deal, account.id);
    },

    refundDeal(account, dealId) {
      const deal = mustGetDeal(account, dealId);
      if (deal.state !== "funded") throw new ApiError(409, "bad_state", `Deal is ${deal.state}; it must be "funded" to refund`);
      const isSeller = deal.sellerId === account.id;
      if (!isSeller && now() < deal.deadlineAt) {
        throw new ApiError(403, "deadline_not_reached", "The buyer can only claim a refund after the deadline; the seller can refund any time");
      }
      const buyer = accounts.get(deal.buyerId);
      record("escrow:" + deal.id, -deal.amount, deal.id, "escrow refunded");
      buyer.balance += deal.amount;
      record(buyer.id, deal.amount, deal.id, "deal refund");
      setState(deal, "refunded", account.id);
      return view(deal, account.id);
    },

    cancelDeal(account, dealId) {
      const deal = mustGetDeal(account, dealId);
      if (deal.state !== "open" && deal.state !== "joined") {
        throw new ApiError(409, "bad_state", `Deal is ${deal.state}; only unfunded deals can be cancelled`);
      }
      dealsByInvite.delete(deal.inviteCode);
      setState(deal, "cancelled", account.id);
      return view(deal, account.id);
    },

    // ---- people: change password ----
    async changePassword(account, currentToken, currentPassword, newPassword) {
      if (account.kind !== "human") throw new ApiError(403, "wrong_account_type", "AI agents use API keys, not passwords");
      if (typeof newPassword !== "string" || newPassword.length < 8 || newPassword.length > 128) {
        throw new ApiError(400, "invalid_password", "New password must be 8-128 characters");
      }
      if (typeof currentPassword !== "string" || currentPassword.length > 128) throw new ApiError(401, "invalid_login", "Current password is wrong");
      const check = await scrypt(currentPassword, account.salt, 64);
      if (!crypto.timingSafeEqual(check, account.hash)) throw new ApiError(401, "invalid_login", "Current password is wrong");
      const salt = crypto.randomBytes(16);
      account.hash = await scrypt(newPassword, salt, 64);
      account.salt = salt;
      // sign out every other browser; keep this one
      const keep = typeof currentToken === "string" ? sha256(currentToken) : null;
      for (const [h, s] of sessions) if (s.accountId === account.id && h !== keep) sessions.delete(h);
      return { ok: true };
    },

    // ---- deals: look before you join ----
    invitePreview(account, rawCode) {
      const code = typeof rawCode === "string" ? rawCode.trim().toUpperCase() : "";
      const deal = deals.get(dealsByInvite.get(code));
      if (!deal) throw new ApiError(404, "invalid_invite", "Invite code not found or already used");
      const creator = party(deal.creatorId);
      let canJoin = true;
      let reason = null;
      if (deal.creatorId === account.id) { canJoin = false; reason = "This is your own deal."; }
      else if (account.kind !== deal.joinKind) { canJoin = false; reason = `This deal is for ${deal.joinKind === "agent" ? "an AI agent" : "a person"} to join.`; }
      return {
        inviteCode: code,
        type: deal.type,
        title: deal.title,
        description: deal.description,
        amount: deal.amount,
        feeBps: FEE_BPS,
        deadlineHours: deal.deadlineHours,
        creator,
        creatorRole: deal.buyerId === deal.creatorId ? "buyer" : "seller",
        yourRole: deal.buyerId === null ? "buyer" : "seller",
        canJoin,
        reason,
      };
    },

    // ---- stats for the dashboard ----
    stats(account, { days = 30 } = {}) {
      const mine = [...deals.values()].filter((d) => d.buyerId === account.id || d.sellerId === account.id);
      const counts = { open: 0, joined: 0, funded: 0, released: 0, refunded: 0, cancelled: 0 };
      let sent = 0, received = 0, feesPaid = 0, inEscrow = 0;
      const toRelease = []; // ms from creation to release
      const fundedToRelease = []; // ms from funding to release
      const start = now() - (days - 1) * DAY_MS;
      const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
      const series = new Map();
      for (let i = 0; i < days; i++) series.set(dayKey(start + i * DAY_MS), { date: dayKey(start + i * DAY_MS), volume: 0, deals: 0 });
      for (const d of mine) {
        counts[d.state]++;
        if (d.state === "funded") inEscrow += d.amount;
        if (d.state !== "released") continue;
        const fee = Math.floor((d.amount * FEE_BPS) / 10000);
        if (d.buyerId === account.id) sent += d.amount;
        else { received += d.amount - fee; feesPaid += fee; }
        const at = releasedAt(d);
        if (at) {
          toRelease.push(at - d.createdAt);
          if (d.fundedAt) fundedToRelease.push(at - d.fundedAt);
          const bucket = series.get(dayKey(at));
          if (bucket) { bucket.volume += d.amount; bucket.deals += 1; }
        }
      }
      const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
      const median = (xs) => {
        if (!xs.length) return null;
        const s = [...xs].sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
      };
      const finished = counts.released + counts.refunded + counts.cancelled;
      return {
        currency: "play-credits",
        totalDeals: mine.length,
        counts,
        active: counts.open + counts.joined + counts.funded,
        volume: { total: sent + received + feesPaid, sent, received, feesPaid, inEscrow },
        completionRate: finished ? counts.released / finished : null,
        durationMs: {
          avgCreatedToReleased: avg(toRelease),
          medianCreatedToReleased: median(toRelease),
          avgFundedToReleased: avg(fundedToRelease),
          fastest: toRelease.length ? Math.min(...toRelease) : null,
        },
        daily: [...series.values()],
      };
    },

    // ---- support tickets ----
    createTicket(account, input) {
      const category = input.category == null ? "other" : input.category;
      if (!TICKET_CATEGORIES.includes(category)) throw new ApiError(400, "invalid_category", `category must be one of: ${TICKET_CATEGORIES.join(", ")}`);
      const subject = cleanText(input.subject, "subject", { min: 3, max: 100 });
      const message = cleanText(input.message, "message", { min: 5, max: 2000 });
      const dealId = input.dealId == null || input.dealId === "" ? null : cleanText(input.dealId, "dealId", { max: 40 });
      if (tickets.size >= MAX_TICKETS) throw new ApiError(503, "capacity", "Support is full right now, try the Discord server");
      let open = 0;
      for (const t of tickets.values()) if (t.accountId === account.id && t.status === "open") open++;
      if (open >= MAX_OPEN_TICKETS_PER_ACCOUNT) {
        throw new ApiError(429, "too_many_tickets", `You can have at most ${MAX_OPEN_TICKETS_PER_ACCOUNT} open tickets. Close one first.`);
      }
      const t = {
        id: randomId("tkt"), number: ++ticketSeq, accountId: account.id, category, subject, dealId,
        status: "open", createdAt: now(), updatedAt: now(), messages: [], discord: null, claimedBy: null, handlers: [],
      };
      pushTicketMessage(t, "user", account.name, message, { attachments: input.attachments || [] });
      tickets.set(t.id, t);
      return ticketView(t);
    },

    listTickets(account) {
      return [...tickets.values()]
        .filter((t) => t.accountId === account.id)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((t) => {
          const v = ticketView(t);
          const last = v.messages[v.messages.length - 1];
          delete v.messages;
          v.lastMessage = last ? { from: last.from, text: last.text.slice(0, 140), at: last.at } : null;
          return v;
        });
    },

    getTicket(account, ticketId) {
      return ticketView(mustGetTicket(account, ticketId));
    },

    addTicketMessage(account, ticketId, rawText, attachments = []) {
      const t = mustGetTicket(account, ticketId);
      if (t.status !== "open") throw new ApiError(409, "ticket_closed", "This ticket is closed. Open a new one if you still need help.");
      // A message can be just an image, so text is only required when nothing is attached.
      const text = cleanText(rawText, "message", { min: attachments.length ? 0 : 1, max: 2000 });
      const msg = pushTicketMessage(t, "user", account.name, text, { attachments });
      return { ticket: ticketView(t), message: { id: msg.id, text: msg.text, attachments: msg.attachments } };
    },

    // Finds the attachment and checks the person asking is allowed to see it.
    ticketAttachment(account, ticketId, attachmentId) {
      const t = mustGetTicket(account, ticketId);
      for (const m of t.messages) {
        for (const a of m.attachments || []) if (a.id === attachmentId) return a;
      }
      throw new ApiError(404, "attachment_not_found", "Attachment not found");
    },

    closeTicket(account, ticketId) {
      const t = mustGetTicket(account, ticketId);
      if (t.status === "open") {
        t.status = "closed";
        t.closedAt = now();
        t.closedBy = "customer";
        pushTicketMessage(t, "system", "Valence", "You closed this ticket.");
      }
      return ticketView(t);
    },

    // A plain-text record of the whole conversation, for the customer and for the Discord log.
    // includeStaffNames is for the owner's copy; the customer's copy shows roles only.
    transcriptData(ticketOrId, { includeStaffNames = false } = {}) {
      const t = typeof ticketOrId === "string" ? tickets.get(ticketOrId) : ticketOrId;
      if (!t) throw new ApiError(404, "ticket_not_found", "Ticket not found");
      const a = accounts.get(t.accountId);
      return {
        id: t.id,
        number: t.number,
        subject: t.subject,
        category: t.category,
        dealId: t.dealId || null,
        status: t.status,
        customer: a ? { name: a.name, kind: a.kind, discord: a.discord ? a.discord.username : null } : { name: "unknown", kind: "human", discord: null },
        claimedBy: t.claimedBy ? { name: includeStaffNames ? t.claimedBy.name : t.claimedBy.role, role: t.claimedBy.role, at: new Date(t.claimedBy.at).toISOString() } : null,
        handlers: (t.handlers || []).map((h) => ({ name: includeStaffNames ? h.name : h.role, role: h.role })),
        openedAt: new Date(t.createdAt).toISOString(),
        closedAt: t.closedAt ? new Date(t.closedAt).toISOString() : null,
        closedBy: t.closedBy || null,
        messages: ticketView(t).messages,
      };
    },

    // Used by the Discord relay only (no account checks: the caller already holds the ticket).
    ticketForRelay(ticketId) {
      return tickets.get(ticketId) || null;
    },
    ticketByChannel(channelId) {
      for (const t of tickets.values()) if (t.discord && t.discord.channelId === channelId) return t;
      return null;
    },
    ticketOwnerName(t) {
      const a = accounts.get(t.accountId);
      return a ? `${a.name} (${a.kind === "agent" ? "AI agent" : "person"})` : "unknown";
    },
    setTicketDiscord(t, patch) {
      t.discord = { ...(t.discord || {}), ...patch };
    },
    // Staff messages pulled from the ticket's Discord channel.
    // Each one carries { author, role, text, attachments, discordUserId }. Support agents must
    // claim the ticket first, so every reply has a name against it; the owner claims by replying.
    addStaffMessages(t, msgs) {
      const result = { added: 0, needClaim: [] };
      for (const m of msgs) {
        if (t.status !== "open") continue;
        const text = String(m.text || "").slice(0, 4000);
        if (!text.trim() && !(m.attachments || []).length) continue;
        if (!t.claimedBy) {
          if (m.role !== "Owner") {
            if (!result.needClaim.some((x) => x.discordUserId === m.discordUserId)) result.needClaim.push(m);
            continue; // not relayed: the agent has to claim first
          }
          claim(t, m); // the owner claims by replying
        }
        pushTicketMessage(t, "staff", m.role || m.author || "Support", text, { attachments: m.attachments || [], staffId: m.discordUserId });
        noteHandler(t, m);
        result.added++;
      }
      return result;
    },

    claimTicket(t, who) {
      if (t.status !== "open") return { ok: false, reason: "This ticket is already closed." };
      if (t.claimedBy && t.claimedBy.discordUserId !== who.discordUserId) {
        return { ok: false, reason: `Already claimed by ${t.claimedBy.name}.`, claimedBy: t.claimedBy };
      }
      claim(t, who);
      return { ok: true, claimedBy: t.claimedBy };
    },

    releaseTicket(t) {
      if (!t.claimedBy) return { ok: false, reason: "Nobody has claimed this ticket." };
      const was = t.claimedBy;
      t.claimedBy = null;
      pushTicketMessage(t, "system", "Valence", "Support handed this ticket back to the queue.");
      return { ok: true, was };
    },

    closeTicketByStaff(t, who, reason) {
      if (t.status !== "open") return { ok: false, reason: "This ticket is already closed." };
      if (who && !t.claimedBy) claim(t, who);
      t.status = "closed";
      t.closedAt = now();
      t.closedBy = who ? `${who.role || "Support"} (${who.author})` : "support";
      if (who) noteHandler(t, who);
      pushTicketMessage(t, "system", "Valence", reason ? `Support closed this ticket: ${reason}` : "Support closed this ticket.");
      return { ok: true };
    },

    // ---- linking a Discord account ----
    startDiscordLink(account) {
      if (account.discord) throw new ApiError(409, "already_linked", "This account is already linked to a Discord account");
      for (const [code, link] of discordLinks) if (link.accountId === account.id) discordLinks.delete(code);
      if (discordLinks.size >= MAX_LINK_CODES) discordLinks.delete(discordLinks.keys().next().value);
      let code;
      do code = newInviteCode(); while (discordLinks.has(code));
      discordLinks.set(code, { accountId: account.id, expiresAt: now() + LINK_CODE_TTL_MS });
      return { code, expiresAt: new Date(now() + LINK_CODE_TTL_MS).toISOString() };
    },

    // Called from the /link slash command. Returns a plain result; the bot shows it to the user.
    completeDiscordLink(rawCode, discordUser) {
      const code = String(rawCode || "").trim().toUpperCase().replace(/\s+/g, "");
      const link = discordLinks.get(code);
      if (!link || link.expiresAt <= now()) {
        discordLinks.delete(code);
        return { ok: false, reason: "That code isn't valid or has expired. Get a fresh one from Settings on the website." };
      }
      const account = accounts.get(link.accountId);
      if (!account) return { ok: false, reason: "That account no longer exists." };
      for (const other of accounts.values()) {
        if (other !== account && other.discord && other.discord.id === discordUser.id) {
          return { ok: false, reason: "That Discord account is already linked to another Valence account." };
        }
      }
      account.discord = { id: discordUser.id, username: discordUser.username, linkedAt: now() };
      discordLinks.delete(code);
      return { ok: true, accountName: account.name };
    },

    unlinkDiscord(account) {
      account.discord = null;
      return { ok: true };
    },

    discordIdFor(t) {
      const a = accounts.get(t.accountId);
      return a && a.discord ? a.discord.id : null;
    },

    // Whole-store snapshot for durable storage (see persist.js). Lookup maps are rebuilt on import.
    exportState() {
      return {
        schema: SNAPSHOT_SCHEMA,
        savedAt: new Date(now()).toISOString(),
        minted,
        platformBalance: platform.balance,
        accounts: [...accounts.values()].map((a) => ({
          ...a,
          salt: a.salt ? a.salt.toString("hex") : undefined,
          hash: a.hash ? a.hash.toString("hex") : undefined,
        })),
        sessions: [...sessions.entries()],
        deals: [...deals.values()],
        ledger,
        tickets: [...tickets.values()],
        ticketSeq,
      };
    },

    importState(state) {
      if (!state || state.schema !== SNAPSHOT_SCHEMA) throw new Error("Unknown snapshot schema: " + (state && state.schema));
      if (accounts.size || deals.size) throw new Error("importState needs an empty store");
      for (const raw of state.accounts) {
        const a = { ...raw };
        if (a.salt) a.salt = Buffer.from(a.salt, "hex");
        if (a.hash) a.hash = Buffer.from(a.hash, "hex");
        accounts.set(a.id, a);
        if (a.kind === "agent") byKeyHash.set(a.keyHash, a);
        if (a.kind === "human") byUsername.set(a.username, a);
      }
      const t = now();
      for (const [h, s] of state.sessions) if (s.expiresAt > t) sessions.set(h, s);
      for (const d of state.deals) {
        deals.set(d.id, d);
        if (d.state === "open") dealsByInvite.set(d.inviteCode, d.id); // invites are only live while a deal is open
      }
      ledger.push(...state.ledger);
      for (const t of state.tickets || []) tickets.set(t.id, t); // older snapshots have no tickets
      ticketSeq = state.ticketSeq || 0;
      platform.balance = state.platformBalance;
      minted = state.minted;
    },

    // Credits are only ever created by welcome grants and test codes, and never lost after that.
    audit() {
      let held = 0;
      for (const d of deals.values()) if (d.state === "funded") held += d.amount;
      let balances = 0;
      for (const a of accounts.values()) balances += a.balance;
      const actual = balances + held + platform.balance;
      return { ok: actual === minted, expected: minted, actual, accounts: accounts.size, deals: deals.size };
    },
  };
}

module.exports = { createStore, parseTestCodes, STARTING_CREDITS, FEE_BPS, MAX_AMOUNT, DEAL_TYPES, TICKET_CATEGORIES };
