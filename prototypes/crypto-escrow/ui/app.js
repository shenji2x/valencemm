let model, busy = false;
const $ = id => document.getElementById(id);
const labels = { deliver: "Seller: mark delivered", release: "Buyer: release", refund: "Seller: refund in full",
  deadlineRefund: "Buyer: claim overdue refund", dispute: "Buyer: open dispute", resolveSeller: "Valence: pay seller",
  resolveBuyer: "Valence: refund buyer", autoRelease: "Seller: finalize after review", claimSeller: "Seller: collect payment",
  claimBuyer: "Buyer: collect refund", claimFee: "Buyer: send 1% to Valence" };
function el(tag, text, className) { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; }
function compact(value) { return Number(value).toLocaleString(undefined, { maximumFractionDigits: 8 }); }
function feedback(text = "", error = false) { $("feedback").textContent = text; $("feedback").className = error ? "error" : ""; }
function locking(value) { busy = value; document.querySelectorAll("button").forEach(n => n.disabled = value); }
async function request(path, data) {
  const response = await fetch(path, data === undefined ? undefined : { method: "POST", headers: {
    "Content-Type": "application/json", "X-Lab-Token": model.token }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The local demo could not complete that action");
  return result;
}
async function mutate(path, data, message) {
  if (busy) return;
  locking(true); feedback("Confirming on the local test network…");
  try { model = await request(path, data); render(); feedback(message); }
  catch (e) { feedback(e.message, true); }
  finally { locking(false); }
}
function button(action, d, className = "") {
  const b = el("button", labels[action], className);
  b.addEventListener("click", () => mutate("/api/action", { id: d.id, action }, `${labels[action]} confirmed. Test money only.`));
  return b;
}
function render() {
  $("deal-count").textContent = `${model.deals.length} ${model.deals.length === 1 ? "deal" : "deals"}`;
  const active = model.deals.filter(d => ["Funded", "Delivered", "Disputed"].includes(d.state) && d.symbol === "TESTUSD");
  $("locked").textContent = compact(active.reduce((sum, d) => sum + Number(d.principal), 0));
  $("earned").textContent = compact(model.deals.filter(d => d.state === "Released" && d.symbol === "TESTUSD").reduce((sum, d) => sum + Number(d.fee), 0));
  $("deals").replaceChildren();
  for (const d of model.deals) {
    const card = el("article", null, "deal");
    const head = el("div", null, "deal-head"); head.append(el("h3", `Deal ${String(d.number).padStart(2, "0")}`),
      el("span", d.state, `badge ${["Released", "Refunded"].includes(d.state) ? "final" : d.state === "Disputed" ? "disputed" : ""}`));
    const value = el("div", compact(d.principal) + " ", "deal-value"); value.append(el("span", d.symbol));
    card.append(head, value, el("p", `Buyer deposits ${compact(d.total)} · Valence fee ${compact(d.fee)} ${d.symbol}`, "deal-info"));
    const actions = el("div", null, "actions");
    if (["Funded", "Delivered"].includes(d.state)) {
      actions.append(button("release", d, "positive"), button("refund", d, "refund"));
      if (d.state === "Funded" && model.timestamp < d.deadline) actions.prepend(button("deliver", d));
      if (d.state === "Funded" && model.timestamp >= d.deadline) actions.append(button("deadlineRefund", d));
      if (d.state === "Funded" || model.timestamp < d.reviewEnds) actions.append(button("dispute", d, "caution"));
      if (d.state === "Delivered" && model.timestamp >= d.reviewEnds) actions.append(button("autoRelease", d));
    }
    if (d.state === "Disputed") actions.append(button("resolveSeller", d, "positive"), button("resolveBuyer", d, "refund"));
    if (Number(d.claims.seller) > 0) actions.append(button("claimSeller", d));
    if (Number(d.claims.buyer) > 0) actions.append(button("claimBuyer", d));
    if (Number(d.claims.treasury) > 0) actions.append(button("claimFee", d));
    const note = {
      Funded: "Funds are locked. The buyer can release, or the seller can refund.",
      Delivered: "The buyer has 72 hours to review or open a dispute. A dispute stops automatic release.",
      Disputed: "Settlement is frozen. Valence signs a decision; a customer submits it and pays the network gas.",
      Released: "The seller’s principal and Valence’s 1% are available to collect separately.",
      Refunded: "The buyer can collect the principal and the full service fee. Previously spent gas is not refundable."
    }[d.state];
    card.append(el("p", note, "deal-note"), actions);
    if (["Released", "Refunded"].includes(d.state)) {
      card.append(el("p", `Available to collect: buyer ${compact(d.claims.buyer)} · seller ${compact(d.claims.seller)} · Valence ${compact(d.claims.treasury)} ${d.symbol}`, "claims"));
    }
    $("deals").append(card);
  }
  $("activity").replaceChildren();
  for (const a of model.activity) {
    const row = el("tr"); const wei = BigInt(a.gasWei);
    const fraction = (wei % 1000000000000000000n).toString().padStart(18, "0").replace(/0+$/, "");
    const gas = `${wei / 1000000000000000000n}${fraction ? "." + fraction : ""}`;
    const tx = el("td"); const code = el("code", a.hash.slice(0, 10) + "…" + a.hash.slice(-6)); code.title = a.hash; tx.append(code);
    row.append(el("td", labels[a.label] || a.label), el("td", a.role === "treasury" ? "Valence" : a.role), el("td", gas), tx);
    $("activity").append(row);
  }
}
function quote() {
  const asset = $("asset").value, raw = $("amount").value;
  const maxDecimals = asset === "ETH" ? 16 : 4;
  $("amount-unit").textContent = asset;
  $("amount-hint").textContent = `Use up to ${maxDecimals} decimal places for an exact 1% fee.`;
  $("amount").setCustomValidity("");
  let valid = new RegExp(`^\\d{1,7}(\\.\\d{1,${maxDecimals}})?$`).test(raw) && Number(raw) > 0;
  if (!valid) {
    $("amount").setCustomValidity(`Enter a positive amount with up to ${maxDecimals} decimal places.`);
    $("quote-principal").textContent = $("quote-fee").textContent = $("quote-total").textContent = "—"; return;
  }
  // Exact integer decimal arithmetic; no floating-point amounts are sent to the contract.
  const decimals = asset === "ETH" ? 18 : 6, [whole, fraction = ""] = raw.split(".");
  const units = BigInt(whole + fraction.padEnd(decimals, "0")), fee = units / 100n;
  const format = value => {
    const text = value.toString().padStart(decimals + 1, "0");
    return (text.slice(0, -decimals) + "." + text.slice(-decimals)).replace(/\.?0+$/, "");
  };
  $("quote-principal").textContent = format(units);
  $("quote-fee").textContent = format(fee);
  $("quote-total").textContent = `${format(units + fee)} ${asset}`;
}
$("amount").addEventListener("input", quote);
$("asset").addEventListener("change", () => { $("amount").value = $("asset").value === "ETH" ? "0.1" : "100"; quote(); });
$("fund-form").addEventListener("submit", e => { e.preventDefault(); quote(); if (!e.target.reportValidity()) return;
  mutate("/api/fund", { asset: $("asset").value, amount: $("amount").value }, "Test deal funded. The principal and 1% fee are locked."); });
$("reset").addEventListener("click", () => mutate("/api/reset", {}, "Demo reset. A new local chain and one sample deal are ready."));
document.querySelectorAll("[data-seconds]").forEach(b => b.addEventListener("click", () => mutate("/api/time", { seconds: Number(b.dataset.seconds) }, "Local clock advanced. No time changed on a public network.")));
locking(true);
request("/api/state").then(s => { model = s; render(); quote(); locking(false); }).catch(e => feedback(e.message, true));
