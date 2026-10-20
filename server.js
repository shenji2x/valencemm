const { createApp } = require("./src/app");

const port = process.env.PORT || 8080;
// POW_SECRET signs anti-bot challenges. Optional with one instance (a random one is made at start);
// set it if the service ever runs more than one instance, so they all accept each other's challenges.
const server = createApp({ powSecret: process.env.POW_SECRET ? Buffer.from(process.env.POW_SECRET) : undefined });

server.ready.then(
  (restored) => {
    server.listen(port, () => {
      console.log(`Listening on ${port}`);
      console.log(`Storage: ${server.persistence.kind}${restored ? " (restored saved data)" : " (starting empty)"}`);
      if (server.persistence.kind === "memory") console.log("Data is NOT saved. Set STORAGE_BUCKET (Cloud Storage) or DATA_FILE (local file) to keep it.");
      console.log(`Support relay: ${server.discord.mode}`);
      console.log(`Security email: ${server.mailer.kind}${server.mailer.enabled ? "" : " (set EMAIL_PROVIDER, RESEND_API_KEY and EMAIL_FROM to turn on)"}`);
      console.log(`Card payments: ${server.stripe.configured ? "on" : "off (set STRIPE_SECRET_KEY to turn on)"}`);
      console.log(`Stripe webhooks: ${server.stripe.acceptsWebhooks ? "on" : "off (set STRIPE_WEBHOOK_SECRET to accept them)"}`);
      console.log(`Anti-bot: proof-of-work on sign-up; client IPs from ${process.env.TRUST_CLOUDFLARE === "1" ? "Cloudflare (CF-Connecting-IP, verified)" : "Cloud Run (X-Forwarded-For)"}`);
      const audit = server.store.audit();
      console.log(`Deals: ${audit.ok ? "consistent" : "NEEDS ATTENTION: " + audit.problems.join("; ")} (${audit.accounts} accounts, ${audit.deals} deals)`);
      if (audit.holdsAtRisk) console.log(`${audit.holdsAtRisk} card hold(s) are close to expiring.`);
    });
  },
  (err) => {
    // Never start on top of data we couldn't read: that would overwrite it with an empty store.
    console.error("FATAL: could not load saved data.", err);
    process.exit(1);
  }
);

// Cloud Run sends SIGTERM before stopping an instance.
process.on("SIGTERM", () => server.close(() => process.exit(0)));
