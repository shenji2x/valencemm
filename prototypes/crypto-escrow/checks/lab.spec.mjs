import assert from "node:assert/strict";
import http from "node:http";
import { before, after, test } from "node:test";
import { startServer } from "../scripts/lab.mjs";

let running, state;
before(async () => {
  running = await startServer({ port: 0 });
  state = await (await fetch(running.url + "/api/state")).json();
});
after(async () => { await running?.close(); });
function post(path, input, headers = {}) {
  return fetch(running.url + path, { method: "POST", headers: {
    "Content-Type": "application/json", "X-Lab-Token": state.token, ...headers
  }, body: JSON.stringify(input) });
}

test("lab binds to loopback, clearly labels test money, and serves a restrictive CSP", async () => {
  assert.equal(running.server.address().address, "127.0.0.1");
  assert.equal(state.chainId, 31337); assert.equal(state.testMoneyOnly, true);
  const page = await fetch(running.url);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(await page.text(), /not real USDT/);
  assert.equal(state.deals[0].total, "101.0");
  assert.equal(state.deals[0].fee, "1.0");
});

test("mutation without the local session token is rejected", async () => {
  const response = await post("/api/reset", {}, { "X-Lab-Token": "" });
  assert.equal(response.status, 403);
});

test("cross-origin and cross-site mutations are rejected even with a token", async () => {
  assert.equal((await post("/api/reset", {}, { Origin: "https://example.com" })).status, 403);
  assert.equal((await post("/api/reset", {}, { "Sec-Fetch-Site": "cross-site" })).status, 403);
});

test("unexpected Host header cannot use a DNS-rebinding origin", async () => {
  const status = await new Promise((resolve, reject) => {
    const request = http.get(running.url + "/api/state", { headers: { Host: "attacker.example" } }, response => {
      response.resume(); response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
  });
  assert.equal(status, 403);
});

test("unsupported real assets, negative amounts and sub-atomic percentage fees are refused", async () => {
  for (const input of [{ asset: "BTC", amount: "100" }, { asset: "TESTUSD", amount: "-100" },
    { asset: "TESTUSD", amount: "0.000001" }]) {
    assert.equal((await post("/api/fund", input)).status, 400);
  }
  assert.equal((await (await fetch(running.url + "/api/state")).json()).deals.length, 1);
});

test("plain-text mutations and arbitrary time values are refused", async () => {
  assert.equal((await post("/api/reset", {}, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post("/api/time", { seconds: -1 })).status, 400);
});

test("concurrent local funding is serialized and creates different on-chain deals", async () => {
  const responses = await Promise.all([post("/api/fund", { asset: "TESTUSD", amount: "10" }),
    post("/api/fund", { asset: "ETH", amount: "0.1" })]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  state = await (await fetch(running.url + "/api/state")).json();
  assert.equal(state.deals.length, 3);
  assert.equal(new Set(state.deals.map(d => d.id)).size, 3);
});

test("HTTP demo resolves a dispute, refunds the fee, and records the customer's gas", async () => {
  const deal = state.deals.find(d => d.number === 1);
  for (const action of ["dispute", "resolveBuyer", "claimBuyer"]) {
    const response = await post("/api/action", { id: deal.id, action });
    assert.equal(response.status, 200); state = await response.json();
  }
  const result = state.deals.find(d => d.id === deal.id);
  assert.equal(result.state, "Refunded"); assert.equal(Number(result.claims.buyer), 0);
  assert.equal(Number(result.claims.treasury), 0);
  assert.equal(state.activity[0].role, "buyer");
  assert.ok(BigInt(state.activity[0].gasWei) > 0n);
});
