// Tests for the deal and payment-record logic. No network, no Stripe: the store records what a
// provider did, so these tests call the same primitives src/payments.js calls.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createStore } = require("../src/store");
const money = require("../src/money");

function setup() {
  const clock = { t: Date.parse("2026-10-17T00:00:00Z") };
  const store = createStore({ now: () => clock.t });
  const agent = (name) => {
    const r = store.registerAgent(name);
    const rec = store.authenticate(r.apiKey);
    return { ...r, rec };
  };
  // A seller can only be paid once Stripe says so, so tests have to say so too.
  const ready = (who) => {
    store.setConnectAccount(who.rec, "acct_" + who.rec.id.slice(-8));
    store.updateConnectStatus(who.rec, { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true });
    return who;
  };
  return { store, clock, agent, ready };
}

// Walks a deal to "funded" the way payments.js does: price it, attach the intent Stripe made,
// then record that the card was authorised.
function funded(ctx, amount = 5000, extra = {}) {
  const buyer = ctx.agent("buyer");
  const seller = ctx.ready(ctx.agent("seller"));
  const deal = ctx.store.createDeal(buyer.rec, { title: "Job", amount, ...extra });
  ctx.store.joinDeal(seller.rec, deal.inviteCode);
  const { deal: rec, quote } = ctx.store.beginFunding(buyer.rec, deal.id);
  ctx.store.attachIntent(rec, { provider: "stripe", intentId: "pi_" + deal.id.slice(-8), stripeAccountId: seller.rec.connect.stripeAccountId, quote });
  ctx.store.markHeld(rec, { brand: "visa", last4: "4242" });
  return { buyer, seller, dealId: deal.id, deal: rec, quote };
}

const code = (fn) => {
  try { fn(); } catch (e) { return `${e.status}:${e.code}`; }
  return "no error";
};

test("registering gives a working key, no balance of any kind, and never stores the key", () => {
  const { store, agent } = setup();
  const a = agent("alpha");
  assert.match(a.apiKey, /^vlc_[0-9a-f]{48}$/);
  // The absence of these is the whole regulatory position, so assert it rather than assume it.
  assert.equal(a.rec.balance, undefined);
  assert.equal("balance" in store.me(a.rec), false);
  assert.equal(store.me(a.rec).payouts.ready, false);
  assert.equal(store.authenticate("vlc_wrong"), null);
  assert.equal(store.authenticate(undefined), null);
  assert.equal(JSON.stringify(a.rec).includes(a.apiKey), false);
  assert.equal(JSON.stringify(store.me(a.rec)).includes(a.apiKey), false);
});

test("no API anywhere hands out a balance or a way to top one up", () => {
  const { store } = setup();
  for (const gone of ["fundDeal", "releaseDeal", "refundDeal", "redeemCredits", "audit_balances"]) {
    assert.equal(typeof store[gone], "undefined", `${gone} should no longer exist`);
  }
});

test("a deal cannot be funded until Stripe says the seller can be paid", () => {
  const ctx = setup();
  const buyer = ctx.agent("buyer");
  const seller = ctx.agent("seller");
  const deal = ctx.store.createDeal(buyer.rec, { title: "Job", amount: 5000 });
  ctx.store.joinDeal(seller.rec, deal.inviteCode);
  // Taking a buyer's money with nowhere to send it is the worst failure available here.
  assert.equal(code(() => ctx.store.beginFunding(buyer.rec, deal.id)), "409:seller_not_ready");
  assert.equal(ctx.store.getDeal(buyer.rec, deal.id).state, "awaiting_setup");
  assert.deepEqual(ctx.store.dealsAwaitingSetup(seller.rec.id).map((d) => d.id), [deal.id]);

  ctx.store.setConnectAccount(seller.rec, "acct_123");
  ctx.store.updateConnectStatus(seller.rec, { chargesEnabled: true, payoutsEnabled: false, detailsSubmitted: true });
  assert.equal(code(() => ctx.store.beginFunding(buyer.rec, deal.id)), "409:seller_not_ready");

  ctx.store.updateConnectStatus(seller.rec, { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true });
  // The moment Stripe says yes, the waiting deal is payable again rather than stuck.
  assert.equal(ctx.store.getDeal(buyer.rec, deal.id).state, "joined");
  assert.deepEqual(ctx.store.dealsAwaitingSetup(seller.rec.id), []);
  const { quote } = ctx.store.beginFunding(buyer.rec, deal.id);
  assert.equal(quote.amount, 5000);
  assert.equal(ctx.store.getDeal(buyer.rec, deal.id).state, "funding");
});

test("the quote the buyer is shown is the one the deal carries", () => {
  const ctx = setup();
  const { dealId, buyer, quote } = funded(ctx, 50000);
  const view = ctx.store.getDeal(buyer.rec, dealId);
  assert.equal(quote.amount, 50000);
  assert.equal(quote.platformFee, 500);              // 1%
  assert.equal(quote.buyerTotal, 50500);             // the buyer pays the fee on top
  assert.equal(view.payment.amount, 50500);
  assert.equal(view.payment.platformFee, 500);
  assert.equal(view.payment.status, "held");
  assert.equal(view.payment.last4, "4242");
  // Nothing has settled, so there is no seller figure yet beyond the estimate.
  assert.equal(view.payment.sellerNet, null);
  assert.equal(view.quote.sellerNet, 50000 - quote.processorFee);
});

test("releasing records what Stripe actually took, not what we estimated", () => {
  const ctx = setup();
  const { buyer, seller, dealId, deal } = funded(ctx, 50000);
  ctx.store.beginRelease(buyer.rec, dealId);
  ctx.store.markReleased(deal, buyer.rec.id, { processorFee: 1393, sellerNet: 48607 });
  const view = ctx.store.getDeal(seller.rec, dealId);
  assert.equal(view.state, "released");
  assert.equal(view.payment.status, "captured");
  assert.equal(view.payment.processorFee, 1393);
  assert.equal(view.payment.sellerNet, 48607);
  // The seller's history shows the payout; the buyer's shows the charge.
  assert.equal(ctx.store.payments(seller.rec).events[0].event, "paid_out");
  assert.equal(ctx.store.payments(seller.rec).events[0].amount, 48607);
  assert.equal(ctx.store.payments(buyer.rec).events[0].event, "released");
  assert.equal(ctx.store.audit().ok, true);
});

test("a deal's deadline can never outlive the card hold", () => {
  const ctx = setup();
  // 7 days is the hold; ask for 7 days and the deadline lands on the hold's expiry, not past it.
  const { deal } = funded(ctx, 5000, { deadlineHours: 168 });
  assert.equal(deal.deadlineAt, money.holdExpiry(deal.payment.authorizedAt));

  const short = funded(ctx, 5000, { deadlineHours: 2 });
  assert.equal(short.deal.deadlineAt - short.deal.payment.authorizedAt, 2 * 3600 * 1000);
});

test("the deadline runs from the payment, not from creating the deal", () => {
  const ctx = setup();
  const buyer = ctx.agent("b");
  const seller = ctx.ready(ctx.agent("s"));
  const d = ctx.store.createDeal(buyer.rec, { title: "t", amount: 5000, deadlineHours: 1 });
  ctx.store.joinDeal(seller.rec, d.inviteCode);
  ctx.clock.t += 5 * 3600 * 1000; // sits unpaid for 5 hours
  const { deal, quote } = ctx.store.beginFunding(buyer.rec, d.id);
  ctx.store.attachIntent(deal, { provider: "stripe", intentId: "pi_1", stripeAccountId: "acct_1", quote });
  const held = ctx.store.markHeld(deal);
  assert.equal(held.deadlineAt - held.fundedAt, 3600 * 1000);
  assert.equal(code(() => ctx.store.beginRefund(buyer.rec, d.id)), "403:deadline_not_reached");
});

test("the seller can refund any time; the buyer only after the deadline", () => {
  const ctx = setup();
  const { buyer, dealId, deal } = funded(ctx, 4000, { deadlineHours: 2 });
  assert.equal(code(() => ctx.store.beginRefund(buyer.rec, dealId)), "403:deadline_not_reached");
  ctx.clock.t += 3 * 3600 * 1000;
  const { captured } = ctx.store.beginRefund(buyer.rec, dealId);
  assert.equal(captured, false); // nothing settled, so this is a cancelled hold, not a refund
  ctx.store.markRefunded(deal, buyer.rec.id, { reason: "deadline passed" });
  assert.equal(ctx.store.getDeal(buyer.rec, dealId).payment.status, "canceled");

  const second = funded(ctx, 1000);
  assert.equal(ctx.store.beginRefund(second.seller.rec, second.dealId).captured, false);
});

test("delivery, then release; and nobody else can do either", () => {
  const ctx = setup();
  const { buyer, seller, dealId, deal } = funded(ctx, 20000);
  const outsider = ctx.agent("outsider");
  assert.equal(code(() => ctx.store.markDelivered(buyer.rec, dealId)), "403:not_seller");
  assert.equal(code(() => ctx.store.beginRelease(seller.rec, dealId)), "403:not_buyer");
  assert.equal(code(() => ctx.store.getDeal(outsider.rec, dealId)), "404:deal_not_found");
  assert.equal(code(() => ctx.store.beginRelease(outsider.rec, dealId)), "404:deal_not_found");

  const delivered = ctx.store.markDelivered(seller.rec, dealId, "Three files, see the link");
  assert.equal(delivered.state, "delivered");
  assert.equal(ctx.store.beginRelease(buyer.rec, dealId).payment.status, "held");
  ctx.store.markReleased(deal, buyer.rec.id, { processorFee: 570, sellerNet: 19430 });
  assert.equal(code(() => ctx.store.beginRelease(buyer.rec, dealId)), "409:bad_state");
  assert.equal(code(() => ctx.store.beginRefund(seller.rec, dealId)), "409:bad_state");
});

test("a delivered deal becomes due for auto-release, and an unreleased one does not", () => {
  const ctx = setup();
  const { seller, dealId } = funded(ctx, 5000);
  const WINDOW = 72 * 3600 * 1000;
  assert.deepEqual(ctx.store.dealsDueForAutoRelease(WINDOW), []); // not delivered yet
  ctx.store.markDelivered(seller.rec, dealId);
  assert.deepEqual(ctx.store.dealsDueForAutoRelease(WINDOW), []); // delivered, but not yet stale
  ctx.clock.t += WINDOW;
  assert.deepEqual(ctx.store.dealsDueForAutoRelease(WINDOW).map((d) => d.id), [dealId]);
});

test("a hold close to expiry is reported so it can be cancelled rather than left to lapse", () => {
  const ctx = setup();
  const { dealId } = funded(ctx, 5000, { deadlineHours: 168 });
  assert.deepEqual(ctx.store.dealsWithExpiringHolds(), []);
  ctx.clock.t += money.HOLD_MS - money.HOLD_SAFETY_MS;
  assert.deepEqual(ctx.store.dealsWithExpiringHolds().map((d) => d.id), [dealId]);
  assert.equal(ctx.store.audit().holdsAtRisk, 1);
});

test("a webhook arriving twice does not fund, release or refund twice", () => {
  const ctx = setup();
  const { buyer, dealId, deal } = funded(ctx, 5000);
  const history = () => ctx.store.getDeal(buyer.rec, dealId).history.filter((h) => h.state === "funded").length;
  assert.equal(history(), 1);
  ctx.store.markHeld(deal, { brand: "visa", last4: "4242" }); // Stripe retries
  assert.equal(history(), 1);
  ctx.store.markReleased(deal, buyer.rec.id, { processorFee: 165, sellerNet: 4835 });
  ctx.store.markReleased(deal, buyer.rec.id, { processorFee: 999, sellerNet: 1 });
  const view = ctx.store.getDeal(buyer.rec, dealId);
  assert.equal(view.payment.processorFee, 165); // the second call changed nothing
  assert.equal(view.history.filter((h) => h.state === "released").length, 1);
});

test("a chargeback freezes the deal and is recorded against the seller", () => {
  const ctx = setup();
  const { seller, dealId, deal } = funded(ctx, 5000);
  ctx.store.recordChargeback(deal, "fraudulent");
  const view = ctx.store.getDeal(seller.rec, dealId);
  assert.equal(view.state, "disputed");
  assert.equal(view.dispute.kind, "chargeback");
  assert.equal(ctx.store.payments(seller.rec).events[0].event, "chargeback");
});

test("either side can dispute a funded deal, and the reason has to say something", () => {
  const ctx = setup();
  const { buyer, seller, dealId } = funded(ctx, 5000);
  assert.equal(code(() => ctx.store.openDispute(buyer.rec, dealId, "bad")), "400:invalid_reason");
  const d = ctx.store.openDispute(buyer.rec, dealId, "The files never arrived and they've stopped replying.");
  assert.equal(d.state, "disputed");
  assert.equal(ctx.store.getDeal(seller.rec, dealId).state, "disputed");
  // A frozen deal can't be quietly released or refunded around the dispute.
  assert.equal(code(() => ctx.store.beginRelease(buyer.rec, dealId)), "409:bad_state");
  assert.equal(code(() => ctx.store.beginRefund(seller.rec, dealId)), "409:bad_state");
});

test("invite codes: single use, case-insensitive, hidden from others, creator can't join", () => {
  const ctx = setup();
  const a = ctx.agent("a");
  const b = ctx.agent("b");
  const c = ctx.agent("c");
  const d = ctx.store.createDeal(a.rec, { title: "t", amount: 5000, role: "seller" });
  assert.match(d.inviteCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(code(() => ctx.store.joinDeal(a.rec, d.inviteCode)), "400:own_deal");
  const j = ctx.store.joinDeal(b.rec, d.inviteCode.toLowerCase());
  assert.equal(j.yourRole, "buyer");
  assert.equal(j.inviteCode, undefined);
  assert.equal(code(() => ctx.store.joinDeal(c.rec, d.inviteCode)), "404:invalid_invite");
  assert.equal(ctx.store.getDeal(a.rec, d.id).inviteCode, undefined);
  assert.equal(code(() => ctx.store.joinDeal(c.rec, 12345)), "404:invalid_invite");
});

test("only the buyer can start funding, and only a joined deal", () => {
  const ctx = setup();
  const a = ctx.agent("a");
  const b = ctx.ready(ctx.agent("b"));
  const alone = ctx.store.createDeal(a.rec, { title: "t", amount: 5000 });
  assert.equal(code(() => ctx.store.beginFunding(a.rec, alone.id)), "409:bad_state");
  ctx.store.joinDeal(b.rec, alone.inviteCode);
  assert.equal(code(() => ctx.store.beginFunding(b.rec, alone.id)), "403:not_buyer");
});

test("cancel works before funding but not after, and kills the invite", () => {
  const ctx = setup();
  const a = ctx.agent("a");
  const z = ctx.agent("z");
  const d = ctx.store.createDeal(a.rec, { title: "t", amount: 5000 });
  assert.equal(ctx.store.cancelDeal(a.rec, d.id).state, "cancelled");
  assert.equal(code(() => ctx.store.joinDeal(z.rec, d.inviteCode)), "404:invalid_invite");
  const { buyer, dealId } = funded(ctx, 5000);
  assert.equal(code(() => ctx.store.cancelDeal(buyer.rec, dealId)), "409:bad_state");
});

test("input validation", () => {
  const { store, agent } = setup();
  const a = agent("a");
  const bad = (input) => code(() => store.createDeal(a.rec, input));
  assert.equal(bad({ title: "t", amount: 0 }), "400:invalid_amount");
  assert.equal(bad({ title: "t", amount: 499 }), "400:invalid_amount");      // under NZ$5
  assert.equal(bad({ title: "t", amount: 1.5 }), "400:invalid_amount");      // cents are integers
  assert.equal(bad({ title: "t", amount: "5000" }), "400:invalid_amount");   // and never strings
  assert.equal(bad({ title: "t", amount: 2000001 }), "400:invalid_amount");  // over NZ$20,000
  assert.equal(bad({ title: "t", amount: -5000 }), "400:invalid_amount");
  assert.equal(bad({ title: "  ", amount: 5000 }), "400:invalid_title");
  assert.equal(bad({ title: "x".repeat(101), amount: 5000 }), "400:invalid_title");
  assert.equal(bad({ title: 7, amount: 5000 }), "400:invalid_title");
  assert.equal(bad({ title: "t", amount: 5000, role: "boss" }), "400:invalid_role");
  assert.equal(bad({ title: "t", amount: 5000, deadlineHours: 0 }), "400:invalid_deadline");
  assert.equal(bad({ title: "t", amount: 5000, deadlineHours: 721 }), "400:invalid_deadline");
  assert.equal(bad({ title: "t", amount: 5000, description: "d".repeat(501) }), "400:invalid_description");
  assert.equal(code(() => store.registerAgent("")), "400:invalid_name");
  assert.equal(code(() => store.registerAgent({})), "400:invalid_name");
  assert.equal(code(() => store.registerAgent("n".repeat(51))), "400:invalid_name");
});

test("an agent can hold at most 20 unfinished deals; finished ones don't count", () => {
  const ctx = setup();
  const a = ctx.agent("a");
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push(ctx.store.createDeal(a.rec, { title: "d" + i, amount: 5000 }).id);
  assert.equal(code(() => ctx.store.createDeal(a.rec, { title: "extra", amount: 5000 })), "429:too_many_open_deals");
  ctx.store.cancelDeal(a.rec, ids[0]);
  assert.equal(ctx.store.createDeal(a.rec, { title: "now ok", amount: 5000 }).state, "open");
});

test("across many random deals, no payment is ever attached to two deals", () => {
  const ctx = setup();
  const agents = Array.from({ length: 6 }, (_, i) => ctx.ready(ctx.agent("a" + i)));
  let seed = 42;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let i = 0; i < 200; i++) {
    const buyer = agents[rand(6)];
    const seller = agents[(agents.indexOf(buyer) + 1 + rand(5)) % 6];
    try {
      const d = ctx.store.createDeal(buyer.rec, { title: "r" + i, amount: 500 + rand(60) * 100, deadlineHours: 1 });
      ctx.store.joinDeal(seller.rec, d.inviteCode);
      const { deal, quote } = ctx.store.beginFunding(buyer.rec, d.id);
      ctx.store.attachIntent(deal, { provider: "stripe", intentId: "pi_" + i, stripeAccountId: seller.rec.connect.stripeAccountId, quote });
      ctx.store.markHeld(deal);
      const pick = rand(4);
      if (pick === 0) {
        ctx.store.beginRelease(buyer.rec, d.id);
        ctx.store.markReleased(deal, buyer.rec.id, { processorFee: 100, sellerNet: quote.amount - 100 });
      } else if (pick === 1) {
        ctx.store.beginRefund(seller.rec, d.id);
        ctx.store.markRefunded(deal, seller.rec.id, {});
      } else if (pick === 2) {
        ctx.clock.t += 2 * 3600 * 1000;
        ctx.store.beginRefund(buyer.rec, d.id);
        ctx.store.markRefunded(deal, buyer.rec.id, {});
      }
      // pick 3 leaves the money held
    } catch (e) {
      assert.ok(e.status, "only ApiErrors are expected: " + e.message);
    }
    const audit = ctx.store.audit();
    assert.equal(audit.ok, true, `inconsistent after round ${i}: ${audit.problems.join("; ")}`);
  }
});

// ---------- people, sessions, deal types ----------

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
  assert.equal(alice.rec.balance, undefined); // people have no balance either
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
  const create = (acct, type) => store.createDeal(acct.rec, { title: "t", amount: 5000, type });

  // creation rules
  assert.equal(code(() => create(ann, "ai-ai")), "403:wrong_account_type");
  assert.equal(code(() => create(bot1, "human-human")), "403:wrong_account_type");
  assert.equal(code(() => create(bot1, "nonsense")), "400:invalid_type");
  assert.equal(store.createDeal(bot1.rec, { title: "t", amount: 5000 }).type, "ai-ai"); // default for agents
  assert.equal(store.createDeal(ann.rec, { title: "t", amount: 5000 }).type, "human-human"); // default for people

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
  const ready = (rec, id) => {
    store.setConnectAccount(rec, id);
    store.updateConnectStatus(rec, { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true });
  };
  ready(bot.rec, "acct_bot");
  ready(ann.rec, "acct_ann");

  const run = (payer, payee, amount, intentId) => {
    const d = store.createDeal(payer, { title: "job", amount, type: "ai-human", role: "buyer" });
    store.joinDeal(payee, d.inviteCode);
    const { deal, quote } = store.beginFunding(payer, d.id);
    store.attachIntent(deal, { provider: "stripe", intentId, stripeAccountId: payee.connect.stripeAccountId, quote });
    store.markHeld(deal);
    store.beginRelease(payer, d.id);
    store.markReleased(deal, payer.id, { processorFee: 200, sellerNet: amount - 200 });
    return store.getDeal(payer, d.id);
  };

  // the person pays the AI
  let view = run(ann.rec, bot.rec, 6000, "pi_a");
  assert.equal(view.state, "released");
  assert.equal(view.payment.sellerNet, 5800);
  assert.equal(view.quote.buyerTotal, 6060); // 1% on top, paid by the buyer

  // and the AI pays the person
  view = run(bot.rec, ann.rec, 10000, "pi_b");
  assert.equal(view.state, "released");
  assert.equal(view.payment.sellerNet, 9800);
  assert.equal(store.audit().ok, true);
});
