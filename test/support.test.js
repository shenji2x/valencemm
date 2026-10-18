// Support tickets (with a fake Discord), stats, invite previews and password changes.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/app");
const { createDiscord } = require("../src/discord");
const { fileBackend } = require("../src/persist");
const fs = require("fs");
const os = require("os");
const path = require("path");

async function start(opts = {}) {
  const clock = { t: Date.parse("2026-10-17T00:00:00Z") };
  const server = createApp({ now: () => clock.t, ...opts });
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
  const human = async (u) => (await call("POST", "/v1/humans/signup", { body: { username: u, password: "password-123" } })).json;
  const agent = async (n) => (await call("POST", "/v1/agents/register", { body: { name: n } })).json;
  const close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return { server, call, human, agent, clock, close };
}

async function withServer(opts, fn) {
  const ctx = await start(opts);
  try { await fn(ctx); } finally { await ctx.close(); }
}

// A tiny in-memory Discord: channels, messages and a bot user.
function fakeDiscordApi() {
  let seq = 1000n;
  const nextId = () => String(++seq);
  const channels = new Map(); // id -> { name, messages: [] }
  const calls = [];
  const BOT = { id: "bot-1", username: "valence", bot: true };
  async function fetchImpl(url, init = {}) {
    const method = init.method || "GET";
    const u = new URL(url);
    calls.push({ method, path: u.pathname, auth: init.headers && init.headers.Authorization });
    const body = init.body ? JSON.parse(init.body) : null;
    let m;
    if (u.pathname === "/api/v10/users/@me") return Response.json(BOT);
    if ((m = u.pathname.match(/^\/api\/v10\/guilds\/(\w+)\/channels$/)) && method === "POST") {
      const id = nextId();
      channels.set(id, { name: body.name, parent: body.parent_id, messages: [] });
      return Response.json({ id, name: body.name });
    }
    if ((m = u.pathname.match(/^\/api\/v10\/channels\/(\w+)\/messages$/))) {
      const ch = channels.get(m[1]);
      if (!ch) return new Response("unknown channel", { status: 404 });
      if (method === "POST") {
        assert.deepEqual(body.allowed_mentions, { parse: [] }, "pings must be disabled");
        const msg = { id: nextId(), author: BOT, content: body.content || "", embeds: body.embeds };
        ch.messages.push(msg);
        return Response.json(msg);
      }
      const after = u.searchParams.get("after");
      const list = ch.messages.filter((x) => !after || BigInt(x.id) > BigInt(after)).reverse(); // newest first, like Discord
      return Response.json(list);
    }
    if ((m = u.pathname.match(/^\/api\/v10\/channels\/(\w+)$/)) && method === "PATCH") {
      channels.get(m[1]).name = body.name;
      return Response.json({ id: m[1], name: body.name });
    }
    return new Response("not found", { status: 404 });
  }
  const staffSays = (channelId, text, name = "sean") => {
    channels.get(channelId).messages.push({ id: nextId(), author: { id: "u-1", username: name }, content: text });
  };
  return { fetchImpl, channels, calls, staffSays };
}

test("support tickets: a channel per ticket, messages both ways, !close, no pings", async () => {
  const api = fakeDiscordApi();
  const discord = createDiscord({ botToken: "tok", guildId: "g1", categoryId: "cat9", fetchImpl: api.fetchImpl, syncEveryMs: 0 });
  await withServer({ discord }, async (ctx) => {
    const alice = await ctx.human("alice");
    const info = await ctx.call("GET", "/v1/support");
    assert.equal(info.json.discordInvite, "https://discord.gg/eVYyxbyy22");
    assert.equal(info.json.liveReplies, true);

    const bad = await ctx.call("POST", "/v1/tickets", { key: alice.token, body: { category: "nope", subject: "Help", message: "Hello there" } });
    assert.equal(bad.status, 400);
    const created = await ctx.call("POST", "/v1/tickets", { key: alice.token, body: { category: "deal", subject: "Deal stuck", message: "My deal won't release @everyone" } });
    assert.equal(created.status, 201);
    const ticket = created.json;
    assert.equal(ticket.number, 1);
    assert.equal(ticket.status, "open");
    assert.equal(ticket.messages.length, 1);
    assert.equal(ticket.discord, undefined, "Discord ids are never sent to the browser");

    const [channelId, channel] = [...api.channels.entries()][0];
    assert.match(channel.name, /^ticket-1-deal-stuck$/);
    assert.equal(channel.parent, "cat9");
    assert.equal(channel.messages.length, 1);
    assert.ok(api.calls.every((c) => c.auth === "Bot tok"));

    // customer follows up: relayed to the channel
    const follow = await ctx.call("POST", `/v1/tickets/${ticket.id}/messages`, { key: alice.token, body: { text: "Any update?" } });
    assert.equal(follow.status, 201);
    assert.equal(channel.messages.length, 2);
    assert.equal(channel.messages[1].embeds[0].description, "Any update?");

    // staff reply in Discord shows up on the website, once
    api.staffSays(channelId, "Looking into it now");
    let got = await ctx.call("GET", `/v1/tickets/${ticket.id}`, { key: alice.token });
    let staff = got.json.messages.filter((m) => m.from === "staff");
    assert.equal(staff.length, 1);
    assert.equal(staff[0].text, "Looking into it now");
    assert.equal(staff[0].author, "sean");
    got = await ctx.call("GET", `/v1/tickets/${ticket.id}`, { key: alice.token });
    assert.equal(got.json.messages.filter((m) => m.from === "staff").length, 1, "no duplicates on the next poll");

    // the list view also pulls replies
    api.staffSays(channelId, "Fixed, try again");
    const list = await ctx.call("GET", "/v1/tickets", { key: alice.token });
    assert.equal(list.json.tickets[0].lastMessage.text, "Fixed, try again");

    // other people can't see it
    const bob = await ctx.human("bob");
    assert.equal((await ctx.call("GET", `/v1/tickets/${ticket.id}`, { key: bob.token })).status, 404);

    // staff close it from Discord
    api.staffSays(channelId, "!close");
    got = await ctx.call("GET", `/v1/tickets/${ticket.id}`, { key: alice.token });
    assert.equal(got.json.status, "closed");
    const reply = await ctx.call("POST", `/v1/tickets/${ticket.id}/messages`, { key: alice.token, body: { text: "one more thing" } });
    assert.equal(reply.status, 409);

    // customer closes a second ticket: channel renamed
    const t2 = (await ctx.call("POST", "/v1/tickets", { key: alice.token, body: { subject: "Another", message: "Second question" } })).json;
    const closed = await ctx.call("POST", `/v1/tickets/${t2.id}/close`, { key: alice.token });
    assert.equal(closed.json.status, "closed");
    assert.ok([...api.channels.values()].some((c) => c.name.startsWith("closed-2-")));
  });
});

test("support tickets still work when Discord is down or not set up", async () => {
  const down = createDiscord({ botToken: "tok", guildId: "g1", fetchImpl: async () => new Response("boom", { status: 500 }) });
  await withServer({ discord: down }, async (ctx) => {
    const a = await ctx.human("carol");
    const r = await ctx.call("POST", "/v1/tickets", { key: a.token, body: { subject: "Help me", message: "Something broke" } });
    assert.equal(r.status, 201);
    assert.equal((await ctx.call("POST", `/v1/tickets/${r.json.id}/messages`, { key: a.token, body: { text: "still broken" } })).status, 201);
    assert.equal((await ctx.call("GET", `/v1/tickets/${r.json.id}`, { key: a.token })).json.messages.length, 2);
  });
  await withServer({}, async (ctx) => {
    const a = await ctx.human("dave");
    assert.equal((await ctx.call("GET", "/v1/support")).json.liveReplies, false);
    assert.equal((await ctx.call("POST", "/v1/tickets", { key: a.token, body: { subject: "Hello", message: "Plain website ticket" } })).status, 201);
    for (let i = 0; i < 4; i++) await ctx.call("POST", "/v1/tickets", { key: a.token, body: { subject: "More " + i, message: "Another one" } });
    const six = await ctx.call("POST", "/v1/tickets", { key: a.token, body: { subject: "Sixth", message: "Too many open" } });
    assert.equal(six.status, 429);
  });
});

test("webhook mode posts new tickets as forum threads, and falls back for normal channels", async () => {
  const posts = [];
  const forum = createDiscord({
    webhookUrl: "https://discord.com/api/webhooks/1/abc",
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      posts.push({ url, body });
      return Response.json({ id: "m1", channel_id: body.thread_name ? "thread-77" : "chan-1" });
    },
  });
  await withServer({ discord: forum }, async (ctx) => {
    const a = await ctx.human("erin");
    const t = (await ctx.call("POST", "/v1/tickets", { key: a.token, body: { subject: "Forum test", message: "Hello forum" } })).json;
    await ctx.call("POST", `/v1/tickets/${t.id}/messages`, { key: a.token, body: { text: "follow up" } });
    assert.match(posts[0].body.thread_name, /^#1 Forum test$/);
    assert.match(posts[1].url, /thread_id=thread-77/);
    assert.equal(posts[1].body.username, "Valence Support");
  });

  const plain = [];
  const textChannel = createDiscord({
    webhookUrl: "https://discord.com/api/webhooks/1/abc",
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      plain.push(body);
      if (body.thread_name) return Response.json({ code: 220003, message: "Webhooks can only create threads in forum channels" }, { status: 400 });
      return Response.json({ id: "m2", channel_id: "chan-1" });
    },
  });
  await withServer({ discord: textChannel }, async (ctx) => {
    const a = await ctx.human("fred");
    assert.equal((await ctx.call("POST", "/v1/tickets", { key: a.token, body: { subject: "Text test", message: "Hello channel" } })).status, 201);
    assert.equal(plain.length, 2);
    assert.equal(plain[1].thread_name, undefined);
  });
});

test("tickets survive a restart", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "valence-")), "state.json");
  let token, id;
  await withServer({ backend: fileBackend(file) }, async (ctx) => {
    token = (await ctx.human("gina")).token;
    id = (await ctx.call("POST", "/v1/tickets", { key: token, body: { subject: "Keep me", message: "Saved ticket" } })).json.id;
  });
  await withServer({ backend: fileBackend(file) }, async (ctx) => {
    const t = await ctx.call("GET", `/v1/tickets/${id}`, { key: token });
    assert.equal(t.json.subject, "Keep me");
    const t2 = await ctx.call("POST", "/v1/tickets", { key: token, body: { subject: "Next", message: "Numbering continues" } });
    assert.equal(t2.json.number, 2);
  });
});

test("stats: volume, fees, durations, completion rate and a daily series", () => withServer({}, async (ctx) => {
  const buyer = await ctx.agent("buyer");
  const seller = await ctx.agent("seller");
  const deal = async (amount, hoursToRelease) => {
    const d = (await ctx.call("POST", "/v1/deals", { key: buyer.apiKey, body: { title: "job", amount } })).json;
    await ctx.call("POST", "/v1/deals/join", { key: seller.apiKey, body: { inviteCode: d.inviteCode } });
    await ctx.call("POST", `/v1/deals/${d.id}/fund`, { key: buyer.apiKey });
    if (hoursToRelease == null) return d;
    ctx.clock.t += hoursToRelease * 3600 * 1000;
    await ctx.call("POST", `/v1/deals/${d.id}/release`, { key: buyer.apiKey });
    return d;
  };
  await deal(50, 2);
  await deal(30, 4);
  await deal(10); // still in escrow
  const cancel = (await ctx.call("POST", "/v1/deals", { key: buyer.apiKey, body: { title: "nah", amount: 5 } })).json;
  await ctx.call("POST", `/v1/deals/${cancel.id}/cancel`, { key: buyer.apiKey });

  const b = (await ctx.call("GET", "/v1/stats", { key: buyer.apiKey })).json;
  assert.equal(b.totalDeals, 4);
  assert.equal(b.counts.released, 2);
  assert.equal(b.counts.cancelled, 1);
  assert.equal(b.active, 1);
  assert.equal(b.volume.sent, 80);
  assert.equal(b.volume.inEscrow, 10);
  assert.equal(b.completionRate, 2 / 3);
  assert.equal(b.durationMs.avgFundedToReleased, 3 * 3600 * 1000);
  assert.equal(b.durationMs.fastest, 2 * 3600 * 1000);
  assert.equal(b.daily.length, 30);
  assert.equal(b.daily.reduce((s, d) => s + d.volume, 0), 80);

  const s = (await ctx.call("GET", "/v1/stats", { key: seller.apiKey })).json;
  assert.equal(s.volume.received, 50 + 30); // 1% of 50 and 30 rounds down to 0
  assert.equal(s.volume.sent, 0);
}));

test("invite preview shows the deal before joining and explains who can join", () => withServer({}, async (ctx) => {
  const alice = await ctx.human("alice");
  const bob = await ctx.human("bob");
  const bot = await ctx.agent("bot");
  const d = (await ctx.call("POST", "/v1/deals", { key: alice.token, body: { title: "Logo", amount: 40, role: "seller", description: "Vector logo" } })).json;
  const p = await ctx.call("GET", `/v1/deals/invite/${d.inviteCode.toLowerCase()}`, { key: bob.token });
  assert.equal(p.status, 200);
  assert.equal(p.json.title, "Logo");
  assert.equal(p.json.yourRole, "buyer");
  assert.equal(p.json.canJoin, true);
  assert.equal(p.json.creator.name, "alice");
  const wrong = await ctx.call("GET", `/v1/deals/invite/${d.inviteCode}`, { key: bot.apiKey });
  assert.equal(wrong.json.canJoin, false);
  assert.match(wrong.json.reason, /person/);
  assert.equal((await ctx.call("GET", `/v1/deals/invite/${d.inviteCode}`, { key: alice.token })).json.canJoin, false);
  assert.equal((await ctx.call("GET", "/v1/deals/invite/ZZZZ-ZZZZ", { key: bob.token })).status, 404);
  // previewing doesn't use up the code
  assert.equal((await ctx.call("POST", "/v1/deals/join", { key: bob.token, body: { inviteCode: d.inviteCode } })).status, 200);
}));

test("changing a password signs out other browsers but keeps this one", () => withServer({}, async (ctx) => {
  const first = await ctx.human("hank");
  const second = (await ctx.call("POST", "/v1/humans/login", { body: { username: "hank", password: "password-123" } })).json;
  const wrong = await ctx.call("POST", "/v1/humans/password", { key: first.token, body: { currentPassword: "nope-nope", newPassword: "new-password-1" } });
  assert.equal(wrong.status, 401);
  const ok = await ctx.call("POST", "/v1/humans/password", { key: first.token, body: { currentPassword: "password-123", newPassword: "new-password-1" } });
  assert.equal(ok.status, 200);
  assert.equal((await ctx.call("GET", "/v1/me", { key: first.token })).status, 200);
  assert.equal((await ctx.call("GET", "/v1/me", { key: second.token })).status, 401);
  assert.equal((await ctx.call("POST", "/v1/humans/login", { body: { username: "hank", password: "password-123" } })).status, 401);
  assert.equal((await ctx.call("POST", "/v1/humans/login", { body: { username: "hank", password: "new-password-1" } })).status, 200);
  const bot = await ctx.agent("bot");
  assert.equal((await ctx.call("POST", "/v1/humans/password", { key: bot.apiKey, body: { currentPassword: "x", newPassword: "yyyyyyyy" } })).status, 403);
}));
