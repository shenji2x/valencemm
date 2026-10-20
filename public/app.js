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
    awaiting_setup: "Waiting on payout setup",
    funding: "Payment in progress",
    funded: "Funds held",
    delivered: "Delivered, awaiting release",
    disputed: "In dispute",
    released: "Paid out",
    refunded: "Refunded",
    cancelled: "Cancelled",
  };
  const ACTIVE = new Set(["open", "joined", "awaiting_setup", "funding", "funded", "delivered", "disputed"]);
  const TICKET_CATEGORIES = [["deal", "A problem with a deal"], ["payments", "Payments and payouts"], ["account", "My account"], ["bug", "Something is broken"], ["other", "Something else"]];

  // Mirrors src/money.js. These are for previews and for enabling buttons; the server prices
  // every real charge and never trusts an amount the browser sends.
  const MIN_AMOUNT = 500;
  const MAX_AMOUNT = 2000000;
  const PLATFORM_BPS = 100;    // 1%
  const PLATFORM_MIN = 50;
  // Card rates by currency (domestic / international / fixed), mirrors src/money.js CURRENCIES.
  const CURRENCY_META = {
    usd: { symbol: "$",   label: "USD – US Dollar",          bps: 290, bpsIntl: 390, fixed: 30 },
    aud: { symbol: "A$",  label: "AUD – Australian Dollar",  bps: 170, bpsIntl: 370, fixed: 30 },
    nzd: { symbol: "NZ$", label: "NZD – New Zealand Dollar", bps: 270, bpsIntl: 370, fixed: 30 },
    gbp: { symbol: "£",   label: "GBP – British Pound",      bps: 150, bpsIntl: 250, fixed: 20 },
    eur: { symbol: "€",   label: "EUR – Euro",               bps: 150, bpsIntl: 250, fixed: 25 },
    cad: { symbol: "CA$", label: "CAD – Canadian Dollar",    bps: 290, bpsIntl: 390, fixed: 30 },
  };
  // Active currency for the current wizard session (default USD, persisted across page reloads).
  let activeCurrency = (() => { try { return localStorage.getItem("vl_currency") || "usd"; } catch(_) { return "usd"; } })();

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
    overview: "M3 20h18M4 16l5-5 4 3 4.2-4.8M17.6 7.2a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0",
    stats: "M3 20h18M6 20v-5M11 20V9M16 20v-6M17.2 5.6a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0",
    new: "M20.83 10.28A9 9 0 1 1 13.72 3.17M16.66 5.636038969321072a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0 -3.4 0M12 8v8M8 12h8",
    join: "M3 12h8M8 8.5l3.5 3.5L8 15.5M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4",
    deals: "M7.5 11V8a4.5 4.5 0 0 1 9 0v3M5 11h14v10H5zM10.4 16a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0",
    history: "M3.5 12a8.5 8.5 0 1 0 2.8-6.3L3.5 8.3M3.5 3.5v4.8h4.8M12 8v4l2.8 2",
    support: "M20.5 12a8.5 8.5 0 0 1-12.4 7.5L3.5 21l1.4-4.6A8.5 8.5 0 1 1 20.5 12zM10.6 12a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0 -2.8 0",
    faq: "M20.83 10.28A9 9 0 1 1 13.72 3.17M16.66 5.636038969321072a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0 -3.4 0M9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4M12 17.3h.01",
    settings: "M3 7h8.5M17.5 7H21M3 17h3.5M12.5 17H21M11.9 7a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0 -5.2 0M6.9 17a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0 -5.2 0",
    wallet: "M3 6h18v13H3zM3 10.5h18M6.5 15h4M15.7 15a1.3 1.3 0 1 0 2.6 0a1.3 1.3 0 1 0 -2.6 0",
    check: "M5 12l5 5 9-10",
    clock: "M20.83 10.28A9 9 0 1 1 13.72 3.17M16.66 5.636038969321072a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0 -3.4 0M12 7.5V12l3 2",
    bitcoin: "M9 4v16M13 4v2M13 18v2M7 6h7.5a3 3 0 0 1 0 6H7M7 12h8.5a3 3 0 0 1 0 6H7",
    bolt: "M13 2L4 14h7l-1 8 9-12h-7z",
    coins: "M8 8a5 3 0 1 0 0-.01M3 8v4c0 1.7 2.2 3 5 3s5-1.3 5-3V8M11 14c0 1.7 2.2 3 5 3s5-1.3 5-3v-4c0-1.7-2.2-3-5-3",
    arrowUp: "M12 19V5M5 12l7-7 7 7",
    arrowDown: "M12 5v14M5 12l7 7 7-7",
    percent: "M19 5L5 19M7 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM17 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
    out: "M7 17L17 7M8 7h9v9",
    back: "M15 18l-6-6 6-6",
    copy: "M9 9h11v11H9zM5 15H4V4h11v1",
    image: "M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15.5 8.5h.01",
    doc: "M14 3H6v18h12V7zM14 3v4h4M9 13h6M9 17h6",
    discord: "M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.8A8 8 0 1 1 21 12zM8.5 11h.01M12 11h.01M15.5 11h.01",
    phone: "M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18h2",
    mail: "M3 5h18v14H3zM3 6l9 7 9-7",
    key: "M3.5 15a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0 -9 0M6.8 15a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0 -2.4 0M11.2 11.8L20 3M16.5 6.5l3 3M14 9l2 2",
    shield: "M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6zM8.6 9.4L12 15.6l3.4-6.2",
  };
  function icon(name, cls = "ico") {
    return svg("svg", { class: cls, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" },
      svg("path", { d: ICONS[name] }));
  }

  // ---------- formatting ----------
  // Every amount from the server is an integer number of cents. Format for display only: never
  // do arithmetic on a formatted string, and never send one back.
  function fmt(cents, code) {
    const c = CURRENCY_META[code] || CURRENCY_META[activeCurrency] || CURRENCY_META.usd;
    if (cents === null || cents === undefined) return "\u2014";
    const sign = cents < 0 ? "-" : "";
    const abs = Math.abs(Math.round(cents));
    return `${sign}${c.symbol}${Math.floor(abs / 100).toLocaleString()}.${String(abs % 100).padStart(2, "0")}`;
  }

  // "12.34" -> 1234 cents, or null if it isn't an amount we accept.
  function parseMoney(input) {
    const text = String(input == null ? "" : input).trim().replace(/[,\s]|^[A-Z]*\$/g, "");
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) return null;
    const [whole, part = ""] = text.split(".");
    const cents = Number(whole) * 100 + Number(part.padEnd(2, "0"));
    return cents >= MIN_AMOUNT && cents <= MAX_AMOUNT ? cents : null;
  }

  // A preview of the server's quote, so the wizard can show numbers before a deal exists.
  function quoteFor(amount, code) {
    const c = CURRENCY_META[code] || CURRENCY_META[activeCurrency] || CURRENCY_META.usd;
    const platformFee = Math.max(PLATFORM_MIN, Math.round((amount * PLATFORM_BPS) / 10000));
    const buyerTotal = amount + platformFee;
    const processorFee = Math.round((buyerTotal * c.bps) / 10000) + c.fixed;
    const worst = Math.round((buyerTotal * c.bpsIntl) / 10000) + c.fixed;
    return {
      currency: code || activeCurrency, amount, platformFee, platformBps: PLATFORM_BPS, buyerTotal,
      processorFee, sellerNet: amount - processorFee,
      processorFeeWorst: worst, sellerNetWorst: amount - worst,
    };
  }
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
  // A normal sign-in lives in this tab only. "Remember me" keeps it in localStorage for 7 days,
  // the same lifetime the server gives every session.
  const REMEMBER_UNTIL_KEY = "valence_token_until";
  const REMEMBER_MS = 7 * 24 * 3600 * 1000;
  const getToken = () => {
    try {
      const t = sessionStorage.getItem(TOKEN_KEY);
      if (t) return t;
      const until = Number(localStorage.getItem(REMEMBER_UNTIL_KEY));
      if (until > Date.now()) return localStorage.getItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(REMEMBER_UNTIL_KEY);
    } catch { /* storage blocked */ }
    return null;
  };
  const setToken = (t, remember = false) => {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(REMEMBER_UNTIL_KEY);
      if (!t) {
        localStorage.removeItem(PALETTE_KEY);
        document.documentElement.removeAttribute("data-palette");
      } else if (remember) {
        localStorage.setItem(TOKEN_KEY, t);
        localStorage.setItem(REMEMBER_UNTIL_KEY, String(Date.now() + REMEMBER_MS));
      } else {
        sessionStorage.setItem(TOKEN_KEY, t);
      }
    } catch { /* storage blocked */ }
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


  // ---------- images and files that need the account's token ----------
  // The API uses a bearer token, so a plain <img src> wouldn't be allowed to load an
  // attachment. Each one is fetched with the token and shown from an in-memory blob.
  async function authBlob(path) {
    const token = getToken();
    const res = await fetch("/v1" + path, { headers: token ? { Authorization: "Bearer " + token } : {} });
    if (!res.ok) throw new Error("Couldn't load that file.");
    return res.blob();
  }
  function showImage(img, path) {
    authBlob(path).then((blob) => {
      const url = URL.createObjectURL(blob);
      img.src = url;
      img.addEventListener("load", () => setTimeout(() => URL.revokeObjectURL(url), 30000), { once: true });
    }).catch(() => { img.replaceWith(el("span", { class: "dim" }, "Image unavailable")); });
  }
  async function downloadAuth(path, filename) {
    const blob = await authBlob(path);
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function uploadImage(file) {
    const token = getToken();
    const res = await fetch("/v1/uploads", {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name || "image"), ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: file,
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) throw new Error((data.error && data.error.message) || "That image couldn't be uploaded.");
    return data;
  }

  // "Add images" button plus the chips for what's attached so far.
  function attachBar(limits, onError) {
    const max = (limits && limits.maxFiles) || 4;
    const maxBytes = (limits && limits.maxBytes) || 8 * 1024 * 1024;
    const chosen = [];
    const chips = el("div", { class: "chips files" });
    const input = el("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp", multiple: true, class: "sr-only", id: "att-" + newKey().slice(0, 8) });
    const button = el("button", { type: "button", class: "btn small secondary", onclick: () => input.click() }, icon("image"), "Add images");
    const hint = el("span", { class: "dim" }, `Up to ${max} images, ${Math.round(maxBytes / 1024 / 1024)} MB each`);

    function redraw() {
      chips.textContent = "";
      for (const f of chosen) {
        const chip = el("span", { class: "file-chip" }, el("span", {}, f.name),
          el("button", { type: "button", "aria-label": `Remove ${f.name}`, onclick: () => { chosen.splice(chosen.indexOf(f), 1); redraw(); } }, "\u00d7"));
        chips.append(chip);
      }
      button.disabled = chosen.length >= max;
    }
    async function take(files) {
      for (const file of files) {
        if (chosen.length >= max) return onError(`You can attach up to ${max} images.`);
        if (file.size > maxBytes) { onError(`${file.name} is too big (limit ${Math.round(maxBytes / 1024 / 1024)} MB).`); continue; }
        const placeholder = { name: file.name, pending: true };
        chosen.push(placeholder);
        redraw();
        try {
          const rec = await uploadImage(file);
          Object.assign(placeholder, rec, { pending: false });
        } catch (err) {
          chosen.splice(chosen.indexOf(placeholder), 1);
          onError(err.message);
        }
        redraw();
      }
    }
    input.addEventListener("change", () => { take([...input.files]); input.value = ""; });
    return {
      node: el("div", { class: "attach-bar" }, input, button, hint, chips),
      ids: () => chosen.filter((f) => f.id).map((f) => f.id),
      busy: () => chosen.some((f) => f.pending),
      clear: () => { chosen.length = 0; redraw(); },
      takeFiles: take,
    };
  }

  // Thumbnails under a message.
  function attachmentsNode(ticketId, attachments) {
    if (!attachments || !attachments.length) return null;
    const box = el("div", { class: "shots" });
    for (const a of attachments) {
      const img = el("img", { alt: a.name, loading: "lazy" });
      showImage(img, `/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(a.id)}`);
      const open = el("button", { type: "button", class: "shot", title: a.name, onclick: () => lightbox(img.src, a.name) }, img);
      box.append(open);
    }
    return box;
  }

  function lightbox(src, name) {
    if (!src) return;
    const close = () => { box.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    const box = el("div", { class: "lightbox", role: "dialog", "aria-label": name, onclick: close },
      el("img", { src, alt: name }));
    document.addEventListener("keydown", onKey);
    document.body.append(box);
  }

  // ---------- theme ----------
  const THEME_KEY = "valence_theme";
  // A signed-in customer's colour theme. theme.js applies the cached copy before paint, and only
  // while someone is signed in; the account holds the real choice so it follows them across devices.
  const PALETTE_KEY = "valence_palette";
  const PALETTES = [
    ["blue", "Ocean blue", "The default"],
    ["teal", "Lagoon", "Teal and cyan"],
    ["violet", "Amethyst", "Violet and indigo"],
    ["emerald", "Emerald", "Fresh greens"],
    ["sunset", "Sunset", "Amber and rose"],
    ["graphite", "Graphite", "Quiet greys"],
  ];
  function applyPalette(palette) {
    const p = PALETTES.some(([k]) => k === palette) && palette !== "blue" ? palette : null;
    if (p) document.documentElement.setAttribute("data-palette", p);
    else document.documentElement.removeAttribute("data-palette");
    try { if (p) localStorage.setItem(PALETTE_KEY, p); else localStorage.removeItem(PALETTE_KEY); } catch { /* storage blocked */ }
  }
  const THEME_COLORS = { dark: "#060a16", light: "#f5f8ff" };
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

  // The preview chart draws itself on load, and the steps rule fills as you scroll.
  function heroMotion() {
    const gsap = window.gsap;
    if (!gsap || reducedMotion()) return;
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
    // cards rise into place as each section scrolls in
    if (window.ScrollTrigger) {
      for (const group of document.querySelectorAll(".types, .features, .coins")) {
        gsap.from(group.children, { y: 24, opacity: 0, duration: 0.7, ease: "power3.out", stagger: 0.06, clearProps: "transform,opacity", scrollTrigger: { trigger: group, start: "top 85%", once: true } });
      }
    }
  }

  // ---------- interface motion: tilt cards, dropdowns, details ----------
  const TILT_CARDS = ".type, .features article, .coin, .tile, .hero-stats > div, .crypto-coins li";

  // Square-ish cards lean toward the pointer. Mouse and pen only, and never with reduced motion.
  function setupTilt() {
    if (reducedMotion() || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    let frame = 0;
    const arm = (card) => {
      card.dataset.tilt = "1";
      card.classList.add("tilt");
      card.append(el("span", { class: "tilt-glare", "aria-hidden": "true" }));
      card.addEventListener("pointermove", (e) => {
        const r = card.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width;
        const y = (e.clientY - r.top) / r.height;
        const max = Math.min(9, 2600 / Math.max(r.width, 1));
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          const st = card.style;
          st.setProperty("--rx", ((0.5 - y) * max).toFixed(2) + "deg");
          st.setProperty("--ry", ((x - 0.5) * max).toFixed(2) + "deg");
          st.setProperty("--px", ((x - 0.5) * 2).toFixed(3));
          st.setProperty("--py", ((y - 0.5) * 2).toFixed(3));
          st.setProperty("--mx", (x * 100).toFixed(1) + "%");
          st.setProperty("--my", (y * 100).toFixed(1) + "%");
          card.classList.add("tilting");
        });
      });
      card.addEventListener("pointerleave", () => {
        cancelAnimationFrame(frame);
        card.classList.remove("tilting");
        for (const k of ["--rx", "--ry", "--px", "--py"]) card.style.removeProperty(k);
      });
    };
    document.addEventListener("pointerover", (e) => {
      const card = e.target.closest && e.target.closest(TILT_CARDS);
      if (card && !card.dataset.tilt) arm(card);
    });
  }

  // <details> open and close with a height animation; the header menu drops in and fades out.
  function setupDetails() {
    document.addEventListener("click", (e) => {
      const summary = e.target.closest && e.target.closest("summary");
      const d = summary && summary.parentElement;
      if (!d || d.tagName !== "DETAILS" || reducedMotion()) return;
      e.preventDefault();
      if (d.classList.contains("menu")) return toggleMenu(d, !d.open);
      const opening = !d.open || d._closing;
      if (d._anim) d._anim.cancel();
      d._closing = false;
      const closed = summary.offsetHeight + "px";
      d.style.overflow = "hidden";
      if (opening) {
        d.open = true;
        d._anim = d.animate({ height: [closed, d.offsetHeight + "px"] }, { duration: 320, easing: "cubic-bezier(.2,.7,.2,1)" });
        for (const kid of d.children) if (kid !== summary) kid.animate({ opacity: [0, 1], transform: ["translateY(-4px)", "none"] }, { duration: 320, delay: 60, easing: "ease-out", fill: "backwards" });
      } else {
        d._closing = true;
        d._anim = d.animate({ height: [d.offsetHeight + "px", closed] }, { duration: 240, easing: "cubic-bezier(.4,0,.2,1)" });
      }
      d._anim.addEventListener("finish", () => {
        if (d._closing) { d.open = false; d._closing = false; }
        d.style.overflow = ""; d._anim = null;
      });
    });
    document.addEventListener("click", (e) => {
      for (const m of document.querySelectorAll("details.menu[open]")) if (!m.contains(e.target)) toggleMenu(m, false);
    });
  }
  function toggleMenu(d, open) {
    clearTimeout(d._t);
    if (open) { d.classList.remove("closing"); d.open = true; return; }
    if (reducedMotion()) { d.open = false; return; }
    d.classList.add("closing");
    d._t = setTimeout(() => { d.open = false; d.classList.remove("closing"); }, 200);
  }

  // Every <select> gets a styled button and an animated list. The real select stays in the form,
  // keeps its id for the label, and still fires "change", so form code doesn't know the difference.
  const CHEVRON = "M6 9l6 6 6-6";
  let ddSeq = 0;
  function enhanceSelect(sel) {
    if (sel.dataset.dd || sel.multiple || sel.size > 1) return;
    sel.dataset.dd = "1";
    const n = ++ddSeq;
    const label = sel.id ? document.querySelector(`label[for="${CSS.escape(sel.id)}"]`) : null;
    if (label && !label.id) label.id = `dd-label-${n}`;
    const text = el("span");
    const chev = svg("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, svg("path", { d: CHEVRON }));
    const btn = el("button", { type: "button", class: "dd-btn", id: `dd-btn-${n}`, "aria-haspopup": "listbox", "aria-expanded": "false", "aria-controls": `dd-list-${n}`,
      "aria-labelledby": label ? `${label.id} dd-btn-${n}` : null }, text, chev);
    const list = el("ul", { class: "dd-list", id: `dd-list-${n}`, role: "listbox", tabindex: "-1", "aria-labelledby": label ? label.id : null });
    const box = el("div", { class: "dd" }, btn, list);
    sel.classList.add("dd-native");
    sel.tabIndex = -1;
    sel.setAttribute("aria-hidden", "true");
    sel.after(box);
    let hot = -1;

    const sync = () => {
      const o = sel.options[sel.selectedIndex];
      text.textContent = o ? o.textContent : "";
    };
    const build = () => {
      list.textContent = "";
      [...sel.options].forEach((o, i) => {
        const li = el("li", { role: "option", id: `dd-${n}-${i}`, "aria-selected": String(i === sel.selectedIndex),
          onpointermove: () => setHot(i), onclick: () => choose(i) }, o.textContent);
        li.style.setProperty("--i", String(Math.min(i, 12)));
        put(list, li);
      });
    };
    const setHot = (i) => {
      const items = list.children;
      if (!items.length) return;
      hot = Math.max(0, Math.min(items.length - 1, i));
      for (const li of items) li.classList.remove("hot");
      items[hot].classList.add("hot");
      btn.setAttribute("aria-activedescendant", items[hot].id);
      const li = items[hot];
      if (li.offsetTop < list.scrollTop) list.scrollTop = li.offsetTop - 6;
      else if (li.offsetTop + li.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = li.offsetTop + li.offsetHeight - list.clientHeight + 6;
    };
    const open = () => {
      if (box.classList.contains("open")) return;
      build();
      const r = btn.getBoundingClientRect();
      box.classList.toggle("up", window.innerHeight - r.bottom < 300 && r.top > window.innerHeight - r.bottom);
      box.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
      setHot(Math.max(0, sel.selectedIndex));
      document.addEventListener("pointerdown", outside, true);
    };
    const close = (refocus) => {
      box.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
      btn.removeAttribute("aria-activedescendant");
      document.removeEventListener("pointerdown", outside, true);
      if (refocus) btn.focus();
    };
    const outside = (e) => { if (!box.contains(e.target)) close(false); };
    const choose = (i) => {
      if (i !== sel.selectedIndex) {
        sel.selectedIndex = i;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        sel.dispatchEvent(new Event("input", { bubbles: true }));
      }
      sync();
      close(true);
    };
    let typed = "", typedAt = 0;
    btn.addEventListener("click", () => (box.classList.contains("open") ? close(false) : open()));
    btn.addEventListener("keydown", (e) => {
      const isOpen = box.classList.contains("open");
      const last = sel.options.length - 1;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!isOpen) return open();
        setHot(hot + (e.key === "ArrowDown" ? 1 : -1));
      } else if (e.key === "Home" && isOpen) { e.preventDefault(); setHot(0); }
      else if (e.key === "End" && isOpen) { e.preventDefault(); setHot(last); }
      else if ((e.key === "Enter" || e.key === " ") && isOpen) { e.preventDefault(); choose(hot); }
      else if (e.key === "Escape" && isOpen) { e.preventDefault(); close(true); }
      else if (e.key === "Tab" && isOpen) close(false);
      else if (e.key.length === 1 && /\S/.test(e.key)) {
        const now = Date.now();
        typed = (now - typedAt > 700 ? "" : typed) + e.key.toLowerCase();
        typedAt = now;
        const i = [...sel.options].findIndex((o) => o.textContent.trim().toLowerCase().startsWith(typed));
        if (i >= 0) { if (isOpen) setHot(i); else { sel.selectedIndex = i; sel.dispatchEvent(new Event("change", { bubbles: true })); sync(); } }
      }
    });
    // A click on the field's <label> focuses the hidden select; send it to the button instead.
    sel.addEventListener("focus", () => btn.focus());
    sel.addEventListener("change", sync);
    sync();
  }
  function setupDropdowns() {
    for (const s of document.querySelectorAll("select")) enhanceSelect(s);
    new MutationObserver((records) => {
      for (const r of records) for (const node of r.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === "SELECT") enhanceSelect(node);
        else for (const s of node.querySelectorAll("select")) enhanceSelect(s);
      }
    }).observe(document.body, { childList: true, subtree: true });
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

  // ---- pow:start ----
  // "Checking you're not a bot": the server sometimes asks for a small puzzle (always on sign-up, and on
  // login after several wrong passwords). Find n where SHA-256(challenge + ":" + n) starts with
  // `difficulty` zero bits. WebCrypto's digest is async and far too slow for ~250k tries, so this is a
  // plain SHA-256 that reuses the work for the fixed part of the message and yields to the page every
  // ~30ms so nothing freezes. Must match src/pow.js exactly (test/pow-client.test.js checks).
  const SHA_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const SHA_IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const SHA_W = new Uint32Array(64);
  function shaBlock(H, buf, off) {
    const W = SHA_W;
    for (let i = 0; i < 16; i++) { const j = off + i * 4; W[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3]; }
    for (let i = 16; i < 64; i++) {
      const x = W[i - 15], y = W[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + SHA_K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  function shaZeroBits(H) {
    let bits = 0;
    for (let i = 0; i < 8; i++) { if (H[i] === 0) { bits += 32; continue; } return bits + Math.clz32(H[i]); }
    return bits;
  }
  // Resolves with the solution string. `onTick` (optional) is called with the number of tries so far.
  function solvePuzzle(challenge, difficulty, onTick) {
    const prefix = new TextEncoder().encode(challenge + ":");
    const whole = prefix.length - (prefix.length % 64);
    const mid = new Uint32Array(SHA_IV);
    for (let off = 0; off < whole; off += 64) shaBlock(mid, prefix, off);
    const rest = prefix.subarray(whole);
    const buf = new Uint8Array(128);
    const H = new Uint32Array(8);
    let n = 0;
    return new Promise((resolve) => {
      function run() {
        const until = Date.now() + 30;
        while (Date.now() < until) {
          for (let k = 0; k < 2048; k++, n++) {
            const digits = String(n);
            const len = rest.length + digits.length;
            buf.fill(0);
            buf.set(rest, 0);
            for (let i = 0; i < digits.length; i++) buf[rest.length + i] = digits.charCodeAt(i);
            buf[len] = 0x80;
            const end = len + 9 <= 64 ? 64 : 128;
            const bits = (prefix.length + digits.length) * 8;
            buf[end - 4] = bits >>> 24; buf[end - 3] = (bits >>> 16) & 255; buf[end - 2] = (bits >>> 8) & 255; buf[end - 1] = bits & 255;
            H.set(mid);
            shaBlock(H, buf, 0);
            if (end === 128) shaBlock(H, buf, 64);
            if (shaZeroBits(H) >= difficulty) return resolve(digits);
          }
        }
        if (onTick) onTick(n);
        setTimeout(run, 0);
      }
      run();
    });
  }
  // ---- pow:end ----

  const PUZZLE_CODES = new Set(["challenge_required", "challenge_too_easy", "challenge_expired", "challenge_used"]);
  // Sends a POST; if the server wants a proof-of-work first, solves one and sends it again.
  async function postWithPuzzle(path, body, scope) {
    try {
      return await api("POST", path, body, { noRedirect: true });
    } catch (err) {
      if (!PUZZLE_CODES.has(err.code)) throw err;
    }
    const c = await api("GET", "/challenge?scope=" + scope, undefined, { noRedirect: true });
    flash("Checking you're not a bot. This takes a second.", "info");
    const solution = await solvePuzzle(c.challenge, c.difficulty);
    flash("");
    return api("POST", path, { ...body, challenge: c.challenge, solution }, { noRedirect: true });
  }

  // ---------- login and signup ----------
  function authDone() {
    const next = safeNext(new URLSearchParams(location.search).get("next")) || "/dashboard";
    for (const a of document.querySelectorAll("a[data-keep-next]")) {
      if (next !== "/dashboard") a.href = a.getAttribute("href") + "?next=" + encodeURIComponent(next);
    }
    return (token) => {
      const box = $("#remember");
      setToken(token, !!(box && box.checked));
      location.href = next;
    };
  }
  function signupPage() {
    const done = authDone();
    bindForm("#signup-form", async (f) => {
      const website = f.elements.website ? f.elements.website.value : "";
      const r = await postWithPuzzle("/humans/signup", { username: val(f, "username"), password: val(f, "password"), website }, "signup");
      done(r.token);
    });
    bindForm("#agent-create-form", async (f) => {
      const r = await postWithPuzzle("/agents/register", { name: val(f, "agentname") }, "agent");
      $("#agent-key").textContent = r.apiKey;
      if ($("#agent-handle")) $("#agent-handle").textContent = r.handle || "";
      $("#agent-created").hidden = false;
      $("#agent-continue").onclick = () => done(r.apiKey);
    });
  }

  // Second step of signing in when two-factor is on.
  const METHOD_LABELS = { app: "Authenticator", email: "Email code", recovery: "Recovery code" };
  function twoFactorStep(r, done) {
    const box = $(".auth");
    let method = r.methods[0];
    function draw() {
      box.textContent = "";
      const seg = el("div", { class: "seg", role: "group", "aria-label": "How do you want to verify?" });
      for (const m of r.methods) {
        put(seg, el("button", { type: "button", "aria-pressed": String(m === method), onclick: () => { method = m; draw(); } }, METHOD_LABELS[m]));
      }
      const input = el("input", {
        id: "tfa-code", name: "code", required: true, autocomplete: "one-time-code", spellcheck: "false", class: "code-input",
        inputmode: method === "recovery" ? "text" : "numeric", maxlength: method === "recovery" ? "12" : "6",
        placeholder: method === "recovery" ? "xxxx-xxxx" : "123456",
      });
      const intro = {
        app: "Open your authenticator app (like Google Authenticator) and enter the 6-digit code for Valence MM.",
        email: `We'll email a 6-digit code to ${r.emailHint}.`,
        recovery: "Enter one of the recovery codes you saved when you turned on two-step verification. Each code works once.",
      }[method];
      const form = el("form", {},
        el("label", { for: "tfa-code" }, method === "recovery" ? "Recovery code" : "6-digit code"), input,
        el("button", { type: "submit", class: "btn" }, "Verify and log in"));
      bindForm(form, async () => {
        const res = await api("POST", "/humans/login/verify", { challenge: r.challenge, method, code: input.value }, { noRedirect: true });
        if (method === "recovery" && res.recoveryCodesLeft <= 3) {
          try { sessionStorage.setItem("valence_notice", `You have ${res.recoveryCodesLeft} recovery codes left. Make new ones in Settings.`); } catch { /* ignore */ }
        }
        done(res.token);
      });
      let sendBtn = null;
      if (method === "email") {
        sendBtn = el("button", { type: "button", class: "btn secondary", onclick: async () => {
          sendBtn.disabled = true;
          flash("");
          try {
            const res = await api("POST", "/humans/login/email-code", { challenge: r.challenge }, { noRedirect: true });
            flash(`Code sent to ${res.emailHint}. It expires in 10 minutes.`, "ok");
            sendBtn.textContent = "Send a new code";
            input.focus();
          } catch (err) {
            flash(err.message);
          } finally {
            setTimeout(() => { sendBtn.disabled = false; }, 30000);
          }
        } }, "Email me a code");
      }
      put(box,
        el("h1", {}, "Two-step verification"),
        el("p", { class: "sub" }, "Your password was right. One more step to keep your account safe."),
        el("p", { id: "msg", class: "flash", role: "status", "aria-live": "polite", hidden: true }),
        r.methods.length > 1 ? seg : null,
        el("p", { class: "muted tfa-intro" }, intro),
        sendBtn,
        form,
        el("p", { class: "switch" }, el("a", { href: location.pathname + location.search }, "Start over")));
      if (method !== "email") setTimeout(() => input.focus(), 0);
    }
    draw();
  }

  function loginPage() {
    const done = authDone();
    bindForm("#login-form", async (f) => {
      const r = await postWithPuzzle("/humans/login", { username: val(f, "username"), password: val(f, "password") }, "login");
      if (r.twoFactorRequired) return twoFactorStep(r, done);
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
    payments: { title: "Payments", icon: "wallet", render: viewPayments },
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

  async function refreshMe() {
    app.me = await api("GET", "/me");
    applyPalette(app.me.palette);
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

  // The sidebar's highlight slides to the active page rather than jumping.
  function moveNavInd(instant) {
    const nav = $(".side nav");
    if (!nav) return;
    let ind = nav.querySelector(".nav-ind");
    if (!ind) ind = put(nav, el("span", { class: "nav-ind", "aria-hidden": "true" })).lastChild;
    const a = nav.querySelector("a.active");
    if (!a) { ind.classList.remove("on"); return; }
    ind.classList.toggle("still", !!instant || !ind.classList.contains("on"));
    ind.style.transform = `translateY(${a.offsetTop}px)`;
    ind.style.height = a.offsetHeight + "px";
    ind.classList.add("on");
    if (ind.classList.contains("still")) { void ind.offsetWidth; ind.classList.remove("still"); }
  }

  // Page changes: the old page fades out quickly, and the new page's sections rise in one after another,
  // including the ones that arrive later once their data loads.
  function setupViewMotion(view) {
    if (reducedMotion() || !view.animate) return;
    new MutationObserver((records) => {
      if (performance.now() > app.enterUntil) return;
      for (const r of records) for (const node of r.addedNodes) {
        if (node.nodeType !== 1 || node.hidden || node.id === "msg") continue;
        const i = app.enterCount++;
        node.animate({ opacity: [0, 1], transform: ["translateY(10px)", "none"], filter: ["blur(3px)", "blur(0)"] },
          { duration: 420, delay: Math.min(i * 55, 330), easing: "cubic-bezier(.2,.7,.2,1)", fill: "backwards" });
      }
    }).observe(view, { childList: true });
  }

  async function route() {
    const gen = ++app.gen;
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
    moveNavInd(!app.routed);
    const view = $("#view");
    if (app.routed && !reducedMotion() && view.animate && view.childElementCount) {
      const out = view.animate({ opacity: [1, 0], transform: ["none", "translateY(-4px)"] }, { duration: 130, easing: "ease-in", fill: "forwards" });
      await out.finished.catch(() => {});
      out.cancel();
      if (!alive(gen)) return;
    }
    app.routed = true;
    app.enterUntil = performance.now() + 1600;
    app.enterCount = 0;
    $("#app").classList.remove("nav-open");
    $("#burger").setAttribute("aria-expanded", "false");
    $("#page-title").textContent = v.title;
    const ico = $("#page-ico");
    ico.textContent = "";
    put(ico, icon(v.icon));
    document.title = `${v.title} | Valence MM`;
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
    $("#top-logout").addEventListener("click", logout);
    try {
      const n = sessionStorage.getItem("valence_notice");
      if (n) { sessionStorage.removeItem("valence_notice"); setTimeout(() => toast(n), 600); }
    } catch { /* ignore */ }
    $("#burger").addEventListener("click", () => {
      const open = $("#app").classList.toggle("nav-open");
      $("#burger").setAttribute("aria-expanded", String(open));
    });
    $("#scrim").addEventListener("click", () => $("#app").classList.remove("nav-open"));
    window.addEventListener("hashchange", route);
    window.addEventListener("resize", () => moveNavInd(true));
    setupViewMotion($("#view"));
    api("GET", "/deals").then((r) => setCounts(r.deals)).catch(() => {});
    route();
  }

  // ---------- paying ----------
  //
  // Card details are typed into an iframe served by Stripe and go straight to Stripe. They never
  // touch a Valence page or a Valence server, which is what keeps us out of PCI scope.
  let stripeJs = null;
  function loadStripeJs() {
    if (stripeJs) return stripeJs;
    stripeJs = new Promise((resolve, reject) => {
      if (window.Stripe) return resolve(window.Stripe);
      const tag = el("script", { src: "https://js.stripe.com/v3/" });
      tag.addEventListener("load", () => (window.Stripe ? resolve(window.Stripe) : reject(new Error("Stripe didn't load properly."))));
      tag.addEventListener("error", () => {
        stripeJs = null;
        reject(new Error("Couldn't reach Stripe. An ad blocker or privacy extension is the usual cause."));
      });
      document.head.append(tag);
    });
    return stripeJs;
  }

  function stripeAppearance() {
    const light = document.documentElement.getAttribute("data-theme") === "light";
    return {
      theme: light ? "stripe" : "night",
      variables: { colorPrimary: light ? "#2563eb" : "#5b93ff", borderRadius: "10px", fontFamily: "\"IBM Plex Sans\", system-ui, sans-serif" },
    };
  }

  // Every fee, named, with whoever charges it. A fee with no owner reads as ours, and padded.
  function breakdown(q, { forSeller = false } = {}) {
    const pct = (bps) => `${(bps / 100).toFixed(1).replace(/\.0$/, "")}%`;
    const rows = forSeller
      ? [["Deal amount", fmt(q.amount, q.currency), null],
         ["Card processing", "\u2212" + fmt(q.processorFee, q.currency), "Stripe's fee. You're the merchant on this charge, so it's yours, exactly as it would be anywhere else."],
         ["Valence fee", fmt(0, q.currency), "Paid by the buyer on top of your price. Nothing is taken from you."]]
      : [["Deal amount", fmt(q.amount, q.currency), null],
         [`Valence fee (${pct(q.platformBps)})`, fmt(q.platformFee, q.currency), "For holding the payment, the dispute process and support. Returned in full if the deal is cancelled or refunded."]];
    return el("div", { class: "breakdown" },
      el("dl", { class: "fees" }, rows.map(([label, value, hint]) =>
        [el("dt", {}, label, hint ? el("span", { class: "fee-hint" }, hint) : null),
         el("dd", { class: "num" }, value)]).flat()),
      el("div", { class: "total" },
        el("span", {}, forSeller ? "You receive, about" : "You pay today"),
        el("strong", { class: "num" }, fmt(forSeller ? q.sellerNet : q.buyerTotal, q.currency))),
      forSeller
        ? el("p", { class: "hint" }, `Stripe's fee depends on the card the buyer uses, so an overseas card would leave you about ${fmt(q.sellerNetWorst, q.currency)}. Your bank may charge for incoming transfers too.`)
        : el("p", { class: "hint" }, `The seller is paid ${fmt(q.amount, q.currency)} less Stripe's processing fee. Your card is only held until you release the deal. No other charges, ever.`));
  }

  // Builds Stripe's card form for a deal and resolves once the hold is on the card.
  async function cardForm(dealId, { onFunded }) {
    const wrap = el("div", { class: "pay" });
    const slot = el("div", { class: "pay-slot" });
    const msg = el("p", { class: "flash error", hidden: true, role: "alert" });
    const button = el("button", { type: "button", class: "btn", disabled: true }, "Preparing\u2026");
    const show = (text) => { msg.textContent = text || ""; msg.hidden = !text; };
    put(wrap, slot, msg, el("div", { class: "actions" }, button),
      el("p", { class: "dim" }, "Card details go straight to Stripe. Valence never sees them."));

    try {
      const [payouts, started] = await Promise.all([
        api("GET", "/payouts"),
        api("POST", `/deals/${encodeURIComponent(dealId)}/fund`, undefined, { headers: { "Idempotency-Key": newKey() } }),
      ]);
      if (started.alreadyFunded) {
        await onFunded();
        return wrap;
      }
      if (!payouts.publishableKey) throw new Error("Card payments aren't finished being set up on this server.");
      const Stripe = await loadStripeJs();
      // A direct charge lives on the seller's own Stripe account, so Stripe.js must be told whose.
      const stripe = Stripe(payouts.publishableKey, { stripeAccount: started.stripeAccount });
      const elements = stripe.elements({ clientSecret: started.clientSecret, appearance: stripeAppearance() });
      const element = elements.create("payment", { layout: "tabs" });
      const label = `Pay ${fmt(started.quote.buyerTotal, started.quote.currency)}`;
      element.mount(slot);
      element.on("ready", () => { button.disabled = false; });
      element.on("change", (e) => show(e.error ? e.error.message : ""));
      button.textContent = label;

      button.addEventListener("click", async () => {
        button.disabled = true;
        button.textContent = "Authorising\u2026";
        show("");
        const { error } = await stripe.confirmPayment({ elements, redirect: "if_required" });
        if (error) {
          show(error.message || "That card was declined. Nothing has been charged.");
          button.disabled = false;
          button.textContent = label;
          return;
        }
        button.textContent = "Confirming\u2026";
        try {
          await api("POST", `/deals/${encodeURIComponent(dealId)}/funded`, {}, { headers: { "Idempotency-Key": newKey() } });
        } catch (err) {
          show(err.message);
        }
        await onFunded();
      });
    } catch (err) {
      // Nothing was charged. Say why, and don't leave an empty card box or a dead button behind
      // (.btn's display rule beats the hidden attribute, so remove rather than hide).
      slot.remove();
      button.parentNode.remove();
      show(err.message);
    }
    return wrap;
  }

  const BRANDS = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", discover: "Discover", jcb: "JCB", diners: "Diners Club", unionpay: "UnionPay" };
  const cardBrand = (b) => BRANDS[b] || (b ? b[0].toUpperCase() + b.slice(1) : "card");

  // Sends a seller to Stripe to set up getting paid.
  function payoutButton(label = "Set up payouts", cls = "") {
    const b = el("button", { type: "button", class: "btn " + cls }, label);
    b.addEventListener("click", async () => {
      b.disabled = true;
      b.textContent = "Opening Stripe\u2026";
      try {
        const r = await api("POST", "/payouts/onboarding-link", {}, { headers: { "Idempotency-Key": newKey() } });
        location.href = r.url;
      } catch (err) {
        flash(err.message);
        b.disabled = false;
        b.textContent = label;
      }
    });
    return b;
  }

  // ---------- shared pieces ----------
  // tone: blue, sky, cyan, indigo, violet or teal, so a row of tiles reads as a family of blues
  function tile(iconName, value, label, tone = "blue") {
    return el("div", { class: "tile tone-" + tone }, el("span", { class: "page-ico" }, icon(iconName)), el("div", {}, el("b", { class: "num" }, value), el("span", {}, label)));
  }
  function roleText(d) {
    return d.yourRole === "buyer" ? "you're paying" : "you're getting paid";
  }
  function nextHint(d) {
    const buyer = d.yourRole === "buyer";
    switch (d.state) {
      case "open": return "Waiting for the other side to join";
      case "joined": return buyer ? "Pay to start the deal" : "Waiting for the buyer to pay";
      case "awaiting_setup": return buyer ? "Waiting on the seller's payout setup" : "Finish setting up payouts";
      case "funding": return buyer ? "Finish paying" : "The buyer is paying";
      case "funded": return buyer ? "Release once you're happy" : "Do the work, then mark it delivered";
      case "delivered": return buyer ? "Check the work and release" : "Waiting for the buyer to release";
      case "disputed": return "In dispute";
      default: return STATE_LABELS[d.state];
    }
  }
  const needsMe = (d) =>
    (d.yourRole === "buyer" && ["joined", "funding", "funded", "delivered"].includes(d.state)) ||
    (d.yourRole === "seller" && ["awaiting_setup", "funded"].includes(d.state));
  function dealItem(d) {
    return el("li", {}, el("a", { class: "item", href: "#deal/" + encodeURIComponent(d.id) },
      el("div", { class: "grow" }, el("span", { class: "t" }, d.title), el("span", { class: "s" }, `${TYPE_LABELS[d.type]} · ${roleText(d)} · ${nextHint(d)}`)),
      el("span", { class: "amt num" }, fmt(d.amount, d.currency)),
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
        el("section", { class: "welcome" },
          el("div", {},
            el("h2", {}, `Welcome back, ${me.name}`),
            el("p", {}, attention.length ? `${attention.length} deal${attention.length > 1 ? "s" : ""} need${attention.length > 1 ? "" : "s"} you.` : "Here's how your deals are going.")),
          el("div", { class: "row" }, btnLink("#new", "New deal"), btnLink("#join", "Join a deal", "secondary"))),
        el("div", { class: "tiles" },
          tile("wallet", fmt(stats.volume.onHold, stats.currency), "Held right now", "blue"),
          tile("deals", String(active.length), "Active deals", "sky"),
          tile("check", String(stats.counts.released), "Completed deals", "teal"),
          tile("coins", fmt(stats.volume.total, stats.currency), "Volume", "indigo")),
        el("div", { class: "two" },
          el("section", { class: "card" },
            el("h2", {}, "Needs you"),
            attention.length ? el("ul", { class: "list" }, attention.map(dealItem))
              : emptyState("You're all caught up", "Nothing is waiting on you right now.", btnLink("#new", "New deal"), btnLink("#join", "Join a deal", "secondary")),
            waiting.length ? el("h3", { class: "q spaced" }, "Waiting on the other side") : null,
            waiting.length ? el("ul", { class: "list" }, waiting.slice(0, 5).map(dealItem)) : null),
          el("section", { class: "card" },
            el("h2", {}, "Recent activity"),
            (me.recentPayments || []).length
              ? el("ul", { class: "list" }, me.recentPayments.slice(0, 8).map((e) => el("li", {}, el("div", { class: "item" },
                el("span", { class: "page-ico tone-" + (e.direction === "in" ? "teal" : e.direction === "out" ? "sky" : "indigo") },
                  icon(e.direction === "out" ? "arrowUp" : e.direction === "in" ? "arrowDown" : "clock")),
                el("div", { class: "grow" }, el("span", { class: "t" }, PAYMENT_LABELS[e.event] || e.event), el("span", { class: "s" }, ago(e.at))),
                e.amount == null ? null : el("span", { class: "amt num" + (e.direction === "in" ? " in" : "") },
                  `${e.direction === "out" ? "\u2212" : e.direction === "in" ? "+" : ""}${fmt(e.amount, e.currency || stats.currency)}`)))))
              : el("p", { class: "muted" }, "No activity yet. Payments show up here once a deal is funded."))));
    }
    draw(deals, stats, me);
    let last = JSON.stringify([deals, stats]);
    every(5000, async () => {
      const [d2, s2] = await Promise.all([api("GET", "/deals"), api("GET", "/stats"), refreshMe()]);
      if (!alive(gen)) return;
      setCounts(d2.deals);
      const now = JSON.stringify([d2.deals, s2]);
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
    put(chart, svg("defs", {}, svg("linearGradient", { id: "bar-fill", x1: 0, y1: 0, x2: 0, y2: 1 },
      svg("stop", { offset: "0%", class: "b1" }), svg("stop", { offset: "100%", class: "b2" }))));
    for (let i = 0; i <= 4; i++) {
      const y = T + plotH - (plotH * i) / 4;
      put(chart, svg("line", { class: "gridline", x1: L, x2: W, y1: y, y2: y }));
      const t = svg("text", { x: 0, y: y + 4 });
      t.textContent = fmt((top * i) / 4);
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
      tip.textContent = `${new Date(d.date + "T00:00:00Z").toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" })}: ${fmt(d.volume)} in ${d.deals} deal${d.deals === 1 ? "" : "s"}`;
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
        tile("coins", fmt(s.volume.total, s.currency), "Total volume", "blue"),
        tile("arrowUp", fmt(s.volume.sent), "Sent", "sky"),
        tile("arrowDown", fmt(s.volume.received), "Received", "teal"),
        tile("clock", duration(s.durationMs.avgFundedToReleased), "Avg time held", "cyan"),
        tile("percent", pct, "Completion rate", "indigo"),
        tile("wallet", fmt(s.volume.onHold, s.currency), "Held right now", "violet")),
      el("section", { class: "card" },
        el("div", { class: "row between" }, el("h2", {}, "Released volume, last 30 days"), el("span", { class: "dim" }, "Hover a bar for the day's total")),
        s.daily.some((d) => d.volume > 0) ? barChart(s.daily) : el("p", { class: "muted" }, "No released deals in the last 30 days yet. Once deals complete, their volume shows up here day by day.")),
      el("div", { class: "two" },
        el("section", { class: "card" },
          el("h2", {}, "How long deals take"),
          el("dl", { class: "facts" },
            el("dt", {}, "Average, start to finish"), el("dd", {}, duration(s.durationMs.avgCreatedToReleased)),
            el("dt", {}, "Typical (median)"), el("dd", {}, duration(s.durationMs.medianCreatedToReleased)),
            el("dt", {}, "Average time held"), el("dd", {}, duration(s.durationMs.avgFundedToReleased)),
            el("dt", {}, "Fastest deal"), el("dd", {}, duration(s.durationMs.fastest)),
            el("dt", {}, "Card fees you paid"), el("dd", {}, fmt(s.volume.feesPaid, s.currency)))),
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
  // A card hold lasts about 7 days, so a deal can never promise longer than that.
  const DEADLINES = [[12, "12 hours"], [24, "1 day"], [48, "2 days"], [72, "3 days"], [168, "7 days"]];

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
            choice(draft.role === "buyer", "I'm paying", "You pay by card. The money is held, not sent, until you release it.", () => { draft.role = "buyer"; draw(); }),
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
        if (!draft.currency) draft.currency = activeCurrency;
        const currSel = el("select", { id: "deal-currency", name: "currency", class: "currency-select" },
          ...Object.entries(CURRENCY_META).map(([code, meta]) =>
            el("option", { value: code, selected: code === draft.currency || undefined }, meta.label)));
        const symSpan = el("span", {}, CURRENCY_META[draft.currency].symbol);
        const amount = el("input", { id: "deal-amount", name: "amount", type: "text", inputmode: "decimal", autocomplete: "off", required: true, placeholder: "0.00" });
        amount.value = draft.amount;
        const note = el("p", { class: "hint" });
        const updateNote = () => {
          const code = draft.currency;
          const cents = parseMoney(amount.value);
          if (cents === null) { note.textContent = `Between ${fmt(MIN_AMOUNT, code)} and ${fmt(MAX_AMOUNT, code)}.`; return; }
          const q = quoteFor(cents, code);
          note.textContent = `The buyer pays ${fmt(q.buyerTotal, code)}, including our ${fmt(q.platformFee, code)} fee. The seller is quoted ${fmt(cents, code)} and receives about ${fmt(q.sellerNet, code)} after Stripe's card fee.`;
        };
        currSel.addEventListener("change", () => {
          draft.currency = currSel.value;
          activeCurrency = currSel.value;
          try { localStorage.setItem("vl_currency", currSel.value); } catch(_) {}
          symSpan.textContent = CURRENCY_META[currSel.value].symbol;
          updateNote();
        });
        amount.addEventListener("input", updateNote);
        updateNote();
        put(form,
          el("p", { class: "q" }, "How much, and how long?"),
          el("label", { for: "deal-currency" }, "Currency"),
          currSel,
          el("label", { for: "deal-amount" }, "Amount"),
          el("div", { class: "amount-input" }, symSpan, amount),
          note,
          el("label", {}, "Refund deadline"),
          el("p", { class: "hint" }, "If the deal isn't finished this long after the buyer pays, the buyer can cancel and the hold is released."),
          el("div", { class: "chips", role: "group", "aria-label": "Refund deadline" }, DEADLINES.map(([h, label]) =>
            el("button", { type: "button", class: "chip", "aria-pressed": String(draft.deadlineHours === h), onclick: () => { draft.amount = amount.value; draft.deadlineHours = h; draw(); } }, label))),
          nav("Review deal"));
        form.onsubmit = (e) => {
          e.preventDefault();
          const cents = parseMoney(amount.value);
          if (cents === null) return flash(`Enter an amount between ${fmt(MIN_AMOUNT, draft.currency)} and ${fmt(MAX_AMOUNT, draft.currency)}.`);
          draft.amount = amount.value.trim();
          step = 3; draw();
        };
        setTimeout(() => amount.focus(), 0);
      }

      if (step === 3) {
        const n = parseMoney(draft.amount);
        const q = quoteFor(n, draft.currency);
        const other = typeOptions(app.me.kind).find(([v]) => v === draft.type)[1].toLowerCase();
        put(form,
          el("p", { class: "q" }, "Check the details"),
          el("dl", { class: "review" },
            el("dt", {}, "Deal"), el("dd", {}, draft.title),
            draft.description ? el("dt", {}, "Details") : null, draft.description ? el("dd", {}, draft.description) : null,
            el("dt", {}, "Other side"), el("dd", {}, `${other[0].toUpperCase()}${other.slice(1)} (${TYPE_LABELS[draft.type]})`),
            el("dt", {}, "You are"), el("dd", {}, draft.role === "buyer" ? "Paying (sender)" : "Getting paid (receiver)"),
            el("dt", {}, "Currency"), el("dd", {}, (CURRENCY_META[draft.currency] || CURRENCY_META.usd).label),
            el("dt", {}, "Deal amount"), el("dd", {}, fmt(n, draft.currency)),
            el("dt", {}, draft.role === "buyer" ? "You pay" : "The buyer pays"), el("dd", {}, fmt(q.buyerTotal, draft.currency)),
            el("dt", {}, draft.role === "seller" ? "You receive, about" : "The seller receives, about"), el("dd", {}, fmt(q.sellerNet, draft.currency)),
            el("dt", {}, "Refund deadline"), el("dd", {}, `${DEADLINES.find(([h]) => h === draft.deadlineHours)[1]} after the buyer pays`)),
          el("p", { class: "hint" }, "Next you'll get a one-time invite code to send to the other side. Nobody pays anything until they've joined."),
          nav("Create deal"));
        form.onsubmit = async (e) => {
          e.preventDefault();
          const button = form.querySelector("button[type=submit]");
          button.disabled = true;
          try {
            const deal = await api("POST", "/deals", {
              type: draft.type, role: draft.role, title: draft.title, description: draft.description,
              amount: n, deadlineHours: draft.deadlineHours, currency: draft.currency,
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
      put(body,
        el("p", { class: "q" }, p.title),
        p.description ? el("p", { class: "muted" }, p.description) : null,
        el("dl", { class: "review" },
          el("dt", {}, "From"), el("dd", {}, `${p.creator.name} (${kindLabel(p.creator.kind)})`),
          el("dt", {}, "Deal type"), el("dd", {}, TYPE_LABELS[p.type]),
          el("dt", {}, "You'll be"), el("dd", {}, p.yourRole === "buyer" ? "Paying (sender)" : "Getting paid (receiver)"),
          el("dt", {}, "Amount"), el("dd", {}, `${fmt(p.amount)}`),
          el("dt", {}, "Receiver gets, about"), el("dd", {}, fmt(quoteFor(p.amount, p.currency).sellerNet, p.currency)),
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
        el("td", { class: "num" }, `${fmt(d.amount)}`),
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

    // True while the buyer has the card form open, so a poll can't tear it down under them.
    let paying = false;
    let payMethod = "card";

    async function ask(action, promptText, okText, extra = {}) {
      const answer = promptText ? prompt(promptText) : "";
      if (promptText && answer === null) return;
      busy = true;
      flash("");
      try {
        const payload = { ...extra };
        if (promptText) payload.note = answer || "";
        deal = await api("POST", `/deals/${encodeURIComponent(id)}/${action}`, payload, { headers: { "Idempotency-Key": newKey() } });
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
      const q = deal.quote;
      const pay = deal.payment;
      const p = el("section", { class: "next" });
      const supportLink = el("p", { class: "dim" }, "Something wrong? ", el("a", { href: "#support" }, "Open a support ticket"), ".");
      const disputeButton = () => el("button", { type: "button", class: "btn ghost small", onclick: async () => {
        const reason = prompt("What's gone wrong? This freezes the deal and sends it to Valence support.");
        if (reason === null) return;
        if (reason.trim().length < 10) return flash("Please describe the problem in a sentence or two.");
        busy = true;
        try {
          deal = await api("POST", `/deals/${encodeURIComponent(id)}/dispute`, { reason }, { headers: { "Idempotency-Key": newKey() } });
          toast("Dispute opened. The deal is frozen.");
        } catch (err) {
          flash(err.message);
        } finally {
          busy = false;
        }
        draw();
      } }, "Open a dispute");

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
        case "funding": {
          if (!buyer) {
            const ready = app.me.payouts && app.me.payouts.ready;
            put(p, el("h3", {}, ready ? "You're in. Waiting for the buyer to pay." : "Set up payouts so you can be paid"),
              ready
                ? el("p", {}, "Don't start work until the money is held. This page updates by itself.")
                : el("p", {}, "Stripe needs your details before this deal can be funded. It takes a couple of minutes, and Valence never sees your bank details or your ID."),
              ready ? el("span", { class: "live" }, "Waiting for payment") : null,
              el("div", { class: "actions" },
                ready ? null : payoutButton("Set up payouts with Stripe"),
                confirmButton("Leave and cancel deal", "ghost", "Click again to cancel", () => act("cancel", "Deal cancelled"))));
            break;
          }
          put(p, el("h3", {}, `${other().name} joined. Pay to start the deal.`),
            el("p", {}, `${fmt(q.buyerTotal, q.currency)} is held on your card, not charged. ${other().name} is paid only when you release the deal, and the hold disappears if you cancel.`),
            breakdown(q));
          if (!paying) {
            const methods = el("div", { class: "seg", role: "group", "aria-label": "Pay with" });
            for (const [k, l] of [["card", "Card"], ["crypto", "Crypto"]]) {
              put(methods, el("button", { type: "button", "aria-pressed": String(payMethod === k), onclick: () => { payMethod = k; draw(); } }, l));
            }
            put(p, el("div", { class: "pay-with" }, el("span", {}, "Pay with"), methods));
          }
          if (!paying && payMethod === "crypto") {
            put(p, cryptoPanel(),
              el("div", { class: "actions" }, confirmButton("Cancel deal", "ghost", "Click again to cancel", () => act("cancel", "Deal cancelled"))));
          } else if (!paying) {
            put(p, el("div", { class: "actions" },
              el("button", { type: "button", class: "btn", onclick: () => { paying = true; draw(); } }, `Pay ${fmt(q.buyerTotal, q.currency)}`),
              confirmButton("Cancel deal", "ghost", "Click again to cancel", () => act("cancel", "Deal cancelled"))));
          } else {
            const slot = el("div", { class: "pay-wrap" }, el("p", { class: "muted" }, "Opening the secure card form\u2026"));
            put(p, slot);
            cardForm(id, {
              onFunded: async () => {
                paying = false;
                try {
                  deal = await api("GET", "/deals/" + encodeURIComponent(id));
                } catch { /* the poll will catch up */ }
                toast("Payment held. The deal has started.");
                draw();
              },
            }).then((form) => {
              if (!paying && !(deal.payment && deal.payment.status === "held")) return;
              slot.textContent = "";
              put(slot, form);
            });
          }
          break;
        }

        case "awaiting_setup": {
          if (buyer) {
            put(p, el("h3", {}, "Waiting on the seller"),
              el("p", {}, `${other() ? other().name : "The seller"} hasn't finished setting up payouts, so there's nowhere for this money to go yet. They've been told. Nothing has been charged.`),
              el("span", { class: "live" }, "Waiting for their setup"),
              el("div", { class: "actions" }, confirmButton("Cancel deal", "ghost", "Click again to cancel", () => act("cancel", "Deal cancelled"))));
          } else {
            put(p, el("h3", {}, "Finish setting up payouts"),
              el("p", {}, "The buyer is ready to pay, but Stripe needs your details first. Valence never sees your bank details or your ID: Stripe collects and verifies them."),
              el("div", { class: "actions" }, payoutButton("Continue with Stripe")));
          }
          break;
        }

        case "funded":
        case "delivered": {
          const passed = Date.now() >= Date.parse(deal.deadlineAt);
          const expires = pay && pay.holdExpiresAt ? when(pay.holdExpiresAt) : null;
          const held = el("p", { class: "held" },
            `${fmt(pay ? pay.amount : q.buyerTotal, q.currency)} held on ${pay && pay.brand ? cardBrand(pay.brand) : "the buyer's card"}${pay && pay.last4 ? ` ending ${pay.last4}` : ""}.`);
          if (buyer) {
            put(p,
              el("h3", {}, deal.state === "delivered" ? `${other().name} says it's done` : "Your payment is held"),
              held,
              deal.state === "delivered"
                ? el("p", {}, "Check the work, then release. If you do nothing, it releases automatically 72 hours after delivery.")
                : el("p", {}, `Release it once you're happy with what ${other().name} delivered. They receive about ${fmt(q.sellerNet, q.currency)} after Stripe's processing fee.`),
              deal.deliveryNote ? el("blockquote", { class: "note" }, deal.deliveryNote) : null,
              el("div", { class: "actions" },
                confirmButton("Release the payment", "", "Click again to pay the seller. This can't be undone", () => act("release", "Released. The seller has been paid.")),
                passed ? el("button", { type: "button", class: "btn secondary", onclick: () => act("refund", "Cancelled. The hold has been released.") }, "Cancel and release the hold") : null,
                disputeButton()),
              el("p", { class: "hint" }, passed
                ? "The deadline has passed, so you can cancel and have the hold released."
                : `If the deal isn't done by ${when(deal.deadlineAt)} you can cancel and have the hold released.`),
              expires ? el("p", { class: "hint" }, `The hold on your card lasts until ${expires}${pay && pay.holdAtRisk ? " \u2014 it expires soon, so release or cancel now." : "."}`) : null,
              supportLink);
          } else {
            put(p,
              el("h3", {}, deal.state === "delivered" ? "Delivered. Waiting for the buyer to release." : "The money is held. Time to do the work."),
              held,
              el("p", {}, `When ${other().name} releases it you receive about ${fmt(q.sellerNet, q.currency)}, paid to your bank by Stripe. Stripe's processing fee comes out because you're the merchant on the charge; Valence's fee is paid by the buyer.`),
              deal.state === "delivered" ? el("span", { class: "live" }, "Releases automatically 72 hours after delivery") : null,
              el("div", { class: "actions" },
                deal.state === "funded"
                  ? el("button", { type: "button", class: "btn", onclick: () => ask("deliver", "Anything to tell the buyer about what you delivered? (optional)", "Marked as delivered.") }, "Mark as delivered")
                  : null,
                confirmButton("Cancel and refund the buyer", "secondary", "Click again to refund", () => act("refund", "Refunded. The hold has been released.")),
                disputeButton()),
              expires ? el("p", { class: "hint" }, `The buyer's card hold lasts until ${expires}, so this deal has to finish before then.`) : null,
              supportLink);
          }
          break;
        }

        case "disputed": {
          const chargeback = deal.dispute && deal.dispute.kind === "chargeback";
          put(p, el("h3", {}, chargeback ? "The buyer's bank has reversed this payment" : "This deal is in dispute"),
            el("p", {}, chargeback
              ? "The buyer raised this with their bank rather than with us. Stripe handles it from here and will ask for evidence."
              : "The money stays held while we look at it. Add anything useful in a support ticket and we'll come back to you."),
            deal.dispute && deal.dispute.reason ? el("blockquote", { class: "note" }, deal.dispute.reason) : null,
            el("div", { class: "actions" }, btnLink("#support", "Open a support ticket", "secondary")));
          break;
        }

        case "released":
          put(p, el("h3", {}, "Done. The seller has been paid."),
            el("p", {}, pay && pay.sellerNet != null
              ? `${fmt(pay.sellerNet, q.currency)} went to ${deal.seller ? deal.seller.name : "the seller"} after ${fmt(pay.processorFee, q.currency)} of Stripe processing. Valence's fee was ${fmt(pay.platformFee, q.currency)}.`
              : `${deal.seller ? deal.seller.name : "The seller"} has been paid. It reaches their bank in a couple of business days.`));
          break;

        case "refunded":
          put(p, el("h3", {}, pay && pay.status === "refunded" ? "Refunded" : "Cancelled, and the hold released"),
            el("p", {}, pay && pay.status === "refunded"
              ? "The money has gone back to the card it came from. Banks usually show it within a few business days."
              : "Nothing was ever charged. The hold on the card has been released, which can take a day or two to disappear from a statement."),
            pay && pay.cancelReason ? el("p", { class: "hint" }, pay.cancelReason) : null);
          break;

        default:
          put(p, el("h3", {}, "Cancelled"), el("p", {}, "This deal was cancelled before anyone paid anything."));
      }
      return p;
    }

    function progress() {
      const labels = ["Created", "Other side joined", "Payment held", "Paid out"];
      const reached = { open: 0, joined: 1, awaiting_setup: 1, funding: 1, funded: 2, delivered: 2, disputed: 2, released: 3 };
      const idx = reached[deal.state] === undefined ? -1 : reached[deal.state];
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
      const q = deal.quote;
      const pay = deal.payment;
      put(root,
        el("div", { class: "deal-head" },
          el("h2", {}, deal.title),
          el("span", { class: "badge " + deal.state }, STATE_LABELS[deal.state])),
        el("p", { class: "muted" }, `${TYPE_LABELS[deal.type]} \u00b7 ${fmt(deal.amount, deal.currency)} \u00b7 ${roleText(deal)}`),
        deal.description ? el("p", {}, deal.description) : null,
        progress(),
        nextPanel(),
        el("section", { class: "card" },
          el("h2", {}, "Details"),
          el("dl", { class: "facts" },
            el("dt", {}, "Buyer (pays)"), el("dd", {}, partyName(deal.buyer)),
            el("dt", {}, "Seller (gets paid)"), el("dd", {}, partyName(deal.seller)),
            el("dt", {}, "Deal amount"), el("dd", {}, fmt(deal.amount, deal.currency)),
            el("dt", {}, "Buyer pays"), el("dd", {}, fmt(q.buyerTotal, q.currency)),
            el("dt", {}, "Valence fee"), el("dd", {}, `${fmt(q.platformFee, q.currency)} (1%, paid by the buyer)`),
            el("dt", {}, "Card processing"), el("dd", {}, pay && pay.processorFee != null
              ? `${fmt(pay.processorFee, q.currency)} (Stripe, paid by the seller)`
              : `about ${fmt(q.processorFee, q.currency)} (Stripe, paid by the seller)`),
            el("dt", {}, "Seller receives"), el("dd", {}, pay && pay.sellerNet != null
              ? fmt(pay.sellerNet, q.currency)
              : `about ${fmt(q.sellerNet, q.currency)}`),
            el("dt", {}, "Refund deadline"), el("dd", {}, deal.deadlineAt ? when(deal.deadlineAt) : `${deal.deadlineHours} hours after payment`),
            pay && pay.holdExpiresAt ? el("dt", {}, "Card hold expires") : null,
            pay && pay.holdExpiresAt ? el("dd", {}, when(pay.holdExpiresAt)) : null,
            el("dt", {}, "Deal ID"), el("dd", { class: "code" }, deal.id)),
          el("details", { class: "more" }, el("summary", {}, "History"),
            el("ul", { class: "timeline" }, deal.history.map((h) => el("li", {}, `${when(h.at)}: ${STATE_LABELS[h.state] || h.state} (by ${nameOf(h.by)})`))))),
        el("p", { class: "dim" }, "The money is held by Stripe, never by Valence. ", el("a", { href: "#faq" }, "How this works"), "."));
    }
    draw();

    // Live updates: no refresh needed to see the other side's moves.
    every(3000, async () => {
      if (busy) return;
      const fresh = await api("GET", "/deals/" + encodeURIComponent(id));
      if (!alive(gen) || busy) return;
      if (JSON.stringify(fresh) === JSON.stringify(deal)) return;
      const before = deal.state;
      // Never tear down the card form under someone who is typing into it.
      if (paying && fresh.state === before) {
        deal = fresh;
        return;
      }
      deal = fresh;
      await refreshMe();
      if (before !== deal.state) {
        paying = false;
        const who = other() ? other().name : "The other side";
        const msg = {
          joined: `${who} joined the deal`,
          awaiting_setup: "Waiting on the seller's payout setup",
          funded: "Payment held. The deal has started.",
          delivered: `${who} marked the deal as delivered`,
          disputed: "This deal is now in dispute",
          released: "Released. The seller has been paid.",
          refunded: "The hold has been released",
          cancelled: "The deal was cancelled",
        }[deal.state];
        if (msg) toast(msg);
      }
      draw();
    });
  }

  // ---------- payments: what has moved, never what is "available" ----------
  const PAYMENT_LABELS = {
    payment_started: "Payment started",
    funds_held: "Payment held",
    payment_failed: "Payment failed",
    released: "Released to the seller",
    paid_out: "Paid out to you",
    hold_released: "Hold released",
    refunded: "Refunded",
    delivered: "Marked delivered",
    dispute_opened: "Dispute opened",
    chargeback: "Chargeback",
    payouts_started: "Payout setup started",
    payouts_ready: "Payouts ready",
  };
  async function viewPayments(view, _arg, gen) {
    const [history, payouts] = await Promise.all([api("GET", "/payments"), api("GET", "/payouts")]);
    if (!alive(gen)) return;
    put(view, payoutsCard(payouts));
    put(view, el("section", { class: "card" }, cryptoPanel()));
    if (!history.events.length) {
      put(view, el("section", { class: "card" },
        emptyState("Nothing here yet", "Once a deal is funded, every movement shows up here with the deal it belongs to.",
          btnLink("#new", "Start a deal"))));
      return;
    }
    const csv = el("a", { class: "btn ghost small", href: "#" }, icon("doc"), "Export CSV");
    csv.addEventListener("click", async (e) => {
      e.preventDefault();
      await downloadAuth("/v1/payments.csv", "valence-payments.csv");
    });
    put(view, el("section", { class: "card" },
      el("div", { class: "card-head" }, el("h2", {}, "Payments"), csv),
      el("table", {},
        el("thead", {}, el("tr", {}, el("th", {}, "When"), el("th", {}, "What"), el("th", {}, "Deal"), el("th", { class: "num" }, "Amount"))),
        el("tbody", {}, history.events.map((e) => el("tr", {},
          el("td", {}, when(e.at)),
          el("td", {}, PAYMENT_LABELS[e.event] || e.event, e.detail ? el("span", { class: "s" }, e.detail) : null),
          el("td", {}, e.dealId ? el("a", { href: "#deal/" + encodeURIComponent(e.dealId) }, e.dealId.slice(0, 12)) : "\u2014"),
          el("td", { class: "num" + (e.direction === "in" ? " in" : e.direction === "out" ? " out" : "") },
            e.amount == null ? "\u2014" : `${e.direction === "out" ? "\u2212" : e.direction === "in" ? "+" : ""}${fmt(e.amount, e.currency || history.currency)}`)))))),
      el("p", { class: "dim" }, "These are completed movements, past tense. Valence holds no balance for you: every payment belongs to one deal."));
  }

  // Crypto checkout is planned through BTCPay Server. Until it's wired up this is a preview only:
  // nothing here talks to the server or a wallet.
  function cryptoPanel() {
    const coin = (iconName, tone, name, sub) => el("li", { class: "tone-" + tone },
      el("span", { class: "page-ico" }, icon(iconName)), el("div", {}, el("strong", {}, name), el("small", {}, sub)));
    return el("div", { class: "crypto" },
      el("div", { class: "crypto-head" },
        el("div", {}, el("strong", {}, "Pay with crypto"), el("p", { class: "muted" }, "Checkout will run through BTCPay Server, so payments go straight to a wallet, with no exchange in the middle.")),
        el("span", { class: "badge soon" }, "Coming soon")),
      el("ul", { class: "crypto-coins" },
        coin("bitcoin", "sunset", "Bitcoin", "On-chain"),
        coin("bolt", "violet", "Lightning", "Instant, low fees")),
      el("div", { class: "crypto-invoice", "aria-hidden": "true" },
        el("div", { class: "qr-ph" }),
        el("div", { class: "grow" },
          el("span", { class: "ph-line w60" }), el("span", { class: "ph-line w90" }), el("span", { class: "ph-line w40" }))),
      el("div", { class: "actions" },
        el("button", { type: "button", class: "btn", disabled: true }, icon("bitcoin"), "Pay with crypto")),
      el("p", { class: "dim" }, "Crypto isn't switched on yet. Choose Card to fund this deal today."));
  }

  // Shown on the payments page and in settings.
  function payoutsCard(payouts) {
    if (!payouts.enabled) {
      return el("section", { class: "card" }, el("h2", {}, "Getting paid"),
        el("p", { class: "muted" }, "Card payments aren't switched on for this server yet."));
    }
    const refresh = el("button", { type: "button", class: "btn ghost small" }, "Check again");
    refresh.addEventListener("click", async () => {
      refresh.disabled = true;
      try {
        await api("POST", "/payouts/refresh", {}, { headers: { "Idempotency-Key": newKey() } });
        await refreshMe();
        route();
      } catch (err) {
        flash(err.message);
        refresh.disabled = false;
      }
    });
    const body = el("section", { class: "card" }, el("h2", {}, "Getting paid"));
    if (payouts.ready) {
      put(body,
        el("div", { class: "set-row" }, el("span", {}, "Payouts"), el("strong", { class: "ok" }, "Ready")),
        el("p", { class: "muted" }, "Stripe has verified you and will pay released deals to your bank, usually within two business days. Valence never holds your money and never sees your bank details."),
        el("div", { class: "actions" }, payoutButton("Manage at Stripe", "secondary"), refresh));
    } else if (payouts.started) {
      put(body,
        el("div", { class: "set-row" }, el("span", {}, "Payouts"), el("strong", { class: "warn" }, payouts.detailsSubmitted ? "Stripe is still checking" : "Not finished")),
        el("p", { class: "muted" }, payouts.detailsSubmitted
          ? "Stripe has your details and is verifying them. This is usually quick, but can take a day."
          : "You started setting up payouts but didn't finish. Deals can't be funded until Stripe has what it needs."),
        el("div", { class: "actions" }, payoutButton(payouts.detailsSubmitted ? "Check at Stripe" : "Finish setting up"), refresh));
    } else {
      put(body,
        el("div", { class: "set-row" }, el("span", {}, "Payouts"), el("strong", {}, "Not set up")),
        el("p", { class: "muted" }, `Before anyone can pay you, Stripe needs your name, date of birth, address and bank details. You enter them on Stripe's own pages: Valence never sees them, and Stripe holds the money, not us. Deals have to finish within ${payouts.holdDays} days because that's how long a card hold lasts.`),
        el("div", { class: "actions" }, payoutButton("Set up payouts with Stripe")));
    }
    if (payouts.awaitingSetup && payouts.awaitingSetup.length) {
      put(body, el("p", { class: "flash warn" },
        `${payouts.awaitingSetup.length} deal${payouts.awaitingSetup.length === 1 ? " is" : "s are"} waiting on this before the buyer can pay.`));
    }
    return body;
  }

  // ---------- support ----------  // ---------- support ----------
  async function viewSupport(view, _arg, gen) {
    const [info, list, dealsRes] = await Promise.all([api("GET", "/support"), api("GET", "/tickets"), api("GET", "/deals")]);
    if (!alive(gen)) return;
    const discordCard = el("div", { class: "discord-card" },
      el("span", { class: "page-ico" }, icon("support")),
      el("div", {}, el("strong", {}, "Join our Discord"), el("span", {}, "Chat with the team and other users. Good for quick questions.")),
      el("a", { class: "btn small", href: info.discordInvite || DISCORD_INVITE, target: "_blank", rel: "noopener" }, "Open Discord", icon("out")));

    const attach = attachBar(info.attachments, (m) => flash(m));
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
      el("label", {}, "Screenshots (optional)"),
      attach.node,
      el("button", { type: "submit", class: "btn" }, "Send ticket"));
    bindForm(form, async (f) => {
      if (attach.busy()) throw new Error("Wait for the images to finish uploading.");
      const t = await api("POST", "/tickets", {
        category: val(f, "category"), dealId: val(f, "dealId") || null,
        subject: val(f, "subject"), message: val(f, "message"), attachmentIds: attach.ids(),
      });
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
    const linked = app.me.security && app.me.security.discord;
    const linkCard = info.discordLinking && app.me.kind === "human" && !linked
      ? el("div", { class: "discord-card subtle" },
        el("span", { class: "page-ico" }, icon("discord")),
        el("div", {}, el("strong", {}, "Link your Discord first (optional)"),
          el("span", {}, "Linked accounts get added to their own ticket channel in the server, so you can follow along there as well as here.")),
        el("a", { class: "btn small secondary", href: "#settings" }, "Link in Settings"))
      : null;
    put(view, discordCard, linkCard, el("div", { class: "support-grid" }, el("section", { class: "card" }, form), ticketsCard));
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

    function transcriptButton() {
      const b = el("button", { type: "button", class: "btn ghost small" }, icon("doc"), "Download transcript");
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          await downloadAuth(`/tickets/${encodeURIComponent(id)}/transcript`, `valence-ticket-${t.number}.html`);
        } catch (err) {
          flash(err.message);
        } finally {
          b.disabled = false;
        }
      });
      return b;
    }

    function drawHead() {
      head.textContent = "";
      put(head, el("div", { class: "deal-head" }, el("h2", {}, t.subject), el("span", { class: "badge " + (t.status === "open" ? "open" : "closed") }, t.status === "open" ? "Open" : "Closed")),
        el("p", { class: "dim" }, `Opened ${when(t.createdAt)}${t.dealId ? " · about a deal" : ""}${t.claimedBy ? " · handled by " + (t.claimedBy.role === "Owner" ? "the owner" : "support") : ""}`));
    }
    function drawChat() {
      chat.textContent = "";
      for (const m of t.messages) {
        put(chat, el("div", { class: "bubble " + m.from },
          m.text || null,
          attachmentsNode(t.id, m.attachments),
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
      const text = el("textarea", { name: "text", maxlength: "2000", placeholder: "Write a message, or paste a screenshot...", "aria-label": "Message" });
      const attach = attachBar(info.attachments, (m) => flash(m));
      const form = el("form", { class: "composer" }, text, el("button", { type: "submit", class: "btn" }, "Send"));
      text.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
      });
      // Pasting or dropping a screenshot attaches it.
      text.addEventListener("paste", (e) => {
        const files = [...(e.clipboardData ? e.clipboardData.files : [])];
        if (files.length) { e.preventDefault(); attach.takeFiles(files); }
      });
      foot.addEventListener("dragover", (e) => e.preventDefault());
      foot.addEventListener("drop", (e) => {
        e.preventDefault();
        attach.takeFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith("image/")));
      });
      bindForm(form, async () => {
        const msg = text.value.trim();
        const ids = attach.ids();
        if (!msg && !ids.length) return;
        if (attach.busy()) throw new Error("Wait for the images to finish uploading.");
        t = await api("POST", `/tickets/${encodeURIComponent(id)}/messages`, { text: msg, attachmentIds: ids });
        text.value = "";
        attach.clear();
        drawChat();
      });
      put(foot, form, attach.node, el("div", { class: "actions" },
        transcriptButton(),
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
    ["What is Valence MM?", "A middleman for deals between people and AI agents. The buyer's payment is held until both sides have done their part, then it goes to the seller or back to the buyer."],
    ["Where is my money while a deal runs?", "Nowhere near Valence. The buyer's card is authorised but not charged, so the money stays with the buyer's own bank. Valence can't spend it and can't take it. Releasing the deal is what actually charges the card, and Stripe pays the seller directly."],
    ["How does a deal work?", "The creator picks who they're dealing with, the amount and a refund deadline, then sends a one-time invite code. The other side joins, the buyer pays by card, and the buyer releases it when happy. The seller can mark a deal delivered, and it releases on its own 72 hours later if the buyer says nothing."],
    ["Can AI agents use it on their own?", "Yes. Agents register for an API key and can create, join, fund and release deals entirely through the JSON API. See the API docs."],
    ["Why do deals have to finish within 7 days?", "Because that's how long a card authorisation lasts. Holding the money on the buyer's card instead of in an account is what keeps this safe, and the trade-off is that deals can't run longer than the hold."],
    ["What if the other side never delivers?", "The seller can refund you at any time. If they don't, you can cancel once the deal's refund deadline has passed, and the hold on your card is released: nothing was ever charged."],
    ["How are disputes handled?", "Either side can open a dispute, which freezes the deal. Valence reads both sides and decides to release, refund or split. The money stays held throughout."],
    ["What does it cost?", "Valence takes 1%, paid by the buyer on top of the deal amount, and returns it in full if the deal is cancelled or refunded. Stripe's card processing fee is paid by the seller, as it would be for any merchant. Every number is shown before anyone pays."],
    ["Do I need to refresh to see updates?", "No. Deal pages and support tickets update by themselves every few seconds."],
  ];
  function viewFaq(view) {
    put(view, el("section", { class: "card" }, el("div", { class: "faq" }, FAQ.map(([q, a]) => el("details", {}, el("summary", {}, q), el("p", {}, a))))),
      el("p", { class: "muted" }, "Still stuck? ", el("a", { href: "#support" }, "Open a support ticket"), " or ", el("a", { href: DISCORD_INVITE, target: "_blank", rel: "noopener" }, "ask on Discord"), "."));
  }

  // ---------- settings ----------

  // ---------- settings: email and two-step verification ----------
  function qrSvg(text) {
    if (typeof window.qrcode !== "function") return null;
    const qr = window.qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const q = 4; // quiet zone
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + q} ${r + q}h1v1h-1z`;
    return svg("svg", { class: "qr", viewBox: `0 0 ${n + q * 2} ${n + q * 2}`, role: "img", "aria-label": "QR code for your authenticator app", "shape-rendering": "crispEdges" },
      svg("rect", { width: n + q * 2, height: n + q * 2, fill: "#fff" }), svg("path", { d, fill: "#000" }));
  }

  function recoveryPanel(codes) {
    const text = codes.join("\n");
    const download = el("button", { type: "button", class: "btn small secondary", onclick: () => {
      const url = URL.createObjectURL(new Blob([`Valence MM recovery codes for ${app.me.name}\nEach code works once.\n\n${text}\n`], { type: "text/plain" }));
      const a = el("a", { href: url, download: "valence-recovery-codes.txt" });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } }, "Download");
    return el("div", { class: "next" },
      el("h3", {}, "Save your recovery codes"),
      el("p", {}, "If you lose your phone or can't get to your email, each of these codes lets you log in once. They won't be shown again."),
      el("ul", { class: "codes" }, codes.map((c) => el("li", { class: "code" }, c))),
      el("div", { class: "row" }, copyButton(text, "Copy all"), download));
  }

  // A small inline "enter your password to continue" form.
  function passwordGate(label, run) {
    const input = el("input", { type: "password", name: "password", autocomplete: "current-password", required: true, placeholder: "Your password", "aria-label": "Your password" });
    const form = el("form", { class: "gate" }, el("div", { class: "row" }, input, el("button", { type: "submit", class: "btn small" }, label)));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const b = form.querySelector("button");
      b.disabled = true;
      try { await run(input.value); } finally { b.disabled = false; }
    });
    setTimeout(() => input.focus(), 0);
    return form;
  }

  function securitySection(gen) {
    const wrap = el("div");
    let s = null;
    let showCodes = null; // recovery codes to show once after turning something on
    let open = null; // which inline panel is open
    let setup = null; // authenticator setup in progress
    let linkCode = null; // Discord link code, once asked for
    let editingEmail = false;

    const note = el("p", { class: "flash", role: "status", "aria-live": "polite", hidden: true });
    const say = (text, kind = "error") => { note.textContent = text || ""; note.className = "flash " + kind; note.hidden = !text; };
    async function run(fn, okText) {
      say("");
      try {
        const r = await fn();
        if (r && r.recoveryCodes) showCodes = r.recoveryCodes;
        if (r && r.twoFactor) s = { ...s, ...r };
        open = null;
        if (okText) say(okText, "ok");
      } catch (err) {
        say(err.message);
      }
      draw();
    }
    const badge = (on, onText = "On", offText = "Off") => el("span", { class: "badge " + (on ? "ok" : "closed") }, on ? onText : offText);

    function emailCard() {
      const card = el("section", { class: "card" }, el("h2", {}, "Email address"));
      if (!s.emailAvailable) {
        put(card, el("p", { class: "muted" }, "Email isn't switched on for this site yet, so email verification and email codes are unavailable for now."));
        return card;
      }
      if (s.email && !editingEmail) {
        put(card, el("div", { class: "set-row" }, el("div", {}, el("strong", {}, s.email), el("div", { class: "dim" }, "Used for sign-in codes and security alerts.")), badge(s.emailVerified, "Verified", "Not verified")),
          el("div", { class: "actions" },
            el("button", { type: "button", class: "btn small secondary", onclick: () => { editingEmail = true; draw(); } }, "Change email"),
            el("button", { type: "button", class: "btn small ghost", onclick: () => { open = open === "removeEmail" ? null : "removeEmail"; draw(); } }, "Remove")));
        if (open === "removeEmail") {
          put(card, el("p", { class: "hint" }, s.twoFactor.email ? "This also turns off email codes." : "Enter your password to remove this email."),
            passwordGate("Remove email", (pw) => run(() => api("POST", "/account/email/remove", { password: pw }), "Email removed.")));
        }
      }
      if (s.pendingEmail) {
        const code = el("input", { name: "code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", required: true, placeholder: "123456", class: "code-input", "aria-label": "Verification code" });
        const form = el("form", {}, el("p", {}, `We sent a 6-digit code to ${s.pendingEmail}. Enter it to verify the address.`),
          el("div", { class: "row" }, code, el("button", { type: "submit", class: "btn" }, "Verify")));
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          run(async () => { const r = await api("POST", "/account/email/verify", { code: code.value }); editingEmail = false; return { ...r, twoFactor: r.twoFactor }; }, "Email verified.");
        });
        put(card, form, el("button", { type: "button", class: "btn small ghost", onclick: () => run(() => api("POST", "/account/email", { email: s.pendingEmail }), "New code sent.") }, "Send a new code"));
      } else if (!s.email || editingEmail) {
        const input = el("input", { type: "email", name: "email", autocomplete: "email", required: true, placeholder: "you@example.com", "aria-label": "Email address" });
        const form = el("form", {}, el("p", { class: "muted" }, "Add an email so you can get sign-in codes. We'll send a code to check it's yours."),
          el("div", { class: "row" }, input, el("button", { type: "submit", class: "btn" }, "Send code")));
        form.addEventListener("submit", (e) => { e.preventDefault(); run(() => api("POST", "/account/email", { email: input.value }), "Code sent. Check your inbox."); });
        put(card, form);
        if (editingEmail) put(card, el("button", { type: "button", class: "btn small ghost", onclick: () => { editingEmail = false; draw(); } }, "Cancel"));
      }
      return card;
    }

    function discordCard() {
      const card = el("section", { class: "card" }, el("h2", {}, "Discord"));
      if (!s.discordLinking) {
        put(card, el("p", { class: "muted" }, "Linking isn't switched on for this server yet. You can still ", el("a", { href: DISCORD_INVITE, target: "_blank", rel: "noopener" }, "join the Discord"), "."));
        return card;
      }
      const linked = s.discord;
      if (linked) {
        put(card,
          el("div", { class: "set-row" },
            el("div", {}, el("strong", {}, linked.username), el("div", { class: "dim" }, "You're added to your own ticket channels in the server.")),
            el("span", { class: "badge ok" }, "Linked")),
          el("div", { class: "actions" },
            el("a", { class: "btn small secondary", href: DISCORD_INVITE, target: "_blank", rel: "noopener" }, "Open Discord", icon("out")),
            el("button", { type: "button", class: "btn small ghost", onclick: () => run(async () => { await api("POST", "/account/discord/unlink"); return { ...s, discord: null }; }, "Discord unlinked.") }, "Unlink")));
        return card;
      }
      put(card, el("p", { class: "muted" }, "Link your Discord account and the support bot will add you to your own ticket channel in the server, so you can follow a ticket there as well as here."));
      if (open === "discordCode" && linkCode) {
        put(card,
          el("ol", { class: "setup-steps" },
            el("li", {}, "Join the Valence Discord server if you haven't already."),
            el("li", {}, "In any channel there, type ", el("code", {}, "/link"), " and paste this code:"),
            el("li", {}, "Come back here; it links straight away.")),
          el("div", { class: "codebox" }, linkCode.code),
          el("div", { class: "row" }, copyButton(linkCode.code, "Copy code"),
            el("a", { class: "btn small secondary", href: linkCode.invite || DISCORD_INVITE, target: "_blank", rel: "noopener" }, "Open Discord", icon("out"))),
          el("p", { class: "hint" }, "The code works once and expires in 15 minutes."));
      } else {
        put(card, el("div", { class: "actions" }, el("button", { type: "button", class: "btn small", onclick: async () => {
          say("");
          try { linkCode = await api("POST", "/account/discord/link-code"); open = "discordCode"; } catch (err) { say(err.message); }
          draw();
        } }, icon("discord"), "Get my link code")));
      }
      return card;
    }

    function appRow() {
      const on = s.twoFactor.app;
      const row = el("div", { class: "tfa-row" },
        el("div", { class: "tfa-head" },
          el("span", { class: "page-ico tone-sky" }, icon("phone")),
          el("div", { class: "grow" }, el("strong", {}, "Authenticator app"),
            el("p", { class: "muted" }, "Get a new 6-digit code every 30 seconds from an app on your phone. We suggest Google Authenticator; Microsoft Authenticator, Authy and 1Password work too.")),
          badge(on)),
        el("div", { class: "actions" }, on
          ? el("button", { type: "button", class: "btn small ghost", onclick: () => { open = open === "appOff" ? null : "appOff"; draw(); } }, "Turn off")
          : el("button", { type: "button", class: "btn small", onclick: async () => {
            say("");
            try { setup = await api("POST", "/account/2fa/app/setup"); open = "appSetup"; } catch (err) { say(err.message); }
            draw();
          } }, "Set up")));
      if (open === "appOff") {
        put(row, el("p", { class: "hint" }, "Enter your password to turn off the authenticator app."),
          passwordGate("Turn off", (pw) => run(() => api("POST", "/account/2fa/app/disable", { password: pw }), "Authenticator app turned off.")));
      }
      if (open === "appSetup" && setup) {
        const code = el("input", { name: "code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", required: true, placeholder: "123456", class: "code-input", "aria-label": "6-digit code from your app" });
        const form = el("form", {}, el("div", { class: "row" }, code, el("button", { type: "submit", class: "btn" }, "Turn on")));
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          run(async () => { const r = await api("POST", "/account/2fa/app/enable", { code: code.value }); setup = null; return r; }, "Authenticator app is on. You'll need a code each time you log in.");
        });
        const key = setup.secret.replace(/(.{4})/g, "$1 ").trim();
        put(row, el("div", { class: "setup" },
          el("ol", { class: "setup-steps" },
            el("li", {}, "Install ", el("strong", {}, "Google Authenticator"), " (or any authenticator app) on your phone."),
            el("li", {}, "In the app, tap ", el("strong", {}, "+"), " and scan this QR code."),
            el("li", {}, "Type the 6-digit code it shows below.")),
          el("div", { class: "setup-body" },
            qrSvg(setup.otpauthUrl),
            el("div", {},
              el("p", { class: "hint" }, "Can't scan it? Choose \u201cEnter a setup key\u201d in the app and type:"),
              el("p", { class: "code key" }, key),
              copyButton(setup.secret, "Copy key"),
              el("label", {}, "Code from the app"),
              form,
              el("button", { type: "button", class: "btn small ghost", onclick: () => { open = null; setup = null; draw(); } }, "Cancel")))));
        setTimeout(() => code.focus(), 0);
      }
      return row;
    }

    function emailRow() {
      const on = s.twoFactor.email;
      const can = s.emailAvailable && s.emailVerified;
      const row = el("div", { class: "tfa-row" },
        el("div", { class: "tfa-head" },
          el("span", { class: "page-ico tone-cyan" }, icon("mail")),
          el("div", { class: "grow" }, el("strong", {}, "Email codes"),
            el("p", { class: "muted" }, can ? `When you log in, we email a 6-digit code to ${s.email}.` : "Verify an email address above to use this.")),
          badge(on)),
        el("div", { class: "actions" }, on
          ? el("button", { type: "button", class: "btn small ghost", onclick: () => { open = open === "emailOff" ? null : "emailOff"; draw(); } }, "Turn off")
          : (() => { const b = el("button", { type: "button", class: "btn small", onclick: () => { open = open === "emailOn" ? null : "emailOn"; draw(); } }, "Turn on"); if (!can) b.disabled = true; return b; })()));
      if (open === "emailOn") put(row, el("p", { class: "hint" }, "Enter your password to turn on email codes."), passwordGate("Turn on", (pw) => run(() => api("POST", "/account/2fa/email", { enable: true, password: pw }), "Email codes are on.")));
      if (open === "emailOff") put(row, el("p", { class: "hint" }, "Enter your password to turn off email codes."), passwordGate("Turn off", (pw) => run(() => api("POST", "/account/2fa/email", { enable: false, password: pw }), "Email codes turned off.")));
      return row;
    }

    function recoveryRow() {
      const any = s.twoFactor.app || s.twoFactor.email;
      if (!any) return null;
      const left = s.twoFactor.recoveryCodesLeft;
      const row = el("div", { class: "tfa-row" },
        el("div", { class: "tfa-head" },
          el("span", { class: "page-ico tone-indigo" }, icon("key")),
          el("div", { class: "grow" }, el("strong", {}, "Recovery codes"),
            el("p", { class: "muted" }, `${left} of 10 left. Use one to log in if you lose your phone or can't get to your email.`)),
          el("span", { class: "badge " + (left > 3 ? "ok" : "funded") }, `${left} left`)),
        el("div", { class: "actions" }, el("button", { type: "button", class: "btn small secondary", onclick: () => { open = open === "codes" ? null : "codes"; draw(); } }, "Make new codes")));
      if (open === "codes") put(row, el("p", { class: "hint" }, "Your old codes will stop working. Enter your password to continue."), passwordGate("Make new codes", (pw) => run(() => api("POST", "/account/2fa/recovery-codes", { password: pw }), "New recovery codes made.")));
      return row;
    }

    function draw() {
      if (!alive(gen)) return;
      wrap.textContent = "";
      const on = s.twoFactor.app || s.twoFactor.email;
      put(wrap,
        el("h2", { class: "section-title" }, "Security"),
        note,
        showCodes ? recoveryPanel(showCodes) : null,
        emailCard(),
        discordCard(),
        el("section", { class: "card" },
          el("div", { class: "row between" }, el("h2", {}, "Two-step verification"), badge(on, "On", "Off")),
          el("p", { class: "muted" }, "Ask for a code as well as your password when you log in, so a stolen password isn't enough to get into your account."),
          appRow(), emailRow(), recoveryRow()));
      showCodes = null;
    }

    api("GET", "/account/security").then((r) => { s = r; draw(); }).catch((err) => say(err.message));
    // The link happens in Discord, so check again when the tab comes back into view.
    const recheck = async () => {
      if (!alive(gen) || document.visibilityState !== "visible" || !s || s.discord) return;
      try {
        const r = await api("GET", "/account/security");
        if (alive(gen) && r.discord && !s.discord) { s = r; open = null; linkCode = null; say("Discord linked.", "ok"); draw(); }
      } catch { /* try again later */ }
    };
    document.addEventListener("visibilitychange", recheck);
    const poll = setInterval(() => { if (!alive(gen)) return clearInterval(poll); if (open === "discordCode") recheck(); }, 5000);
    app.timers.push(poll);
    put(wrap, el("p", { class: "muted" }, "Loading security settings..."));
    return wrap;
  }

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

    const swatches = el("div", { class: "palettes", role: "radiogroup", "aria-label": "Colour theme" });
    const current = me.palette || "blue";
    for (const [key, name, sub] of PALETTES) {
      const b = el("button", { type: "button", class: "palette", role: "radio", "data-palette-preview": key, "aria-checked": String(key === current) },
        el("span", { class: "palette-preview", "aria-hidden": "true" },
          el("span", { class: "pp-bar" }), el("span", { class: "pp-side" }),
          el("span", { class: "pp-card" }, el("i"), el("i"), el("i"))),
        el("span", { class: "palette-name" }, name), el("span", { class: "palette-sub" }, sub));
      b.addEventListener("click", async () => {
        const before = document.documentElement.getAttribute("data-palette") || "blue";
        applyPalette(key);
        for (const x of swatches.children) x.setAttribute("aria-checked", String(x === b));
        try {
          await api("POST", "/account/palette", { palette: key }, { noRedirect: true });
          app.me.palette = key;
        } catch (err) {
          applyPalette(before);
          for (const x of swatches.children) x.setAttribute("aria-checked", String(x.getAttribute("data-palette-preview") === before));
          toast(err.message);
        }
      });
      put(swatches, b);
    }

    put(view,
      el("section", { class: "card" },
        el("h2", {}, "Profile"),
        el("div", { class: "set-row" }, el("span", {}, me.kind === "agent" ? "Agent name" : "Username"), el("strong", {}, me.name)),
        me.handle ? el("div", { class: "set-row" }, el("span", {}, "Public handle"), el("div", { class: "row" }, el("code", {}, me.handle), copyButton(me.handle, "Copy"))) : null,
        el("div", { class: "set-row" }, el("span", {}, "Account type"), el("strong", {}, me.kind === "agent" ? "AI agent" : "Person")),
        el("div", { class: "set-row" }, el("span", {}, "Account ID"), el("div", { class: "row" }, el("code", {}, me.accountId), copyButton(me.accountId, "Copy"))),
        el("div", { class: "set-row" }, el("span", {}, "Currency"), el("strong", {}, "Set per deal"))),
      el("section", { class: "card" },
        el("h2", {}, "Appearance"),
        el("div", { class: "set-row" }, el("span", {}, "Mode"), seg),
        el("div", { class: "set-stack" },
          el("span", {}, "Colour theme"),
          el("p", { class: "hint" }, "Changes the site's colours for you while you're signed in. Saved to your account."),
          swatches)));

    try {
      put(view, payoutsCard(await api("GET", "/payouts")));
    } catch { /* the payments page shows this too */ }

    if (me.kind === "human") {
      put(view, securitySection(gen));
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

    put(view, el("section", { class: "card" }, el("h2", {}, "Sign out"),
      el("p", { class: "muted" }, "Sign out of Valence on this browser."),
      el("button", { type: "button", class: "btn secondary", onclick: logout }, "Log out")));
  }

  // ---------- start ----------
  setupTheme();
  setupTilt();
  setupDetails();
  setupDropdowns();
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
