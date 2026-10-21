import { randomBytes } from "node:crypto";
import { getAddress, verifyTypedData, ZeroAddress } from "ethers";

export const walletCheckTypes = { WalletCheck: [
  { name: "account", type: "address" }, { name: "nonce", type: "bytes32" },
  { name: "origin", type: "string" }, { name: "purpose", type: "string" },
  { name: "expiresAt", type: "uint256" }
] };
export function createWalletCheck(expectedAddress, { now = () => Math.floor(Date.now() / 1000) } = {}) {
  const account = getAddress(expectedAddress);
  const pending = new Map();
  let receipt = null;
  return {
    status() { return { account, chainId: 11155111, verified: !!receipt, receipt }; },
    challenge(origin) {
      const payload = {
        domain: { name: "Valence Wallet Check", version: "1", chainId: 11155111, verifyingContract: ZeroAddress },
        types: walletCheckTypes, primaryType: "WalletCheck",
        message: { account, nonce: "0x" + randomBytes(32).toString("hex"), origin,
          purpose: "Verify Valence arbitration wallet control only. No payment, token approval, or dispute decision.",
          expiresAt: now() + 300 }
      };
      // At most one outstanding challenge per allowed loopback origin.
      pending.set(origin, payload);
      return structuredClone(payload);
    },
    verify(origin, nonce, signature) {
      const payload = pending.get(origin);
      if (!payload || nonce !== payload.message.nonce) throw new Error("Request a fresh wallet check");
      if (now() >= payload.message.expiresAt) { pending.delete(origin); throw new Error("Wallet check expired; try again"); }
      if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("Invalid signature");
      let recovered;
      try { recovered = verifyTypedData(payload.domain, payload.types, payload.message, signature); }
      catch { throw new Error("Invalid signature"); }
      if (recovered !== account) throw new Error("The signature does not match the arbitration wallet");
      pending.delete(origin);
      receipt = { account, origin, chainId: 11155111, verifiedAt: now(),
        scope: "Wallet control and EIP-712 signing only; no deployed escrow or live payment authorization" };
      return this.status();
    }
  };
}
