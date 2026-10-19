// The fee engine. Everything here is arithmetic on integer cents, so it is cheap to pin down
// exactly -- and worth pinning down, because these numbers appear on screens before anyone pays.
const test = require("node:test");
const assert = require("node:assert/strict");
const money = require("../src/money");

test("the buyer pays the deal plus 1%, and the seller is quoted what they asked for", () => {
  const q = money.quote(50000); // NZ$500.00
  assert.equal(q.amount, 50000);
  assert.equal(q.platformFee, 500);
  assert.equal(q.buyerTotal, 50500);
  // Stripe's fee is charged on what is actually charged, which is the buyer's total.
  assert.equal(q.processorFee, Math.round(50500 * 0.027) + 30);
  assert.equal(q.sellerNet, 50000 - q.processorFee);
  assert.equal(q.currency, "nzd");
});

test("small deals pay a floor fee, so they cover their own support cost", () => {
  // 1% of NZ$5 is 5c, which does not pay for a single support message.
  assert.equal(money.platformFee(500), 50);
  assert.equal(money.platformFee(4999), 50);
  assert.equal(money.platformFee(5000), 50);  // exactly the floor
  assert.equal(money.platformFee(5001), 50);
  assert.equal(money.platformFee(10000), 100); // 1% takes over above NZ$50
});

test("an overseas card costs the seller more, and both figures are available", () => {
  const r = money.quoteRange(50000);
  assert.ok(r.processorFeeWorst > r.processorFee);
  assert.ok(r.sellerNetWorst < r.sellerNet);
  // The buyer's total never changes with the card: only the seller's share does.
  assert.equal(r.buyerTotal, money.quote(50000, { origin: "international" }).buyerTotal);
});

test("fees never make the seller's share bigger than the deal", () => {
  for (const amount of [500, 1000, 9999, 50000, 123456, 2000000]) {
    const q = money.quoteRange(amount);
    assert.ok(q.sellerNet < amount, `seller net should be below the deal at ${amount}`);
    assert.ok(q.sellerNetWorst > 0, `seller should still receive something at ${amount}`);
    assert.equal(q.buyerTotal, amount + q.platformFee);
    // Valence's cut is exactly the difference between what the buyer pays and the deal.
    assert.equal(q.buyerTotal - q.amount, q.platformFee);
  }
});

test("formatting is exact, and negative amounts keep their sign", () => {
  assert.equal(money.format(0), "NZ$0.00");
  assert.equal(money.format(5), "NZ$0.05");
  assert.equal(money.format(500), "NZ$5.00");
  assert.equal(money.format(50500), "NZ$505.00");
  assert.equal(money.format(123456789), "NZ$1,234,567.89");
  assert.equal(money.format(-500), "-NZ$5.00");
});

test("parsing accepts what people type and refuses what they shouldn't", () => {
  assert.equal(money.parseAmount("5"), 500);
  assert.equal(money.parseAmount("5.00"), 500);
  assert.equal(money.parseAmount("5.5"), 550);
  assert.equal(money.parseAmount("1,250.99"), 125099);
  assert.equal(money.parseAmount(" 12.34 "), 1234);
  assert.equal(money.parseAmount("$12.34"), 1234);
  // Thousands separators are stripped wherever they appear, so "5," is read as 5 rather than refused.
  assert.equal(money.parseAmount("5,"), 500);
  for (const junk of ["", "abc", "5.123", "-5", "1e3", "5..0", null, undefined, {}]) {
    assert.equal(money.parseAmount(junk), null, `should refuse ${JSON.stringify(junk)}`);
  }
});

test("a quote always takes integer cents, never a float", () => {
  assert.throws(() => money.quote(12.34), /integer/);
  assert.throws(() => money.quote("5000"), /integer/);
});

test("a card hold lasts seven days, and is 'at risk' before it actually lapses", () => {
  const at = Date.parse("2026-10-19T00:00:00Z");
  assert.equal(money.holdExpiry(at) - at, 7 * 24 * 3600 * 1000);
  assert.equal(money.holdAtRisk(at, at), false);
  assert.equal(money.holdAtRisk(at, at + 6 * 24 * 3600 * 1000), false);
  // Flagged with hours to spare, so there is time to cancel rather than let it expire silently.
  assert.equal(money.holdAtRisk(at, money.holdExpiry(at) - money.HOLD_SAFETY_MS), true);
  assert.equal(money.holdAtRisk(at, money.holdExpiry(at)), true);
});

test("unsupported currencies are refused rather than quietly treated as dollars", () => {
  assert.throws(() => money.quote(5000, { code: "usd" }), /unsupported currency/);
  assert.throws(() => money.currency("gbp"), /unsupported currency/);
});
