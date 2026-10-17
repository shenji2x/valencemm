"use strict";
// Basic front end for Valence. No framework. All text from the server is put on the page with
// textContent / text nodes (never innerHTML), so names and titles can't inject markup.
(() => {
  // sessionStorage = one login per browser tab, so you can test both sides of a deal in two tabs.
  const TOKEN_KEY = "valence_token";
  const TYPE_LABELS = { "ai-ai": "AI to AI", "ai-human": "AI and Human", "human-human": "Human to Human" };
  const STATE_LABELS = {
    open: "Waiting for the other side",
    joined: "Ready to fund",
    funded: "In escrow",
    released: "Released",
    refunded: "Refunded",
    cancelled: "Cancelled",
  };

  const $ = (sel, root = document) => root.querySelector(sel);

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
    return node;
  }

  const getToken = () => {
    try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
  };
  const setToken = (t) => {
    try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ }
  };

  function goLogin() {
    location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search);
  }

  function safeNext(value) {
    return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : null;
  }

  async function api(method, path, body, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    const token = getToken();
    if (token) headers.Authorization = "Bearer " + token;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res;
    try {
      res = await fetch("/v1" + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch {
      throw new Error("Can't reach the server. Check your connection and try again.");
    }
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      if (res.status === 401 && token && !opts.noRedirect) {
        setToken(null);
        goLogin();
      }
      const err = new Error((data.error && data.error.message) || "Something went wrong");
      err.status = res.status;
      err.code = data.error && data.error.code;
      throw err;
    }
    return data;
  }

  function flash(text, kind = "error") {
    const box = $("#msg");
    if (!box) return;
    box.textContent = text || "";
    box.className = "flash " + kind;
    box.hidden = !text;
  }

  // Runs handler(form) on submit, disables the button while it works, and shows any error.
  function bindForm(selector, handler) {
    const form = $(selector);
    if (!form) return;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const button = form.querySelector("button[type=submit]");
      if (button) button.disabled = true;
      flash("");
      try {
        await handler(form);
      } catch (err) {
        flash(err.message);
      } finally {
        if (button) button.disabled = false;
      }
    });
  }

  const val = (form, name) => form.elements[name].value;
  const kindLabel = (kind) => (kind === "agent" ? "AI agent" : "person");
  const newKey = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

  // ---------- header ----------
  async function logout() {
    try { await api("POST", "/logout", undefined, { noRedirect: true }); } catch { /* already logged out */ }
    setToken(null);
    location.href = "/";
  }

  function renderNav() {
    const nav = $("#nav");
    if (!nav) return;
    nav.textContent = "";
    const right = el("div", { class: "nav-right" });
    if (getToken()) {
      right.append(
        el("a", { href: "/dashboard", class: "btn small" }, "Dashboard"),
        el("button", { type: "button", class: "btn small secondary", onclick: logout }, "Log out")
      );
    } else {
      right.append(
        el("a", { href: "/login", class: "btn small secondary" }, "Log in"),
        el("a", { href: "/login#signup", class: "btn small" }, "Sign up")
      );
    }
    nav.append(
      el("a", { href: "/", class: "logo" }, "Valence"),
      el("div", { class: "nav-links" },
        el("a", { href: "/#how" }, "How it works"),
        el("a", { href: "/#faq" }, "FAQ"),
        el("a", { href: "/docs" }, "API docs")),
      right
    );
  }

  // ---------- login page ----------
  function loginPage() {
    const next = safeNext(new URLSearchParams(location.search).get("next")) || "/dashboard";
    const done = (token) => {
      setToken(token);
      location.href = next;
    };

    bindForm("#login-form", async (f) => {
      const r = await api("POST", "/humans/login", { username: val(f, "username"), password: val(f, "password") }, { noRedirect: true });
      done(r.token);
    });
    bindForm("#signup-form", async (f) => {
      const r = await api("POST", "/humans/signup", { username: val(f, "username"), password: val(f, "password") }, { noRedirect: true });
      done(r.token);
    });
    bindForm("#agent-create-form", async (f) => {
      const r = await api("POST", "/agents/register", { name: val(f, "agentname") }, { noRedirect: true });
      $("#agent-key").textContent = r.apiKey;
      $("#agent-created").hidden = false;
      $("#agent-continue").onclick = () => done(r.apiKey);
    });
    bindForm("#agent-key-form", async (f) => {
      const key = val(f, "apikey").trim();
      setToken(key);
      try {
        await api("GET", "/me", undefined, { noRedirect: true });
      } catch (err) {
        setToken(null);
        throw new Error(err.status === 401 ? "That API key wasn't recognised" : err.message);
      }
      done(key);
    });
  }

  // ---------- dashboard ----------
  function typeOptions(kind) {
    return kind === "agent"
      ? [["ai-ai", "AI to AI (the other side is an AI agent)"], ["ai-human", "AI to Human (the other side is a person)"]]
      : [["human-human", "Human to Human (the other side is a person)"], ["ai-human", "Human to AI (the other side is an AI agent)"]];
  }

  function showBalance(me) {
    $("#balance").textContent = String(me.balance);
  }

  async function dashboardPage() {
    if (!getToken()) return goLogin();
    let me;
    try { me = await api("GET", "/me"); } catch (err) { return flash(err.message); }
    $("#who").textContent = me.name;
    $("#kind").textContent = kindLabel(me.kind);
    showBalance(me);

    const select = $("#create-form").elements.type;
    for (const [value, label] of typeOptions(me.kind)) select.append(el("option", { value }, label));

    const code = new URLSearchParams(location.search).get("code");
    if (code) {
      $("#join-form").elements.code.value = code;
      $("#join-card").scrollIntoView();
    }

    bindForm("#redeem-form", async (f) => {
      const r = await api("POST", "/credits/redeem", { code: val(f, "code") });
      f.reset();
      $("#balance").textContent = String(r.balance);
      flash(`Added ${r.added} test credits.`, "ok");
    });
    bindForm("#create-form", async (f) => {
      const deal = await api("POST", "/deals", {
        type: val(f, "type"),
        role: val(f, "role"),
        title: val(f, "title"),
        description: val(f, "description"),
        amount: Number(val(f, "amount")),
        deadlineHours: Number(val(f, "deadline")),
      }, { headers: { "Idempotency-Key": newKey() } });
      location.href = "/deal?id=" + encodeURIComponent(deal.id);
    });
    bindForm("#join-form", async (f) => {
      const deal = await api("POST", "/deals/join", { inviteCode: val(f, "code") });
      location.href = "/deal?id=" + encodeURIComponent(deal.id);
    });

    try {
      const { deals } = await api("GET", "/deals");
      const list = $("#deals");
      list.textContent = "";
      if (!deals.length) list.append(el("li", { class: "muted" }, "No deals yet. Create one or join with an invite code."));
      for (const d of deals) {
        list.append(el("li", {},
          el("a", { href: "/deal?id=" + encodeURIComponent(d.id) }, d.title),
          el("span", { class: "muted" },
            `${TYPE_LABELS[d.type]} · ${d.amount} credits · you are the ${d.yourRole === "buyer" ? "sender" : "receiver"} · ${STATE_LABELS[d.state]}`)));
      }
    } catch (err) {
      flash(err.message);
    }
  }

  // ---------- deal page ----------
  async function dealPage() {
    if (!getToken()) return goLogin();
    const id = new URLSearchParams(location.search).get("id");
    if (!id) return flash("No deal selected. Go to your dashboard and open one.");
    let me;
    let deal = null;
    let busy = false;

    const partyText = (p, fallback) => (p ? `${p.name} (${kindLabel(p.kind)})${p.id === me.accountId ? " - you" : ""}` : fallback);
    const nameOf = (accountId) => {
      for (const p of [deal.buyer, deal.seller]) if (p && p.id === accountId) return p.id === me.accountId ? "you" : p.name;
      return "someone";
    };

    function nextStep() {
      const role = deal.yourRole;
      switch (deal.state) {
        case "open": return "Waiting for the other side to join. Send them the invite below.";
        case "joined": return role === "buyer" ? "Both sides are in. Fund escrow to start the deal." : "Waiting for the sender to fund escrow.";
        case "funded": return role === "buyer"
          ? "The credits are held in escrow. Release them once you're happy with what you received."
          : "The credits are held in escrow. Do the work, then ask the sender to release them.";
        case "released": return "Done. The receiver has been paid.";
        case "refunded": return "Done. The sender got their credits back.";
        default: return "This deal was cancelled.";
      }
    }

    async function act(action) {
      busy = true;
      flash("");
      try {
        deal = await api("POST", `/deals/${encodeURIComponent(id)}/${action}`, undefined, { headers: { "Idempotency-Key": newKey() } });
        me = await api("GET", "/me");
      } catch (err) {
        flash(err.message);
      } finally {
        busy = false;
      }
      render();
    }

    function actionButton(label, action, cls, confirmText) {
      return el("button", {
        type: "button",
        class: "btn " + cls,
        onclick: () => { if (!confirmText || window.confirm(confirmText)) act(action); },
      }, label);
    }

    function copyButton(text, label) {
      return el("button", {
        type: "button",
        class: "btn small secondary",
        onclick: async (e) => {
          try {
            await navigator.clipboard.writeText(text);
            e.target.textContent = "Copied";
          } catch {
            e.target.textContent = "Copy failed, select the text instead";
          }
        },
      }, label);
    }

    function render() {
      const root = $("#deal");
      root.textContent = "";
      const fee = Math.floor((deal.amount * deal.feeBps) / 10000);
      const isBuyer = deal.yourRole === "buyer";
      const isSeller = deal.yourRole === "seller";

      root.append(
        el("div", { class: "row between" },
          el("h1", {}, deal.title),
          el("span", { class: "badge " + deal.state }, STATE_LABELS[deal.state])),
        deal.description ? el("p", { class: "muted" }, deal.description) : null,
        el("p", {}, nextStep()),
        el("dl", { class: "facts" },
          el("dt", {}, "Deal type"), el("dd", {}, TYPE_LABELS[deal.type]),
          el("dt", {}, "Amount"), el("dd", {}, `${deal.amount} credits`),
          el("dt", {}, "Fee"), el("dd", {}, `${fee} credits (${deal.feeBps / 100}%, taken from the receiver's payout)`),
          el("dt", {}, "Sender (pays)"), el("dd", {}, partyText(deal.buyer, "Waiting for someone to join")),
          el("dt", {}, "Receiver (gets paid)"), el("dd", {}, partyText(deal.seller, "Waiting for someone to join")),
          el("dt", {}, "Refund deadline"),
          el("dd", {}, deal.deadlineAt ? new Date(deal.deadlineAt).toLocaleString() : `${deal.deadlineHours} hours after funding`),
          el("dt", {}, "Your balance"), el("dd", {}, `${me.balance} credits`))
      );

      if (deal.inviteCode) {
        const link = `${location.origin}/dashboard?code=${deal.inviteCode}`;
        const who = deal.joinKind === "agent" ? "an AI agent" : "a person";
        root.append(el("div", { class: "card" },
          el("h2", {}, "Invite the other side"),
          el("p", { class: "muted" }, `Send this code or link to ${who}. It works once.`),
          el("div", { class: "codebox", id: "invite-code" }, deal.inviteCode),
          el("div", { class: "row" }, copyButton(deal.inviteCode, "Copy code"), copyButton(link, "Copy link")),
          el("p", { class: "dim" }, link)));
      }

      const actions = el("div", { class: "actions" });
      if (deal.state === "joined" && isBuyer) actions.append(actionButton(`Fund escrow (${deal.amount} credits)`, "fund", "", null));
      if (deal.state === "funded" && isBuyer) {
        actions.append(actionButton("Release funds to the receiver", "release", "", "Release the funds? This can't be undone."));
        if (Date.now() >= Date.parse(deal.deadlineAt)) actions.append(actionButton("Claim refund (deadline passed)", "refund", "secondary", null));
      }
      if (deal.state === "funded" && isSeller) actions.append(actionButton("Refund the sender", "refund", "secondary", "Return the credits to the sender?"));
      if (deal.state === "open" || deal.state === "joined") actions.append(actionButton("Cancel deal", "cancel", "danger", "Cancel this deal?"));
      if (actions.children.length) root.append(actions);

      root.append(
        el("h2", {}, "History"),
        el("ul", { class: "history" },
          ...deal.history.map((h) => el("li", {}, `${new Date(h.at).toLocaleString()}: ${STATE_LABELS[h.state] || h.state} (by ${nameOf(h.by)})`))));
    }

    async function load(showErrors) {
      try {
        me = me || await api("GET", "/me");
        const fresh = await api("GET", `/deals/${encodeURIComponent(id)}`);
        const changed = !deal || JSON.stringify(fresh) !== JSON.stringify(deal);
        deal = fresh;
        if (changed) render();
      } catch (err) {
        if (showErrors) flash(err.message);
      }
    }

    await load(true);
    // Keep the page fresh so you see the other side's moves without reloading.
    setInterval(async () => {
      if (busy || document.visibilityState !== "visible") return;
      const before = me && me.balance;
      try { me = await api("GET", "/me"); } catch { return; }
      await load(false);
      if (me.balance !== before && deal) render();
    }, 4000);
  }

  // ---------- start ----------
  renderNav();
  const page = document.body.dataset.page;
  if (page === "login") loginPage();
  else if (page === "dashboard") dashboardPage();
  else if (page === "deal") dealPage();
})();
