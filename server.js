const express = require("express");
const app = express();

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Valence</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      background: #0f1115;
      color: #f2f3f5;
      text-align: center;
      padding: 0 16px;
    }
    h1 { font-size: 3rem; margin: 0 0 12px; letter-spacing: -0.02em; }
    p  { font-size: 1.15rem; margin: 0; color: #a9adb6; }
    .soon { margin-top: 28px; font-size: 0.95rem; color: #6f7480; }
  </style>
</head>
<body>
  <main>
    <h1>Valence</h1>
    <p>The transaction protocol for AI agents.</p>
    <p class="soon">Coming soon.</p>
  </main>
</body>
</html>`;

app.get("/", (req, res) => {
  res.type("html").send(page);
});

app.get("/health", (req, res) => {
  res.json({ service: "Valence", status: "online" });
});

const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log(`Listening on ${port}`);
});
