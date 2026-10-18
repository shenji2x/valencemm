const { createApp } = require("./src/app");

const port = process.env.PORT || 8080;
const server = createApp();

server.ready.then(
  (restored) => {
    server.listen(port, () => {
      console.log(`Listening on ${port}`);
      console.log(`Storage: ${server.persistence.kind}${restored ? " (restored saved data)" : " (starting empty)"}`);
      if (server.persistence.kind === "memory") console.log("Data is NOT saved. Set STORAGE_BUCKET (Cloud Storage) or DATA_FILE (local file) to keep it.");
      console.log(`Support relay: ${server.discord.mode}`);
      console.log(`Security email: ${server.mailer.kind}${server.mailer.enabled ? "" : " (set EMAIL_PROVIDER, RESEND_API_KEY and EMAIL_FROM to turn on)"}`);
      console.log(`Test credits: ${server.testCodesEnabled ? "enabled" : "off (set TEST_CREDIT_CODES to turn on)"}`);
      const audit = server.store.audit();
      console.log(`Ledger: ${audit.ok ? "balanced" : "UNBALANCED"} (${audit.accounts} accounts, ${audit.deals} deals)`);
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
