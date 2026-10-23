// Support tickets: image attachments, the Discord relay, claiming, slash commands,
// account linking and transcripts. Discord is faked, so no network is involved.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../src/app");
const { createDiscord } = require("../src/discord");
const { fileBackend } = require("../src/persist");
const { memoryBlobs } = require("../src/files");

const OWNER_ROLE = "1561491576373383208";
const SUPPORT_ROLE = "1561491658540060712";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 3)]);
const NOT_AN_IMAGE = Buffer.from("<script>alert(1)</script> this is not a picture at all");

// A small stand-in for the parts of Discord we use.
function fakeDiscordApi() {
  let seq = 1000n;
  const nextId = () => String(++seq);
  const channels = new Map(); // id -> { name, parent, messages, overwrites }
  const cdn = new Map(); // url -> buffer
  const calls = [];
  const BOT = { id: "bot-1", username: "valence", bot: true };
  let registeredCommands = null;

  function readForm(body) {
    // FormData from the bot's multipart upload
    const payload = JSON.parse(body.get("payload_json"));
    const files = [];
    for (const [k, v] of body.entries()) if (k.startsWith("files[")) files.push(v);
    return { payload, files };
  }

  async function fetchImpl(url, init = {}) {
    const method = init.method || "GET";
    const u = new URL(url);
    calls.push({ method, path: u.pathname });
    if (cdn.has(url)) return new Response(cdn.get(url));
    const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
    let m;
    if (u.pathname === "/api/v10/users/@me") return Response.json(BOT);
    if ((m = u.pathname.match(/^\/api\/v10\/applications\/(\S+)\/guilds\/(\S+)\/commands$/)) && method === "PUT") {
      registeredCommands = body;
      return Response.json(body);
    }
    if ((m = u.pathname.match(/^\/api\/v10\/guilds\/([\w-]+)\/channels$/)) && method === "POST") {
      const id = nextId();
      channels.set(id, { name: body.name, parent: body.parent_id, messages: [], overwrites: body.permission_overwrites || [] });
      return Response.json({ id, name: body.name });
    }
    if ((m = u.pathname.match(/^\/api\/v10\/channels\/([\w-]+)\/messages$/))) {
      const ch = channels.get(m[1]);
      if (!ch) return new Response("unknown channel", { status: 404 });
      if (method === "POST") {
        let payload = body;
        let files = [];
        if (!payload) ({ payload, files } = readForm(init.body));
        assert.deepEqual(payload.allowed_mentions, { parse: [] }, "pings must stay disabled");
        const msg = {
          id: nextId(), author: BOT, content: payload.content || "", embeds: payload.embeds || [],
          files: files.map((f) => ({ name: f.name, size: f.size, type: f.type })),
        };
        ch.messages.push(msg);
        return Response.json(msg);
      }
      const after = u.searchParams.get("after");
      return Response.json(ch.messages.filter((x) => !after || BigInt(x.id) > BigInt(after)).reverse());
    }
    if ((m = u.pathname.match(/^\/api\/v10\/channels\/([\w-]+)$/)) && method === "PATCH") {
      channels.get(m[1]).name = body.name;
      return Response.json({ id: m[1], name: body.name });
    }
    if ((m = u.pathname.match(/^\/api\/v10\/channels\/([\w-]+)\/permissions\/([\w-]+)$/)) && method === "PUT") {
      channels.get(m[1]).overwrites.push({ id: m[2], ...body });
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }

  // Someone in Discord types a message in a ticket channel.
  function says(channelId, { text = "", roles = [SUPPORT_ROLE], userId = "staff-1", nick = ".gg/shenji", attachments = [] } = {}) {
    const atts = attachments.map((a) => {
      const url = `https://cdn.example/${nextId()}-${a.name}`;
      cdn.set(url, a.buf);
      return { url, filename: a.name, content_type: a.contentType, size: a.buf.length };
    });
    channels.get(channelId).messages.push({
      id: nextId(), author: { id: userId, username: "someone" }, member: { nick, roles },
      content: text, attachments: atts, embeds: [], files: [],
    });
  }
  return { fetchImpl, channels, calls, says, commands: () => registeredCommands, firstChannel: () => [...channels.entries()].find(([, c]) => /^(ticket|closed)-/.test(c.name)) };
}

function signer() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const hex = publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("hex");
  return {
    publicKeyHex: hex,
    sign(timestamp, bodyText) {
      return crypto.sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(bodyText)]), privateKey).toString("hex");
    },
  };
}

async function start(opts = {}) {
  const clock = { t: Date.parse("2026-10-19T00:00:00Z") };
  const server = createApp({ supportTicketsEnabled: true, now: () => clock.t, loginLimit: 500, powDifficulty: 0, ...opts });
  await server.ready;
  await server.commandsRegistered;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, p, { key, body, headers, raw } = {}) {
    const res = await fetch(base + p, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...headers,
      },
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  const human = async (u) => (await call("POST", "/v1/humans/signup", { body: { username: u, password: "password-123" } })).json;
  const upload = (key, buf, name) => call("POST", "/v1/uploads", { key, raw: buf, headers: { "Content-Type": "application/octet-stream", "X-File-Name": name } });
  const close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return { server, call, human, upload, clock, close, base };
}

async function withServer(opts, fn) {
  const ctx = await start(opts);
  try { await fn(ctx); } finally { await ctx.close(); }
}

function botSetup(extra = {}) {
  const api = fakeDiscordApi();
  const sig = signer();
  const discord = createDiscord({
    botToken: "tok", guildId: "g1", categoryId: "cat9",
    ownerRoleId: OWNER_ROLE, supportRoleId: SUPPORT_ROLE,
    transcriptChannelId: "log-1", publicKey: sig.publicKeyHex,
    fetchImpl: api.fetchImpl, syncEveryMs: 0, ...extra,
  });
  api.channels.set("log-1", { name: "support-logs", messages: [], overwrites: [] });
  return { api, sig, discord };
}

// Sends a slash command the way Discord would, signature and all.
async function command(ctx, sig, payload) {
  const bodyText = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return ctx.call("POST", "/discord/interactions", {
    raw: bodyText,
    headers: { "Content-Type": "application/json", "X-Signature-Ed25519": sig.sign(timestamp, bodyText), "X-Signature-Timestamp": timestamp },
  });
}
const staffCmd = (channelId, name, options = [], { roles = [SUPPORT_ROLE], userId = "staff-1", nick = ".gg/shenji" } = {}) => ({
  type: 2, channel_id: channelId, data: { name, options },
  member: { nick, roles, user: { id: userId, username: "shenji", global_name: ".gg/shenji" } },
});

test("paused website support directs users to Discord and preserves ticket history", async () => {
  await withServer({ supportTicketsEnabled: false, blobs: memoryBlobs() }, async (ctx) => {
    const alice = await ctx.human("alice");
    const account = ctx.server.store.authenticate(alice.token);
    const ticket = ctx.server.store.createTicket(account, { subject: "Existing help", message: "Keep this history" });
    const info = (await ctx.call("GET", "/v1/support")).json;
    assert.equal(info.ticketsEnabled, false);
    assert.equal(info.liveReplies, false);
    assert.equal(info.discordInvite, "https://discord.gg/eVYyxbyy22");
    for (const endpoint of ["/v1/tickets", `/v1/tickets/${ticket.id}/messages`, `/v1/tickets/${ticket.id}/close`, "/v1/uploads"]) {
      const result = await ctx.call("POST", endpoint, { key: alice.token, body: { subject: "New help", message: "Do not create this", text: "Do not append" } });
      assert.equal(result.status, 503);
      assert.equal(result.json.error.code, "support_paused");
      assert.equal(result.json.error.discordInvite, info.discordInvite);
    }
    const saved = (await ctx.call("GET", `/v1/tickets/${ticket.id}`, { key: alice.token })).json;
    assert.equal(saved.status, "open");
    assert.equal(saved.messages.length, ticket.messages.length);
    assert.equal((await ctx.call("GET", "/v1/tickets", { key: alice.token })).json.tickets.length, 1);
    assert.equal((await ctx.call("GET", `/v1/tickets/${ticket.id}`)).status, 401);
    for (const endpoint of ["/support", "/support/", "/tickets", "/tickets/old-ticket"]) {
      const res = await fetch(ctx.base + endpoint, { redirect: "manual" });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), info.discordInvite);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
  });
});

test("website tickets are paused by default", async () => {
  await withServer({ supportTicketsEnabled: undefined }, async (ctx) => {
    assert.equal((await ctx.call("GET", "/v1/support")).json.ticketsEnabled, false);
  });
});

test("a ticket with images creates a channel, uploads the pictures, and keeps them private", async () => {
  const { api, discord } = botSetup();
  await withServer({ discord, blobs: memoryBlobs() }, async (ctx) => {
    const alice = await ctx.human("alice");
    const bob = await ctx.human("bob");

    const up = await ctx.upload(alice.token, PNG, "screenshot of the error.png");
    assert.equal(up.status, 201);
    assert.equal(up.json.contentType, "image/png");
    assert.equal(up.json.name, "screenshot of the error.png");

    const bad = await ctx.upload(alice.token, NOT_AN_IMAGE, "sneaky.png");
    assert.equal(bad.status, 400);
    assert.match(bad.json.error.message, /PNG, JPEG, GIF and WebP/);

    const t = await ctx.call("POST", "/v1/tickets", { key: alice.token, body: { category: "deal", subject: "Deal stuck", message: "It won't release", attachmentIds: [up.json.id] } });
    assert.equal(t.status, 201);
    assert.equal(t.json.messages[0].attachments.length, 1);
    assert.equal(t.json.messages[0].attachments[0].name, "screenshot of the error.png");

    const [, channel] = api.firstChannel();
    assert.match(channel.name, /^ticket-1-deal-stuck$/);
    assert.equal(channel.messages[0].files.length, 1, "the image reached Discord");
    assert.equal(channel.messages[0].files[0].name, "screenshot of the error.png");

    // the image is served from our own origin, to its owner only
    const attId = t.json.messages[0].attachments[0].id;
    const img = await ctx.call("GET", `/v1/tickets/${t.json.id}/attachments/${attId}`, { key: alice.token });
    assert.equal(img.status, 200);
    assert.match(img.headers.get("content-type"), /image\/png/);
    assert.equal(img.headers.get("x-content-type-options"), "nosniff");
    assert.equal((await ctx.call("GET", `/v1/tickets/${t.json.id}/attachments/${attId}`, { key: bob.token })).status, 404);
    assert.equal((await ctx.call("GET", `/v1/tickets/${t.json.id}/attachments/${attId}`)).status, 401);

    // an upload can't be attached twice, and not by someone else
    const reuse = await ctx.call("POST", `/v1/tickets/${t.json.id}/messages`, { key: alice.token, body: { text: "again", attachmentIds: [up.json.id] } });
    assert.equal(reuse.status, 400);
    const bobUp = await ctx.upload(bob.token, JPEG, "mine.jpg");
    const steal = await ctx.call("POST", `/v1/tickets/${t.json.id}/messages`, { key: alice.token, body: { text: "hi", attachmentIds: [bobUp.json.id] } });
    assert.equal(steal.status, 400);

    // an image on its own, with no words, is allowed
    const up2 = await ctx.upload(alice.token, JPEG, "more.jpg");
    const imgOnly = await ctx.call("POST", `/v1/tickets/${t.json.id}/messages`, { key: alice.token, body: { text: "", attachmentIds: [up2.json.id] } });
    assert.equal(imgOnly.status, 201);
    assert.equal(imgOnly.json.messages.at(-1).attachments.length, 1);

    const five = [];
    for (let i = 0; i < 5; i++) five.push((await ctx.upload(alice.token, PNG, `p${i}.png`)).json.id);
    const tooMany = await ctx.call("POST", `/v1/tickets/${t.json.id}/messages`, { key: alice.token, body: { text: "lots", attachmentIds: five } });
    assert.equal(tooMany.status, 400);
  });
});

test("support must claim before replying; the customer sees the role, never the Discord name", async () => {
  const { api, sig, discord } = botSetup();
  await withServer({ discord, blobs: memoryBlobs() }, async (ctx) => {
    const alice = await ctx.human("alice");
    const t = (await ctx.call("POST", "/v1/tickets", { key: alice.token, body: { subject: "Help", message: "Something is broken" } })).json;
    const [channelId, channel] = api.firstChannel();

    // an unclaimed agent's message is held back
    api.says(channelId, { text: "hello, are you there?" });
    let got = await ctx.call("GET", `/v1/tickets/${t.id}`, { key: alice.token });
    assert.equal(got.json.messages.filter((m) => m.from === "staff").length, 0);
    assert.ok(channel.messages.some((m) => (m.embeds[0] || {}).description && /\/claim/.test(m.embeds[0].description)), "the bot asks them to claim");

    // claim, then the reply goes through, labelled "Support"
    const claim = await command(ctx, sig, staffCmd(channelId, "claim"));
    assert.equal(claim.status, 200);
    assert.match(claim.json.data.content, /Claimed/);
    assert.equal(claim.json.data.flags, 64, "command replies are private to the staff member");
    api.says(channelId, { text: "Looking into it now" });
    got = await ctx.call("GET", `/v1/tickets/${t.id}`, { key: alice.token });
    const staff = got.json.messages.filter((m) => m.from === "staff");
    assert.equal(staff.length, 1);
    assert.equal(staff[0].text, "Looking into it now");
    assert.equal(staff[0].author, "Support");
    assert.equal(got.text.includes(".gg/shenji"), false, "the staff member's Discord name is never sent to the customer");
    assert.equal(got.json.claimedBy.role, "Support");

    // someone else can't take a claimed ticket
    const other = await command(ctx, sig, staffCmd(channelId, "claim", [], { userId: "staff-2", nick: "helper" }));
    assert.match(other.json.data.content, /Already claimed/);

    // a staff image comes back to the website and is stored by us
    api.says(channelId, { text: "see this", attachments: [{ name: "fix.png", buf: PNG, contentType: "image/png" }] });
    got = await ctx.call("GET", `/v1/tickets/${t.id}`, { key: alice.token });
    const withImg = got.json.messages.at(-1);
    assert.equal(withImg.attachments.length, 1);
    const shown = await ctx.call("GET", `/v1/tickets/${t.id}/attachments/${withImg.attachments[0].id}`, { key: alice.token });
    assert.equal(shown.status, 200);
    assert.match(shown.headers.get("content-type"), /image\/png/);

    // people with no staff role are ignored entirely
    api.says(channelId, { text: "random passer-by", roles: [], userId: "nobody-1" });
    got = await ctx.call("GET", `/v1/tickets/${t.id}`, { key: alice.token });
    assert.equal(got.text.includes("random passer-by"), false);
  });
});

test("the owner replies without claiming, and is shown as Owner", async () => {
  const { api, discord } = botSetup();
  await withServer({ discord, blobs: memoryBlobs() }, async (ctx) => {
    const alice = await ctx.human("alice");
    const t = (await ctx.call("POST", "/v1/tickets", { key: alice.token, body: { subject: "Fee question", message: "A question about fees" } })).json;
    const [channelId] = api.firstChannel();
    api.says(channelId, { text: "I can answer that", roles: [OWNER_ROLE], userId: "owner-1", nick: ".gg/shenji" });
    const got = await ctx.call("GET", `/v1/tickets/${t.id}`, { key: alice.token });
    const staff = got.json.messages.filter((m) => m.from === "staff");
    assert.equal(staff.length, 1);
    assert.equal(staff[0].author, "Owner");
    assert.equal(got.json.claimedBy.role, "Owner");
    assert.ok(got.json.messages.some((m) => m.from === "system" && /owner is handling/i.test(m.text)));
  });
});

test("slash commands: close posts a transcript to the log channel, and unsigned requests are refused", async () => {
  const { api, sig, discord } = botSetup();
  await withServer({ discord, blobs: memoryBlobs() }, async (ctx) => {
    const alice = await ctx.human("alice");
    const t = (await ctx.call("POST", "/v1/tickets", { key: alice.token, body: { subject: "Refund please", message: "I need a refund" } })).json;
    const [channelId, channel] = api.firstChannel();

    assert.deepEqual((api.commands() || []).map((c) => c.name).sort(), ["claim", "close", "help", "link", "ticket", "transcript", "unclaim"]);

    // Discord's ping handshake
    const ping = await command(ctx, sig, { type: 1 });
    assert.deepEqual(ping.json, { type: 1 });

    // forged requests are refused
    const bodyText = JSON.stringify(staffCmd(channelId, "close"));
    const forged = await ctx.call("POST", "/discord/interactions", {
      raw: bodyText,
      headers: { "Content-Type": "application/json", "X-Signature-Ed25519": "00".repeat(64), "X-Signature-Timestamp": "123" },
    });
    assert.equal(forged.status, 401);
    assert.equal((await ctx.call("POST", "/discord/interactions", { body: { type: 1 } })).status, 401);

    const info = await command(ctx, sig, staffCmd(channelId, "ticket"));
    assert.match(info.json.data.content, /Refund please/);
    assert.match(info.json.data.content, /Discord not linked/);

    await command(ctx, sig, staffCmd(channelId, "claim"));
    const unclaim = await command(ctx, sig, staffCmd(channelId, "unclaim"));
    assert.match(unclaim.json.data.content, /Handed back/);
    await command(ctx, sig, staffCmd(channelId, "claim"));

    const closed = await command(ctx, sig, staffCmd(channelId, "close", [{ name: "reason", value: "sorted on Discord" }]));
    assert.match(closed.json.data.content, /Closed/);

    const after = await ctx.call("GET", `/v1/tickets/${t.id}`, { key: alice.token });
    assert.equal(after.json.status, "closed");
    assert.ok(after.json.messages.some((m) => m.from === "system" && /sorted on Discord/.test(m.text)));
    assert.match(channel.name, /^closed-1-/, "the channel is archived by name");

    const logged = api.channels.get("log-1").messages.at(-1);
    assert.equal(logged.files.length, 1);
    assert.match(logged.files[0].name, /ticket-1-transcript\.html/);
    assert.match(logged.embeds[0].description, /Handled by: .gg\/shenji \(Support\)/);

    // the customer can read the transcript on the website
    const tr = await ctx.call("GET", `/v1/tickets/${t.id}/transcript`, { key: alice.token });
    assert.equal(tr.status, 200);
    assert.match(tr.headers.get("content-type"), /text\/html/);
    assert.match(tr.text, /I need a refund/);
    assert.match(tr.text, /Ticket #1/);
    assert.equal(tr.text.includes(".gg/shenji"), false, "the transcript the customer sees keeps staff names out");
    const bob = await ctx.human("bob");
    assert.equal((await ctx.call("GET", `/v1/tickets/${t.id}/transcript`, { key: bob.token })).status, 404);

    // a closed ticket takes no more commands
    assert.match((await command(ctx, sig, staffCmd(channelId, "claim"))).json.data.content, /already closed/);
  });
});

test("linking a Discord account lets the bot add the customer to their ticket channel", async () => {
  const { api, sig, discord } = botSetup();
  await withServer({ discord, blobs: memoryBlobs() }, async (ctx) => {
    const alice = await ctx.human("alice");
    assert.equal((await ctx.call("GET", "/v1/support")).json.discordLinking, true);
    assert.equal((await ctx.call("GET", "/v1/me", { key: alice.token })).json.security.discord, null);

    const { code } = (await ctx.call("POST", "/v1/account/discord/link-code", { key: alice.token })).json;
    assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const wrong = await command(ctx, sig, { type: 2, channel_id: "whatever", data: { name: "link", options: [{ name: "code", value: "ZZZZ-ZZZZ" }] }, member: { roles: [], user: { id: "u-9", username: "nope" } } });
    assert.match(wrong.json.data.content, /isn't valid/);

    const linked = await command(ctx, sig, { type: 2, channel_id: "whatever", data: { name: "link", options: [{ name: "code", value: code.toLowerCase() }] }, member: { roles: [], user: { id: "u-5", username: "alice_on_discord" } } });
    assert.match(linked.json.data.content, /alice/);
    assert.equal((await ctx.call("GET", "/v1/me", { key: alice.token })).json.security.discord.username, "alice_on_discord");

    // the code works once
    assert.match((await command(ctx, sig, { type: 2, channel_id: "x", data: { name: "link", options: [{ name: "code", value: code }] }, member: { roles: [], user: { id: "u-6", username: "someone" } } })).json.data.content, /isn't valid/);

    // a new ticket gives that Discord user access to the channel
    await ctx.call("POST", "/v1/tickets", { key: alice.token, body: { subject: "Linked ticket", message: "Hello from a linked account" } });
    const [, channel] = api.firstChannel();
    assert.ok(channel.overwrites.some((o) => o.id === "u-5"), "the customer can see their own ticket channel");
    assert.match(channel.messages[0].embeds[0].fields.find((f) => f.name === "Customer").value, /<@u-5>/);

    // their own Discord messages in that channel are not echoed back to the website
    const [channelId] = api.firstChannel();
    api.says(channelId, { text: "typed in Discord by the customer", roles: [], userId: "u-5" });
    const tickets = (await ctx.call("GET", "/v1/tickets", { key: alice.token })).json.tickets;
    assert.equal(JSON.stringify(tickets).includes("typed in Discord"), false);

    // unlinking
    assert.equal((await ctx.call("POST", "/v1/account/discord/unlink", { key: alice.token })).status, 200);
    assert.equal((await ctx.call("GET", "/v1/me", { key: alice.token })).json.security.discord, null);
  });
});

test("tickets, attachments and links survive a restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "valence-"));
  const file = path.join(dir, "state.json");
  const blobs = memoryBlobs(); // shared, standing in for the bucket
  const { api, sig, discord } = botSetup();
  let token, ticketId, attId;
  await withServer({ discord, blobs, backend: fileBackend(file) }, async (ctx) => {
    token = (await ctx.human("gina")).token;
    const { code } = (await ctx.call("POST", "/v1/account/discord/link-code", { key: token })).json;
    await command(ctx, sig, { type: 2, channel_id: "x", data: { name: "link", options: [{ name: "code", value: code }] }, member: { roles: [], user: { id: "u-7", username: "gina_d" } } });
    const up = await ctx.upload(token, PNG, "keep.png");
    const t = (await ctx.call("POST", "/v1/tickets", { key: token, body: { subject: "Keep me", message: "Saved ticket", attachmentIds: [up.json.id] } })).json;
    ticketId = t.id;
    attId = t.messages[0].attachments[0].id;
    const [channelId] = api.firstChannel();
    api.says(channelId, { text: "on it", roles: [OWNER_ROLE], userId: "owner-1" });
    await ctx.call("GET", `/v1/tickets/${ticketId}`, { key: token });
  });
  await withServer({ discord, blobs, backend: fileBackend(file), skipCommandRegistration: true }, async (ctx) => {
    const t = await ctx.call("GET", `/v1/tickets/${ticketId}`, { key: token });
    assert.equal(t.json.subject, "Keep me");
    assert.equal(t.json.claimedBy.role, "Owner");
    assert.equal(t.json.messages.filter((m) => m.from === "staff")[0].author, "Owner");
    assert.equal((await ctx.call("GET", `/v1/tickets/${ticketId}/attachments/${attId}`, { key: token })).status, 200);
    assert.equal((await ctx.call("GET", "/v1/me", { key: token })).json.security.discord.username, "gina_d");
  });
});

test("without a bot, tickets still work and Discord features report themselves as off", async () => {
  await withServer({}, async (ctx) => {
    const a = await ctx.human("dave");
    const info = await ctx.call("GET", "/v1/support");
    assert.equal(info.json.liveReplies, false);
    assert.equal(info.json.discordLinking, false);
    assert.equal(info.json.attachments.maxFiles, 4);
    assert.equal((await ctx.call("POST", "/v1/account/discord/link-code", { key: a.token })).status, 503);
    const up = await ctx.upload(a.token, PNG, "x.png");
    const t = await ctx.call("POST", "/v1/tickets", { key: a.token, body: { subject: "Hello", message: "Plain website ticket", attachmentIds: [up.json.id] } });
    assert.equal(t.status, 201);
    assert.equal((await ctx.call("GET", `/v1/tickets/${t.json.id}/attachments/${t.json.messages[0].attachments[0].id}`, { key: a.token })).status, 200);
    assert.equal((await ctx.call("GET", `/v1/tickets/${t.json.id}/transcript`, { key: a.token })).status, 200);
    assert.equal((await ctx.call("POST", "/discord/interactions", { body: { type: 1 } })).status, 401);
  });
});

test("webhook mode still posts tickets as threads when there is no bot", async () => {
  const posts = [];
  const forum = createDiscord({
    webhookUrl: "https://discord.com/api/webhooks/1/abc",
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      posts.push({ url, body });
      return Response.json({ id: "m1", channel_id: body.thread_name ? "thread-77" : "chan-1" });
    },
  });
  await withServer({ discord: forum, blobs: memoryBlobs() }, async (ctx) => {
    const a = await ctx.human("erin");
    const t = (await ctx.call("POST", "/v1/tickets", { key: a.token, body: { subject: "Forum test", message: "Hello forum" } })).json;
    await ctx.call("POST", `/v1/tickets/${t.id}/messages`, { key: a.token, body: { text: "follow up" } });
    assert.match(posts[0].body.thread_name, /^#1 Forum test$/);
    assert.match(posts[1].url, /thread_id=thread-77/);
    assert.equal((await ctx.call("GET", "/v1/support")).json.relay, "webhook");
  });
});
