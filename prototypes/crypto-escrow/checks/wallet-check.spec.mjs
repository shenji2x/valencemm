import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet, ZeroAddress } from "ethers";
import { createWalletCheck } from "../scripts/wallet-check.mjs";

const origin = "http://127.0.0.1:8790";
function fixture() {
  const wallet = Wallet.createRandom(); let timestamp = 1000;
  const check = createWalletCheck(wallet.address, { now: () => timestamp });
  return { wallet, check, advance: value => { timestamp += value; } };
}
const sign = (wallet, p) => wallet.signTypedData(p.domain, p.types, p.message);

test("wallet check binds a distinct non-payment purpose, test chain and zero contract", () => {
  const { check, wallet } = fixture(); const p = check.challenge(origin);
  assert.equal(p.domain.name, "Valence Wallet Check"); assert.equal(p.domain.chainId, 11155111);
  assert.equal(p.domain.verifyingContract, ZeroAddress); assert.equal(p.primaryType, "WalletCheck");
  assert.equal(p.message.account, wallet.address); assert.equal(p.message.origin, origin);
  assert.match(p.message.purpose, /No payment, token approval, or dispute decision/);
  assert.equal(p.message.expiresAt, 1300); assert.equal(check.status().verified, false);
});
test("only a valid expected-wallet signature creates a receipt; replay is rejected", async () => {
  const { check, wallet } = fixture(); const p = check.challenge(origin); const sig = await sign(wallet, p);
  const result = check.verify(origin, p.message.nonce, sig);
  assert.equal(result.verified, true); assert.equal(result.receipt.account, wallet.address);
  assert.match(result.receipt.scope, /no deployed escrow/);
  assert.throws(() => check.verify(origin, p.message.nonce, sig), /fresh wallet check/);
});
test("another wallet cannot verify the proposed account", async () => {
  const { check } = fixture(); const p = check.challenge(origin);
  assert.throws(() => check.verify(origin, p.message.nonce, "0x00"), /Invalid signature/);
  const sig = await sign(Wallet.createRandom(), p);
  assert.throws(() => check.verify(origin, p.message.nonce, sig), /does not match/);
  assert.equal(check.status().verified, false);
});
test("expired checks are rejected at the exact expiry boundary", async () => {
  const { check, wallet, advance } = fixture(); const p = check.challenge(origin); const sig = await sign(wallet, p);
  advance(300); assert.throws(() => check.verify(origin, p.message.nonce, sig), /expired/);
  assert.equal(check.status().verified, false);
});
test("origin and nonce are bound to a server-issued challenge", async () => {
  const { check, wallet } = fixture(); const p = check.challenge(origin); const sig = await sign(wallet, p);
  assert.throws(() => check.verify("http://localhost:8790", p.message.nonce, sig), /fresh wallet check/);
  assert.throws(() => check.verify(origin, "0x" + "00".repeat(32), sig), /fresh wallet check/);
});
test("a regenerated challenge invalidates its predecessor", async () => {
  const { check, wallet } = fixture(); const first = check.challenge(origin); const sig = await sign(wallet, first);
  const second = check.challenge(origin); assert.notEqual(first.message.nonce, second.message.nonce);
  assert.throws(() => check.verify(origin, first.message.nonce, sig), /fresh wallet check/);
});
test("tampered purpose, chain and arbitration-domain signatures are rejected", async () => {
  for (const mutate of [p => { p.message.purpose = "Release funds"; }, p => { p.domain.chainId = 1; },
    p => { p.domain.name = "ValenceTestEscrow"; }]) {
    const { check, wallet } = fixture(); const p = check.challenge(origin); const changed = structuredClone(p); mutate(changed);
    const sig = await sign(wallet, changed);
    assert.throws(() => check.verify(origin, p.message.nonce, sig), /does not match/);
  }
});
test("mutating returned challenge fields cannot alter the verifier's stored message", async () => {
  const { check, wallet } = fixture(); const p = check.challenge(origin); p.message.expiresAt += 9999;
  const sig = await sign(wallet, p);
  assert.throws(() => check.verify(origin, p.message.nonce, sig), /does not match/);
});
