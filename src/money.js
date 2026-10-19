// Money, fees and quotes.
//
// Every amount in Valence is an integer in the currency's minor unit (cents). There are no
// floats anywhere near a price, and there is no such thing as a balance: an amount only ever
// belongs to one deal.
//
// Who pays what, and why:
//   The buyer pays the deal amount plus Valence's commission.
//   The seller is the merchant of record for the charge, so the seller pays the card
//   processing fee, exactly as any merchant does. That means the seller's quoted price is
//   the amount the buyer agrees to, and the only deduction the seller sees is the processor's.
//
// Card rates are Stripe's published New Zealand prices. They depend on the card the buyer
// actually uses, which we don't know until they pay, so the seller's side is an estimate and
// is always labelled as one.

const CURRENCIES = {
  nzd: {
    code: "nzd",
    label: "NZD",
    symbol: "NZ$",
    minor: 100,
    // Stripe New Zealand, standard pricing, charged to the merchant of record (the seller).
    card: {
      domestic: { bps: 270, fixed: 30 },
      international: { bps: 370, fixed: 30 },
    },
  },
};

const DEFAULT_CURRENCY = "nzd";

// Valence's commission: 1% of the deal, with a floor so tiny deals still cover their support cost.
const PLATFORM_BPS = 100;
const PLATFORM_MIN = 50;

// Card authorisations are good for 7 days. A deal has to finish inside that, because the hold
// on the buyer's card IS the escrow -- see docs/payments.md.
const HOLD_DAYS = 7;
const HOLD_MS = HOLD_DAYS * 24 * 3600 * 1000;
// Leave a margin so we are never racing the network's expiry when a buyer releases late.
const HOLD_SAFETY_MS = 6 * 3600 * 1000;

const MIN_AMOUNT = 500; // NZ$5.00
const MAX_AMOUNT = 2000000; // NZ$20,000.00

function currency(code) {
  const c = CURRENCIES[String(code || DEFAULT_CURRENCY).toLowerCase()];
  if (!c) throw new Error(`unsupported currency: ${code}`);
  return c;
}

// Percentage of an amount, rounded half-up, in minor units.
function bps(amount, rate) {
  return Math.round((amount * rate) / 10000);
}

function platformFee(amount) {
  return Math.max(PLATFORM_MIN, bps(amount, PLATFORM_BPS));
}

function processorFee(total, { origin = "domestic", code = DEFAULT_CURRENCY } = {}) {
  const rates = currency(code).card[origin === "international" ? "international" : "domestic"];
  return bps(total, rates.bps) + rates.fixed;
}

// What the buyer is charged, what Valence keeps, and what the seller can expect.
// `amount` is the deal: the price the two of them agreed on.
function quote(amount, { code = DEFAULT_CURRENCY, origin = "domestic" } = {}) {
  if (!Number.isInteger(amount)) throw new Error("amount must be an integer in minor units");
  const c = currency(code);
  const fee = platformFee(amount);
  const total = amount + fee;
  const processor = processorFee(total, { origin, code });
  return {
    currency: c.code,
    amount,                       // the deal
    platformFee: fee,             // Valence's commission, taken by Stripe at capture
    platformBps: PLATFORM_BPS,
    buyerTotal: total,            // authorised on the buyer's card
    processorFee: processor,       // Stripe's cut, paid by the seller as merchant of record
    processorOrigin: origin,
    sellerNet: amount - processor, // estimate: depends on the card the buyer uses
  };
}

// Both estimates, so a screen can say "between X and Y" without guessing the buyer's card.
function quoteRange(amount, { code = DEFAULT_CURRENCY } = {}) {
  const domestic = quote(amount, { code, origin: "domestic" });
  const international = quote(amount, { code, origin: "international" });
  return { ...domestic, sellerNetWorst: international.sellerNet, processorFeeWorst: international.processorFee };
}

function format(amount, code = DEFAULT_CURRENCY) {
  const c = currency(code);
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const whole = Math.floor(abs / c.minor);
  const part = String(abs % c.minor).padStart(String(c.minor - 1).length, "0");
  return `${sign}${c.symbol}${whole.toLocaleString("en-NZ")}.${part}`;
}

// Accepts "12.34", "12", 12.34 (dollars) and returns minor units, or null if it isn't a price.
function parseAmount(input, code = DEFAULT_CURRENCY) {
  const c = currency(code);
  const text = typeof input === "number" ? input.toFixed(2) : String(input == null ? "" : input).trim().replace(/[,\s]|^\$|^NZ\$/g, "");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) return null;
  const [whole, part = ""] = text.split(".");
  return Number(whole) * c.minor + Number(part.padEnd(String(c.minor - 1).length, "0"));
}

function holdExpiry(authorizedAt) {
  return authorizedAt + HOLD_MS;
}

// True once a hold is close enough to expiry that we should stop promising a release.
function holdAtRisk(authorizedAt, at) {
  return at >= holdExpiry(authorizedAt) - HOLD_SAFETY_MS;
}

module.exports = {
  CURRENCIES, DEFAULT_CURRENCY, PLATFORM_BPS, PLATFORM_MIN,
  HOLD_DAYS, HOLD_MS, HOLD_SAFETY_MS, MIN_AMOUNT, MAX_AMOUNT,
  currency, bps, platformFee, processorFee, quote, quoteRange, format, parseAmount,
  holdExpiry, holdAtRisk,
};
