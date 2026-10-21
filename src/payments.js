// Ties deals to money. The store records what happened; this module is the only thing that
// talks to Stripe, and nothing here ever holds a balance.
//
// The whole lifecycle in one place:
//
//   seller onboards   -> a Standard Stripe account of their own, verified by Stripe
//   buyer funds       -> a manual-capture PaymentIntent ON the seller's account: a hold, no money moved
//   buyer releases    -> capture. Stripe pays the seller and routes Valence's 1% in the same instant
//   refund            -> cancel the hold. Nothing settled, so there is nothing to charge back
//   hold near expiry  -> cancel it rather than let it lapse silently, and tell both sides
//
// A card authorisation lasts about 7 days, which is why a deal's deadline is clamped to the
// hold's expiry when it is funded.

const money = require("./money");
const { ApiError } = require("./errors");
const { requireCardDeal } = require("./crypto-checkout");

const AUTO_RELEASE_MS = 72 * 3600 * 1000; // after the seller marks delivery and the buyer stays silent
const SWEEP_EVERY_MS = 15 * 60 * 1000;

function feesFromCharge(charge, { applicationFee }) {
  const bt = charge && charge.balance_transaction;
  if (!bt || typeof bt !== "object") return { processorFee: null, sellerNet: null };
  const details = bt.fee_details || [];
  const stripeFee = details
    .filter((d) => d.type !== "application_fee")
    .reduce((sum, d) => sum + (d.amount || 0), 0);
  return {
    // Stripe's own cut, which the seller pays as merchant of record. Valence's fee is separate.
    processorFee: stripeFee || Math.max(0, (bt.fee || 0) - (applicationFee || 0)),
    sellerNet: bt.net == null ? null : bt.net,
  };
}

function createPayments({ store, stripe, persistence, siteUrl = "https://valencemm.com", now = () => Date.now(), log = console } = {}) {
  const save = () => (persistence ? persistence.commit() : Promise.resolve());

  function mustBeConfigured() {
    if (!stripe.configured) {
      throw new ApiError(503, "payments_off", "Card payments aren't switched on for this server yet.");
    }
  }

  // Turns a Stripe failure into something a person can read, without leaking internals.
  function fail(err, what) {
    if (err instanceof ApiError) throw err;
    const d = stripe.describeError(err);
    log.error?.(`Stripe ${what} failed:`, d.code, d.message);
    throw new ApiError(502, "provider_error", d.message || "The payment provider refused that. Nothing was charged.");
  }

  // ---- the seller's payout account ----

  async function onboardingLink(account, { returnPath = "/dashboard#settings" } = {}) {
    mustBeConfigured();
    try {
      let id = account.connect && account.connect.stripeAccountId;
      if (!id) {
        const created = await stripe.createAccount({ accountId: account.id, email: account.email || null });
        id = created.id;
        store.setConnectAccount(account, id);
        await save();
      }
      const link = await stripe.accountLink({
        stripeAccountId: id,
        refreshUrl: `${siteUrl}/dashboard#settings`,
        returnUrl: `${siteUrl}${returnPath}`,
      });
      return { url: link.url, expiresAt: new Date(link.expires_at * 1000).toISOString(), payouts: store.payoutsStatus(account) };
    } catch (err) {
      fail(err, "onboarding");
    }
  }

  // Called when the seller comes back from Stripe, and from the account.updated webhook.
  async function refreshPayoutStatus(account) {
    if (!stripe.configured || !account.connect || !account.connect.stripeAccountId) return store.payoutsStatus(account);
    try {
      const acct = await stripe.getAccount(account.connect.stripeAccountId);
      const status = store.updateConnectStatus(account, {
        chargesEnabled: acct.charges_enabled,
        payoutsEnabled: acct.payouts_enabled,
        detailsSubmitted: acct.details_submitted,
      });
      await save();
      return status;
    } catch (err) {
      log.error?.("Stripe account refresh failed:", err.message);
      return store.payoutsStatus(account);
    }
  }

  // ---- funding ----

  // Prices the deal and puts a hold on the buyer's card. Returns what the browser needs to
  // show Stripe's own card form; the card details never reach us.
  async function startFunding(account, dealId) {
    mustBeConfigured();
    const { deal, seller, quote } = store.beginFunding(account, dealId);

    // Reuse an intent we already made for this deal rather than stacking holds on one card.
    const existing = deal.payment;
    if (existing && existing.status === "pending" && existing.intentId) {
      try {
        const intent = await stripe.getIntent({ stripeAccountId: existing.stripeAccountId, intentId: existing.intentId });
        if (["requires_payment_method", "requires_confirmation", "requires_action"].includes(intent.status) && intent.amount === quote.buyerTotal) {
          return { clientSecret: intent.client_secret, quote, stripeAccount: existing.stripeAccountId, deal: store.getDeal(account, deal.id) };
        }
        if (intent.status === "requires_capture") {
          // It was already authorised and we missed the webhook.
          store.markHeld(deal, cardBits(intent));
          await save();
          return { alreadyFunded: true, deal: store.getDeal(account, deal.id) };
        }
      } catch (err) {
        log.error?.("Could not reuse the existing intent, making a new one:", err.message);
      }
    }

    try {
      const intent = await stripe.createIntent({
        stripeAccountId: seller.connect.stripeAccountId,
        amount: quote.buyerTotal,
        currency: quote.currency,
        applicationFee: quote.platformFee,
        dealId: deal.id,
        description: `Valence deal ${deal.id}: ${deal.title}`.slice(0, 200),
        // One hold per deal per price. A double-click cannot make two.
        idempotencyKey: `fund_${deal.id}_${quote.buyerTotal}`,
      });
      store.attachIntent(deal, {
        provider: "stripe",
        intentId: intent.id,
        stripeAccountId: seller.connect.stripeAccountId,
        quote,
      });
      await save();
      return { clientSecret: intent.client_secret, quote, stripeAccount: seller.connect.stripeAccountId, deal: store.getDeal(account, deal.id) };
    } catch (err) {
      fail(err, "authorisation");
    }
  }

  function cardBits(intent) {
    const charge = intent.latest_charge && typeof intent.latest_charge === "object" ? intent.latest_charge : null;
    const card = charge && charge.payment_method_details && charge.payment_method_details.card;
    return { brand: card ? card.brand : null, last4: card ? card.last4 : null };
  }

  // The browser says the card went through. The webhook is the source of truth, but the buyer is
  // standing there waiting, so we check with Stripe directly instead of making them refresh.
  async function confirmFunding(account, dealId) {
    const deal = store.dealById(dealId);
    if (!deal || (deal.buyerId !== account.id && deal.sellerId !== account.id)) {
      throw new ApiError(404, "deal_not_found", "Deal not found");
    }
    requireCardDeal(deal);
    const p = deal.payment;
    if (!p || !p.intentId) throw new ApiError(409, "no_payment", "This deal has no payment to confirm");
    if (p.status === "held" || p.status === "captured") return store.getDeal(account, dealId);
    try {
      const intent = await stripe.getIntent({ stripeAccountId: p.stripeAccountId, intentId: p.intentId });
      applyIntent(deal, intent);
      await save();
      return store.getDeal(account, dealId);
    } catch (err) {
      fail(err, "confirmation");
    }
  }

  // One place that maps a Stripe intent status onto our deal, used by both polling and webhooks.
  function applyIntent(deal, intent) {
    requireCardDeal(deal);
    const p = deal.payment;
    if (!p || p.provider !== "stripe" || intent.id !== p.intentId || intent.amount !== p.amount ||
        intent.currency !== p.currency || intent.metadata?.valence_deal_id !== deal.id) {
      throw new ApiError(502, "payment_verification_failed", "The provider payment does not match this deal. Contact support.");
    }
    // A delayed authorization event cannot reopen a completed or disputed deal.
    if (["released", "refunded", "cancelled", "disputed"].includes(deal.state)) return deal;
    if (intent.status === "requires_capture") return store.markHeld(deal, cardBits(intent));
    if (intent.status === "succeeded") {
      // Captured without us asking: only possible if someone captured in the Stripe dashboard.
      const charge = typeof intent.latest_charge === "object" ? intent.latest_charge : null;
      store.markHeld(deal, cardBits(intent));
      return store.markReleased(deal, null, feesFromCharge(charge, { applicationFee: deal.payment.platformFee }));
    }
    if (intent.status === "canceled") return store.markRefunded(deal, null, { reason: intent.cancellation_reason || "canceled at the provider" });
    if (intent.last_payment_error) return store.markHeldFailed(deal, intent.last_payment_error.message);
    return deal;
  }

  // ---- release ----

  async function release(account, dealId, { byTimer = false } = {}) {
    mustBeConfigured();
    const { deal, payment } = store.beginRelease(account, dealId, { byTimer });
    try {
      const intent = await stripe.capture({
        stripeAccountId: payment.stripeAccountId,
        intentId: payment.intentId,
        idempotencyKey: `capture_${deal.id}`,
      });
      const charge = typeof intent.latest_charge === "object" ? intent.latest_charge : null;
      store.markReleased(deal, byTimer ? null : account.id, feesFromCharge(charge, { applicationFee: payment.platformFee }));
      await save();
      return byTimer ? deal : store.getDeal(account, dealId);
    } catch (err) {
      fail(err, "capture");
    }
  }

  // ---- refund ----

  // Before capture this cancels the hold, which is the good case: no money ever moved, so there
  // is no settled payment for anyone to dispute later.
  async function refund(account, dealId, { reason = null } = {}) {
    mustBeConfigured();
    const { deal, payment, captured } = store.beginRefund(account, dealId);
    try {
      if (captured) {
        await stripe.refund({
          stripeAccountId: payment.stripeAccountId,
          intentId: payment.intentId,
          idempotencyKey: `refund_${deal.id}`,
        });
        store.markRefunded(deal, account.id, { reason, refunded: true });
      } else {
        await stripe.cancel({
          stripeAccountId: payment.stripeAccountId,
          intentId: payment.intentId,
          idempotencyKey: `cancel_${deal.id}`,
        });
        store.markRefunded(deal, account.id, { reason });
      }
      await save();
      return store.getDeal(account, dealId);
    } catch (err) {
      fail(err, "refund");
    }
  }

  // ---- timers ----

  // A delivered deal nobody objected to gets released, so an absent buyer (or an AI agent that
  // never comes back) can't strand a seller's money until the hold lapses.
  async function runAutoRelease({ windowMs = AUTO_RELEASE_MS } = {}) {
    const due = store.dealsDueForAutoRelease(windowMs);
    let released = 0;
    for (const deal of due) {
      try {
        await release({ id: deal.buyerId }, deal.id, { byTimer: true });
        released++;
      } catch (err) {
        log.error?.(`Auto-release failed for ${deal.id}:`, err.message);
      }
    }
    return { considered: due.length, released };
  }

  // A hold that lapses on its own leaves a deal looking funded when it isn't. Cancel first and
  // say so, rather than discovering it later.
  async function sweepExpiringHolds() {
    const risky = store.dealsWithExpiringHolds();
    let cancelled = 0;
    for (const deal of risky) {
      try {
        await stripe.cancel({
          stripeAccountId: deal.payment.stripeAccountId,
          intentId: deal.payment.intentId,
          reason: "abandoned",
          idempotencyKey: `expire_${deal.id}`,
        });
        store.markRefunded(deal, null, { reason: `the ${money.HOLD_DAYS}-day hold on the card was about to expire` });
        cancelled++;
      } catch (err) {
        log.error?.(`Could not cancel the expiring hold on ${deal.id}:`, err.message);
      }
    }
    if (cancelled) await save();
    return { considered: risky.length, cancelled };
  }

  let timer = null;
  function startTimers({ everyMs = SWEEP_EVERY_MS } = {}) {
    if (timer || !stripe.configured) return null;
    timer = setInterval(() => {
      runAutoRelease().catch((e) => log.error?.("auto-release sweep:", e.message));
      sweepExpiringHolds().catch((e) => log.error?.("hold sweep:", e.message));
    }, everyMs);
    timer.unref?.();
    return timer;
  }
  function stopTimers() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // ---- webhooks ----

  // Stripe is the source of truth for anything that moved. Handlers must be safe to run twice:
  // Stripe retries, and events do not always arrive in order.
  async function handleWebhook(event) {
    const type = event && event.type;
    const obj = event && event.data && event.data.object;
    if (!type || !obj) return { handled: false };

    if (type === "account.updated") {
      const account = store.accountByStripeId(obj.id);
      if (!account) return { handled: false, reason: "unknown account" };
      store.updateConnectStatus(account, {
        chargesEnabled: obj.charges_enabled,
        payoutsEnabled: obj.payouts_enabled,
        detailsSubmitted: obj.details_submitted,
      });
      await save();
      return { handled: true, account: account.id };
    }

    if (type.startsWith("payment_intent.")) {
      const deal = store.dealByIntent(obj.id);
      if (!deal) return { handled: false, reason: "unknown intent" };
      if (event.account !== deal.payment.stripeAccountId) return { handled: false, reason: "wrong connected account" };
      // Signed events can arrive out of order. Read the current provider state on
      // the bound seller account rather than trusting an old event's status.
      const current = await stripe.getIntent({ stripeAccountId: deal.payment.stripeAccountId, intentId: deal.payment.intentId });
      applyIntent(deal, current);
      await save();
      return { handled: true, deal: deal.id, state: deal.state };
    }

    if (type === "charge.dispute.created" || type === "charge.dispute.closed") {
      const intentId = obj.payment_intent;
      const deal = intentId ? store.dealByIntent(intentId) : null;
      if (!deal) return { handled: false, reason: "unknown intent" };
      if (event.account !== deal.payment.stripeAccountId) return { handled: false, reason: "wrong connected account" };
      store.recordChargeback(deal, `${type === "charge.dispute.closed" ? `closed as ${obj.status}` : obj.reason || "disputed"}`);
      await save();
      return { handled: true, deal: deal.id };
    }

    return { handled: false, reason: "not interesting" };
  }

  return {
    get configured() {
      return stripe.configured;
    },
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
    onboardingLink, refreshPayoutStatus,
    startFunding, confirmFunding,
    release, refund,
    runAutoRelease, sweepExpiringHolds, startTimers, stopTimers,
    handleWebhook,
    AUTO_RELEASE_MS,
  };
}

module.exports = { createPayments, AUTO_RELEASE_MS, feesFromCharge };

