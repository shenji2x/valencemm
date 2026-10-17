// Tests for the deal and ledger logic. These need no network and no express.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createStore } = require("../src/store");

function setup() {
  const clock = { t: Date.parse("2026-10-17T00:00:00Z") };
  const store = createStore({ now: () => clock.t });
  const agent = (name) => {
    const r = store.registerAgent(name);
    return { ...r, rec: store.authenticate(r.apiKey) };
  };
  return { store, clock, agent };
}

function funded(ctx, amount = 50, extra = {}) {
  const buyer = ctx.agent("buyer");
  const seller = ctx.agent("seller");
  const deal = ctx.store.createDeal(buyer.rec, { title: "Job", amount, ...extra });
  ctx.store.joinDeal(seller.rec, deal.inviteCode);
  ctx.store.fundDeal(buyer.rec, deal.id);
  return { buyer, seller, dealId: deal.id };
}

const code = (fn) => {
  try { fn(); } catch (e) { return `${e.status}:${e.code}`; }
  return "no error";
};

test("register returns a key that authenticates, with 100 credits; key is not stored in plain text", () => {
  const { store, agent } = setup();
  const a = agent("alpha");
  assert.match(a.apiKey, /^vlc_[0-9a-f]{48}$/);
  assert.equal(a.rec.balance, 100);
  assert.equal(store.authenticate("vlc_wrong"), null);
  assert.equal(store.authenticate(undefined), null);
  assert.equal(JSON.stringify(a.rec).includes(a.apiKey), false);
  assert.equal(JSON.stringify(store.me(a.rec)).includes(a.apiKey), false);
});

test("happy path: release pays the seller and the ledger balances", () => {
  const ctx = setup();
  const { buyer, seller, dealId } = funded(ctx, 50);
  assert.equal(buyer.rec.balance, 50);
  const d = ctx.store.releaseDeal(buyer.rec, dealId);
  assert.equal(d.state, "released");
  assert.equal(seller.rec.balance, 150); // fee = floor(50 * 1%) = 0
  assert.equal(ctx.store.audit().ok, true);
});

test("fee is floor(amount * 1%): 99 -> 0, 100 -> 1, 1999 -> 19", () => {
  const ctx = setup();
  for (const [amount, expectedPayout] of [[99, 99], [100, 99], [1999, 1980]]) {
    const buyer = ctx.agent("b");
    const seller = ctx.agent("s");
    buyer.rec.balance += amount; // test-only top-up so the buyer can afford big amounts (this test doesn't check the audit)
    const d = ctx.store.createDeal(buyer.rec, { title: "t", amount });
    ctx.store.joinDeal(seller.rec, d.inviteCode);
    ctx.store.fundDeal(buyer.rec, d.id);
    const before = seller.rec.balance;
    ctx.store.releaseDeal(buyer.rec, d.id);
    assert.equal(seller.rec.balance - before, expectedPayout);
  }
});

test("seller can refund any time; buyer only after the deadline", () => {
  const ctx = setup();
  const { buyer, seller, dealId } = funded(ctx, 40, { deadlineHours: 2 });
  assert.equal(code(() => ctx.store.refundDeal(buyer.rec, dealId)), "403:deadline_not_reached");
  ctx.clock.t += 3 * 3600 * 1000;
  assert.equal(ctx.store.refundDeal(buyer.rec, dealId).state, "refunded");
  assert.equal(buyer.rec.balance, 100);
  assert.equal(seller.rec.balance, 100);

  const second = funded(ctx, 10);
  assert.equal(ctx.store.refundDeal(second.seller.rec, second.dealId).state, "refunded");
  assert.equal(second.buyer.rec.balance, 100);
  assert.equal(ctx.store.audit().ok, true);
});

test("the deadline runs from funding, not creation", () => {
  const ctx = setup();
  const buyer = ctx.agent("b");
  const seller = ctx.agent("s");
  const d = ctx.store.createDeal(buyer.rec, { title: "t", amount: 10, deadlineHours: 1 });
  ctx.store.joinDeal(seller.rec, d.inviteCode);
  ctx.clock.t += 5 * 3600 * 1000; // sits unfunded for 5 hours
  const f = ctx.store.fundDeal(buyer.rec, d.id);
  assert.equal(Date.parse(f.deadlineAt) - Date.parse(f.fundedAt), 3600 * 1000);
  assert.equal(code(() => ctx.store.refundDeal(buyer.rec, d.id)), "403:deadline_not_reached");
});

test("permissions: only the buyer funds/releases; outsiders see 404; no double release", () => {
  const ctx = setup();
  const { buyer, seller, dealId } = funded(ctx, 20);
  const outsider = ctx.agent("outsider");
  assert.equal(code(() => ctx.store.releaseDeal(seller.rec, dealId)), "403:not_buyer");
  assert.equal(code(() => ctx.store.getDeal(outsider.rec, dealId)), "404:deal_not_found");
  assert.equal(code(() => ctx.store.releaseDeal(outsider.rec, dealId)), "404:deal_not_found");
  assert.equal(code(() => ctx.store.cancelDeal(outsider.rec, dealId)), "404:deal_not_found");
  assert.equal(ctx.store.getDeal(seller.rec, dealId).yourRole, "seller");
  ctx.store.releaseDeal(buyer.rec, dealId);
  assert.equal(code(() => ctx.store.releaseDeal(buyer.rec, dealId)), "409:bad_state");
  assert.equal(code(() => ctx.store.refundDeal(seller.rec, dealId)), "409:bad_state");
  assert.equal(seller.rec.balance, 120);
  assert.equal(ctx.store.audit().ok, true);
});

test("invite codes: single use, case-insensitive, hidden from others, creator can't join", () => {
  const ctx = setup();
  const a = ctx.agent("a");
  const b = ctx.agent("b");
  const c = ctx.agent("c");
  const d = ctx.store.createDeal(a.rec, { title: "t", amount: 5, role: "seller" });
  assert.match(d.inviteCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(code(() => ctx.store.joinDeal(a.rec, d.inviteCode)), "400:own_deal");
  const j = ctx.store.joinDeal(b.rec, d.inviteCode.toLowerCase());
  assert.equal(j.yourRole, "buyer");
  assert.equal(j.inviteCode, undefined);
  assert.equal(code(() => ctx.store.joinDeal(c.rec, d.inviteCode)), "404:invalid_invite");
  assert.equal(ctx.store.getDeal(a.rec, d.id).inviteCode, undefined);
  assert.equal(code(() => ctx.store.joinDeal(c.rec, 12345)), "404:invalid_invite");
});

test("funding needs a counterparty and enough credits", () => {
  const ctx = setup();
  const a = ctx.agent("a");
  const b = ctx.agent("b");
  const small = ctx.store.createDeal(a.rec, { title: "t", amount: 5 });
  assert.equal(code(() => ctx.store.fundDeal(a.rec, small.id)), "409:bad_state");
  const big = ctx.store.createDeal(a.rec, { title: "big", amount: 5000 });
  ctx.store.joinDeal(b.rec, big.inviteCode);
  assert.equal(code(() => ctx.store.fundDeal(a.rec, big.id)), "402:insufficient_credits");
  assert.equal(a.rec.balance, 100);
  assert.equal(code(() => { ctx.store.joinDeal(b.rec, small.inviteCode); ctx.store.fundDeal(b.rec, small.id); }), "403:not_buyer");
});

test("cancel works before funding but not after, and kills the invite", () => {
  const ctx = setup();
  const a = ctx.agent("a");
  const z = ctx.agent("z");
  const d = ctx.store.createDeal(a.rec, { title: "t", amount: 5 });
  assert.equal(ctx.store.cancelDeal(a.rec, d.id).state, "cancelled");
  assert.equal(code(() => ctx.store.joinDeal(z.rec, d.inviteCode)), "404:invalid_invite");
  const { buyer, dealId } = funded(ctx, 10);
  assert.equal(code(() => ctx.store.cancelDeal(buyer.rec, dealId)), "409:bad_state");
});

test("input validation", () => {
  const { store, agent } = setup();
  const a = agent("a");
  const bad = (input) => code(() => store.createDeal(a.rec, input));
  assert.equal(bad({ title: "t", amount: 0 }), "400:invalid_amount");
  assert.equal(bad({ title: "t", amount: 1.5 }), "400:invalid_amount");
  assert.equal(bad({ title: "t", amount: "5" }), "400:invalid_amount");
  assert.equal(bad({ title: "t", amount: 10001 }), "400:invalid_amount");
  assert.equal(bad({ title: "t", amount: -5 }), "400:invalid_amount");
  assert.equal(bad({ title: "  ", amount: 5 }), "400:invalid_title");
  assert.equal(bad({ title: "x".repeat(101), amount: 5 }), "400:invalid_title");
  assert.equal(bad({ title: 7, amount: 5 }), "400:invalid_title");
  assert.equal(bad({ title: "t", amount: 5, role: "boss" }), "400:invalid_role");
  assert.equal(bad({ title: "t", amount: 5, deadlineHours: 0 }), "400:invalid_deadline");
  assert.equal(bad({ title: "t", amount: 5, deadlineHours: 721 }), "400:invalid_deadline");
  assert.equal(bad({ title: "t", amount: 5, description: "d".repeat(501) }), "400:invalid_description");
  assert.equal(code(() => store.registerAgent("")), "400:invalid_name");
  assert.equal(code(() => store.registerAgent({})), "400:invalid_name");
  assert.equal(code(() => store.registerAgent("n".repeat(51))), "400:invalid_name");
});

test("an agent can hold at most 20 unfinished deals; finished ones don't count", () => {
  const ctx = setup();
  const a = ctx.agent("a");
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push(ctx.store.createDeal(a.rec, { title: "d" + i, amount: 1 }).id);
  assert.equal(code(() => ctx.store.createDeal(a.rec, { title: "extra", amount: 1 })), "429:too_many_open_deals");
  ctx.store.cancelDeal(a.rec, ids[0]);
  assert.equal(ctx.store.createDeal(a.rec, { title: "now ok", amount: 1 }).state, "open");
});

test("credits are conserved across many random deals", () => {
  const ctx = setup();
  const agents = Array.from({ length: 6 }, (_, i) => ctx.agent("a" + i));
  let seed = 42;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let i = 0; i < 300; i++) {
    const buyer = agents[rand(6)];
    const seller = agents[(agents.indexOf(buyer) + 1 + rand(5)) % 6];
    try {
      const d = ctx.store.createDeal(buyer.rec, { title: "r" + i, amount: 1 + rand(60), deadlineHours: 1 });
      ctx.store.joinDeal(seller.rec, d.inviteCode);
      ctx.store.fundDeal(buyer.rec, d.id);
      const pick = rand(4);
      if (pick === 0) ctx.store.releaseDeal(buyer.rec, d.id);
      else if (pick === 1) ctx.store.refundDeal(seller.rec, d.id);
      else if (pick === 2) { ctx.clock.t += 2 * 3600 * 1000; ctx.store.refundDeal(buyer.rec, d.id); }
      // pick 3 leaves the deal funded
    } catch (e) {
      assert.ok(e.status, "only ApiErrors are expected: " + e.message);
    }
    assert.equal(ctx.store.audit().ok, true, `ledger unbalanced after round ${i}`);
    for (const a of agents) assert.ok(a.rec.balance >= 0, "balance went negative");
  }
});
