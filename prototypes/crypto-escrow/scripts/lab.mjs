import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createLab } from "./local.mjs";

const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]]
]);
const publicRoot = fileURLToPath(new URL("../ui/", import.meta.url));
async function body(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > 4096) throw new Error("Request too large");
  }
  const value = JSON.parse(data || "{}");
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Expected a JSON object");
  return value;
}

export async function startServer({ port = 8790 } = {}) {
  let lab = await createLab();
  await lab.fund("TESTUSD", "100");
  const token = randomBytes(32).toString("hex");
  let queue = Promise.resolve();
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const send = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(value));
    };
    const actualPort = server.address()?.port;
    const hosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
    if (!hosts.includes(req.headers.host)) return send(403, { error: "This demo only accepts localhost requests" });
    if (req.headers["sec-fetch-site"] === "cross-site") return send(403, { error: "Cross-site requests are blocked" });
    const url = new URL(req.url, `http://127.0.0.1:${actualPort}`);
    try {
      if (req.method === "GET" && files.has(url.pathname)) {
        const [name, type] = files.get(url.pathname);
        res.writeHead(200, { "Content-Type": type });
        res.end(await fs.readFile(path.join(publicRoot, name)));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        await queue;
        return send(200, { ...await lab.state(), token });
      }
      if (req.method !== "POST" || !["/api/fund", "/api/action", "/api/time", "/api/reset"].includes(url.pathname)) {
        return send(404, { error: "Not found" });
      }
      if (req.headers.origin && !hosts.some(host => req.headers.origin === `http://${host}`)) {
        return send(403, { error: "Origin is not allowed" });
      }
      const supplied = req.headers["x-lab-token"] || "";
      if (typeof supplied !== "string" || supplied.length !== token.length
          || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
        return send(403, { error: "Reload the local demo before making changes" });
      }
      if (!req.headers["content-type"]?.startsWith("application/json")) return send(415, { error: "JSON required" });
      const input = await body(req);
      const operation = queue.then(async () => {
        if (url.pathname === "/api/fund") await lab.fund(input.asset, input.amount);
        if (url.pathname === "/api/action") await lab.act(input.id, input.action);
        if (url.pathname === "/api/time") {
          if (![86401, 259201].includes(input.seconds)) throw new Error("Choose one of the local time controls");
          await lab.advance(input.seconds);
        }
        if (url.pathname === "/api/reset") {
          const fresh = await createLab();
          try { await fresh.fund("TESTUSD", "100"); }
          catch (error) { await fresh.close(); throw error; }
          await lab.close(); lab = fresh;
        }
        return { ...await lab.state(), token };
      });
      queue = operation.catch(() => {});
      send(200, await operation);
    } catch (error) {
      send(400, { error: error.revert?.name || error.shortMessage || error.message || "That action failed" });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.maxHeadersCount = 40;
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  } catch (error) { await lab.close(); throw error; }
  return { server, url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await queue;
      await new Promise(resolve => server.close(resolve));
      await lab.close();
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const running = await startServer();
  console.log(`Valence escrow lab: ${running.url}`);
  console.log("LOCAL TEST MONEY ONLY. All roles are simulated. No public RPC, wallet connection or billing.");
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await running.close(); process.exit(0); });
}
