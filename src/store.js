// Store for the Valence prototype. PLAY CREDITS ONLY, no real money.
// The working copy lives in memory; persist.js saves a snapshot to durable storage after
// every change (Cloud Storage in production) and loads it back on startup.

const crypto = require("crypto");
const { promisify } = require("util");
const { ApiError } = require("./errors");

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
  const platform = { balance: 0 };
  let minted = 0; // every credit ever created (welcome grants + test codes)
  const dummySalt = crypto.randomBytes(16); // used to keep login timing similar for unknown usernames

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
      const hash = await scrypt(password, person.salt, 64);
      if (!crypto.timingSafeEqual(hash, person.hash)) throw fail();
      return { token: newSession(person), account: publicAccount(person) };
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

module.exports = { createStore, parseTestCodes, STARTING_CREDITS, FEE_BPS, MAX_AMOUNT, DEAL_TYPES };
