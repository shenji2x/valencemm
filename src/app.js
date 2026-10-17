const express = require("express");
const path = require("path");
const { createStore } = require("./store");
const { createApi } = require("./api");

function createApp(opts = {}) {
  const app = express();
  const store = createStore({ now: opts.now });

  app.disable("x-powered-by");
  app.set("trust proxy", 1); // Cloud Run sits behind one Google proxy hop

  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    next();
  });

  app.use(express.json({ limit: "10kb" }));

  app.get("/health", (req, res) => {
    res.json({ service: "Valence", status: "online", mode: "play-credits", ledger: store.audit().ok ? "balanced" : "UNBALANCED" });
  });

  app.use("/v1", createApi(store, opts));

  app.use(express.static(path.join(__dirname, "..", "public"), { extensions: ["html"] }));

  app.use((req, res) => res.status(404).type("text").send("Not found"));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === "entity.parse.failed") {
      return res.status(400).json({ error: { code: "invalid_json", message: "Request body is not valid JSON" } });
    }
    if (err.type === "entity.too.large") {
      return res.status(413).json({ error: { code: "too_large", message: "Request body too large" } });
    }
    if (err.status && err.code) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    console.error(err);
    res.status(500).json({ error: { code: "internal", message: "Something went wrong" } });
  });

  app.locals.store = store;
  return app;
}

module.exports = { createApp };
