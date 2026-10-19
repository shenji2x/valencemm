// A stand-in for Stripe, good enough to prove the payment flow end to end: accounts, hosted
// onboarding links, manual-capture PaymentIntents, capture, cancel, refunds and signed webhooks.
//
// It records every request so tests can assert on the parameters that matter -- capture_method,
// application_fee_amount and the Stripe-Account header are the whole design, so they get checked.

const http = require("http");
const crypto = require("crypto");

function parseForm(body) {
  const out = {};
  for (const pair of String(body || "").split("&")) {
    if (!pair) continue;
    const i = pair.indexOf("=");
    out[decodeURIComponent(pair.slice(0, i).replace(/\+/g, " "))] = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, " "));
  }
  return out;
}

function createFakeStripe({ webhookSecret = "whsec_test" } = {}) {
  const state = {
    requests: [],          // { method, path, params, stripeAccount, idempotencyKey }
    accounts: new Map(),
    intents: new Map(),
    refunds: [],
    nextFail: null,        // { status, code, message } -> the next request fails
    seq: 0,
  };
  const id = (prefix) => `${prefix}_${++state.seq}${crypto.randomBytes(3).toString("hex")}`;

  // A captured charge, with the balance transaction expanded the way the real API does it.
  function chargeFor(intent) {
    const stripeFee = Math.round(intent.amount * 0.027) + 30;
    const appFee = intent.application_fee_amount || 0;
    return {
      id: id("ch"),
      payment_method_details: { card: { brand: "visa", last4: "4242" } },
      balance_transaction: {
        id: id("txn"),
        fee: stripeFee + appFee,
        net: intent.amount - stripeFee - appFee,
        fee_details: [
          { type: "stripe_fee", amount: stripeFee },
          { type: "application_fee", amount: appFee },
        ],
      },
    };
  }

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const params = req.method === "GET" ? {} : parseForm(body);
      const path = req.url.split("?")[0];
      state.requests.push({
        method: req.method,
        path,
        params,
        stripeAccount: req.headers["stripe-account"] || null,
        idempotencyKey: req.headers["idempotency-key"] || null,
        auth: req.headers.authorization || null,
      });

      const send = (status, obj) => {
        const out = JSON.stringify(obj);
        res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(out) });
        res.end(out);
      };
      const fail = (status, code, message) => send(status, { error: { type: "invalid_request_error", code, message } });

      if (state.nextFail) {
        const f = state.nextFail;
        state.nextFail = null;
        return fail(f.status || 402, f.code || "card_declined", f.message || "Your card was declined.");
      }

      // ---- accounts ----
      if (path === "/v1/accounts" && req.method === "POST") {
        const acct = {
          id: id("acct"),
          type: params.type,
          country: params.country,
          charges_enabled: false,
          payouts_enabled: false,
          details_submitted: false,
        };
        state.accounts.set(acct.id, acct);
        return send(200, acct);
      }
      const acctMatch = path.match(/^\/v1\/accounts\/([^/]+)$/);
      if (acctMatch && req.method === "GET") {
        const acct = state.accounts.get(acctMatch[1]);
        return acct ? send(200, acct) : fail(404, "resource_missing", "No such account");
      }
      if (path === "/v1/account_links" && req.method === "POST") {
        return send(200, {
          url: `https://connect.stripe.test/setup/${params.account}`,
          expires_at: Math.floor(Date.now() / 1000) + 300,
        });
      }

      // ---- payment intents ----
      if (path === "/v1/payment_intents" && req.method === "POST") {
        const intent = {
          id: id("pi"),
          object: "payment_intent",
          amount: Number(params.amount),
          currency: params.currency,
          capture_method: params.capture_method,
          application_fee_amount: Number(params.application_fee_amount || 0),
          transfer_group: params.transfer_group,
          metadata: { valence_deal_id: params["metadata[valence_deal_id]"] },
          status: "requires_payment_method",
          latest_charge: null,
          on_account: req.headers["stripe-account"] || null,
        };
        intent.client_secret = `${intent.id}_secret_test`;
        state.intents.set(intent.id, intent);
        return send(200, intent);
      }
      const piMatch = path.match(/^\/v1\/payment_intents\/([^/]+)(\/capture|\/cancel)?$/);
      if (piMatch) {
        const intent = state.intents.get(piMatch[1]);
        if (!intent) return fail(404, "resource_missing", "No such payment intent");
        const action = piMatch[2];
        if (!action) return send(200, intent);
        if (action === "/capture") {
          if (intent.status !== "requires_capture") return fail(400, "payment_intent_unexpected_state", `Cannot capture a PaymentIntent that is ${intent.status}.`);
          intent.status = "succeeded";
          intent.latest_charge = chargeFor(intent);
          return send(200, intent);
        }
        if (intent.status === "succeeded") return fail(400, "payment_intent_unexpected_state", "Cannot cancel a captured PaymentIntent.");
        intent.status = "canceled";
        intent.cancellation_reason = params.cancellation_reason || "abandoned";
        return send(200, intent);
      }

      if (path === "/v1/refunds" && req.method === "POST") {
        const intent = state.intents.get(params.payment_intent);
        if (!intent) return fail(404, "resource_missing", "No such payment intent");
        const refund = { id: id("re"), payment_intent: intent.id, amount: Number(params.amount || intent.amount), status: "succeeded" };
        state.refunds.push({ ...refund, refund_application_fee: params.refund_application_fee });
        return send(200, refund);
      }

      return fail(404, "unknown_route", `fake stripe has no route for ${req.method} ${path}`);
    });
  });

  return {
    server,
    state,
    async listen() {
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${server.address().port}`;
    },
    close() {
      return new Promise((r) => server.close(r));
    },

    // ---- helpers tests use to drive the fake ----

    // Stand in for the buyer entering a card: the hold is now on it.
    authorize(intentId) {
      const intent = this.state.intents.get(intentId);
      intent.status = "requires_capture";
      intent.latest_charge = { id: "ch_auth", payment_method_details: { card: { brand: "visa", last4: "4242" } } };
      return intent;
    },
    finishOnboarding(stripeAccountId) {
      Object.assign(this.state.accounts.get(stripeAccountId), {
        charges_enabled: true, payouts_enabled: true, details_submitted: true,
      });
    },
    declineNext(detail = {}) {
      this.state.nextFail = detail;
    },
    lastIntent() {
      return [...this.state.intents.values()].pop();
    },
    calls(path) {
      return this.state.requests.filter((r) => r.path === path || r.path.endsWith(path));
    },

    // Signs a webhook the way Stripe does, so verification is exercised for real.
    sign(event, { secret = webhookSecret, timestamp = Math.floor(Date.now() / 1000) } = {}) {
      const payload = JSON.stringify(event);
      const sig = crypto.createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
      return { payload, header: `t=${timestamp},v1=${sig}` };
    },
    webhookSecret,
  };
}

module.exports = { createFakeStripe };
