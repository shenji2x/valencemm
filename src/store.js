// In-memory store for the Valence prototype. PLAY CREDITS ONLY, no real money.
// Everything here is lost when the server restarts or scales to zero.
// A real database comes later; the method names here are the seam to swap it in.

const crypto = require("crypto");
const { ApiError } = require("./errors");

const STARTING_CREDITS = 100;
const FEE_BPS = 100; // 1% platform fee, charged to the seller's payout on release
const MAX_AMOUNT = 10000;
const MAX_AGENTS = 5000;
const MAX_DEALS = 20000;
const MAX_OPEN_DEALS_PER_AGENT = 20;
const MAX_LEDGER_ENTRIES = 200000;
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars, no 0/O/1/I
const HOUR_MS = 3600 * 1000;
const OPEN_STATES = new Set(["open", "joined", "funded"]);

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
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

function createStore({ now = () => Date.now() } = {}) {
  const agents = new Map(); // agentId -> agent
  const agentsByKeyHash = new Map(); // sha256(apiKey) -> agent
  const deals = new Map(); // dealId -> deal
  const dealsByInvite = new Map(); // inviteCode -> dealId
  const ledger = []; // append-only
  const platform = { balance: 0 };

  function record(account, delta, dealId, memo) {
    ledger.push({ id: ledger.length + 1, at: now(), account, delta, dealId: dealId || null, memo });
    if (ledger.length > MAX_LEDGER_ENTRIES) ledger.splice(0, ledger.length - MAX_LEDGER_ENTRIES);
  }

  function openDealCount(agentId) {
    let n = 0;
    for (const d of deals.values()) {
      if ((d.buyerId === agentId || d.sellerId === agentId) && OPEN_STATES.has(d.state)) n++;
    }
    return n;
  }

  function setState(deal, state, byId) {
    deal.state = state;
    deal.history.push({ at: now(), state, by: byId });
  }

  function view(deal, viewerId) {
    const role = deal.buyerId === viewerId ? "buyer" : deal.sellerId === viewerId ? "seller" : null;
    const out = {
      id: deal.id,
      title: deal.title,
      description: deal.description,
      amount: deal.amount,
      feeBps: FEE_BPS,
      state: deal.state,
      yourRole: role,
      buyerId: deal.buyerId,
      sellerId: deal.sellerId,
      createdAt: new Date(deal.createdAt).toISOString(),
      fundedAt: deal.fundedAt ? new Date(deal.fundedAt).toISOString() : null,
      deadlineAt: deal.deadlineAt ? new Date(deal.deadlineAt).toISOString() : null,
      history: deal.history.map((h) => ({ at: new Date(h.at).toISOString(), state: h.state, by: h.by })),
    };
    // Only the creator sees the invite code, and only until someone joins.
    if (deal.state === "open" && deal.creatorId === viewerId) out.inviteCode = deal.inviteCode;
    return out;
  }

  function mustGetDeal(agent, dealId) {
    const deal = deals.get(dealId);
    // Same error whether the deal is missing or belongs to others, so ids can't be probed.
    if (!deal || (deal.buyerId !== agent.id && deal.sellerId !== agent.id)) {
      throw new ApiError(404, "deal_not_found", "Deal not found");
    }
    return deal;
  }

  return {
    registerAgent(rawName) {
      const name = cleanText(rawName, "name", { max: 50 });
      if (agents.size >= MAX_AGENTS) throw new ApiError(503, "capacity", "Prototype is full, try again later");
      const apiKey = "vlc_" + crypto.randomBytes(24).toString("hex");
      const agent = { id: randomId("agent"), name, createdAt: now(), balance: STARTING_CREDITS, keyHash: sha256(apiKey) };
      agents.set(agent.id, agent);
      agentsByKeyHash.set(agent.keyHash, agent);
      record(agent.id, STARTING_CREDITS, null, "play-credit signup grant");
      return { agentId: agent.id, name: agent.name, apiKey, balance: agent.balance };
    },

    authenticate(apiKey) {
      if (typeof apiKey !== "string" || apiKey.length > 100) return null;
      return agentsByKeyHash.get(sha256(apiKey)) || null;
    },

    me(agent) {
      const recent = ledger.filter((e) => e.account === agent.id).slice(-20).reverse();
      return {
        agentId: agent.id,
        name: agent.name,
        balance: agent.balance,
        currency: "play-credits",
        recentLedger: recent.map((e) => ({ at: new Date(e.at).toISOString(), delta: e.delta, dealId: e.dealId, memo: e.memo })),
      };
    },

    createDeal(agent, input) {
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
      if (deals.size >= MAX_DEALS) throw new ApiError(503, "capacity", "Prototype is full, try again later");
      if (openDealCount(agent.id) >= MAX_OPEN_DEALS_PER_AGENT) {
        throw new ApiError(429, "too_many_open_deals", `You can have at most ${MAX_OPEN_DEALS_PER_AGENT} unfinished deals`);
      }
      let code;
      do code = newInviteCode(); while (dealsByInvite.has(code));
      const deal = {
        id: randomId("deal"), title, description, amount, deadlineHours,
        state: "open", creatorId: agent.id,
        buyerId: role === "buyer" ? agent.id : null,
        sellerId: role === "seller" ? agent.id : null,
        inviteCode: code, createdAt: now(), fundedAt: null, deadlineAt: null,
        history: [{ at: now(), state: "open", by: agent.id }],
      };
      deals.set(deal.id, deal);
      dealsByInvite.set(code, deal.id);
      return view(deal, agent.id);
    },

    joinDeal(agent, rawCode) {
      const code = typeof rawCode === "string" ? rawCode.trim().toUpperCase() : "";
      const deal = deals.get(dealsByInvite.get(code));
      if (!deal) throw new ApiError(404, "invalid_invite", "Invite code not found or already used");
      if (deal.creatorId === agent.id) throw new ApiError(400, "own_deal", "You can't join your own deal");
      if (openDealCount(agent.id) >= MAX_OPEN_DEALS_PER_AGENT) {
        throw new ApiError(429, "too_many_open_deals", `You can have at most ${MAX_OPEN_DEALS_PER_AGENT} unfinished deals`);
      }
      if (deal.buyerId === null) deal.buyerId = agent.id;
      else deal.sellerId = agent.id;
      dealsByInvite.delete(code); // single use
      setState(deal, "joined", agent.id);
      return view(deal, agent.id);
    },

    getDeal(agent, dealId) {
      return view(mustGetDeal(agent, dealId), agent.id);
    },

    listDeals(agent) {
      return [...deals.values()]
        .filter((d) => d.buyerId === agent.id || d.sellerId === agent.id)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 100)
        .map((d) => view(d, agent.id));
    },

    fundDeal(agent, dealId) {
      const deal = mustGetDeal(agent, dealId);
      if (deal.buyerId !== agent.id) throw new ApiError(403, "not_buyer", "Only the buyer can fund the deal");
      if (deal.state !== "joined") throw new ApiError(409, "bad_state", `Deal is ${deal.state}; it must be "joined" to fund`);
      if (agent.balance < deal.amount) throw new ApiError(402, "insufficient_credits", "Not enough play credits");
      agent.balance -= deal.amount;
      record(agent.id, -deal.amount, deal.id, "deposit into escrow");
      record("escrow:" + deal.id, deal.amount, deal.id, "escrow funded");
      deal.fundedAt = now();
      deal.deadlineAt = deal.fundedAt + deal.deadlineHours * HOUR_MS;
      setState(deal, "funded", agent.id);
      return view(deal, agent.id);
    },

    releaseDeal(agent, dealId) {
      const deal = mustGetDeal(agent, dealId);
      if (deal.buyerId !== agent.id) throw new ApiError(403, "not_buyer", "Only the buyer can release the funds");
      if (deal.state !== "funded") throw new ApiError(409, "bad_state", `Deal is ${deal.state}; it must be "funded" to release`);
      const seller = agents.get(deal.sellerId);
      const fee = Math.floor((deal.amount * FEE_BPS) / 10000);
      const payout = deal.amount - fee;
      record("escrow:" + deal.id, -deal.amount, deal.id, "escrow released");
      seller.balance += payout;
      record(seller.id, payout, deal.id, "deal payout");
      if (fee > 0) {
        platform.balance += fee;
        record("platform", fee, deal.id, "platform fee");
      }
      setState(deal, "released", agent.id);
      return view(deal, agent.id);
    },

    refundDeal(agent, dealId) {
      const deal = mustGetDeal(agent, dealId);
      if (deal.state !== "funded") throw new ApiError(409, "bad_state", `Deal is ${deal.state}; it must be "funded" to refund`);
      const isSeller = deal.sellerId === agent.id;
      if (!isSeller && now() < deal.deadlineAt) {
        throw new ApiError(403, "deadline_not_reached", "The buyer can only claim a refund after the deadline; the seller can refund any time");
      }
      const buyer = agents.get(deal.buyerId);
      record("escrow:" + deal.id, -deal.amount, deal.id, "escrow refunded");
      buyer.balance += deal.amount;
      record(buyer.id, deal.amount, deal.id, "deal refund");
      setState(deal, "refunded", agent.id);
      return view(deal, agent.id);
    },

    cancelDeal(agent, dealId) {
      const deal = mustGetDeal(agent, dealId);
      if (deal.state !== "open" && deal.state !== "joined") {
        throw new ApiError(409, "bad_state", `Deal is ${deal.state}; only unfunded deals can be cancelled`);
      }
      dealsByInvite.delete(deal.inviteCode);
      setState(deal, "cancelled", agent.id);
      return view(deal, agent.id);
    },

    // Credits are never created or destroyed after signup. Used by tests and /health.
    audit() {
      let held = 0;
      for (const d of deals.values()) if (d.state === "funded") held += d.amount;
      let balances = 0;
      for (const a of agents.values()) balances += a.balance;
      const actual = balances + held + platform.balance;
      const expected = agents.size * STARTING_CREDITS;
      return { ok: actual === expected, expected, actual, agents: agents.size, deals: deals.size };
    },
  };
}

module.exports = { createStore, STARTING_CREDITS, FEE_BPS, MAX_AMOUNT };
