const { ApiError } = require("./errors");

const ASSETS = Object.freeze([
  { symbol: "BTC", name: "Bitcoin", network: "Bitcoin", decimals: 8 },
  { symbol: "ETH", name: "Ethereum", network: "Ethereum", decimals: 18 },
  { symbol: "LTC", name: "Litecoin", network: "Litecoin", decimals: 8 },
  { symbol: "SOL", name: "Solana", network: "Solana", decimals: 9 },
  { symbol: "USDT", name: "Tether", network: "All networks", decimals: 6 }
]);
const USDT_REASON = "USDT is temporarily disabled. The holding wallet needs its network's native gas coin (such as ETH or BNB) for outgoing transfers.";
function cryptoMethods() {
  return {
    ready: false,
    reason: "Crypto deposits are not open yet. Deposit tracking and secure release/refund payouts must be connected before a payment address can be issued.",
    platformBps: 100,
    releaseRecipient: "seller", refundRecipient: "buyer",
    assets: ASSETS.map(a => ({ ...a, disabled: a.symbol === "USDT", reason: a.symbol === "USDT" ? USDT_REASON : null,
      releaseFeeAcknowledgementRequired: true }))
  };
}
function enabledAsset(symbol) {
  const asset = ASSETS.find(a => a.symbol === symbol);
  if (!asset) throw new ApiError(400, "unsupported_crypto", "Choose BTC, ETH, LTC or SOL");
  if (symbol === "USDT") throw new ApiError(409, "usdt_disabled", USDT_REASON);
  return asset;
}
function atomic(value, name) {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,35})$/.test(value)) {
    throw new ApiError(400, "invalid_crypto_amount", `${name} must be an integer number of atomic units`);
  }
  return BigInt(value);
}
function decimal(value, decimals) {
  const text = value.toString().padStart(decimals + 1, "0");
  return (text.slice(0, -decimals) + "." + text.slice(-decimals)).replace(/\.?0+$/, "");
}
// For a future server-side custody adapter. Browser amounts never price a live deal.
// No chain, conversion, swap, or fee estimate is invented here. Native-only quotes
// explicitly have no swap; a reserve is not a promise of the later network fee.
function nativeBreakdown({ symbol, principalAtomic, payoutReserveAtomic }) {
  const asset = enabledAsset(symbol);
  const principal = atomic(principalAtomic, "Principal");
  const reserve = atomic(payoutReserveAtomic, "Payout fee reserve");
  if (!principal || principal % 100n) {
    throw new ApiError(400, "fee_precision", "The amount must allow an exact 1% fee in this coin's atomic units");
  }
  const fee = principal / 100n;
  return { symbol, network: asset.network, decimals: asset.decimals,
    principalAtomic: principal.toString(), platformFeeAtomic: fee.toString(),
    swapFeeAtomic: "0", payoutReserveAtomic: reserve.toString(), totalAtomic: (principal + fee + reserve).toString(),
    principal: decimal(principal, asset.decimals), platformFee: decimal(fee, asset.decimals),
    swapFee: "0", payoutReserve: decimal(reserve, asset.decimals), total: decimal(principal + fee + reserve, asset.decimals),
    senderNetworkFee: "Paid separately in the sending wallet",
    payoutFee: "Requoted before release; reserve surplus or shortfall must be reconciled",
    swap: "None: deposit and payout use the same coin and network" };
}
function refuseUnconfiguredInvoice(symbol) {
  enabledAsset(symbol);
  throw new ApiError(503, "crypto_not_ready", cryptoMethods().reason);
}
// The agreed rail is immutable. Only these fields are accepted from a new deal;
// destinations, exchange rates, fees and payment state are never client supplied.
function paymentSelection(input) {
  const type = input.paymentType == null ? "stripe" : input.paymentType;
  if (type !== "stripe" && type !== "crypto") throw new ApiError(400, "invalid_payment_type", "Choose Stripe or crypto");
  if (input.rail != null && input.rail !== (type === "crypto" ? "crypto" : "card")) {
    throw new ApiError(400, "payment_type_mismatch", "Payment type and rail do not match");
  }
  if (type === "stripe") {
    if (input.cryptoAsset != null || input.cryptoNetwork != null) throw new ApiError(400, "payment_type_mismatch", "A Stripe deal cannot select a crypto asset");
    return { rail: "card", cryptoAsset: null, cryptoNetwork: null };
  }
  const asset = enabledAsset(input.cryptoAsset);
  if (input.cryptoNetwork != null && input.cryptoNetwork !== asset.network) {
    throw new ApiError(400, "unsupported_network", `Use ${asset.symbol} on ${asset.network} only`);
  }
  return { rail: "crypto", cryptoAsset: asset.symbol, cryptoNetwork: asset.network };
}
function requireCardDeal(deal) {
  if ((deal.rail || "card") !== "card") throw new ApiError(409, "payment_type_mismatch", "This is a crypto deal. Stripe cannot fund, confirm, release or refund it.");
}
function requireCryptoDeal(deal, symbol) {
  enabledAsset(symbol);
  if (deal.rail !== "crypto" || deal.cryptoAsset !== symbol) throw new ApiError(409, "payment_type_mismatch", "Use the payment type and coin agreed when this deal was created");
}
module.exports = { cryptoMethods, nativeBreakdown, refuseUnconfiguredInvoice, paymentSelection, requireCardDeal, requireCryptoDeal };
