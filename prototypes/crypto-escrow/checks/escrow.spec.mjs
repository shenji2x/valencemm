import assert from "node:assert/strict";
import { test } from "node:test";
import { ZeroAddress, ZeroHash, id as hash, parseEther, parseUnits } from "ethers";
import { createLab, startChain, deploy, signAward } from "../scripts/local.mjs";

function scenario(name, run) {
  test(name, async () => {
    const lab = await createLab();
    try { await run(lab); } finally { await lab.close(); }
  });
}
async function revert(action, reason) {
  await assert.rejects(async () => { const tx = await action(); if (tx?.wait) await tx.wait(); },
    reason ? error => String(error).includes(reason) || String(error?.revert?.name).includes(reason)
      || error.data === hash(reason + "()").slice(0, 10) : undefined);
}
async function eth(lab, address) { return BigInt(await lab.provider.send("eth_getBalance", [address, "latest"])); }

scenario("exact 1% fee, 101 token deposit, principal to seller, customer-sponsored Valence claim", async l => {
  const before = await eth(l, l.addresses.treasury);
  const d = await l.fund("TESTUSD", "100");
  assert.equal(await l.token.balanceOf(await l.escrow.getAddress()), parseUnits("101", 6));
  await l.act(d, "release");
  assert.equal(await l.escrow.claimable(d, l.addresses.seller), parseUnits("100", 6));
  assert.equal(await l.escrow.claimable(d, l.addresses.treasury), parseUnits("1", 6));
  await l.act(d, "claimSeller"); await l.act(d, "claimFee");
  assert.equal(await l.token.balanceOf(l.addresses.seller), parseUnits("100", 6));
  assert.equal(await l.token.balanceOf(l.addresses.treasury), parseUnits("1", 6));
  assert.equal(await eth(l, l.addresses.treasury), before, "Valence pays no claim gas");
  assert.equal(await l.token.balanceOf(await l.escrow.getAddress()), 0n);
});

scenario("native ETH principal and fee remain exact; a customer pays fee-claim gas", async l => {
  const d = await l.fund("ETH", "0.1");
  const before = await eth(l, l.addresses.treasury);
  await l.act(d, "release"); await l.act(d, "claimFee");
  assert.equal(await eth(l, l.addresses.treasury) - before, parseEther("0.001"));
  assert.equal(await l.escrow.claimable(d, l.addresses.seller), parseEther("0.1"));
});

scenario("seller refund returns principal AND fee; no platform fee on a full refund", async l => {
  const before = await l.token.balanceOf(l.addresses.buyer);
  const d = await l.fund(); await l.act(d, "refund"); await l.act(d, "claimBuyer");
  assert.equal(await l.token.balanceOf(l.addresses.buyer), before);
  assert.equal(await l.escrow.claimable(d, l.addresses.treasury), 0n);
});

scenario("only the buyer can release; no withdrawal before settlement", async l => {
  const d = await l.fund();
  for (const role of ["seller", "arbitrator", "outsider", "treasury"]) {
    await revert(() => l.escrow.connect(l.who[role]).release(d));
    await revert(() => l.escrow.connect(l.who[role]).claimFor(d, l.addresses.seller));
  }
  assert.equal((await l.escrow.deals(d)).state, 1n);
});

scenario("buyer cannot refund early; outsider cannot refund; undelivered work refunds after deadline", async l => {
  const d = await l.fund();
  await revert(() => l.escrow.refund(d));
  await revert(() => l.escrow.connect(l.who.outsider).refund(d));
  await l.advance(86401); await l.act(d, "deadlineRefund");
  assert.equal(await l.escrow.claimable(d, l.addresses.buyer), parseUnits("101", 6));
});

scenario("only seller delivers and delivery is rejected at or after the work deadline", async l => {
  const d = await l.fund();
  await revert(() => l.escrow.markDelivered(d));
  await l.advance(86401);
  await revert(() => l.escrow.connect(l.who.seller).markDelivered(d));
});

scenario("a timely delivery keeps the full 72-hour review window beyond the work deadline", async l => {
  const d = await l.fund(); await l.advance(86000); await l.act(d, "deliver");
  await l.advance(500);
  await revert(() => l.escrow.refund(d));
  await revert(() => l.escrow.finalizeAfterReview(d));
  await l.advance(72 * 3600); await l.act(d, "autoRelease");
  assert.equal((await l.escrow.deals(d)).state, 4n);
});

scenario("permissionless auto-release after review; a late dispute cannot steal the payout", async l => {
  const d = await l.fund(); await l.act(d, "deliver"); await l.advance(72 * 3600 + 1);
  await revert(() => l.escrow.dispute(d));
  await (await l.escrow.connect(l.who.outsider).finalizeAfterReview(d)).wait();
  assert.equal(await l.escrow.claimable(d, l.addresses.seller), parseUnits("100", 6));
});

scenario("dispute freezes release, refund, claims and timers until the arbitrator resolves", async l => {
  const d = await l.fund(); await l.act(d, "deliver"); await l.act(d, "dispute");
  await l.advance(4 * 86400);
  await revert(() => l.escrow.release(d));
  await revert(() => l.escrow.connect(l.who.seller).refund(d));
  await revert(() => l.escrow.refund(d));
  await revert(() => l.escrow.finalizeAfterReview(d));
  await revert(() => l.escrow.claimFor(d, l.addresses.buyer));
  await revert(() => l.escrow.resolve(d, true));
  await l.act(d, "resolveSeller");
  assert.equal((await l.escrow.deals(d)).state, 4n);
});

scenario("arbitrator can refund a dispute including fee, but cannot withdraw to itself", async l => {
  const d = await l.fund(); await l.act(d, "dispute");
  await revert(() => l.escrow.connect(l.who.arbitrator).claim(d, l.addresses.arbitrator));
  await l.act(d, "resolveBuyer");
  assert.equal(await l.escrow.claimable(d, l.addresses.buyer), parseUnits("101", 6));
  assert.equal(await l.escrow.claimable(d, l.addresses.arbitrator), 0n);
});

scenario("seller may also open a dispute; unrelated addresses cannot", async l => {
  const d = await l.fund();
  await revert(() => l.escrow.connect(l.who.outsider).dispute(d));
  await (await l.escrow.connect(l.who.seller).dispute(d)).wait();
  assert.equal((await l.escrow.deals(d)).state, 3n);
});

scenario("customer-sponsored arbitration charges no gas to Valence and cannot replay", async l => {
  const d = await l.fund(); await l.act(d, "dispute");
  const arbBefore = await eth(l, l.addresses.arbitrator);
  const award = await signAward(l, d, true);
  await (await l.escrow.resolveWithSignature(d, true, award.validUntil, award.signature)).wait();
  assert.equal(await eth(l, l.addresses.arbitrator), arbBefore);
  assert.equal((await l.escrow.deals(d)).state, 4n);
  await revert(() => l.escrow.resolveWithSignature(d, true, award.validUntil, award.signature));
});

scenario("signed awards reject forged signer, modified decision, expiry and deal ID", async l => {
  const a = await l.fund(); const b = await l.fund();
  await l.act(a, "dispute"); await l.act(b, "dispute");
  const award = await signAward(l, a, true);
  await revert(() => l.escrow.resolveWithSignature(a, false, award.validUntil, award.signature));
  await revert(() => l.escrow.resolveWithSignature(a, true, award.validUntil + 1, award.signature));
  await revert(() => l.escrow.resolveWithSignature(b, true, award.validUntil, award.signature));
  const forged = await signAward(l, a, true, { signer: l.who.buyer });
  await revert(() => l.escrow.resolveWithSignature(a, true, forged.validUntil, forged.signature));
  assert.equal((await l.escrow.deals(a)).state, 3n);
  assert.equal((await l.escrow.deals(b)).state, 3n);
});

scenario("signed awards are bound to the specific chain and contract", async l => {
  const d = await l.fund(); await l.act(d, "dispute");
  for (const options of [{ chainId: 1 }, { verifyingContract: l.token.target }]) {
    const award = await signAward(l, d, true, options);
    await revert(() => l.escrow.resolveWithSignature(d, true, award.validUntil, award.signature));
  }
  assert.equal((await l.escrow.deals(d)).state, 3n);
});

scenario("deal identity changes with funded terms even if a local reorg reuses the nonce", async l => {
  const snapshot = await l.connection.provider.request({ method: "evm_snapshot", params: [] });
  const a = await l.fund("TESTUSD", "100");
  assert.equal(await l.connection.provider.request({ method: "evm_revert", params: [snapshot] }), true);
  const b = await l.fund("TESTUSD", "200");
  assert.notEqual(a, b, "a previously signed award must not identify different funded terms");
});

scenario("expired arbitrator decisions cannot be submitted", async l => {
  const d = await l.fund(); await l.act(d, "dispute");
  const award = await signAward(l, d, false, { validUntil: await l.timestamp() - 1 });
  await revert(() => l.escrow.resolveWithSignature(d, false, award.validUntil, award.signature), "ExpiredAward");
});

scenario("finalization and claims cannot replay; one deal cannot consume another's funds", async l => {
  const a = await l.fund("TESTUSD", "100"); const b = await l.fund("TESTUSD", "200");
  assert.notEqual(a, b); await l.act(a, "release"); await l.act(a, "claimSeller");
  await revert(() => l.escrow.release(a));
  await revert(() => l.escrow.connect(l.who.seller).claimFor(a, l.addresses.seller));
  assert.equal((await l.escrow.deals(b)).state, 1n);
  assert.equal(await l.token.balanceOf(await l.escrow.getAddress()), parseUnits("203", 6));
});

scenario("a sponsor can trigger a rightful claim but cannot redirect someone else's payment", async l => {
  const d = await l.fund(); await l.act(d, "release");
  await revert(() => l.escrow.connect(l.who.outsider).claim(d, l.addresses.outsider));
  await (await l.escrow.connect(l.who.outsider).claimFor(d, l.addresses.seller)).wait();
  assert.equal(await l.token.balanceOf(l.addresses.seller), parseUnits("100", 6));
  assert.equal(await l.token.balanceOf(l.addresses.outsider), 0n);
});

scenario("rejects wrong ETH value, unexpected ETH with tokens, unknown asset, and unapproved tokens", async l => {
  const args = [l.addresses.seller, ZeroAddress, parseEther("1"), await l.timestamp() + 86400, hash("terms")];
  const tokenAddress = await l.token.getAddress();
  await revert(() => l.escrow.fund(...args, { value: parseEther("1") }));
  await revert(() => l.escrow.fund(args[0], tokenAddress, 100n, args[3], args[4], { value: 1n }));
  await revert(() => l.escrow.fund(args[0], l.addresses.outsider, 100n, args[3], args[4]));
  await revert(() => l.escrow.fund(args[0], l.token.target, 100n, args[3], args[4]));
});

scenario("rejects invalid terms, self deals, participant-arbitrators, unsafe deadlines and rounding", async l => {
  const deadline = await l.timestamp() + 86400;
  for (const seller of [ZeroAddress, l.addresses.buyer, l.addresses.arbitrator, l.escrow.target]) {
    await revert(() => l.escrow.fund(seller, ZeroAddress, 100n, deadline, hash("terms"), { value: 101n }));
  }
  for (const [amount, at, terms] of [[0n, deadline, hash("a")], [101n, deadline, hash("a")],
    [100n, 1, hash("a")], [100n, deadline + 31 * 86400, hash("a")], [100n, deadline, ZeroHash]]) {
    await revert(() => l.escrow.fund(l.addresses.seller, ZeroAddress, amount, at, terms, { value: amount + amount / 100n }));
  }
  assert.equal(await l.escrow.nonce(), 0n);
});

scenario("unknown deal IDs fail and zero/self claim destinations cannot burn the funds", async l => {
  await revert(() => l.escrow.release(ZeroHash));
  const d = await l.fund(); await l.act(d, "release");
  await revert(() => l.escrow.connect(l.who.seller).claim(d, ZeroAddress));
  await revert(() => l.escrow.connect(l.who.seller).claim(d, l.escrow.target));
  assert.equal(await l.escrow.claimable(d, l.addresses.seller), parseUnits("100", 6));
});

scenario("fee-on-transfer token cannot create an undercollateralized deal", async l => {
  const token = await deploy(l, "TaxToken");
  const escrow = await deploy(l, "ValenceTestEscrow", [l.addresses.treasury, l.addresses.arbitrator, token.target]);
  await (await token.mint(l.addresses.buyer, 10100n)).wait();
  await (await token.approve(escrow.target, 10100n)).wait();
  const deadline = await l.timestamp() + 86400;
  await revert(() => escrow.fund(l.addresses.seller, token.target, 10000n, deadline, hash("terms")), "UnsupportedTokenBehavior");
  assert.equal(await token.balanceOf(l.addresses.buyer), 10100n);
  assert.equal(await token.balanceOf(escrow.target), 0n);
  assert.equal(await escrow.nonce(), 0n);
});

scenario("a failing native recipient cannot block settlement or the fee; claim can redirect", async l => {
  const reject = await deploy(l, "RejectEther");
  const receipt = await (await l.escrow.fund(reject.target, ZeroAddress, 10000n, await l.timestamp() + 86400,
    hash("terms"), { value: 10100n })).wait();
  const d = l.escrow.interface.parseLog(receipt.logs[0]).args.id;
  await (await l.escrow.release(d)).wait();
  await revert(() => l.escrow.claimFor(d, reject.target));
  assert.equal(await l.escrow.claimable(d, reject.target), 10000n);
  await (await l.escrow.claimFor(d, l.addresses.treasury)).wait();
  await (await reject.redirect(l.escrow.target, d, l.addresses.seller)).wait();
  assert.equal(await l.escrow.claimable(d, reject.target), 0n);
});

scenario("reentrant native recipient cannot claim twice", async l => {
  const attacker = await deploy(l, "ReentrantReceiver");
  const receipt = await (await l.escrow.fund(attacker.target, ZeroAddress, 10000n, await l.timestamp() + 86400,
    hash("terms"), { value: 10100n })).wait();
  const d = l.escrow.interface.parseLog(receipt.logs[0]).args.id;
  await (await attacker.configure(l.escrow.target, d)).wait();
  await (await l.escrow.release(d)).wait();
  await (await l.escrow.claimFor(d, attacker.target)).wait();
  assert.equal(await attacker.blocked(), true);
  assert.equal(await eth(l, attacker.target), 10000n);
  assert.equal(await l.escrow.claimable(d, attacker.target), 0n);
});

scenario("SafeERC20 rejects false-return transfer and preserves the claim for retry", async l => {
  const token = await deploy(l, "BlockingToken");
  const escrow = await deploy(l, "ValenceTestEscrow", [l.addresses.treasury, l.addresses.arbitrator, token.target]);
  await (await token.mint(l.addresses.buyer, 10100n)).wait();
  await (await token.approve(escrow.target, 10100n)).wait();
  const receipt = await (await escrow.fund(l.addresses.seller, token.target, 10000n,
    await l.timestamp() + 86400, hash("terms"))).wait();
  const d = receipt.logs.map(log => { try { return escrow.interface.parseLog(log); } catch { return null; } })
    .find(log => log?.name === "Funded").args.id;
  await (await escrow.release(d)).wait();
  await (await token.setBlocked(l.addresses.seller, true)).wait();
  await revert(() => escrow.claimFor(d, l.addresses.seller));
  assert.equal(await escrow.claimable(d, l.addresses.seller), 10000n);
  await (await token.setBlocked(l.addresses.seller, false)).wait();
  await (await escrow.claimFor(d, l.addresses.seller)).wait();
  assert.equal(await token.balanceOf(l.addresses.seller), 10000n);
});

test("deployment rejects Ethereum, Base, Arbitrum and Polygon mainnet chain IDs", async () => {
  for (const chainId of [1, 8453, 42161, 137]) {
    const chain = await startChain(chainId);
    try {
      await revert(() => deploy(chain, "MockUSDT"), "UnsupportedNetwork");
      await revert(() => deploy(chain, "ValenceTestEscrow", [chain.addresses.treasury,
        chain.addresses.arbitrator, chain.addresses.outsider]), "UnsupportedNetwork");
    }
    finally { await chain.close(); }
  }
});

test("Sepolia chain ID is allowed, still using a local simulation with no public RPC", async () => {
  const chain = await startChain(11155111);
  try { const token = await deploy(chain, "MockUSDT"); assert.equal(await token.decimals(), 6n); }
  finally { await chain.close(); }
});
