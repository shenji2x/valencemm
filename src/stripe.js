// Stripe Connect, configured so that Valence never holds money and never carries a chargeback.
//
// The configuration is deliberate and each part of it does a job:
//
//   Standard connected accounts  The seller has their own Stripe account. Stripe collects their
//                                identity documents and bank details, Stripe is responsible for
//                                any negative balance on it, and Stripe bills them for their own
//                                processing fees. None of that is Valence's job or Valence's risk.
//
//   Direct charges               The charge is created ON the seller's account, so the seller is
//                                the merchant of record. If the buyer's bank reverses a payment,
//                                Stripe debits the seller's balance, not Valence's. With
//                                destination charges it would be the other way around.
//
//   Manual capture               The buyer's card is authorised at funding and captured only on
//                                release. Until then no money has moved: the hold IS the escrow.
//                                Cancelling an authorisation leaves nothing to charge back.
//
//   application_fee_amount       Valence's 1% is routed by Stripe at the moment of capture. It is
//                                never mixed with money owed to a seller.
//
//   3D Secure, requested always  An authenticated card shifts fraud liability to the issuer.
//
// Set STRIPE_SECRET_KEY to turn this on, STRIPE_WEBHOOK_SECRET to accept webhooks. With neither,
// mode is "off" and the payments UI says so rather than pretending to work.

const crypto = require("crypto");

const API = process.env.STRIPE_API_BASE || "https://api.stripe.com";
const VERSION = "2024-06-20";
const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

// Stripe takes form-encoded bodies with bracketed paths for nesting.
function encode(params, prefix = "", out = []) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const path = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((v, i) => (typeof v === "object" && v !== null ? encode(v, `${path}[${i}]`, out) : out.push(`${encodeURIComponent(`${path}[${i}]`)}=${encodeURIComponent(v)}`)));
    } else if (typeof value === "object") {
      encode(value, path, out);
    } else {
      out.push(`${encodeURIComponent(path)}=${encodeURIComponent(value)}`);
    }
  }
  return out;
}

class StripeError extends Error {
  constructor(status, body) {
    const err = (body && body.error) || {};
    super(err.message || `Stripe request failed (${status})`);
    this.name = "StripeError";
    this.status = status;
    this.code = err.code || err.type || "stripe_error";
    this.declineCode = err.decline_code || null;
    this.raw = body;
  }
}

function createStripe({ secretKey, webhookSecret, premiumWebhookSecret, apiBase = API, fetchImpl = fetch, log = console } = {}) {
  const mode = secretKey ? "live" : "off";

  async function request(method, path, params, { stripeAccount, idempotencyKey } = {}) {
    if (mode === "off") throw new Error("Stripe is not configured on this server");
    const headers = {
      Authorization: `Bearer ${secretKey}`,
      "Stripe-Version": VERSION,
    };
    if (stripeAccount) headers["Stripe-Account"] = stripeAccount;
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    let url = `${apiBase}${path}`;
    let body;
    const encoded = params ? encode(params).join("&") : "";
    if (method === "GET") {
      if (encoded) url += `?${encoded}`;
    } else {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = encoded;
    }
    const res = await fetchImpl(url, { method, headers, body });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Stripe returned something that isn't JSON (${res.status})`);
    }
    if (!res.ok) throw new StripeError(res.status, json);
    return json;
  }

  return {
    mode,
    get configured() {
      return mode === "live";
    },
    acceptsWebhooks: Boolean(webhookSecret),
    acceptsPremiumWebhooks: Boolean(premiumWebhookSecret || webhookSecret),
    request,

    // ---- the seller's own Stripe account ----

    // A Standard account: the seller owns it, Stripe verifies them, Stripe carries their losses.
    createAccount({ accountId, email, country = "NZ" }) {
      return request("POST", "/v1/accounts", {
        type: "standard",
        country,
        email: email || undefined,
        metadata: { valence_account_id: accountId },
      }, { idempotencyKey: `acct_${accountId}` });
    },

    // Hosted onboarding. The seller fills everything in on Stripe's pages, never ours.
    accountLink({ stripeAccountId, refreshUrl, returnUrl }) {
      return request("POST", "/v1/account_links", {
        account: stripeAccountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: "account_onboarding",
        collect: "currently_due",
      });
    },

    getAccount(stripeAccountId) {
      return request("GET", `/v1/accounts/${stripeAccountId}`);
    },

    // ---- the money ----

    // Authorise, don't capture. `applicationFee` is Valence's commission, in minor units.
    createIntent({ stripeAccountId, amount, currency, applicationFee, dealId, description, idempotencyKey }) {
      return request("POST", "/v1/payment_intents", {
        amount,
        currency,
        capture_method: "manual",
        application_fee_amount: applicationFee,
        description: description || undefined,
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        // An authenticated card moves fraud liability to the issuer, so ask for it every time.
        payment_method_options: { card: { request_three_d_secure: "any", capture_method: "manual" } },
        transfer_group: dealId,
        metadata: { valence_deal_id: dealId },
      }, { stripeAccount: stripeAccountId, idempotencyKey });
    },

    getIntent({ stripeAccountId, intentId }) {
      return request("GET", `/v1/payment_intents/${intentId}`, null, { stripeAccount: stripeAccountId });
    },

    // Release: take the money that was held, and Valence's fee with it.
    capture({ stripeAccountId, intentId, amountToCapture, idempotencyKey }) {
      return request("POST", `/v1/payment_intents/${intentId}/capture`, {
        amount_to_capture: amountToCapture || undefined,
      }, { stripeAccount: stripeAccountId, idempotencyKey });
    },

    // Refund before capture: the hold simply disappears. Nothing settled, nothing to dispute.
    cancel({ stripeAccountId, intentId, reason = "requested_by_customer", idempotencyKey }) {
      return request("POST", `/v1/payment_intents/${intentId}/cancel`, {
        cancellation_reason: reason,
      }, { stripeAccount: stripeAccountId, idempotencyKey });
    },

    // Refund after capture. Only needed when a dispute is decided after release.
    refund({ stripeAccountId, intentId, amount, idempotencyKey }) {
      return request("POST", "/v1/refunds", {
        payment_intent: intentId,
        amount: amount || undefined,
        refund_application_fee: true,
        reverse_transfer: false,
      }, { stripeAccount: stripeAccountId, idempotencyKey });
    },

    // Stripe signs every webhook. An unsigned or stale one is not from Stripe.
    verifyWebhook(rawBody, signatureHeader, { now = Date.now(), premium = false } = {}) {
      const signingSecret = premium ? premiumWebhookSecret || webhookSecret : webhookSecret;
      if (!signingSecret) return { ok: false, reason: "no_webhook_secret" };
      if (typeof signatureHeader !== "string" || !signatureHeader) return { ok: false, reason: "no_signature" };
      const parts = new Map(signatureHeader.split(",").map((p) => {
        const i = p.indexOf("=");
        return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
      }));
      const timestamp = parts.get("t");
      const given = parts.get("v1");
      if (!timestamp || !given) return { ok: false, reason: "malformed_signature" };
      if (Math.abs(now - Number(timestamp) * 1000) > WEBHOOK_TOLERANCE_MS) return { ok: false, reason: "stale" };
      const expected = crypto.createHmac("sha256", signingSecret)
        .update(`${timestamp}.${Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody}`)
        .digest("hex");
      const a = Buffer.from(expected, "utf8");
      const b = Buffer.from(given, "utf8");
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "bad_signature" };
      try {
        return { ok: true, event: JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody) };
      } catch {
        return { ok: false, reason: "bad_json" };
      }
    },

    describeError(err) {
      if (!(err instanceof StripeError)) return { code: "stripe_unavailable", message: "The payment provider didn't respond. Nothing was charged." };
      log.error?.("Stripe error:", err.code, err.message);
      return { code: err.code, message: err.message, declineCode: err.declineCode };
    },
  };
}

function stripeFromEnv(overrides = {}) {
  return createStripe({
    secretKey: process.env.STRIPE_SECRET_KEY || null,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
    premiumWebhookSecret: process.env.STRIPE_PREMIUM_WEBHOOK_SECRET || null,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
    ...overrides,
  });
}

module.exports = { createStripe, stripeFromEnv, StripeError, encode };

