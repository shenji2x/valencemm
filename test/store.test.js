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

// ---------- people, sessions, deal types, test credits ----------

const { parseTestCodes } = require("../src/store");

async function person(store, name = "alice", password = "correct horse") {
  const r = await store.registerHuman(name, password);
  return { token: r.token, rec: store.authenticate(r.token), password };
}

const rejects = async (fn) => {
  try { await fn(); } catch (e) { return `${e.status}:${e.code}`; }
  return "no error";
};

test("people can sign up, log in, and log out; passwords are never kept in plain text", async () => {
  const { store } = setup();
  const alice = await person(store, "Alice_1");
  assert.equal(alice.rec.kind, "human");
  assert.equal(alice.rec.name, "alice_1"); // usernames are lowercased
  assert.equal(alice.rec.balance, 100);
  assert.equal(JSON.stringify(alice.rec).includes(alice.password), false);

  const login = await store.loginHuman("ALICE_1", alice.password);
  assert.equal(store.authenticate(login.token).id, alice.rec.id);
  assert.equal(await rejects(() => store.loginHuman("alice_1", "wrong password")), "401:invalid_login");
  assert.equal(await rejects(() => store.loginHuman("nobody", "whatever1")), "401:invalid_login");
  assert.equal(await rejects(() => store.loginHuman("alice_1", { x: 1 })), "401:invalid_login");

  store.logout(login.token);
  assert.equal(store.authenticate(login.token), null);
  assert.ok(store.authenticate(alice.token), "other sessions stay valid");
});

test("signup validation and unique usernames", async () => {
  const { store } = setup();
  await person(store, "taken_name");
  assert.equal(await rejects(() => store.registerHuman("TAKEN_name", "longenough1")), "409:username_taken");
  assert.equal(await rejects(() => store.registerHuman("ab", "longenough1")), "400:invalid_username");
  assert.equal(await rejects(() => store.registerHuman("has space", "longenough1")), "400:invalid_username");
  assert.equal(await rejects(() => store.registerHuman("<script>", "longenough1")), "400:invalid_username");
  assert.equal(await rejects(() => store.registerHuman("x".repeat(21), "longenough1")), "400:invalid_username");
  assert.equal(await rejects(() => store.registerHuman(42, "longenough1")), "400:invalid_username");
  assert.equal(await rejects(() => store.registerHuman("valid_one", "short")), "400:invalid_password");
  assert.equal(await rejects(() => store.registerHuman("valid_one", "p".repeat(129))), "400:invalid_password");
  assert.equal(await rejects(() => store.registerHuman("valid_one", undefined)), "400:invalid_password");
});

test("two signups for the same username at the same time: only one wins", async () => {
  const { store } = setup();
  const results = await Promise.allSettled([store.registerHuman("racer", "password-1"), store.registerHuman("racer", "password-2")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected")[0].reason.code, "username_taken");
  assert.equal(store.audit().accounts, 1);
});

test("sessions expire after 7 days", async () => {
  const { store, clock } = setup();
  const p = await person(store);
  clock.t += 6 * 24 * 3600 * 1000;
  assert.ok(store.authenticate(p.token));
  clock.t += 2 * 24 * 3600 * 1000;
  assert.equal(store.authenticate(p.token), null);
});

test("authenticate only accepts the right kind of token", async () => {
  const { store, agent } = setup();
  const a = agent("bot");
  const p = await person(store);
  assert.equal(store.authenticate(a.apiKey).kind, "agent");
  assert.equal(store.authenticate(p.token).kind, "human");
  for (const bad of ["", "vlc_", "vls_", "Bearer " + a.apiKey, p.token + "x", null, undefined, 5, "x".repeat(200)]) {
    assert.equal(store.authenticate(bad), null, String(bad));
  }
});

test("deal types: who can create and who can join", async () => {
  const { store, agent } = setup();
  const bot1 = agent("bot1");
  const bot2 = agent("bot2");
  const ann = await person(store, "ann");
  const bob = await person(store, "bob");
  const create = (acct, type) => store.createDeal(acct.rec, { title: "t", amount: 5, type });

  // creation rules
  assert.equal(code(() => create(ann, "ai-ai")), "403:wrong_account_type");
  assert.equal(code(() => create(bot1, "human-human")), "403:wrong_account_type");
  assert.equal(code(() => create(bot1, "nonsense")), "400:invalid_type");
  assert.equal(store.createDeal(bot1.rec, { title: "t", amount: 5 }).type, "ai-ai"); // default for agents
  assert.equal(store.createDeal(ann.rec, { title: "t", amount: 5 }).type, "human-human"); // default for people

  // AI to AI: only an agent may join
  const aa = create(bot1, "ai-ai");
  assert.equal(aa.joinKind, "agent");
  assert.equal(code(() => store.joinDeal(ann.rec, aa.inviteCode)), "403:wrong_account_type");
  assert.equal(store.joinDeal(bot2.rec, aa.inviteCode).state, "joined");

  // Human to Human: only a person may join
  const hh = create(ann, "human-human");
  assert.equal(hh.joinKind, "human");
  assert.equal(code(() => store.joinDeal(bot1.rec, hh.inviteCode)), "403:wrong_account_type");
  assert.equal(store.joinDeal(bob.rec, hh.inviteCode).state, "joined");

  // AI and Human, created by the AI: a person must join
  const ah = create(bot1, "ai-human");
  assert.equal(ah.joinKind, "human");
  assert.equal(code(() => store.joinDeal(bot2.rec, ah.inviteCode)), "403:wrong_account_type");
  const joined = store.joinDeal(bob.rec, ah.inviteCode);
  assert.equal(joined.buyer.kind === "agent" || joined.seller.kind === "agent", true);
  assert.equal(joined.buyer.kind !== joined.seller.kind, true);

  // AI and Human, created by the person: an AI agent must join
  const ha = create(ann, "ai-human");
  assert.equal(ha.joinKind, "agent");
  assert.equal(code(() => store.joinDeal(bob.rec, ha.inviteCode)), "403:wrong_account_type");
  assert.equal(store.joinDeal(bot2.rec, ha.inviteCode).state, "joined");
});

test("a person and an AI agent can complete a full deal either way round", async () => {
  const { store, agent } = setup();
  const bot = agent("bot");
  const ann = await person(store, "ann");

  // person pays the AI
  let d = store.createDeal(ann.rec, { title: "write code", amount: 60, type: "ai-human", role: "buyer" });
  store.joinDeal(bot.rec, d.inviteCode);
  store.fundDeal(ann.rec, d.id);
  store.releaseDeal(ann.rec, d.id);
  assert.equal(ann.rec.balance, 40);
  assert.equal(bot.rec.balance, 160); // fee floor(60 * 1%) = 0

  // AI pays the person
  d = store.createDeal(bot.rec, { title: "photo", amount: 100, type: "ai-human", role: "buyer" });
  store.joinDeal(ann.rec, d.inviteCode);
  store.fundDeal(bot.rec, d.id);
  store.releaseDeal(bot.rec, d.id);
  assert.equal(bot.rec.balance, 60);
  assert.equal(ann.rec.balance, 139); // 40 + 100 - fee 1
  assert.equal(store.audit().ok, true);
});

test("test credits: disabled by default, secret code adds credits and keeps the ledger balanced", async () => {
  const off = setup();
  const offAgent = off.agent("a");
  assert.equal(code(() => off.store.redeemCredits(offAgent.rec, "anything")), "404:redeem_disabled");

  const clock = { t: Date.now() };
  const store = createStore({ now: () => clock.t, testCodes: parseTestCodes("my-secret-code=500, another-code-1=25") });
  const r = store.registerAgent("a");
  const a = store.authenticate(r.apiKey);
  assert.equal(code(() => store.redeemCredits(a, "wrong")), "400:invalid_code");
  assert.equal(code(() => store.redeemCredits(a, "")), "400:invalid_code");
  assert.equal(code(() => store.redeemCredits(a, undefined)), "400:invalid_code");
  assert.deepEqual(store.redeemCredits(a, "my-secret-code"), { added: 500, balance: 600 });
  assert.deepEqual(store.redeemCredits(a, "  another-code-1  "), { added: 25, balance: 625 });
  assert.equal(store.audit().ok, true);
  assert.equal(store.me(a).recentLedger[0].memo, "test credits (code redeemed)");
  assert.equal(JSON.stringify(store.me(a)).includes("my-secret-code"), false);
});

test("parseTestCodes ignores short codes, bad amounts and junk", () => {
  assert.deepEqual([...parseTestCodes("abcdefgh=10,short=5,validcode1=0,validcode2=-3,validcode3=1.5,novalue,=7, goodcode99 = 42 ")], [
    ["abcdefgh", 10],
    ["goodcode99", 42],
  ]);
  assert.equal(parseTestCodes(undefined).size, 0);
  assert.equal(parseTestCodes("").size, 0);
});
