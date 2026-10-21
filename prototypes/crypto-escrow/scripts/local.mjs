import hre from "hardhat";
import { BrowserProvider, ContractFactory, ZeroAddress, id, parseEther, parseUnits, formatUnits } from "ethers";
import { compileContracts } from "./compile.mjs";

export const states = ["Missing", "Funded", "Delivered", "Disputed", "Released", "Refunded"];
export const roles = ["buyer", "seller", "arbitrator", "treasury", "outsider"];
export async function signAward(lab, dealId, paySeller, { signer = lab.signers[2],
  validUntil, verifyingContract = lab.escrow.target, chainId = 31337 } = {}) {
  validUntil ??= await lab.timestamp() + 3600;
  const signature = await signer.signTypedData({ name: "ValenceTestEscrow", version: "1", chainId, verifyingContract },
    { Resolution: [{ name: "dealId", type: "bytes32" }, { name: "paySeller", type: "bool" },
      { name: "validUntil", type: "uint256" }] }, { dealId, paySeller, validUntil });
  return { validUntil, signature };
}
export async function startChain(chainId = 31337) {
  const connection = await hre.network.create({ network: "local", override: { chainId } });
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1, pollingInterval: 20 });
  const signers = await Promise.all(roles.map((_, i) => provider.getSigner(i)));
  const addresses = Object.fromEntries(await Promise.all(roles.map(async (role, i) => [role, await signers[i].getAddress()])));
  return { connection, provider, signers, addresses,
    async close() { provider.destroy(); await connection.close(); },
    async advance(seconds) {
      await connection.provider.request({ method: "evm_increaseTime", params: [seconds] });
      await connection.provider.request({ method: "evm_mine", params: [] });
    },
    async timestamp() {
      const block = await provider.send("eth_getBlockByNumber", ["latest", false]);
      return Number(BigInt(block.timestamp));
    }
  };
}

export async function deploy(chain, name, args = [], signer = chain.signers[0]) {
  const artifact = compileContracts()[name];
  if (!artifact) throw new Error(`Unknown contract ${name}`);
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode, signer).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

export async function createLab() {
  const chain = await startChain();
  try {
    const token = await deploy(chain, "MockUSDT");
    const escrow = await deploy(chain, "ValenceTestEscrow", [chain.addresses.treasury, chain.addresses.arbitrator, await token.getAddress()]);
    await (await token.mint(chain.addresses.buyer, parseUnits("100000", 6))).wait();
    const deals = [];
    const activity = [];
    const who = Object.fromEntries(roles.map((role, i) => [role, chain.signers[i]]));
    async function record(tx, role, label) {
      const receipt = await tx.wait();
      activity.unshift({ label, role, hash: receipt.hash, gasWei: (receipt.gasUsed * receipt.gasPrice).toString() });
      return receipt;
    }
    async function fund(symbol = "TESTUSD", amount = "100", deadlineSeconds = 86400) {
      if (!["TESTUSD", "ETH"].includes(symbol)) throw new Error("Only test ETH and TESTUSD are supported");
      if (typeof amount !== "string" || !/^\d{1,7}(\.\d{1,18})?$/.test(amount)) throw new Error("Enter a valid positive amount");
      const decimals = symbol === "ETH" ? 18 : 6;
      const principal = parseUnits(amount, decimals);
      const fee = await escrow.feeFor(principal);
      const total = principal + fee;
      const asset = symbol === "ETH" ? ZeroAddress : await token.getAddress();
      if (symbol !== "ETH") await record(await token.approve(await escrow.getAddress(), total), "buyer", "Approve test token");
      const deadline = await chain.timestamp() + deadlineSeconds;
      const termsHash = id(`Valence local demonstration ${deals.length + 1}; ${symbol}; ${principal}; ${deadline}`);
      const receipt = await record(await escrow.fund(chain.addresses.seller, asset, principal, deadline, termsHash,
        { value: symbol === "ETH" ? total : 0n }), "buyer", "Fund deal");
      const event = receipt.logs.map(log => { try { return escrow.interface.parseLog(log); } catch { return null; } })
        .find(e => e?.name === "Funded");
      deals.unshift({ id: event.args.id, number: deals.length + 1, symbol, decimals });
      return event.args.id;
    }
    async function act(dealId, action) {
      if (!deals.some(d => d.id === dealId)) throw new Error("Unknown local deal");
      async function submitAward(paySeller) {
        const award = await signAward({ ...chain, escrow }, dealId, paySeller);
        return escrow.connect(who.buyer).resolveWithSignature(dealId, paySeller, award.validUntil, award.signature);
      }
      const jobs = {
        deliver: ["seller", () => escrow.connect(who.seller).markDelivered(dealId)],
        release: ["buyer", () => escrow.connect(who.buyer).release(dealId)],
        refund: ["seller", () => escrow.connect(who.seller).refund(dealId)],
        deadlineRefund: ["buyer", () => escrow.connect(who.buyer).refund(dealId)],
        dispute: ["buyer", () => escrow.connect(who.buyer).dispute(dealId)],
        resolveSeller: ["buyer", () => submitAward(true)],
        resolveBuyer: ["buyer", () => submitAward(false)],
        autoRelease: ["seller", () => escrow.connect(who.seller).finalizeAfterReview(dealId)],
        claimSeller: ["seller", () => escrow.connect(who.seller).claimFor(dealId, chain.addresses.seller)],
        claimBuyer: ["buyer", () => escrow.connect(who.buyer).claimFor(dealId, chain.addresses.buyer)],
        claimFee: ["buyer", () => escrow.connect(who.buyer).claimFor(dealId, chain.addresses.treasury)]
      };
      const job = jobs[action];
      if (!job) throw new Error("Unknown action");
      await record(await job[1](), job[0], action);
    }
    async function state() {
      const list = [];
      for (const item of deals) {
        const d = await escrow.deals(item.id);
        const claims = {};
        for (const role of ["buyer", "seller", "treasury"]) claims[role] = formatUnits(await escrow.claimable(item.id, chain.addresses[role]), item.decimals);
        list.push({ ...item, state: states[Number(d.state)], principal: formatUnits(d.principal, item.decimals),
          fee: formatUnits(d.fee, item.decimals), total: formatUnits(d.principal + d.fee, item.decimals),
          deadline: Number(d.deadline), reviewEnds: Number(d.reviewEnds), claims });
      }
      return { network: "Local test network", chainId: 31337, testMoneyOnly: true,
        escrow: await escrow.getAddress(), token: await token.getAddress(), addresses: chain.addresses,
        timestamp: await chain.timestamp(), deals: list, activity: activity.slice(0, 40) };
    }
    return { ...chain, token, escrow, who, fund, act, state };
  } catch (error) { await chain.close(); throw error; }
}
