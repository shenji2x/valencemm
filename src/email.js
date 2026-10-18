// Sends security emails (verification and sign-in codes).
//
//   EMAIL_PROVIDER=resend   RESEND_API_KEY=re_...   EMAIL_FROM="Valence MM <security@valencemm.com>"
//   EMAIL_PROVIDER=log      prints emails to the server log instead (local development only)
//   unset                   email features are switched off and the website says so
//
// Resend (resend.com) is used because it's a single HTTPS call, so no extra packages are needed.

function createMailer(cfg = {}) {
  const fetchImpl = cfg.fetchImpl || ((...a) => fetch(...a));
  const provider = cfg.provider || null;

  if (provider === "resend" && cfg.apiKey && cfg.from) {
    return {
      enabled: true,
      kind: "resend",
      async send({ to, subject, text, html }) {
        const res = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: "Bearer " + cfg.apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ from: cfg.from, to: [to], subject, text, html }),
        });
        if (!res.ok) throw new Error(`Email provider refused the message: ${res.status} ${await res.text().catch(() => "")}`);
      },
    };
  }
  if (provider === "log") {
    return {
      enabled: true,
      kind: "log",
      async send({ to, subject, text }) {
        console.log(`[email to ${to}] ${subject}\n${text}`);
      },
    };
  }
  return { enabled: false, kind: "off", async send() { throw new Error("Email is not set up on this server"); } };
}

function mailerFromEnv(env = process.env) {
  return createMailer({ provider: env.EMAIL_PROVIDER, apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function codeEmail({ code, purpose, username }) {
  const why = purpose === "verify" ? "confirm this email address for your Valence MM account" : "finish signing in to Valence MM";
  const subject = purpose === "verify" ? `${code} is your Valence MM verification code` : `${code} is your Valence MM sign-in code`;
  const text = `Hi ${username},\n\nUse this code to ${why}:\n\n${code}\n\nIt expires in 10 minutes. If you didn't ask for it, you can ignore this email` +
    (purpose === "login" ? ", but someone may know your password, so consider changing it." : ".") + "\n\nValence MM";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0a1222">
<p>Hi ${esc(username)},</p><p>Use this code to ${why}:</p>
<p style="font-family:Consolas,Menlo,monospace;font-size:30px;letter-spacing:6px;font-weight:bold;background:#eef3fd;border-radius:8px;padding:14px 18px;text-align:center">${esc(code)}</p>
<p style="color:#4b5872">It expires in 10 minutes. If you didn't ask for it, you can ignore this email${purpose === "login" ? ", but someone may know your password, so consider changing it" : ""}.</p>
<p style="color:#4b5872">Valence MM</p></div>`;
  return { subject, text, html };
}

module.exports = { createMailer, mailerFromEnv, codeEmail };
