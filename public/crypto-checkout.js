"use strict";
// Customer checkout UI. A payment destination is only rendered from a server
// invoice. The owner's service-fee wallet is never used as a fallback address.
(() => {
  function node(tag, text, className) {
    const n = document.createElement(tag); if (text !== undefined && text !== null) n.textContent = text;
    if (className) n.className = className; return n;
  }
  function mount(host, { request, dealId = null }) {
    let generation = 0, selected, disposed = false, expiryTimer;
    const title = node("div", null, "cc-heading");
    title.append(node("div", "Pay with crypto", "cc-title"), node("span", "1% Valence fee", "badge"));
    const subtitle = node("p", "Choose a coin. Your deposit quote will show the network, every fee, and the exact amount to send.", "muted");
    const choices = node("div", null, "cc-choices"); choices.setAttribute("role", "group"); choices.setAttribute("aria-label", "Cryptocurrency");
    const notice = node("p", "Loading payment methods...", "hint"); notice.setAttribute("role", "status");
    const content = node("div");
    const lifecycle = node("p", "After a confirmed deposit, funds stay held for the deal. Release pays the seller; a refund returns funds to the buyer. The payout network fee is reviewed before either payout.", "hint");
    host.replaceChildren(title, subtitle, choices, notice, content, lifecycle);
    const clear = () => { clearInterval(expiryTimer); content.replaceChildren(); };
    function copyControl(label, text) {
      const wrap = node("div", null, "cc-copy"); const input = node("input"); input.value = text; input.readOnly = true; input.setAttribute("aria-label", label);
      const button = node("button", "Copy", "btn secondary small"); button.type = "button";
      button.setAttribute("aria-label", "Copy " + label.toLowerCase());
      button.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(text); button.textContent = "Copied"; }
        catch { input.focus(); input.select(); button.textContent = "Select and copy"; }
      });
      wrap.append(input, button); return wrap;
    }
    function renderInvoice(invoice) {
      clear();
      const expiry = Date.parse(invoice.expiresAt);
      if (invoice.asset !== selected || invoice.status !== "awaiting_deposit" || !Number.isFinite(expiry) || expiry <= Date.now()
          || !invoice.address || !invoice.total || !invoice.network || !invoice.fees) throw new Error("No current deposit invoice is available");
      const preview = invoice.preview === true;
      if (preview && !String(invoice.qrPayload).startsWith("valence-preview:")) throw new Error("Invalid preview code");
      if (!preview && invoice.qrPayload !== invoice.address) throw new Error("QR destination does not match the deposit address");
      if (typeof window.qrcode !== "function") throw new Error("QR generator could not load. Reload before sending funds.");
      const card = node("section", null, "cc-invoice");
      card.append(node("h3", preview ? "Example deposit invoice - do not send funds" : "Send your deposit"));
      const grid = node("div", null, "cc-invoice-grid");
      const qrWrap = node("div", null, "cc-qr");
      const qr = window.qrcode(0, "M"); qr.addData(invoice.qrPayload, "Byte"); qr.make();
      const count = qr.getModuleCount(), scale = 5, padding = 4;
      const canvas = node("canvas"); canvas.width = canvas.height = (count + padding * 2) * scale;
      canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", preview ? "Non-payment checkout preview QR code" : `${invoice.asset} deposit address QR code`);
      const ctx = canvas.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = "#000";
      for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (qr.isDark(r, c)) ctx.fillRect((c + padding) * scale, (r + padding) * scale, scale, scale);
      qrWrap.append(canvas, node("small", preview ? "Preview code cannot pay a wallet" : "Address only - enter the amount shown"));
      const instructions = node("div");
      instructions.append(node("p", `Use ${invoice.asset} on ${invoice.network} only.`, "cc-network"), node("label", "Exact amount to send"),
        copyControl("Exact crypto amount", invoice.total), node("p", invoice.asset, "hint"), node("label", "Deposit wallet address"),
        copyControl("Deposit wallet address", invoice.address));
      grid.append(qrWrap, instructions); card.append(grid);
      const fees = node("dl", null, "cc-fees");
      for (const [label, value] of [["Deal amount", invoice.fees.principal], ["Valence service fee - 1%", invoice.fees.platform],
        ["Swap fee - no swap for this quote", invoice.fees.swap], ["Payout network fee reserve (estimate)", invoice.fees.payoutReserve], ["Total deposit", invoice.total]]) {
        fees.append(node("dt", label), node("dd", `${value} ${invoice.asset}`));
      }
      card.append(fees, node("p", "The sending wallet charges its network fee separately. Make sure the full deposit amount arrives; do not subtract that fee from this amount.", "hint"),
        node("p", "Deposit and payout use the same coin and network. No swap is included. Any later conversion needs a separate quote and your approval.", "hint"));
      const countdown = node("p", "", "cc-expiry"); card.append(countdown);
      const controls = node("div", null, "actions"); const refresh = node("button", "Refresh quote", "btn secondary"); refresh.type = "button";
      refresh.addEventListener("click", () => load(selected)); controls.append(refresh); card.append(controls);
      const tick = () => {
        if (!host.isConnected) { clearInterval(expiryTimer); return; }
        const remaining = Math.ceil((expiry - Date.now()) / 1000);
        if (remaining <= 0) { clearInterval(expiryTimer); content.replaceChildren(node("p", "This quote expired. Select the coin again to get a fresh invoice. Do not send to the old quote.", "flash warn")); return; }
        countdown.textContent = `Quote expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
      };
      content.append(card); tick(); expiryTimer = setInterval(tick, 1000);
    }
    async function load(asset) {
      const current = ++generation; selected = asset; clear();
      for (const button of choices.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.asset === asset));
      if (!dealId) { content.append(node("p", "Open a joined deal as the buyer to request its deposit invoice.", "hint")); return; }
      content.append(node("p", "Preparing your deposit quote...", "muted"));
      try {
        const invoice = await request("POST", `/deals/${encodeURIComponent(dealId)}/crypto/invoice`, { asset });
        if (!disposed && current === generation && host.isConnected) renderInvoice(invoice);
      } catch (error) {
        if (!disposed && current === generation) {
          clear(); const message = error.message || "Cannot issue a deposit invoice";
          if (message !== notice.textContent) content.append(node("p", message, "flash warn"));
        }
      }
    }
    request("GET", "/crypto/methods").then(policy => {
      if (disposed) return;
      notice.textContent = policy.ready ? "Only pay a current invoice for this deal." : policy.reason;
      for (const asset of policy.assets) {
        const button = node("button", null, "cc-coin"); button.type = "button"; button.dataset.asset = asset.symbol;
        button.disabled = asset.disabled || asset.symbol === "USDT"; button.setAttribute("aria-pressed", "false");
        button.append(node("strong", asset.symbol), node("span", asset.name), node("small", asset.disabled ? "Temporarily disabled" : asset.network));
        button.addEventListener("click", () => load(asset.symbol)); choices.append(button);
        if (asset.disabled && asset.reason) { const reason = node("p", asset.reason + " If USDT is enabled later, its payout gas quote must be acknowledged before release.", "hint"); host.append(reason); }
      }
      const initial = policy.assets.find(a => !a.disabled); if (initial) load(initial.symbol);
    }).catch(error => { notice.textContent = error.message || "Could not load payment methods"; });
    return { destroy() { disposed = true; generation++; clearInterval(expiryTimer); } };
  }
  window.ValenceCryptoCheckout = { mount };
})();
