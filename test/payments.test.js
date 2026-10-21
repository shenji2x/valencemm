// The money path, against a fake Stripe. These tests are the ones that matter most: they prove
// the design claims, not just the code paths.
//
//   - the charge is created ON the seller's account (direct charge), so disputes hit them
//   - it is authorised and not captured, so escrow is a hold rather than a balance
//   - Valence's 1% rides on the charge as an application fee
//   - cancelling a hold is not a refund, because nothing ever settled
const test = require("node:test");
const assert = require("node:assert/strict");
const { createStore } = require("../src/store");
const { createStripe } = require("../src/stripe");
const { createPayments } = require("../src/payments");
const { createFakeStripe } = require("./fakestripe");
const money = require("../src/money");

const quiet = { error() {}, log() {} };

async function setup() {
  const fake = createFakeStripe();
  const apiBase = await fake.listen();
  const clock = { t: Date.parse("2026-10-19T00:00:00Z") };
  const store = createStore({ now: () => clock.t });
  const stripe = createStripe({ secretKey: "sk_test_123", webhookSecret: fake.webhookSecret, apiBase, log: quiet });
  const payments = createPayments({ store, stripe, siteUrl: "https://valencemm.test", log: quiet });

  const agent = (name) => {
    const r = store.registerAgent(name);
    return { ...r, rec: store.authenticate(r.apiKey) };
  };
  // Takes a seller all the way through Stripe onboarding.
  const onboard = async (who) => {
    const link = await payments.onboardingLink(who.rec);
    fake.finishOnboarding(who.rec.connect.stripeAccountId);
    await payments.refreshPayoutStatus(who.rec);
    return link;
  };
  return { fake, store, stripe, payments, clock, agent, onboard, close: () => fake.close() };
}

// A deal with a hold already on the buyer's card.
async function held(ctx, amount = 50000, extra = {}) {
  const buyer = ctx.agent("buyer");
  const seller = ctx.agent("seller");
  await ctx.onboard(seller);
  const deal = ctx.store.createDeal(buyer.rec, { title: "Logo design", amount, ...extra });
  ctx.store.joinDeal(seller.rec, deal.inviteCode);
  const started = await ctx.payments.startFunding(buyer.rec, deal.id);
  ctx.fake.authorize(ctx.fake.lastIntent().id);
  await ctx.payments.confirmFunding(buyer.rec, deal.id);
  return { buyer, seller, dealId: deal.id, started };
}

const codeOf = async (fn) => {
  try { await fn(); } catch (e) { return `${e.status}:${e.code}`; }
  return "no error";
};

test("onboarding creates a Standard account the seller owns, and nothing is ready until Stripe says so", async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  const seller = ctx.agent("seller");

  const link = await ctx.payments.onboardingLink(seller.rec);
  assert.match(link.url, /^https:\/\/connect\.stripe\.test\/setup\//);
  // Standard accounts are the configuration where Stripe carries the connected account's losses
  // and collects its own fees from the seller. That is the whole liability position.
  assert.equal(ctx.fake.calls("/v1/accounts")[0].params.type, "standard");
  assert.equal(ctx.fake.calls("/v1/accounts")[0].params.country, "NZ");
  assert.equal(ctx.store.payoutsStatus(seller.rec).ready, false);

  // Asking twice reuses the account rather than creating a second one.
  await ctx.payments.onboardingLink(seller.rec);
  assert.equal(ctx.fake.calls("/v1/accounts").filter((c) => c.method === "POST").length, 1);

  ctx.fake.finishOnboarding(seller.rec.connect.stripeAccountId);
  const status = await ctx.payments.refreshPayoutStatus(seller.rec);
  assert.deepEqual(status, { provider: "stripe", started: true, detailsSubmitted: true, ready: true });
});

test("funding authorises on the seller's account and never captures", async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  const { started, seller } = await held(ctx, 50000);

  const create = ctx.fake.calls("/v1/payment_intents").find((c) => c.method === "POST");
  // The charge belongs to the seller: this is what puts chargeback liability on them.
  assert.equal(create.stripeAccount, seller.rec.connect.stripeAccountId);
  // A hold, not a payment.
  assert.equal(create.params.capture_method, "manual");
  // The buyer pays the deal plus Valence's 1%, and Valence's cut rides on the charge.
  assert.equal(Number(create.params.amount), 50500);
  assert.equal(Number(create.params.application_fee_amount), 500);
  // 3D Secure shifts fraud liability to the issuer, so ask for it every time.
  assert.equal(create.params["payment_method_options[card][request_three_d_secure]"], "any");
  assert.equal(create.params["metadata[valence_deal_id]"], started.deal.id);
  assert.match(started.clientSecret, /_secret_test$/);
  assert.equal(ctx.fake.lastIntent().status, "requires_capture");
  // Nothing has been captured, and no refund exists, because no money has moved.
  assert.equal(ctx.fake.calls("/capture").length, 0);
  assert.equal(ctx.fake.state.refunds.length, 0);
});

test("the deal only becomes funded once the card is actually authorised", async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  const buyer = ctx.agent("buyer");
  const seller = ctx.agent("seller");
  await ctx.onboard(seller);
  const deal = ctx.store.createDeal(buyer.rec, { title: "job", amount: 20000 });
  ctx.store.joinDeal(seller.rec, deal.inviteCode);

  await ctx.payments.startFunding(buyer.rec, deal.id);
  assert.equal(ctx.store.getDeal(buyer.rec, deal.id).state, "funding");
  // The browser claiming success is not enough: we ask Stripe.
  await ctx.payments.confirmFunding(buyer.rec, deal.id);
  assert.equal(ctx.store.getDeal(buyer.rec, deal.id).state, "funding");

  ctx.fake.authorize(ctx.fake.lastIntent().id);
  const view = await ctx.payments.confirmFunding(buyer.rec, deal.id);
  assert.equal(view.state, "funded");
  assert.equal(view.payment.status, "held");
  assert.equal(view.payment.last4, "4242");
});

test("a buyer who double-clicks gets one hold, not two", async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  const buyer = ctx.agent("buyer");
  const seller = ctx.agent("seller");
  await ctx.onboard(seller);
  const deal = ctx.store.createDeal(buyer.rec, { title: "job", amount: 20000 });
  ctx.store.joinDeal(seller.rec, deal.inviteCode);

  const first = await ctx.payments.startFunding(buyer.rec, deal.id);
  const second = await ctx.payments.startFunding(buyer.rec, deal.id);
  assert.equal(first.clientSecret, second.clientSecret);
  assert.equal(ctx.fake.calls("/v1/payment_intents").filter((c) => c.method === "POST").length, 1);
  // And the request carried an idempotency key, so a retry at the network level is safe too.
  assert.ok(ctx.fake.calls("/v1/payment_intents")[0].idempotencyKey);
});

test("releasing captures the hold and records what Stripe really took", async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  const { buyer, seller, dealId } = await held(ctx, 50000);

  const view = await ctx.payments.release(buyer.rec, dealId);
  assert.equal(view.state, "released");
  assert.equal(view.payment.status, "captured");

  const capture = ctx.fake.calls("/capture")[0];
  assert.equal(capture.stripeAccount, seller.rec.connect.stripeAccountId);
  assert.ok(capture.idempotencyKey);
  // The recorded processor fee is Stripe's alone: the application fee is ours and is excluded.
  const expectedStripeFee = Math.round(50500 * 0.027) + 30;
  assert.equal(view.payment.processorFee, expectedStripeFee);
  assert.equal(view.payment.sellerNet, 50500 - expectedStripeFee - 500);
  assert.equal(view.payment.platformFee, 500);
});

test("cancelling before capture releases the hold and is not a refund", async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  const { seller, dealId } = await held(ctx, 50000);

  const view = await ctx.payments.refund(seller.rec, dealId, { reason: "can't finish it" });
  assert.equal(view.state, "refunded");
  assert.equal(view.payment.status, "canceled");
  assert.equal(ctx.fake.lastIntent().status, "canceled");
  // The important part: no settled payment ever existed, so there is nothing to charge back.
  assert.equal(ctx.fake.state.refunds.length, 0);
  assert.equal(ctx.fake.calls("/cancel").length, 1);
});

test("refunding after capture does go through Stripe, and returns our fee too", async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  const { buyer, seller, dealId } = await held(ctx, 50000);
  await ctx.payments.release(buyer.rec, dealId);

  // Only reachable through a decided dispute, but it has to work when it is.
  const deal = ctx.store.dealById(dealId);
  deal.state = "funded";
  const view = await ctx.payments.refund(seller.rec, dealId, { reason: "dispute decided for the buyer" });
  assert.equal(view.payment.status, "refunded");
  assert.equal(ctx.fake.state.refunds.length, 1);
  assert.equal(ctx.fake.state.refunds[0].refund_application_fee, "true");
});

test("a declined card leaves the deal unfunded and says why", async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  const buyer = ctx.agent("buyer");
  const seller = ctx.agent("seller");
  await ctx.onboard(seller);
  const deal = ctx.store.createDeal(buyer.rec, { title: "job", amount: 20000 });
  ctx.store.joinDeal(seller.rec, deal.inviteCode);

  ctx.fake.declineNext({ status: 402, code: "card_declined", message: "Your card was declined." });
  assert.equal(await codeOf(() => ctx.payments.startFunding(buyer.rec, deal.id)), "502:provider_error");
  assert.equal(ctx.store.getDeal(buyer.rec, deal.id).state, "funding");
  assert.equal(ctx.store.getDeal(buyer.rec, deal.id).payment, null);
});

test("webhooks: a bad signature is refused, a good one funds the deal, a replay changes nothing", async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  const buyer = ctx.agent("buyer");
  const seller = ctx.agent("seller");
  await ctx.onboard(seller);
  const deal = ctx.store.createDeal(buyer.rec, { title: "job", amount: 20000 });
  ctx.store.joinDeal(seller.rec, deal.inviteCode);
  await ctx.payments.startFunding(buyer.rec, deal.id);
  const intent = ctx.fake.authorize(ctx.fake.lastIntent().id);

  const event = { id: "evt_1", account: seller.rec.connect.stripeAccountId, type: "payment_intent.amount_capturable_updated", data: { object: { ...intent, status: "requires_capture" } } };
  const signed = ctx.fake.sign(event);

  assert.equal(ctx.stripe.verifyWebhook(signed.payload, "t=1,v1=deadbeef").ok, false);
  assert.equal(ctx.stripe.verifyWebhook(signed.payload, undefined).reason, "no_signature");
  assert.equal(ctx.stripe.verifyWebhook(signed.payload, ctx.fake.sign(event, { secret: "whsec_wrong" }).header).reason, "bad_signature");
  // An old event is refused even with a valid signature, so a captured one can't be replayed later.
  assert.equal(ctx.stripe.verifyWebhook(signed.payload, ctx.fake.sign(event, { timestamp: 1000 }).header).reason, "stale");

  const ok = ctx.stripe.verifyWebhook(signed.payload, signed.header);
  assert.equal(ok.ok, true);
  assert.deepEqual(await ctx.payments.handleWebhook(ok.event), { handled: true, deal: deal.id, state: "funded" });

  const fundedTimes = () => ctx.store.getDeal(buyer.rec, deal.id).history.filter((h) => h.state === "funded").length;
  assert.equal(fundedTimes(), 1);
  await ctx.payments.handleWebhook(ok.event); // Stripe retries
  assert.equal(fundedTimes(), 1);
});

test("an account.updated webhook turns payouts on without the seller clicking anything", async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  const seller = ctx.agent("seller");
  await ctx.payments.onboardingLink(seller.rec);
  const acct = seller.rec.connect.stripeAccountId;
  assert.equal(ctx.store.payoutsStatus(seller.rec).ready, false);

  const r = await ctx.payments.handleWebhook({
    type: "account.updated",
    data: { object: { id: acct, charges_enabled: true, payouts_enabled: true, details_submitted: true } },
  });
  assert.deepEqual(r, { handled: true, account: seller.rec.id });
  assert.equal(ctx.store.payoutsStatus(seller.rec).ready, true);
  assert.equal(ctx.store.payments(seller.rec).events[0].event, "payouts_ready");
});

test("a chargeback webhook freezes the deal", async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  const { buyer, dealId } = await held(ctx, 50000);
  const intentId = ctx.fake.lastIntent().id;

  await ctx.payments.handleWebhook({
    type: "charge.dispute.created",
    account: ctx.fake.lastIntent().on_account,
    data: { object: { id: "dp_1", payment_intent: intentId, reason: "fraudulent" } },
  });
  const view = ctx.store.getDeal(buyer.rec, dealId);
  assert.equal(view.state, "disputed");
  assert.equal(view.dispute.kind, "chargeback");
});

test("a webhook for something we don't know about is ignored, not an error", async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  assert.equal((await ctx.payments.handleWebhook({ type: "invoice.paid", data: { object: {} } })).handled, false);
  assert.equal((await ctx.payments.handleWebhook({ type: "payment_intent.succeeded", data: { object: { id: "pi_nope" } } })).handled, false);
  assert.equal((await ctx.payments.handleWebhook(null)).handled, false);
});

test("webhooks reject the wrong connected account and ignore stale statuses after a refund", async t => {
  const ctx = await setup(); t.after(ctx.close);
  const { buyer, seller, dealId } = await held(ctx);
  const intent = { ...ctx.fake.lastIntent() };
  const event = { type: "payment_intent.succeeded", account: "acct_other", data: { object: intent } };
  assert.equal((await ctx.payments.handleWebhook(event)).handled, false);
  assert.equal(ctx.store.getDeal(buyer.rec, dealId).state, "funded");
  await ctx.payments.refund(seller.rec, dealId);
  await ctx.payments.handleWebhook({ ...event, account: intent.on_account, data: { object: { ...intent, status: "requires_capture" } } });
  assert.equal(ctx.store.getDeal(buyer.rec, dealId).state, "refunded");
  assert.equal(ctx.store.getDeal(buyer.rec, dealId).payment.status, "canceled");
});

test("provider confirmation verifies amount, currency, intent and deal identity before funding", async t => {
  const ctx = await setup(); t.after(ctx.close);
  const buyer = ctx.agent("buyer"), seller = ctx.agent("seller"); await ctx.onboard(seller);
  const d = ctx.store.createDeal(buyer.rec, { title: "Verification", amount: 50000 }); ctx.store.joinDeal(seller.rec, d.inviteCode);
  await ctx.payments.startFunding(buyer.rec, d.id);
  const intent = ctx.fake.authorize(ctx.fake.lastIntent().id);
  for (const [key, wrong] of [["amount", 1], ["currency", "eur"], ["id", "pi_other"], ["metadata", { valence_deal_id: "deal_other" }]]) {
    const original = intent[key]; intent[key] = wrong;
    await assert.rejects(ctx.payments.confirmFunding(buyer.rec, d.id), e => e.code === "payment_verification_failed");
    assert.equal(ctx.store.getDeal(buyer.rec, d.id).state, "funding"); intent[key] = original;
  }
  await ctx.payments.confirmFunding(buyer.rec, d.id);
  assert.equal(ctx.store.getDeal(buyer.rec, d.id).state, "funded");
});

test("a delivered deal nobody responds to releases on its own", async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  const { seller, dealId } = await held(ctx, 50000);
  ctx.store.markDelivered(seller.rec, dealId);

  assert.deepEqual(await ctx.payments.runAutoRelease(), { considered: 0, released: 0 });
  ctx.clock.t += 72 * 3600 * 1000;
  assert.deepEqual(await ctx.payments.runAutoRelease(), { considered: 1, released: 1 });
  assert.equal(ctx.store.getDeal(seller.rec, dealId).state, "released");
  assert.equal(ctx.fake.lastIntent().status, "succeeded");
});

test("a hold about to expire is cancelled rather than left to lapse quietly", async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  const { buyer, dealId } = await held(ctx, 50000, { deadlineHours: 168 });

  assert.deepEqual(await ctx.payments.sweepExpiringHolds(), { considered: 0, cancelled: 0 });
  ctx.clock.t += money.HOLD_MS - money.HOLD_SAFETY_MS;
  assert.deepEqual(await ctx.payments.sweepExpiringHolds(), { considered: 1, cancelled: 1 });

  const view = ctx.store.getDeal(buyer.rec, dealId);
  assert.equal(view.state, "refunded");
  assert.equal(view.payment.status, "canceled");
  assert.match(ctx.store.payments(buyer.rec).events[0].detail, /hold on the card was about to expire/);
});

test("with no Stripe key, every money route refuses clearly instead of half working", async (t) => {
  const store = createStore();
  const stripe = createStripe({ log: quiet });
  const payments = createPayments({ store, stripe, log: quiet });
  const r = store.registerAgent("solo");
  const rec = store.authenticate(r.apiKey);

  assert.equal(stripe.configured, false);
  assert.equal(payments.configured, false);
  assert.equal(await codeOf(() => payments.onboardingLink(rec)), "503:payments_off");
  assert.equal(await codeOf(() => payments.startFunding(rec, "deal_x")), "503:payments_off");
  assert.equal(payments.startTimers(), null); // nothing to sweep
  assert.deepEqual(stripe.verifyWebhook("{}", "t=1,v1=x"), { ok: false, reason: "no_webhook_secret" });
});

