// Builds a transcript of a support ticket: one self-contained HTML page, and a plain
// summary line for the Discord log. The same page is offered to the customer on the website
// and posted as a file in Discord when a ticket closes.

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const FROM_LABEL = { user: "Customer", staff: "Support", system: "System" };

function when(iso) {
  const d = new Date(iso);
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function duration(fromIso, toIso) {
  const ms = Date.parse(toIso || new Date().toISOString()) - Date.parse(fromIso);
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = min / 60;
  return h < 48 ? `${h.toFixed(1)} hours` : `${(h / 24).toFixed(1)} days`;
}

// `attachmentHref` turns an attachment into a link for the reader, or null to list it by name.
function transcriptHtml(data, { embedded = new Map(), siteUrl = "https://valencemm.com" } = {}) {
  const rows = data.messages.map((m) => {
    const who = m.from === "staff" ? esc(m.author || "Support") : m.from === "user" ? esc(data.customer.name) : "Valence";
    const files = (m.attachments || []).map((a) => {
      const label = `${esc(a.name)} (${Math.round(a.size / 1024)} KB)`;
      const src = embedded.get(a.id);
      return src
        ? `<figure class="att"><img src="${src}" alt="${esc(a.name)}"><figcaption>${label}</figcaption></figure>`
        : `<div class="att">${label}</div>`;
    }).join("");
    return `<div class="m ${esc(m.from)}">
      <div class="meta"><b>${who}</b> <span class="role">${FROM_LABEL[m.from] || ""}</span> <time>${esc(when(m.at))}</time></div>
      ${m.text ? `<div class="t">${esc(m.text)}</div>` : ""}${files}
    </div>`;
  }).join("\n");

  const handlers = data.handlers.length
    ? data.handlers.map((h) => (h.name === h.role ? esc(h.role) : `${esc(h.name)} (${esc(h.role)})`)).join(", ")
    : "nobody";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ticket #${data.number} transcript | Valence MM</title>
<style>
  :root { color-scheme: light dark; --bg:#f5f7fc; --card:#fff; --ink:#0a1222; --muted:#4b5872; --line:#e2e8f2; --accent:#1f5eff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#05070d; --card:#0b1019; --ink:#f1f5fc; --muted:#98a4bb; --line:#182133; --accent:#7aabff; } }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.6 -apple-system,Segoe UI,Roboto,Arial,sans-serif; }
  .wrap { max-width:760px; margin:0 auto; padding:32px 20px 60px; }
  h1 { font-size:1.6rem; margin:0 0 4px; letter-spacing:-.02em; }
  .sub { color:var(--muted); margin:0 0 24px; }
  dl { display:grid; grid-template-columns:max-content 1fr; gap:6px 20px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; margin:0 0 24px; }
  dt { color:var(--muted); } dd { margin:0; }
  .m { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin:0 0 10px; }
  .m.user { border-left:3px solid var(--accent); }
  .m.system { background:transparent; border-style:dashed; color:var(--muted); }
  .meta { font-size:.85rem; color:var(--muted); display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; }
  .meta b { color:var(--ink); }
  .role { text-transform:uppercase; letter-spacing:.06em; font-size:.72rem; }
  .t { white-space:pre-wrap; overflow-wrap:anywhere; margin-top:6px; }
  .att { margin:8px 0 0; font-size:.9rem; color:var(--muted); }
  figure.att img { display:block; max-width:100%; max-height:420px; border-radius:8px; border:1px solid var(--line); }
  figcaption { margin-top:4px; }
  footer { margin-top:28px; color:var(--muted); font-size:.85rem; }
  a { color:var(--accent); }
</style></head><body><div class="wrap">
<h1>Ticket #${data.number}: ${esc(data.subject)}</h1>
<p class="sub">Transcript of your conversation with Valence MM support.</p>
<dl>
  <dt>Status</dt><dd>${esc(data.status)}</dd>
  <dt>Topic</dt><dd>${esc(data.category)}</dd>
  ${data.dealId ? `<dt>Deal</dt><dd>${esc(data.dealId)}</dd>` : ""}
  <dt>Customer</dt><dd>${esc(data.customer.name)}${data.customer.discord ? ` · Discord ${esc(data.customer.discord)}` : ""}</dd>
  <dt>Handled by</dt><dd>${handlers}</dd>
  <dt>Opened</dt><dd>${esc(when(data.openedAt))}</dd>
  ${data.closedAt ? `<dt>Closed</dt><dd>${esc(when(data.closedAt))} (${esc(duration(data.openedAt, data.closedAt))})</dd>` : ""}
  <dt>Messages</dt><dd>${data.messages.length}</dd>
</dl>
${rows}
<footer>Generated ${esc(when(new Date().toISOString()))} · <a href="${esc(siteUrl)}">${esc(siteUrl.replace(/^https?:\/\//, ""))}</a></footer>
</div></body></html>`;
}

function transcriptSummary(data) {
  const handlers = data.handlers.length
    ? data.handlers.map((h) => (h.name === h.role ? h.role : `${h.name} (${h.role})`)).join(", ")
    : "nobody";
  return [
    `**${data.subject}**`,
    `Customer: ${data.customer.name}${data.customer.discord ? ` · Discord ${data.customer.discord}` : ""}`,
    `Topic: ${data.category}${data.dealId ? ` · Deal ${data.dealId}` : ""}`,
    `Handled by: ${handlers}`,
    `Opened: ${when(data.openedAt)}`,
    data.closedAt ? `Closed: ${when(data.closedAt)} by ${data.closedBy || "support"} (open ${duration(data.openedAt, data.closedAt)})` : `Still open (${duration(data.openedAt)})`,
    `Messages: ${data.messages.length}`,
  ].join("\n");
}

module.exports = { transcriptHtml, transcriptSummary };
