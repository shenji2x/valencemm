"use strict";
// Front end for Valence MM. No framework. Text from the server is always put on the page with
// textContent / text nodes (never innerHTML), so names, titles and messages can't inject markup.
(() => {
  // sessionStorage = one login per browser tab, so you can test both sides of a deal in two tabs.
  const TOKEN_KEY = "valence_token";
  const DISCORD_INVITE = "https://discord.gg/eVYyxbyy22";
  const TYPE_LABELS = { "ai-ai": "AI to AI", "ai-human": "AI and Human", "human-human": "Human to Human" };
  const STATE_LABELS = {
    open: "Waiting for the other side",
    joined: "Ready to fund",
    funded: "In escrow",
    released: "Released",
    refunded: "Refunded",
    cancelled: "Cancelled",
  };
  const ACTIVE = new Set(["open", "joined", "funded"]);
  const TICKET_CATEGORIES = [["deal", "A problem with a deal"], ["payments", "Credits and payments"], ["account", "My account"], ["bug", "Something is broken"], ["other", "Something else"]];

  const $ = (sel, root = document) => root.querySelector(sel);
  const SVG_NS = "http://www.w3.org/2000/svg";

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
    return node;
  }

  // Appends children, skipping null/false (Node.append would print them as text).
  function put(node, ...kids) {
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
    return node;
  }

  function svg(tag, attrs = {}, ...children) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    for (const c of children) if (c) node.append(c);
    return node;
  }

  // Small fixed icon set (static paths, never user data).
  const ICONS = {
    overview: "M3 20h18M5 16l4-5 4 3 6-8",
    stats: "M4 20V10M10 20V4M16 20v-7M22 20H2",
    new: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v8M8 12h8",
    join: "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3",
    deals: "M6 11V7a6 6 0 0 1 12 0v4M4 11h16v10H4z",
    history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2",
    support: "M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.8A8 8 0 1 1 21 12z",
    faq: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5h.01",
    settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1",
    wallet: "M3 7h18v12H3zM3 7l3-4h12l3 4M16 13h2",
    check: "M5 12l5 5 9-10",
    clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
    coins: "M8 8a5 3 0 1 0 0-.01M3 8v4c0 1.7 2.2 3 5 3s5-1.3 5-3V8M11 14c0 1.7 2.2 3 5 3s5-1.3 5-3v-4c0-1.7-2.2-3-5-3",
    arrowUp: "M12 19V5M5 12l7-7 7 7",
    arrowDown: "M12 5v14M5 12l7 7 7-7",
    percent: "M19 5L5 19M7 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM17 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
    out: "M7 17L17 7M8 7h9v9",
    back: "M15 18l-6-6 6-6",
    copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  };
  function icon(name, cls = "ico") {
    return svg("svg", { class: cls, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" },
      svg("path", { d: ICONS[name] }));
  }

  // ---------- formatting ----------
  const credits = (n) => Number(n || 0).toLocaleString();
  function duration(ms) {
    if (ms == null) return "-";
    const min = ms / 60000;
    if (min < 1) return "< 1 min";
    if (min < 60) return `${Math.round(min)} min`;
    const h = min / 60;
    if (h < 48) return `${h < 10 ? h.toFixed(1) : Math.round(h)} hours`;
    return `${(h / 24).toFixed(1)} days`;
  }
  function ago(iso) {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 45) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
  }
  const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const kindLabel = (kind) => (kind === "agent" ? "AI agent" : "person");

  // ---------- session and API ----------
  const getToken = () => { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } };
  const setToken = (t) => {
    try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ }
  };
  function goLogin() {
    location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search + location.hash);
  }
  function safeNext(value) {
    return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : null;
  }
  const newKey = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

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

  function flash(text, kind = "error", root = document) {
    const box = $("#msg", root);
    if (!box) return;
    box.textContent = text || "";
    box.className = "flash " + kind;
    box.hidden = !text;
  }

  let toastTimer = null;
  function toast(text) {
    const box = $("#toast");
    if (!box) return;
    box.textContent = text;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 4500);
  }

  // Runs handler(form) on submit, disables the button while it works, and shows any error.
  function bindForm(form, handler) {
    if (typeof form === "string") form = $(form);
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

  // A button that needs a second click within a few seconds, instead of a browser dialog.
  function confirmButton(label, cls, confirmLabel, run) {
    let armed = false;
    let timer = null;
    const b = el("button", { type: "button", class: "btn " + cls }, label);
    b.addEventListener("click", async () => {
      if (!armed) {
        armed = true;
        b.textContent = confirmLabel;
        b.classList.add("confirming");
        timer = setTimeout(() => { armed = false; b.textContent = label; b.classList.remove("confirming"); }, 4000);
        return;
      }
      clearTimeout(timer);
      b.disabled = true;
      try { await run(); } finally { b.disabled = false; }
    });
    return b;
  }

  function copyButton(text, label) {
    const b = el("button", { type: "button", class: "btn small secondary" }, icon("copy"), label);
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        b.lastChild.textContent = "Copied";
      } catch {
        b.lastChild.textContent = "Copy failed, select it instead";
      }
    });
    return b;
  }

  // ---------- theme ----------
  const THEME_KEY = "valence_theme";
  const THEME_COLORS = { dark: "#05070d", light: "#f5f7fc" };
  function systemTheme() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", THEME_COLORS[theme]);
    const btn = $("#theme-toggle");
    if (btn) btn.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
  }
  function savedTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch { return null; }
  }
  function saveTheme(choice) {
    try {
      if (choice === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, choice);
    } catch { /* storage blocked */ }
    applyTheme(choice === "system" ? systemTheme() : choice);
  }
  function setupTheme() {
    applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
    const btn = $("#theme-toggle");
    if (btn) btn.addEventListener("click", () => saveTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light"));
  }

  // ---------- marketing pages: Lenis + GSAP ----------
  const reducedMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function setupScroll() {
    for (const a of document.querySelectorAll(".menu-panel a")) {
      a.addEventListener("click", () => { const d = a.closest("details"); if (d) d.open = false; });
    }
    if (reducedMotion() || typeof window.Lenis !== "function") return;
    const gsap = window.gsap;
    const lenis = new window.Lenis({ duration: 1.1, anchors: { offset: -84 }, autoRaf: !gsap });
    if (gsap) {
      if (window.ScrollTrigger) {
        gsap.registerPlugin(window.ScrollTrigger);
        lenis.on("scroll", window.ScrollTrigger.update);
      }
      gsap.ticker.add((t) => lenis.raf(t * 1000));
      gsap.ticker.lagSmoothing(0);
    }
  }

  // The glowing columns rise on load, then drift slowly. One orchestrated moment.
  function heroMotion() {
    const gsap = window.gsap;
    if (!gsap || reducedMotion()) return;
    for (const group of document.querySelectorAll(".bars")) {
      const bars = group.querySelectorAll("i");
      gsap.from(bars, { scaleY: 0, duration: 1.2, ease: "power3.out", stagger: { each: 0.04, from: "random" } });
      bars.forEach((b) => {
        gsap.to(b, { scaleY: () => 0.75 + Math.random() * 0.5, duration: () => 3 + Math.random() * 3, ease: "sine.inOut", repeat: -1, yoyo: true, delay: 1.2 + Math.random() });
      });
    }
    const line = $("#mock-line");
    if (line && line.getTotalLength) {
      const len = line.getTotalLength();
      gsap.fromTo(line, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, duration: 1.6, ease: "power2.out", delay: 0.3 });
      gsap.from("#mock-area", { opacity: 0, duration: 1.2, delay: 0.9 });
    }
    const fill = $("#steps-fill");
    if (fill && window.ScrollTrigger) {
      gsap.fromTo(fill, { scaleX: 0 }, { scaleX: 1, ease: "none", scrollTrigger: { trigger: ".steps-wrap", start: "top 85%", end: "bottom 55%", scrub: 0.6 } });
    }
  }

  // Header buttons when signed in.
  async function logout() {
    try { await api("POST", "/logout", undefined, { noRedirect: true }); } catch { /* already logged out */ }
    setToken(null);
    location.href = "/";
  }
  function renderNav() {
    const box = $("#nav-auth");
    if (!box || !getToken()) return;
    box.textContent = "";
    put(box, 
      el("button", { type: "button", class: "btn small outline", onclick: logout }, "Log out"),
      el("a", { href: "/dashboard", class: "btn small" }, "Dashboard")
    );
  }

  // ---------- login and signup ----------
  function authDone() {
    const next = safeNext(new URLSearchParams(location.search).get("next")) || "/dashboard";
    for (const a of document.querySelectorAll("a[data-keep-next]")) {
      if (next !== "/dashboard") a.href = a.getAttribute("href") + "?next=" + encodeURIComponent(next);
    }
    return (token) => { setToken(token); location.href = next; };
  }
  function signupPage() {
    const done = authDone();
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
  }
  function loginPage() {
    const done = authDone();
    bindForm("#login-form", async (f) => {
      const r = await api("POST", "/humans/login", { username: val(f, "username"), password: val(f, "password") }, { noRedirect: true });
      done(r.token);
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

  // ================= dashboard app =================
  const app = { me: null, view: null, timers: [], gen: 0 };

  const VIEWS = {
    overview: { title: "Overview", icon: "overview", render: viewOverview },
    stats: { title: "Stats", icon: "stats", render: viewStats },
    new: { title: "New deal", icon: "new", render: viewNewDeal, slim: true },
    join: { title: "Join a deal", icon: "join", render: viewJoin, slim: true },
    deals: { title: "Active deals", icon: "deals", render: viewActive },
    history: { title: "Past deals", icon: "history", render: viewHistory },
    deal: { title: "Deal", icon: "deals", nav: "deals", render: viewDeal, slim: true },
    support: { title: "Support", icon: "support", render: viewSupport },
    ticket: { title: "Support ticket", icon: "support", nav: "support", render: viewTicket, slim: true },
    faq: { title: "FAQ", icon: "faq", render: viewFaq, slim: true },
    settings: { title: "Settings", icon: "settings", render: viewSettings, slim: true },
  };

  // Repeats fn while this view is open and the tab is visible. Cleared on navigation.
  function every(ms, fn) {
    const gen = app.gen;
    const id = setInterval(async () => {
      if (gen !== app.gen || document.visibilityState !== "visible") return;
      try { await fn(); } catch { /* next tick will retry */ }
    }, ms);
    app.timers.push(id);
  }
  const alive = (gen) => gen === app.gen;

  function setBalance(n) {
    const b = $("#top-balance");
    if (b) b.textContent = credits(n);
  }
  async function refreshMe() {
    app.me = await api("GET", "/me");
    setBalance(app.me.balance);
    return app.me;
  }
  function setCounts(deals) {
    const active = deals.filter((d) => ACTIVE.has(d.state)).length;
    const c = $("#count-active");
    if (c) { c.textContent = String(active); c.hidden = active === 0; }
  }

  function parseRoute() {
    const raw = decodeURIComponent(location.hash.replace(/^#/, ""));
    const [name, ...rest] = raw.split("/");
    const arg = rest.join("/") || null;
    if (name === "support" && arg) return { name: "ticket", arg };
    if (VIEWS[name]) return { name, arg };
    return { name: "overview", arg: null };
  }

  async function route() {
    app.gen++;
    for (const id of app.timers) clearInterval(id);
    app.timers = [];
    const { name, arg } = parseRoute();
    const v = VIEWS[name];
    const navName = v.nav || name;
    for (const a of document.querySelectorAll(".side nav a")) {
      const on = a.dataset.view === navName;
      a.classList.toggle("active", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    }
    $("#app").classList.remove("nav-open");
    $("#burger").setAttribute("aria-expanded", "false");
    $("#page-title").textContent = v.title;
    const ico = $("#page-ico");
    ico.textContent = "";
    put(ico, icon(v.icon));
    document.title = `${v.title} | Valence MM`;
    const view = $("#view");
    view.className = "view" + (v.slim ? " slim" : "");
    view.textContent = "";
    put(view, el("p", { id: "msg", class: "flash", role: "status", "aria-live": "polite", hidden: true }));
    window.scrollTo(0, 0);
    try {
      await v.render(view, arg, app.gen);
    } catch (err) {
      if (alive(app.gen)) flash(err.message);
    }
  }

  async function dashboardPage() {
    if (!getToken()) return goLogin();
    // Old-style links: /dashboard?code=ABCD-2345 -> the join flow
    const code = new URLSearchParams(location.search).get("code");
    if (code && !location.hash) history.replaceState(null, "", "/dashboard#join/" + encodeURIComponent(code));
    try {
      await refreshMe();
    } catch (err) {
      return flash(err.message);
    }
    const me = app.me;
    $("#me-name").textContent = me.name;
    $("#me-kind").textContent = me.kind === "agent" ? "AI agent" : "Person";
    const av = $("#me-avatar");
    av.textContent = me.name.slice(0, 1);
    if (me.kind === "agent") av.classList.add("agent");
    $("#logout").addEventListener("click", logout);
    $("#burger").addEventListener("click", () => {
      const open = $("#app").classList.toggle("nav-open");
      $("#burger").setAttribute("aria-expanded", String(open));
    });
    $("#scrim").addEventListener("click", () => $("#app").classList.remove("nav-open"));
    window.addEventListener("hashchange", route);
    api("GET", "/deals").then((r) => setCounts(r.deals)).catch(() => {});
    route();
  }

  // ---------- shared pieces ----------
  function tile(iconName, value, label, accent) {
    return el("div", { class: "tile" + (accent ? " accent" : "") }, el("span", { class: "page-ico" }, icon(iconName)), el("div", {}, el("b", { class: "num" }, value), el("span", {}, label)));
  }
  function roleText(d) {
    return d.yourRole === "buyer" ? "you're paying" : "you're getting paid";
  }
  function nextHint(d) {
    const buyer = d.yourRole === "buyer";
    switch (d.state) {
      case "open": return "Waiting for the other side to join";
      case "joined": return buyer ? "Fund escrow to start" : "Waiting for the sender to fund";
      case "funded": return buyer ? "Release once you're happy" : "Do the work, then ask for release";
      default: return STATE_LABELS[d.state];
    }
  }
  const needsMe = (d) => (d.state === "joined" || d.state === "funded") && d.yourRole === "buyer";
  function dealItem(d) {
    return el("li", {}, el("a", { class: "item", href: "#deal/" + encodeURIComponent(d.id) },
      el("div", { class: "grow" }, el("span", { class: "t" }, d.title), el("span", { class: "s" }, `${TYPE_LABELS[d.type]} · ${roleText(d)} · ${nextHint(d)}`)),
      el("span", { class: "amt num" }, `${credits(d.amount)} cr`),
      el("span", { class: "badge " + d.state }, STATE_LABELS[d.state])));
  }
  function emptyState(title, text, ...buttons) {
    return el("div", { class: "empty" }, el("h3", {}, title), el("p", {}, text), el("div", { class: "row center" }, ...buttons));
  }
  const btnLink = (href, label, cls = "") => el("a", { class: "btn " + cls, href }, label);

  // ---------- overview ----------
  async function viewOverview(view, _arg, gen) {
    const [dealsRes, stats] = await Promise.all([api("GET", "/deals"), api("GET", "/stats"), refreshMe()]);
    if (!alive(gen)) return;
    const deals = dealsRes.deals;
    setCounts(deals);
    const me = app.me;
    const box = el("div");
    put(view, box);

    function draw(deals, stats, me) {
      box.textContent = "";
      const active = deals.filter((d) => ACTIVE.has(d.state));
      const attention = active.filter(needsMe);
      const waiting = active.filter((d) => !needsMe(d));
      put(box, 
        el("h2", {}, `Welcome back, ${me.name}`),
        el("p", { class: "muted" }, attention.length ? `${attention.length} deal${attention.length > 1 ? "s" : ""} need${attention.length > 1 ? "" : "s"} you.` : "Here's how your deals are going."),
        el("div", { class: "tiles" },
          tile("wallet", credits(me.balance), "Balance (credits)", true),
          tile("deals", String(active.length), "Active deals"),
          tile("check", String(stats.counts.released), "Completed deals"),
          tile("coins", credits(stats.volume.total), "Volume (credits)")),
        el("div", { class: "two" },
          el("section", { class: "card" },
            el("h2", {}, "Needs you"),
            attention.length ? el("ul", { class: "list" }, attention.map(dealItem))
              : emptyState("You're all caught up", "Nothing is waiting on you right now.", btnLink("#new", "New deal"), btnLink("#join", "Join a deal", "secondary")),
            waiting.length ? el("h3", { class: "q spaced" }, "Waiting on the other side") : null,
            waiting.length ? el("ul", { class: "list" }, waiting.slice(0, 5).map(dealItem)) : null),
          el("section", { class: "card" },
            el("h2", {}, "Recent activity"),
            me.recentLedger.length
              ? el("ul", { class: "list" }, me.recentLedger.slice(0, 8).map((e) => el("li", {}, el("div", { class: "item" },
                el("span", { class: "page-ico" }, icon(e.delta >= 0 ? "arrowDown" : "arrowUp")),
                el("div", { class: "grow" }, el("span", { class: "t" }, e.memo), el("span", { class: "s" }, ago(e.at))),
                el("span", { class: "amt num" }, `${e.delta > 0 ? "+" : ""}${credits(e.delta)}`)))))
              : el("p", { class: "muted" }, "No activity yet."))));
    }
    draw(deals, stats, me);
    let last = JSON.stringify([deals, stats, me.balance]);
    every(5000, async () => {
      const [d2, s2] = await Promise.all([api("GET", "/deals"), api("GET", "/stats"), refreshMe()]);
      if (!alive(gen)) return;
      setCounts(d2.deals);
      const now = JSON.stringify([d2.deals, s2, app.me.balance]);
      if (now !== last) { last = now; draw(d2.deals, s2, app.me); }
    });
  }

  // ---------- stats ----------
  function barChart(daily) {
    const W = 720, H = 220, L = 40, B = 26, T = 12;
    const max = Math.max(...daily.map((d) => d.volume), 0);
    const top = max <= 0 ? 10 : Math.ceil(max / 4 / 10) * 10 * 4 || 10;
    const plotW = W - L, plotH = H - B - T;
    const slot = plotW / daily.length;
    const bw = Math.max(2, slot - 2); // 2px gap between bars
    const chart = svg("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Released volume per day for the last 30 days" });
    for (let i = 0; i <= 4; i++) {
      const y = T + plotH - (plotH * i) / 4;
      put(chart, svg("line", { class: "gridline", x1: L, x2: W, y1: y, y2: y }));
      const t = svg("text", { x: 0, y: y + 4 });
      t.textContent = credits((top * i) / 4);
      put(chart, t);
    }
    daily.forEach((d, i) => {
      const h = d.volume > 0 ? Math.max(3, (d.volume / top) * plotH) : 2;
      const x = L + i * slot + 1;
      const y = T + plotH - h;
      const r = Math.min(4, bw / 2, h);
      // rounded top, square bottom on the baseline
      const path = `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${y + h} Z`;
      const bar = svg("path", { class: "bar" + (d.volume > 0 ? "" : " zero"), d: path });
      const tip = svg("title");
      tip.textContent = `${new Date(d.date + "T00:00:00Z").toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" })}: ${credits(d.volume)} credits in ${d.deals} deal${d.deals === 1 ? "" : "s"}`;
      put(bar, tip);
      // a taller invisible hit target so the tooltip is easy to reach
      const hit = svg("rect", { x, y: T, width: bw, height: plotH, fill: "transparent" });
      put(hit, tip.cloneNode(true));
      put(chart, bar, hit);
      if ((daily.length - 1 - i) % 7 === 0) {
        const lbl = svg("text", { x: x, y: H - 6 });
        lbl.textContent = new Date(d.date + "T00:00:00Z").toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
        put(chart, lbl);
      }
    });
    return chart;
  }

  async function viewStats(view, _arg, gen) {
    const s = await api("GET", "/stats");
    if (!alive(gen)) return;
    const pct = s.completionRate == null ? "-" : `${Math.round(s.completionRate * 100)}%`;
    const states = ["open", "joined", "funded", "released", "refunded", "cancelled"];
    const maxCount = Math.max(1, ...states.map((k) => s.counts[k]));
    put(view, 
      el("div", { class: "tiles" },
        tile("coins", credits(s.volume.total), "Total volume (credits)", true),
        tile("arrowUp", credits(s.volume.sent), "Sent"),
        tile("arrowDown", credits(s.volume.received), "Received"),
        tile("clock", duration(s.durationMs.avgFundedToReleased), "Avg time in escrow"),
        tile("percent", pct, "Completion rate"),
        tile("wallet", credits(s.volume.inEscrow), "In escrow now")),
      el("section", { class: "card" },
        el("div", { class: "row between" }, el("h2", {}, "Released volume, last 30 days"), el("span", { class: "dim" }, "Hover a bar for the day's total")),
        s.daily.some((d) => d.volume > 0) ? barChart(s.daily) : el("p", { class: "muted" }, "No released deals in the last 30 days yet. Once deals complete, their volume shows up here day by day.")),
      el("div", { class: "two" },
        el("section", { class: "card" },
          el("h2", {}, "How long deals take"),
          el("dl", { class: "facts" },
            el("dt", {}, "Average, start to finish"), el("dd", {}, duration(s.durationMs.avgCreatedToReleased)),
            el("dt", {}, "Typical (median)"), el("dd", {}, duration(s.durationMs.medianCreatedToReleased)),
            el("dt", {}, "Average time in escrow"), el("dd", {}, duration(s.durationMs.avgFundedToReleased)),
            el("dt", {}, "Fastest deal"), el("dd", {}, duration(s.durationMs.fastest)),
            el("dt", {}, "Fees paid"), el("dd", {}, `${credits(s.volume.feesPaid)} credits`))),
        el("section", { class: "card" },
          el("h2", {}, "Deals by status"),
          el("div", { class: "split" }, states.map((k) => {
            const bar = el("i", { class: s.counts[k] ? "" : "zero" });
            bar.style.width = `${(s.counts[k] / maxCount) * 100}%`;
            return el("div", {}, el("span", {}, STATE_LABELS[k]), el("span", {}, bar), el("b", { class: "num" }, String(s.counts[k])));
          })))));
  }

  // ---------- new deal: step by step ----------
  function typeOptions(kind) {
    return kind === "agent"
      ? [["ai-ai", "An AI agent", "Both sides are AI agents using the API."], ["ai-human", "A person", "A human will join from the website."]]
      : [["human-human", "A person", "Another person joins from the website."], ["ai-human", "An AI agent", "An AI agent joins through the API."]];
  }
  const DEADLINES = [[24, "1 day"], [72, "3 days"], [168, "7 days"], [336, "14 days"], [720, "30 days"]];

  function viewNewDeal(view) {
    const draft = { type: null, role: null, title: "", description: "", amount: "", deadlineHours: 72, key: newKey() };
    const STEPS = ["Who", "What", "How much", "Review"];
    let step = 0;
    const body = el("div", { class: "card" });
    put(view, body);

    function choice(selected, title, sub, onPick) {
      return el("button", { type: "button", class: "choice", "aria-pressed": String(selected), onclick: onPick }, el("strong", {}, title), el("span", {}, sub));
    }
    function nav(nextLabel, onNext, { canBack = true } = {}) {
      return el("div", { class: "wiz-nav" },
        canBack ? el("button", { type: "button", class: "btn ghost", onclick: () => { step--; draw(); } }, "Back") : el("span"),
        el("button", { type: "submit", class: "btn" }, nextLabel));
    }
    function draw() {
      body.textContent = "";
      flash("");
      put(body, el("ol", { class: "stepper" }, STEPS.map((s, i) => el("li", { class: i < step ? "done" : i === step ? "now" : "" }, `${i + 1}. ${s}`))));
      const form = el("form", { novalidate: true });
      put(body, form);

      if (step === 0) {
        put(form, 
          el("p", { class: "q" }, "Who are you dealing with?"),
          el("div", { class: "choices" }, typeOptions(app.me.kind).map(([v, t, s]) => choice(draft.type === v, t, s, () => { draft.type = v; draw(); }))),
          el("p", { class: "q spaced" }, "Are you paying or getting paid?"),
          el("div", { class: "choices" },
            choice(draft.role === "buyer", "I'm paying", "You fund escrow and release it when you're happy.", () => { draft.role = "buyer"; draw(); }),
            choice(draft.role === "seller", "I'm getting paid", "You do the work and receive the funds.", () => { draft.role = "seller"; draw(); })),
          nav("Continue", null, { canBack: false }));
        form.onsubmit = (e) => {
          e.preventDefault();
          if (!draft.type || !draft.role) return flash("Pick who you're dealing with and whether you're paying or getting paid.");
          step = 1; draw();
        };
      }

      if (step === 1) {
        const title = el("input", { id: "deal-title", name: "title", maxlength: "100", required: true, placeholder: "e.g. Logo design for my store" });
        title.value = draft.title;
        const desc = el("textarea", { id: "deal-description", name: "description", maxlength: "500", placeholder: "What exactly will be delivered, and by when?" });
        desc.value = draft.description;
        put(form, 
          el("p", { class: "q" }, "What's the deal for?"),
          el("p", { class: "muted" }, "Both sides see this, so be specific."),
          el("label", { for: "deal-title" }, "Title"), title,
          el("label", { for: "deal-description" }, "Details (optional)"), desc,
          nav("Continue"));
        form.onsubmit = (e) => {
          e.preventDefault();
          draft.title = title.value.trim();
          draft.description = desc.value.trim();
          if (!draft.title) return flash("Give the deal a title.");
          step = 2; draw();
        };
        setTimeout(() => title.focus(), 0);
      }

      if (step === 2) {
        const amount = el("input", { id: "deal-amount", name: "amount", type: "number", min: "1", max: "10000", step: "1", inputmode: "numeric", required: true, placeholder: "0" });
        amount.value = draft.amount;
        const note = el("p", { class: "hint" });
        const updateNote = () => {
          const n = Math.floor(Number(amount.value));
          if (!n || n < 1) { note.textContent = "Whole credits, from 1 to 10,000."; return; }
          const fee = Math.floor(n / 100);
          note.textContent = `The receiver gets ${credits(n - fee)} credits after the 1% fee (${credits(fee)}).`;
        };
        amount.addEventListener("input", updateNote);
        updateNote();
        put(form, 
          el("p", { class: "q" }, "How much, and how long?"),
          el("label", { for: "deal-amount" }, "Amount"),
          el("div", { class: "amount-input" }, amount, el("span", {}, "credits")),
          note,
          el("label", {}, "Refund deadline"),
          el("p", { class: "hint" }, "If the deal isn't finished this long after funding, the sender can take the credits back."),
          el("div", { class: "chips", role: "group", "aria-label": "Refund deadline" }, DEADLINES.map(([h, label]) =>
            el("button", { type: "button", class: "chip", "aria-pressed": String(draft.deadlineHours === h), onclick: () => { draft.amount = amount.value; draft.deadlineHours = h; draw(); } }, label))),
          nav("Review deal"));
        form.onsubmit = (e) => {
          e.preventDefault();
          const n = Number(amount.value);
          if (!Number.isInteger(n) || n < 1 || n > 10000) return flash("Enter a whole number of credits from 1 to 10,000.");
          draft.amount = String(n);
          step = 3; draw();
        };
        setTimeout(() => amount.focus(), 0);
      }

      if (step === 3) {
        const n = Number(draft.amount);
        const fee = Math.floor(n / 100);
        const other = typeOptions(app.me.kind).find(([v]) => v === draft.type)[1].toLowerCase();
        put(form, 
          el("p", { class: "q" }, "Check the details"),
          el("dl", { class: "review" },
            el("dt", {}, "Deal"), el("dd", {}, draft.title),
            draft.description ? el("dt", {}, "Details") : null, draft.description ? el("dd", {}, draft.description) : null,
            el("dt", {}, "Other side"), el("dd", {}, `${other[0].toUpperCase()}${other.slice(1)} (${TYPE_LABELS[draft.type]})`),
            el("dt", {}, "You are"), el("dd", {}, draft.role === "buyer" ? "Paying (sender)" : "Getting paid (receiver)"),
            el("dt", {}, "Amount"), el("dd", {}, `${credits(n)} credits`),
            el("dt", {}, "Receiver gets"), el("dd", {}, `${credits(n - fee)} credits after the 1% fee`),
            el("dt", {}, "Refund deadline"), el("dd", {}, `${DEADLINES.find(([h]) => h === draft.deadlineHours)[1]} after funding`)),
          el("p", { class: "hint" }, "Next you'll get a one-time invite code to send to the other side."),
          nav("Create deal"));
        form.onsubmit = async (e) => {
          e.preventDefault();
          const button = form.querySelector("button[type=submit]");
          button.disabled = true;
          try {
            const deal = await api("POST", "/deals", {
              type: draft.type, role: draft.role, title: draft.title, description: draft.description,
              amount: n, deadlineHours: draft.deadlineHours,
            }, { headers: { "Idempotency-Key": draft.key } });
            location.hash = "#deal/" + encodeURIComponent(deal.id);
          } catch (err) {
            flash(err.message);
            button.disabled = false;
          }
        };
      }
    }
    draw();
  }

  // ---------- join a deal: code, preview, confirm ----------
  function viewJoin(view, arg, gen) {
    const body = el("div", { class: "card" });
    put(view, body);

    function askCode(prefill) {
      body.textContent = "";
      const input = el("input", { id: "join-code", name: "code", autocomplete: "off", spellcheck: "false", placeholder: "ABCD-2345", required: true, class: "code" });
      if (prefill) input.value = prefill;
      const form = el("form", {},
        el("p", { class: "q" }, "Enter your invite code"),
        el("p", { class: "muted" }, "The person who created the deal sent you a code or link."),
        el("label", { for: "join-code" }, "Invite code"), input,
        el("div", { class: "wiz-nav" }, el("span"), el("button", { type: "submit", class: "btn" }, "Continue")));
      bindForm(form, async () => {
        const preview = await api("GET", "/deals/invite/" + encodeURIComponent(input.value.trim()));
        if (alive(gen)) showPreview(preview);
      });
      put(body, form);
      setTimeout(() => input.focus(), 0);
    }

    function showPreview(p) {
      body.textContent = "";
      flash("");
      const fee = Math.floor((p.amount * p.feeBps) / 10000);
      put(body, 
        el("p", { class: "q" }, p.title),
        p.description ? el("p", { class: "muted" }, p.description) : null,
        el("dl", { class: "review" },
          el("dt", {}, "From"), el("dd", {}, `${p.creator.name} (${kindLabel(p.creator.kind)})`),
          el("dt", {}, "Deal type"), el("dd", {}, TYPE_LABELS[p.type]),
          el("dt", {}, "You'll be"), el("dd", {}, p.yourRole === "buyer" ? "Paying (sender)" : "Getting paid (receiver)"),
          el("dt", {}, "Amount"), el("dd", {}, `${credits(p.amount)} credits`),
          el("dt", {}, "Receiver gets"), el("dd", {}, `${credits(p.amount - fee)} credits after the 1% fee`),
          el("dt", {}, "Refund deadline"), el("dd", {}, `${p.deadlineHours} hours after funding`)),
        p.canJoin ? null : el("p", { class: "flash error" }, p.reason),
        el("div", { class: "wiz-nav" },
          el("button", { type: "button", class: "btn ghost", onclick: () => askCode(p.inviteCode) }, "Back"),
          p.canJoin ? el("button", {
            type: "button", class: "btn", onclick: async (e) => {
              e.target.disabled = true;
              try {
                const deal = await api("POST", "/deals/join", { inviteCode: p.inviteCode }, { headers: { "Idempotency-Key": newKey() } });
                location.hash = "#deal/" + encodeURIComponent(deal.id);
              } catch (err) {
                flash(err.message);
                e.target.disabled = false;
              }
            },
          }, "Join deal") : null));
    }
    askCode(arg);
  }

  // ---------- active and past deals ----------
  async function viewActive(view, _arg, gen) {
    const list = el("section", { class: "card" });
    put(view, list);
    let last = "";
    async function load() {
      const { deals } = await api("GET", "/deals");
      if (!alive(gen)) return;
      setCounts(deals);
      const active = deals.filter((d) => ACTIVE.has(d.state));
      const sig = JSON.stringify(active);
      if (sig === last) return;
      last = sig;
      list.textContent = "";
      if (!active.length) {
        put(list, emptyState("No active deals", "Start a deal, or join one with an invite code.", btnLink("#new", "New deal"), btnLink("#join", "Join a deal", "secondary")));
        return;
      }
      put(list, el("div", { class: "row between" }, el("h2", {}, `${active.length} active`), el("span", { class: "live" }, "Updates live")),
        el("ul", { class: "list" }, active.map(dealItem)));
    }
    await load();
    every(4000, load);
  }

  function dealEndedAt(d) {
    const h = d.history[d.history.length - 1];
    return h ? h.at : d.createdAt;
  }

  async function viewHistory(view, _arg, gen) {
    const { deals } = await api("GET", "/deals");
    if (!alive(gen)) return;
    const past = deals.filter((d) => !ACTIVE.has(d.state)).sort((a, b) => Date.parse(dealEndedAt(b)) - Date.parse(dealEndedAt(a)));
    const card = el("section", { class: "card" });
    put(view, card);
    if (!past.length) {
      put(card, emptyState("No finished deals yet", "Deals show up here once they're released, refunded or cancelled.", btnLink("#deals", "See active deals", "secondary")));
      return;
    }
    put(card, el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "Deal"), el("th", {}, "Amount"), el("th", {}, "Outcome"), el("th", {}, "Finished"), el("th", {}, "Took"))),
      el("tbody", {}, past.map((d) => el("tr", {},
        el("td", {}, el("a", { href: "#deal/" + encodeURIComponent(d.id) }, d.title), el("div", { class: "dim" }, `${TYPE_LABELS[d.type]} · ${d.yourRole === "buyer" ? "you paid" : "you were paid"}`)),
        el("td", { class: "num" }, `${credits(d.amount)} cr`),
        el("td", {}, el("span", { class: "badge " + d.state }, STATE_LABELS[d.state])),
        el("td", {}, when(dealEndedAt(d))),
        el("td", {}, duration(Date.parse(dealEndedAt(d)) - Date.parse(d.createdAt))))))));
  }

  // ---------- one deal: focused, live ----------
  async function viewDeal(view, id, gen) {
    if (!id) { location.hash = "#deals"; return; }
    let deal = await api("GET", "/deals/" + encodeURIComponent(id));
    await refreshMe();
    if (!alive(gen)) return;
    const root = el("div");
    put(view, el("a", { class: "back", href: ACTIVE.has(deal.state) ? "#deals" : "#history" }, icon("back"), ACTIVE.has(deal.state) ? "Active deals" : "Past deals"), root);
    let busy = false;

    const partyName = (p) => (p ? `${p.name} (${kindLabel(p.kind)})${p.id === app.me.accountId ? ", you" : ""}` : "Not joined yet");
    const nameOf = (accountId) => {
      for (const p of [deal.buyer, deal.seller]) if (p && p.id === accountId) return p.id === app.me.accountId ? "you" : p.name;
      return "someone";
    };
    const other = () => (deal.yourRole === "buyer" ? deal.seller : deal.buyer);

    async function act(action, okText) {
      busy = true;
      flash("");
      try {
        deal = await api("POST", `/deals/${encodeURIComponent(id)}/${action}`, undefined, { headers: { "Idempotency-Key": newKey() } });
        await refreshMe();
        toast(okText);
      } catch (err) {
        flash(err.message);
      } finally {
        busy = false;
      }
      draw();
    }

    function nextPanel() {
      const buyer = deal.yourRole === "buyer";
      const fee = Math.floor((deal.amount * deal.feeBps) / 10000);
      const p = el("section", { class: "next" });
      switch (deal.state) {
        case "open": {
          if (deal.inviteCode) {
            const link = `${location.origin}/dashboard#join/${deal.inviteCode}`;
            put(p, el("h3", {}, "Send this code to the other side"),
              el("p", {}, `It works once, and only for ${deal.joinKind === "agent" ? "an AI agent" : "a person"}. This page updates by itself when they join.`),
              el("div", { class: "codebox", id: "invite-code" }, deal.inviteCode),
              el("div", { class: "row" }, copyButton(deal.inviteCode, "Copy code"), copyButton(link, "Copy link"), el("span", { class: "live" }, "Waiting for them to join")));
          } else {
            put(p, el("h3", {}, "Waiting for the other side"), el("span", { class: "live" }, "Updates live"));
          }
          put(p, el("div", { class: "actions" }, confirmButton("Cancel deal", "danger small", "Click again to cancel", () => act("cancel", "Deal cancelled"))));
          break;
        }
        case "joined":
          if (buyer) {
            const enough = app.me.balance >= deal.amount;
            put(p, el("h3", {}, `${other().name} joined. Fund escrow to start.`),
              el("p", {}, `${credits(deal.amount)} credits move from your balance into escrow. Nobody can touch them until you release them, or they're refunded.`),
              enough ? null : el("p", { class: "flash error" }, `You have ${credits(app.me.balance)} credits, so you need ${credits(deal.amount - app.me.balance)} more.`),
              el("div", { class: "actions" },
                (() => { const b = el("button", { type: "button", class: "btn", onclick: () => act("fund", "Escrow funded") }, `Fund escrow (${credits(deal.amount)} credits)`); if (!enough) b.disabled = true; return b; })(),
                confirmButton("Cancel deal", "ghost", "Click again to cancel", () => act("cancel", "Deal cancelled"))));
          } else {
            put(p, el("h3", {}, "You're in. Waiting for the sender to fund escrow."),
              el("p", {}, "Don't start work until the credits are in escrow. This page updates by itself."),
              el("span", { class: "live" }, "Waiting for funding"),
              el("div", { class: "actions" }, confirmButton("Leave and cancel deal", "ghost", "Click again to cancel", () => act("cancel", "Deal cancelled"))));
          }
          break;
        case "funded": {
          const deadline = Date.parse(deal.deadlineAt);
          const passed = Date.now() >= deadline;
          if (buyer) {
            put(p, el("h3", {}, "Credits are in escrow"),
              el("p", {}, `Release them once you're happy with what ${other().name} delivered. They'll get ${credits(deal.amount - fee)} credits.`),
              el("div", { class: "actions" },
                confirmButton("Release funds", "", "Click again to release. This can't be undone", () => act("release", "Funds released")),
                passed ? el("button", { type: "button", class: "btn secondary", onclick: () => act("refund", "Refund claimed") }, "Claim refund (deadline passed)") : null),
              el("p", { class: "hint" }, passed ? "The refund deadline has passed, so you can also take the credits back." : `You can claim a refund after ${when(deal.deadlineAt)} if the deal isn't done.`));
          } else {
            put(p, el("h3", {}, "Credits are locked in escrow. Time to do the work."),
              el("p", {}, `When ${other().name} releases them you'll get ${credits(deal.amount - fee)} credits. If you can't finish, refund them instead.`),
              el("span", { class: "live" }, "Waiting for release"),
              el("div", { class: "actions" }, confirmButton("Refund the sender", "secondary", "Click again to refund", () => act("refund", "Refunded"))));
          }
          break;
        }
        case "released":
          put(p, el("h3", {}, "Done. The receiver has been paid."), el("p", {}, `${credits(deal.amount - fee)} credits went to the receiver and ${credits(fee)} to the fee.`));
          break;
        case "refunded":
          put(p, el("h3", {}, "Refunded"), el("p", {}, "The sender got all of their credits back."));
          break;
        default:
          put(p, el("h3", {}, "Cancelled"), el("p", {}, "This deal was cancelled before any credits moved."));
      }
      return p;
    }

    function progress() {
      const order = ["open", "joined", "funded", "released"];
      const labels = ["Created", "Other side joined", "In escrow", "Released"];
      const idx = order.indexOf(deal.state);
      const ended = deal.state === "refunded" || deal.state === "cancelled";
      return el("ol", { class: "progress" }, labels.map((l, i) => {
        let cls = "";
        if (ended) cls = i === 0 || (deal.state === "refunded" && i <= 2) ? "done" : "";
        else if (i < idx || deal.state === "released") cls = "done";
        else if (i === idx) cls = "now";
        return el("li", { class: cls }, i === 3 && deal.state === "refunded" ? "Refunded" : i === 3 && deal.state === "cancelled" ? "Cancelled" : l);
      }));
    }

    function draw() {
      root.textContent = "";
      const fee = Math.floor((deal.amount * deal.feeBps) / 10000);
      put(root, 
        el("div", { class: "deal-head" },
          el("h2", {}, deal.title),
          el("span", { class: "badge " + deal.state }, STATE_LABELS[deal.state])),
        el("p", { class: "muted" }, `${TYPE_LABELS[deal.type]} · ${credits(deal.amount)} credits · ${roleText(deal)}`),
        deal.description ? el("p", {}, deal.description) : null,
        progress(),
        nextPanel(),
        el("section", { class: "card" },
          el("h2", {}, "Details"),
          el("dl", { class: "facts" },
            el("dt", {}, "Sender (pays)"), el("dd", {}, partyName(deal.buyer)),
            el("dt", {}, "Receiver (gets paid)"), el("dd", {}, partyName(deal.seller)),
            el("dt", {}, "Amount"), el("dd", {}, `${credits(deal.amount)} credits`),
            el("dt", {}, "Fee"), el("dd", {}, `${credits(fee)} credits (1%, from the receiver's payout)`),
            el("dt", {}, "Refund deadline"), el("dd", {}, deal.deadlineAt ? when(deal.deadlineAt) : `${deal.deadlineHours} hours after funding`),
            el("dt", {}, "Deal ID"), el("dd", { class: "code" }, deal.id)),
          el("details", { class: "more" }, el("summary", {}, "History"),
            el("ul", { class: "timeline" }, deal.history.map((h) => el("li", {}, `${when(h.at)}: ${STATE_LABELS[h.state] || h.state} (by ${nameOf(h.by)})`))))),
        el("p", { class: "dim" }, "Problem with this deal? ", el("a", { href: "#support" }, "Open a support ticket"), "."));
    }
    draw();

    // Live updates: no refresh needed to see the other side's moves.
    every(3000, async () => {
      if (busy) return;
      const fresh = await api("GET", "/deals/" + encodeURIComponent(id));
      if (!alive(gen) || busy) return;
      if (JSON.stringify(fresh) === JSON.stringify(deal)) return;
      const before = deal.state;
      deal = fresh;
      await refreshMe();
      if (before !== deal.state) {
        const who = other() ? other().name : "The other side";
        const msg = { joined: `${who} joined the deal`, funded: "Escrow is funded", released: "Funds released", refunded: "Credits refunded", cancelled: "The deal was cancelled" }[deal.state];
        if (msg) toast(msg);
      }
      draw();
    });
  }

  // ---------- support ----------
  async function viewSupport(view, _arg, gen) {
    const [info, list, dealsRes] = await Promise.all([api("GET", "/support"), api("GET", "/tickets"), api("GET", "/deals")]);
    if (!alive(gen)) return;
    const discordCard = el("div", { class: "discord-card" },
      el("span", { class: "page-ico" }, icon("support")),
      el("div", {}, el("strong", {}, "Join our Discord"), el("span", {}, "Chat with the team and other users. Good for quick questions.")),
      el("a", { class: "btn small", href: info.discordInvite || DISCORD_INVITE, target: "_blank", rel: "noopener" }, "Open Discord", icon("out")));

    const cat = el("select", { id: "t-category", name: "category" }, TICKET_CATEGORIES.map(([v, l]) => el("option", { value: v }, l)));
    const dealSel = el("select", { id: "t-deal", name: "dealId" }, el("option", { value: "" }, "No specific deal"),
      dealsRes.deals.slice(0, 50).map((d) => el("option", { value: d.id }, `${d.title} (${STATE_LABELS[d.state]})`)));
    const form = el("form", {},
      el("h2", {}, "Open a ticket"),
      el("p", { class: "muted" }, info.liveReplies
        ? "Your ticket goes straight to our team. Replies show up here, and you can keep chatting on this page."
        : "Your ticket goes straight to our team. For the fastest reply, also message us on Discord."),
      el("label", { for: "t-category" }, "What's it about?"), cat,
      el("label", { for: "t-deal" }, "Related deal"), dealSel,
      el("label", { for: "t-subject" }, "Subject"), el("input", { id: "t-subject", name: "subject", required: true, minlength: "3", maxlength: "100", placeholder: "A short summary" }),
      el("label", { for: "t-message" }, "Message"), el("textarea", { id: "t-message", name: "message", required: true, minlength: "5", maxlength: "2000", placeholder: "What happened, and what did you expect?" }),
      el("button", { type: "submit", class: "btn" }, "Send ticket"));
    bindForm(form, async (f) => {
      const t = await api("POST", "/tickets", { category: val(f, "category"), dealId: val(f, "dealId") || null, subject: val(f, "subject"), message: val(f, "message") });
      location.hash = "#support/" + encodeURIComponent(t.id);
    });

    const ticketsCard = el("section", { class: "card" }, el("h2", {}, "Your tickets"));
    const drawTickets = (tickets) => {
      ticketsCard.textContent = "";
      put(ticketsCard, el("h2", {}, "Your tickets"));
      if (!tickets.length) { put(ticketsCard, el("p", { class: "muted" }, "No tickets yet.")); return; }
      put(ticketsCard, el("ul", { class: "list" }, tickets.map((t) => el("li", {}, el("a", { class: "item", href: "#support/" + encodeURIComponent(t.id) },
        el("div", { class: "grow" }, el("span", { class: "t" }, `#${t.number} ${t.subject}`),
          el("span", { class: "s" }, t.lastMessage ? `${t.lastMessage.from === "staff" ? "Support: " : t.lastMessage.from === "user" ? "You: " : ""}${t.lastMessage.text}` : "")),
        el("span", { class: "badge " + (t.status === "open" ? "open" : "closed") }, t.status === "open" ? "Open" : "Closed"))))));
    };
    drawTickets(list.tickets);
    put(view, discordCard, el("div", { class: "support-grid" }, el("section", { class: "card" }, form), ticketsCard));
    let last = JSON.stringify(list.tickets);
    every(6000, async () => {
      const r = await api("GET", "/tickets");
      if (!alive(gen)) return;
      const sig = JSON.stringify(r.tickets);
      if (sig !== last) { last = sig; drawTickets(r.tickets); }
    });
  }

  async function viewTicket(view, id, gen) {
    let [t, info] = await Promise.all([api("GET", "/tickets/" + encodeURIComponent(id)), api("GET", "/support")]);
    if (!alive(gen)) return;
    $("#page-title").textContent = `Ticket #${t.number}`;
    const head = el("div");
    const chat = el("div", { class: "chat", "aria-live": "polite", "data-lenis-prevent": "" });
    const foot = el("div");
    put(view, el("a", { class: "back", href: "#support" }, icon("back"), "Support"),
      el("section", { class: "card" }, head, chat, foot));

    function drawHead() {
      head.textContent = "";
      put(head, el("div", { class: "deal-head" }, el("h2", {}, t.subject), el("span", { class: "badge " + (t.status === "open" ? "open" : "closed") }, t.status === "open" ? "Open" : "Closed")),
        el("p", { class: "dim" }, `Opened ${when(t.createdAt)}${t.dealId ? " · about a deal" : ""}`));
    }
    function drawChat() {
      chat.textContent = "";
      for (const m of t.messages) {
        put(chat, el("div", { class: "bubble " + m.from }, m.text,
          m.from === "system" ? null : el("small", {}, `${m.from === "user" ? "You" : m.author || "Support"} · ${ago(m.at)}`)));
      }
      if (t.status === "open" && !t.messages.some((m) => m.from === "staff")) {
        put(chat, el("div", { class: "bubble system" }, info.liveReplies ? "Our team has your ticket. Replies appear here automatically." : "Our team has been notified. You can also reach us on Discord."));
      }
      chat.scrollTop = chat.scrollHeight;
    }
    function drawFoot() {
      foot.textContent = "";
      if (t.status !== "open") {
        put(foot, el("p", { class: "muted" }, "This ticket is closed. ", el("a", { href: "#support" }, "Open a new one"), " if you still need help."));
        return;
      }
      const text = el("textarea", { name: "text", required: true, maxlength: "2000", placeholder: "Write a message...", "aria-label": "Message" });
      const form = el("form", { class: "composer" }, text, el("button", { type: "submit", class: "btn" }, "Send"));
      text.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
      });
      bindForm(form, async () => {
        const msg = text.value.trim();
        if (!msg) return;
        t = await api("POST", `/tickets/${encodeURIComponent(id)}/messages`, { text: msg });
        text.value = "";
        drawChat();
      });
      put(foot, form, el("div", { class: "actions" },
        el("a", { class: "btn ghost small", href: info.discordInvite || DISCORD_INVITE, target: "_blank", rel: "noopener" }, "Discord", icon("out")),
        confirmButton("Close ticket", "ghost small", "Click again to close", async () => {
          t = await api("POST", `/tickets/${encodeURIComponent(id)}/close`);
          drawHead(); drawChat(); drawFoot();
        })));
    }
    drawHead(); drawChat(); drawFoot();

    every(3000, async () => {
      const fresh = await api("GET", "/tickets/" + encodeURIComponent(id));
      if (!alive(gen)) return;
      if (fresh.messages.length === t.messages.length && fresh.status === t.status) return;
      const statusChanged = fresh.status !== t.status;
      const staffBefore = t.messages.filter((m) => m.from === "staff").length;
      t = fresh;
      drawChat();
      if (statusChanged) { drawHead(); drawFoot(); }
      if (t.messages.filter((m) => m.from === "staff").length > staffBefore) toast("New reply from support");
    });
  }

  // ---------- FAQ ----------
  const FAQ = [
    ["What is Valence MM?", "An automated escrow middleman. It holds the payment for a deal until both sides have done their part, then releases it to the receiver or returns it to the sender."],
    ["How does a deal work?", "The creator picks who they're dealing with, the amount and a refund deadline, then sends a one-time invite code. The other side joins, the sender funds escrow, and the sender releases the credits when happy."],
    ["Can AI agents use it on their own?", "Yes. Agents register for an API key and can create, join, fund and release deals entirely through the JSON API. See the API docs."],
    ["Is this real money?", "Not yet. The prototype runs on play credits only, so you can test safely. Real crypto deposits come later, once the safety and legal side is in place."],
    ["What if the other side never delivers?", "The receiver can refund you at any time. If they don't, you can claim your credits back once the deal's refund deadline has passed."],
    ["How are disputes handled?", "For now the sender decides when to release, with the deadline as a backstop. If something goes wrong, open a support ticket and we'll look at it. Independent dispute resolution is on the roadmap."],
    ["What does it cost?", "A flat 1% fee, taken from the receiver's payout when funds are released. Refunds and cancellations are free."],
    ["Do I need to refresh to see updates?", "No. Deal pages and support tickets update by themselves every few seconds."],
  ];
  function viewFaq(view) {
    put(view, el("section", { class: "card" }, el("div", { class: "faq" }, FAQ.map(([q, a]) => el("details", {}, el("summary", {}, q), el("p", {}, a))))),
      el("p", { class: "muted" }, "Still stuck? ", el("a", { href: "#support" }, "Open a support ticket"), " or ", el("a", { href: DISCORD_INVITE, target: "_blank", rel: "noopener" }, "ask on Discord"), "."));
  }

  // ---------- settings ----------
  async function viewSettings(view, _arg, gen) {
    const health = await fetch("/health").then((r) => r.json()).catch(() => null);
    await refreshMe();
    if (!alive(gen)) return;
    const me = app.me;

    const choice = savedTheme() === "light" || savedTheme() === "dark" ? savedTheme() : "system";
    const seg = el("div", { class: "seg", role: "group", "aria-label": "Theme" });
    for (const [v, l] of [["dark", "Dark"], ["light", "Light"], ["system", "Device"]]) {
      put(seg, el("button", { type: "button", "aria-pressed": String(choice === v), onclick: (e) => {
        saveTheme(v);
        for (const b of seg.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
      } }, l));
    }

    put(view, 
      el("section", { class: "card" },
        el("h2", {}, "Profile"),
        el("div", { class: "set-row" }, el("span", {}, me.kind === "agent" ? "Agent name" : "Username"), el("strong", {}, me.name)),
        el("div", { class: "set-row" }, el("span", {}, "Account type"), el("strong", {}, me.kind === "agent" ? "AI agent" : "Person")),
        el("div", { class: "set-row" }, el("span", {}, "Account ID"), el("div", { class: "row" }, el("code", {}, me.accountId), copyButton(me.accountId, "Copy"))),
        el("div", { class: "set-row" }, el("span", {}, "Balance"), el("strong", { class: "num" }, `${credits(me.balance)} play credits`))),
      el("section", { class: "card" },
        el("h2", {}, "Appearance"),
        el("div", { class: "set-row" }, el("span", {}, "Theme"), seg)));

    if (me.kind === "human") {
      const form = el("form", {},
        el("h2", {}, "Change password"),
        el("p", { class: "muted" }, "Other browsers where you're logged in will be signed out."),
        el("label", { for: "pw-current" }, "Current password"), el("input", { id: "pw-current", name: "current", type: "password", autocomplete: "current-password", required: true }),
        el("label", { for: "pw-new" }, "New password"), el("input", { id: "pw-new", name: "next", type: "password", autocomplete: "new-password", minlength: "8", maxlength: "128", required: true }),
        el("p", { class: "hint" }, "At least 8 characters."),
        el("button", { type: "submit", class: "btn" }, "Change password"));
      bindForm(form, async (f) => {
        await api("POST", "/humans/password", { currentPassword: val(f, "current"), newPassword: val(f, "next") }, { noRedirect: true });
        f.reset();
        flash("Password changed.", "ok");
      });
      put(view, el("section", { class: "card" }, form));
    } else {
      put(view, el("section", { class: "card" }, el("h2", {}, "API key"),
        el("p", { class: "muted" }, "Your API key was shown once when this agent was created, and it's how the agent signs in. Keep it secret. If it's lost, register a new agent."),
        el("a", { href: "/docs" }, "API docs")));
    }

    if (health && health.testCredits) {
      const form = el("form", {},
        el("h2", {}, "Add test credits"),
        el("p", { class: "muted" }, "Have a test code? It adds play credits to your balance."),
        el("div", { class: "row" }, el("input", { name: "code", autocomplete: "off", placeholder: "Test code", required: true, "aria-label": "Test code" }), el("button", { type: "submit", class: "btn" }, "Add")));
      bindForm(form, async (f) => {
        const r = await api("POST", "/credits/redeem", { code: val(f, "code") });
        f.reset();
        setBalance(r.balance);
        flash(`Added ${r.added} test credits.`, "ok");
      });
      put(view, el("section", { class: "card" }, form));
    }

    put(view, el("section", { class: "card" }, el("h2", {}, "Sign out"),
      el("p", { class: "muted" }, "Sign out of this browser tab."),
      el("button", { type: "button", class: "btn secondary", onclick: logout }, "Log out")));
  }

  // ---------- start ----------
  setupTheme();
  const page = document.body.dataset.page;
  if (page === "dashboard") {
    dashboardPage();
  } else if (page === "deal") {
    const id = new URLSearchParams(location.search).get("id");
    location.replace("/dashboard" + (id ? "#deal/" + encodeURIComponent(id) : "#deals"));
  } else {
    renderNav();
    setupScroll();
    if (page === "home") heroMotion();
    else if (page === "login") loginPage();
    else if (page === "signup") signupPage();
  }
})();
