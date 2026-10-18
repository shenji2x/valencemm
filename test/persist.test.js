// Saving and restoring data: snapshots, the file and Cloud Storage backends, and group commit.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../src/app");
const { createStore } = require("../src/store");
const { createPersistence, fileBackend, gcsBackend, ConflictError } = require("../src/persist");

async function start(opts = {}) {
  const server = createApp(opts);
  await server.ready;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, p, { key, body } = {}) {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json };
  }
  const close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return { server, call, close };
}

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "valence-")), "state.json");

test("a snapshot restores accounts, passwords, keys, sessions, deals, invites and the ledger", async () => {
  const a = createStore();
  const buyer = a.registerAgent("buyer");
  const seller = a.registerAgent("seller");
  const { token } = await a.registerHuman("alice", "password-123");
  const alice = a.authenticate(token);
  const b = a.authenticate(buyer.apiKey);
  const s = a.authenticate(seller.apiKey);
  const done = a.createDeal(b, { title: "done", amount: 30 });
  a.joinDeal(s, done.inviteCode);
  a.fundDeal(b, done.id);
  a.releaseDeal(b, done.id);
  const funded = a.createDeal(b, { title: "funded", amount: 20 });
  a.joinDeal(s, funded.inviteCode);
  a.fundDeal(b, funded.id);
  const open = a.createDeal(alice, { title: "open", amount: 5 });

  const restored = createStore();
  restored.importState(JSON.parse(JSON.stringify(a.exportState())));

  assert.deepEqual(restored.audit(), a.audit());
  assert.equal(restored.audit().ok, true);
  const rb = restored.authenticate(buyer.apiKey);
  assert.equal(rb.balance, 50);
  assert.equal(restored.authenticate(seller.apiKey).balance, 100 + 30 - 0); // 1% of 30 rounds down to 0
  assert.equal(restored.authenticate(token).username, "alice"); // session still valid
  assert.equal((await restored.loginHuman("alice", "password-123")).account.username, "alice");
  await assert.rejects(restored.loginHuman("alice", "wrong-password"), { code: "invalid_login" });
  assert.equal(restored.getDeal(rb, funded.id).state, "funded");
  assert.equal(restored.me(rb).recentLedger.length > 0, true);
  // the open deal's invite code still works, and used codes stay used
  const bob = restored.authenticate((await restored.registerHuman("bob", "password-123")).token);
  assert.equal(restored.joinDeal(bob, open.inviteCode).state, "joined");
  assert.throws(() => restored.joinDeal(restored.authenticate(seller.apiKey), done.inviteCode), { code: "invalid_invite" });
  await assert.rejects(restored.registerHuman("alice", "password-123"), { code: "username_taken" });
  assert.throws(() => restored.importState(a.exportState()), /empty store/);
});

test("data written through the API survives a restart (file storage)", async () => {
  const file = tmpFile();
  const one = await start({ backend: fileBackend(file) });
  const agent = (await one.call("POST", "/v1/agents/register", { body: { name: "keeper" } })).json;
  const human = (await one.call("POST", "/v1/humans/signup", { body: { username: "carol", password: "password-123" } })).json;
  const deal = (await one.call("POST", "/v1/deals", { key: agent.apiKey, body: { title: "Persist me", amount: 40, type: "ai-human" } })).json;
  assert.equal((await one.call("POST", "/v1/deals/join", { key: human.token, body: { inviteCode: deal.inviteCode } })).status, 200);
  assert.equal((await one.call("POST", `/v1/deals/${deal.id}/fund`, { key: agent.apiKey })).status, 200);
  await one.close();

  const two = await start({ backend: fileBackend(file) });
  try {
    const me = await two.call("GET", "/v1/me", { key: agent.apiKey });
    assert.equal(me.status, 200);
    assert.equal(me.json.balance, 60);
    const d = await two.call("GET", `/v1/deals/${deal.id}`, { key: human.token }); // session token still works
    assert.equal(d.json.state, "funded");
    assert.equal((await two.call("POST", "/v1/humans/login", { body: { username: "carol", password: "password-123" } })).status, 200);
    assert.equal((await two.call("POST", `/v1/deals/${deal.id}/release`, { key: agent.apiKey })).json.state, "released");
    assert.equal((await two.call("GET", "/health")).json.ledger, "balanced");
    assert.equal((await two.call("GET", "/health")).json.storage, "saved");
  } finally {
    await two.close();
  }
});

test("a success response is only sent after the change is saved, and bursts share writes", async () => {
  const writes = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const backend = {
    kind: "test",
    async read() { return null; },
    async write(text) {
      writes.push(JSON.parse(text));
      if (writes.length === 1) await gate; // hold the first write open
    },
  };
  const ctx = await start({ backend, registerLimit: 1000, globalLimit: 1000 });
  try {
    const first = ctx.call("POST", "/v1/agents/register", { body: { name: "a0" } });
    let firstDone = false;
    first.then(() => { firstDone = true; });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(firstDone, false, "responded before the write finished");
    const burst = Array.from({ length: 15 }, (_, i) => ctx.call("POST", "/v1/agents/register", { body: { name: "b" + i } }));
    await new Promise((r) => setTimeout(r, 50));
    release();
    const results = await Promise.all([first, ...burst]);
    assert.ok(results.every((r) => r.status === 201));
    assert.ok(writes.length <= 3, `expected the burst to share writes, got ${writes.length}`);
    assert.equal(writes.at(-1).accounts.length, 16); // the last snapshot has everyone
  } finally {
    await ctx.close();
  }
});

function fakeGcs() {
  const calls = [];
  let stored = null;
  let generation = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET" });
    const u = new URL(url);
    if (u.pathname.startsWith("/upload/")) {
      if (u.searchParams.get("ifGenerationMatch") !== String(generation)) return new Response("", { status: 412 });
      stored = init.body;
      generation += 1;
      return Response.json({ generation: String(generation) });
    }
    if (!stored) return new Response("", { status: 404 });
    return new Response(stored, { headers: { "x-goog-generation": String(generation) } });
  };
  return { calls, fetchImpl, bumpElsewhere: () => { generation += 1; } };
}

test("Cloud Storage backend: conditional writes, restore, and refusing to overwrite someone else's write", async () => {
  const gcs = fakeGcs();
  const backend = () => gcsBackend("bucket", "valence-state.json", { fetchImpl: gcs.fetchImpl, tokenProvider: async () => "tok" });

  const one = await start({ backend: backend() });
  const agent = (await one.call("POST", "/v1/agents/register", { body: { name: "cloud" } })).json;
  assert.match(gcs.calls.find((c) => c.method === "POST").url, /ifGenerationMatch=0/); // first write: object must not exist
  await one.call("POST", "/v1/deals", { key: agent.apiKey, body: { title: "x", amount: 1 } });
  await one.close();

  let fatal = null;
  const two = await start({ backend: backend(), onFatal: (err) => { fatal = err; } });
  try {
    assert.equal((await two.call("GET", "/v1/me", { key: agent.apiKey })).json.name, "cloud");
    assert.equal((await two.call("GET", "/v1/deals", { key: agent.apiKey })).json.deals.length, 1);
    gcs.bumpElsewhere(); // another instance wrote in the meantime
    const r = await two.call("POST", "/v1/agents/register", { body: { name: "late" } });
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, "storage_unavailable");
    await new Promise((res) => setImmediate(res));
    assert.ok(fatal instanceof ConflictError, "should restart rather than overwrite");
  } finally {
    await two.close();
  }
});

test("the server refuses to start when saved data can't be read", async () => {
  const backend = { kind: "test", async read() { throw new Error("bucket unreachable"); }, async write() {} };
  const server = createApp({ backend });
  await assert.rejects(server.ready, /bucket unreachable/);
});

test("group commit never runs two writes at once", async () => {
  const store = createStore();
  let active = 0;
  let maxActive = 0;
  const backend = {
    kind: "test",
    async write() {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    },
  };
  const p = createPersistence(store, backend);
  const all = [];
  for (let i = 0; i < 30; i++) {
    store.registerAgent("a" + i);
    all.push(p.commit());
    if (i % 7 === 0) await new Promise((r) => setTimeout(r, 3));
  }
  await Promise.all(all);
  assert.equal(maxActive, 1);
});
