// AI agents get a random public handle instead of a username they choose.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createStore } = require("../src/store");
const { createPersistence, fileBackend } = require("../src/persist");
const { reservedUsername } = require("../src/policy");
const { createApp } = require("../src/app");

const HANDLE = /^ai-[abcdefghjkmnpqrstuvwxyz23456789]{12}$/;

test("every agent gets a random handle that ignores its name", () => {
  const store = createStore();
  const seen = new Set();
  for (let i = 0; i < 1500; i++) {
    const a = store.registerAgent("same-name");
    assert.match(a.handle, HANDLE);
    assert.ok(!seen.has(a.handle), "handles must be unique");
    seen.add(a.handle);
    assert.ok(!a.handle.includes("same"), "the handle must not come from the name");
    assert.ok(!a.handle.includes(a.agentId.slice(6, 12)), "the handle must not come from the ID");
  }
  // No look-alike characters, so it reads unambiguously when someone copies it by hand.
  for (const h of seen) assert.doesNotMatch(h.slice(3), /[01ilo]/);
});

test("the handle shows on the agent's own account and to the other side of a deal, never on people", async () => {
  const store = createStore();
  const agent = store.registerAgent("helper");
  const me = store.me(store.authenticate(agent.apiKey));
  assert.equal(me.handle, agent.handle);
  const person = await store.registerHuman("maya", "correct-horse-1");
  assert.equal(person.account.handle, undefined);

  const deal = store.createDeal(store.authenticate(person.token), { title: "Job", amount: 5000, type: "ai-human" });
  const joined = store.joinDeal(store.authenticate(agent.apiKey), deal.inviteCode);
  const seenByPerson = store.getDeal(store.authenticate(person.token), joined.id);
  const parties = JSON.stringify(seenByPerson);
  assert.ok(parties.includes(agent.handle), "the person should see the agent's handle on the deal");
});

test("agents saved before handles existed get one on load, and it's saved so it never changes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "valence-handles-"));
  const file = path.join(dir, "state.json");
  try {
    // An old snapshot: two agents without handles, one with.
    const old = createStore();
    const a1 = old.registerAgent("old-one");
    const a2 = old.registerAgent("old-two");
    const keep = old.registerAgent("already-has-one");
    const snap = old.exportState();
    for (const acct of snap.accounts) if (acct.id !== keep.agentId) delete acct.handle;
    fs.writeFileSync(file, JSON.stringify(snap));

    const first = createStore();
    await createPersistence(first, fileBackend(file)).load();
    const h1 = first.me(first.authenticate(a1.apiKey)).handle;
    const h2 = first.me(first.authenticate(a2.apiKey)).handle;
    assert.match(h1, HANDLE);
    assert.match(h2, HANDLE);
    assert.notEqual(h1, h2);
    assert.equal(first.me(first.authenticate(keep.apiKey)).handle, keep.handle, "existing handles are kept");

    // Restart without any other change: the backfilled handles must be the same.
    const second = createStore();
    await createPersistence(second, fileBackend(file)).load();
    assert.equal(second.me(second.authenticate(a1.apiKey)).handle, h1);
    assert.equal(second.me(second.authenticate(a2.apiKey)).handle, h2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("over the API an agent can't choose its handle, and people can't register look-alikes", async () => {
  const server = createApp({ skipTimers: true, powDifficulty: 0 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(base + "/v1/agents/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "picker", handle: "ai-chosenname1", username: "admin" }),
    });
    const agent = await res.json();
    assert.equal(res.status, 201);
    assert.match(agent.handle, HANDLE);
    assert.notEqual(agent.handle, "ai-chosenname1");

    const copy = agent.handle.replace("ai-", "ai_");
    const signup = await fetch(base + "/v1/humans/signup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: copy, password: "correct-horse-1" }),
    });
    assert.equal((await signup.json()).error.code, "username_reserved");
  } finally {
    await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  }
  for (const name of ["ai_7kq2xm9p4tzd", "agent_smith", "AI_helper"]) assert.equal(reservedUsername(name), true, name);
  for (const name of ["aiden", "aisha", "agentina", "kai_two"]) assert.equal(reservedUsername(name), false, name);
});
