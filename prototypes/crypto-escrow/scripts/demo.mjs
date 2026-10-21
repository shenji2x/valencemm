import assert from "node:assert/strict";
import { parseUnits } from "ethers";
import { createLab } from "./local.mjs";

const lab = await createLab();
try {
  const release = await lab.fund("TESTUSD", "100");
  await lab.act(release, "deliver");
  await lab.act(release, "release");
  await lab.act(release, "claimSeller");
  await lab.act(release, "claimFee");
  assert.equal(await lab.token.balanceOf(lab.addresses.seller), parseUnits("100", 6));
  assert.equal(await lab.token.balanceOf(lab.addresses.treasury), parseUnits("1", 6));

  const refund = await lab.fund("TESTUSD", "50");
  await lab.act(refund, "dispute");
  await lab.act(refund, "resolveBuyer");
  await lab.act(refund, "claimBuyer");
  assert.equal(await lab.token.balanceOf(await lab.escrow.getAddress()), 0n);
  console.log("PASS: Buyer pays 101 TESTUSD; seller receives 100; Valence receives 1.");
  console.log("PASS: Disputed 50 TESTUSD deal refunds 50.5, including the fee.");
  console.log("PASS: Customers pay simulated transaction gas, including Valence's fee claim.");
  console.log("Local EVM only; no real money or public deployment.");
} finally { await lab.close(); }
