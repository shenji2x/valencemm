"use strict";
// Deliberately non-payable samples: neither addresses nor QR payloads are real.
const samples = {
  BTC: ["Bitcoin", "0.001", "0.00001", "0.000002", "0.001012"],
  ETH: ["Ethereum", "0.1", "0.001", "0.0001", "0.1011"],
  LTC: ["Litecoin", "1", "0.01", "0.00001", "1.01001"],
  SOL: ["Solana", "1", "0.01", "0.000005", "1.010005"]
};
window.ValenceCryptoCheckout.mount(document.getElementById("checkout"), {
  dealId: "design-preview", async request(method, path, input) {
    if (path === "/crypto/methods") return { ready: false, reason: "Example invoice only. Choose a coin to preview the checkout; no payments are accepted.",
      assets: Object.entries(samples).map(([symbol, [network]]) => ({ symbol, name: network, network, disabled: false })).concat([
        { symbol: "USDT", name: "Tether", network: "All networks", disabled: true, reason: "USDT is temporarily disabled because the holding wallet has no native gas balance." }
      ]) };
    const [network, principal, platform, payoutReserve, total] = samples[input.asset];
    return { preview: true, asset: input.asset, network, status: "awaiting_deposit", expiresAt: new Date(Date.now() + 900000).toISOString(),
      address: `PREVIEW-ONLY-${input.asset}-NOT-A-PAYMENT-ADDRESS`, qrPayload: `valence-preview:${input.asset}:design-only`, total,
      fees: { principal, platform, swap: "0", payoutReserve } };
  }
});
