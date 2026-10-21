"use strict";
const $ = id => document.getElementById(id);
let provider, account, expected, token, challenge, busy = false;
const listening = new WeakSet();
window.addEventListener("eip6963:announceProvider", event => {
  if (!provider && event.detail?.info?.rdns === "io.metamask") provider = event.detail.provider;
});
window.dispatchEvent(new Event("eip6963:requestProvider"));
function status(text, error = false) { $("feedback").textContent = text; $("feedback").className = error ? "error" : ""; }
function invalidate() { challenge = null; $("message-review").hidden = true; }
async function api(path, data) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Lab-Token": token }, body: JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || "Wallet check failed"); return result;
}
async function refresh() {
  if (!provider) return;
  const accounts = await provider.request({ method: "eth_accounts" });
  account = accounts[0]; const chain = await provider.request({ method: "eth_chainId" });
  const correct = account?.toLowerCase() === expected?.toLowerCase();
  $("connection").textContent = account ? `Connected: ${account} | ${chain === "0xaa36a7" ? "Sepolia" : "Switch to Sepolia"}${correct ? "" : " | Select the proposed arbitration account in MetaMask"}` : "No account connected.";
  $("switch-network").disabled = busy || !correct || chain === "0xaa36a7";
  $("sign-check").disabled = busy || !correct || chain !== "0xaa36a7";
}
async function action(job) {
  if (busy) return; busy = true;
  document.querySelectorAll("button").forEach(b => b.disabled = true);
  try { await job(); }
  catch (error) { invalidate(); status(error.code === 4001 ? "Request cancelled. Nothing was transferred." : error.code === 4902 ? "Enable Sepolia in MetaMask's test networks, then try again." : error.message || "Wallet check failed", true); }
  finally { busy = false; $("connect-wallet").disabled = !token; $("confirm-sign").disabled = false; await refresh().catch(() => {}); }
}
$("connect-wallet").addEventListener("click", () => action(async () => {
  invalidate();
  provider ||= window.ethereum?.providers?.find(p => p.isMetaMask) || (window.ethereum?.isMetaMask ? window.ethereum : null);
  if (!provider) throw new Error("MetaMask was not found. Open this link in Chrome or Edge with MetaMask installed, then reload.");
  await provider.request({ method: "eth_requestAccounts" });
  if (provider.on && !listening.has(provider)) {
    listening.add(provider);
    for (const event of ["accountsChanged", "chainChanged"]) provider.on(event, () => { invalidate(); status("Account or network changed. Review a fresh check before signing."); refresh().catch(() => {}); });
  }
  status("Connected. Select the proposed account and Sepolia before continuing.");
}));
$("switch-network").addEventListener("click", () => action(async () => {
  invalidate(); await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xaa36a7" }] }); status("Sepolia selected. You do not need test ETH for this message check.");
}));
$("sign-check").addEventListener("click", () => action(async () => {
  await refresh();
  if (account?.toLowerCase() !== expected.toLowerCase() || await provider.request({ method: "eth_chainId" }) !== "0xaa36a7") throw new Error("Select the proposed arbitration account on Sepolia first");
  challenge = await api("/api/wallet-challenge", {});
  $("message-fields").textContent = JSON.stringify(challenge, null, 2);
  $("message-review").hidden = false; status("Review the message, then choose Sign this wallet check. It expires in five minutes.");
}));
$("confirm-sign").addEventListener("click", () => action(async () => {
  if (!challenge) throw new Error("Review a fresh wallet check first");
  const active = challenge;
  await refresh();
  if (account?.toLowerCase() !== expected.toLowerCase() || await provider.request({ method: "eth_chainId" }) !== "0xaa36a7") throw new Error("Account or network changed; review a fresh check");
  const typed = { ...active, types: { EIP712Domain: [{name:"name",type:"string"},{name:"version",type:"string"},{name:"chainId",type:"uint256"},{name:"verifyingContract",type:"address"}], ...active.types } };
  status("Review Valence Wallet Check in MetaMask. This is a message signature with no gas fee.");
  const signature = await provider.request({ method: "eth_signTypedData_v4", params: [account, JSON.stringify(typed)] });
  const result = await api("/api/wallet-verify", { nonce: active.message.nonce, signature });
  invalidate(); status(`Verified: ${result.account}. Wallet control and EIP-712 signing passed. Live payments remain disabled.`);
}));
$("connect-wallet").disabled = true;
fetch("/api/state").then(r => { if (!r.ok) throw new Error("Restart the local lab, then reload this page"); return r.json(); }).then(async s => {
  token = s.token; const info = await api("/api/wallet-status", {}); expected = info.account;
  $("expected").textContent = expected; $("connect-wallet").disabled = false;
  if (info.verified) status(`Previously verified in this running session: ${info.account}. Live payments remain disabled.`);
}).catch(e => status(e.message, true));
