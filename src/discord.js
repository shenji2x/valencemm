// Relays support tickets between the website and the owner's Discord server.
//
// Modes, picked from the environment:
//   bot     DISCORD_BOT_TOKEN + DISCORD_GUILD_ID (+ DISCORD_TICKET_CATEGORY_ID,
//           DISCORD_OWNER_ROLE_ID, DISCORD_SUPPORT_ROLE_ID, DISCORD_TRANSCRIPT_CHANNEL_ID)
//           Each ticket gets its own channel. Customer messages (and images) are posted there,
//           and staff replies are pulled back to the website. Staff act through slash commands.
//   webhook DISCORD_WEBHOOK_URL
//           One-way: tickets and messages are posted to the webhook's channel. No replies back.
//   off     neither is set.
//
// Staff replies are fetched while the customer's ticket page is open (it polls every few
// seconds). Slash commands arrive the other way: Discord posts them to /discord/interactions,
// so /claim and /close take effect immediately.

const crypto = require("crypto");

const API = process.env.DISCORD_API_BASE || "https://discord.com/api/v10";
const BLUE = 0x2f6bff;
const GREEN = 0x34d399;
const GREY = 0x6c7a93;
const NO_PINGS = { parse: [] }; // customers can't @everyone the server
const VIEW_CHANNEL = 1 << 10;
const SEND_MESSAGES = 1 << 11;
const READ_HISTORY = 1 << 16;
const ATTACH_FILES = 1 << 15;
const CUSTOMER_PERMS = String(VIEW_CHANNEL | SEND_MESSAGES | READ_HISTORY | ATTACH_FILES);
// A customer who is in the server can read their own ticket channel. Their Discord messages are
// not relayed to the website, so the channel topic tells them to reply on the site.
const MAX_RELAY_BYTES = 8 * 1024 * 1024;

const COMMANDS = [
  { name: "link", description: "Link your Discord account to your Valence account", options: [{ name: "code", description: "The code from Settings on valencemm.com", type: 3, required: true }] },
  { name: "claim", description: "Claim this ticket so you can reply to the customer" },
  { name: "unclaim", description: "Hand this ticket back to the queue" },
  { name: "close", description: "Close this ticket and post a transcript", options: [{ name: "reason", description: "Shown to the customer", type: 3, required: false }] },
  { name: "transcript", description: "Post a transcript of this ticket so far" },
  { name: "ticket", description: "Show who this ticket belongs to and who is handling it" },
  { name: "help", description: "List the Valence support commands" },
];

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "ticket";
}

function modeFrom(cfg) {
  if (cfg.botToken && cfg.guildId) return "bot";
  if (cfg.webhookUrl) return "webhook";
  return "off";
}

// Discord signs every interaction with Ed25519. An unsigned or badly signed request is not
// from Discord, so it must be refused.
function verifyInteraction(publicKeyHex, signature, timestamp, rawBody) {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, Buffer.concat([Buffer.from(timestamp), rawBody]), key, Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

function createDiscord(cfg = {}) {
  const fetchImpl = cfg.fetchImpl || ((...a) => fetch(...a));
  const log = cfg.log || console;
  const mode = modeFrom(cfg);
  let botUserId = null;
  const syncing = new Map(); // ticketId -> in-flight sync promise
  const lastSync = new Map(); // ticketId -> ms
  const SYNC_EVERY_MS = cfg.syncEveryMs == null ? 3000 : cfg.syncEveryMs;

  async function call(url, init, attempt = 0) {
    const res = await fetchImpl(url, init);
    if (res.status === 429 && attempt < 2) {
      let wait = 1;
      try { wait = (await res.json()).retry_after || 1; } catch { /* default */ }
      await new Promise((r) => setTimeout(r, Math.min(wait, 5) * 1000));
      return call(url, init, attempt + 1);
    }
    return res;
  }

  async function bot(method, path, body) {
    const res = await call(API + path, {
      method,
      headers: { Authorization: "Bot " + cfg.botToken, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Discord ${method} ${path.split("?")[0]} failed: ${res.status} ${await res.text().catch(() => "")}`);
    return res.status === 204 ? null : res.json();
  }

  // Multipart post, for messages that carry images or a transcript file.
  async function botUpload(channelId, payload, files) {
    const form = new FormData();
    form.append("payload_json", JSON.stringify({ allowed_mentions: NO_PINGS, ...payload }));
    files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.buf], { type: f.contentType || "application/octet-stream" }), f.name));
    const res = await call(`${API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: "Bot " + cfg.botToken },
      body: form,
    });
    if (!res.ok) throw new Error(`Discord upload failed: ${res.status} ${await res.text().catch(() => "")}`);
    return res.json();
  }

  async function hook(query, body) {
    return call(cfg.webhookUrl + (cfg.webhookUrl.includes("?") ? "&" : "?") + "wait=true" + query, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Valence Support", allowed_mentions: NO_PINGS, ...body }),
    });
  }

  function embedFor(t, author, text, title) {
    return {
      color: BLUE,
      title: title || undefined,
      author: { name: String(author).slice(0, 250) },
      description: (text || "").slice(0, 4000) || undefined,
      footer: { text: `Ticket #${t.number} · ${t.category}` },
      timestamp: new Date().toISOString(),
    };
  }

  async function myId() {
    if (!botUserId) botUserId = (await bot("GET", "/users/@me")).id;
    return botUserId;
  }

  // "Owner" or "Support" from the member's roles, or null for anyone else.
  function roleOf(member) {
    const roles = (member && member.roles) || [];
    if (cfg.ownerRoleId && roles.includes(cfg.ownerRoleId)) return "Owner";
    if (cfg.supportRoleId && roles.includes(cfg.supportRoleId)) return "Support";
    return null;
  }

  // Without configured role ids there's no way to tell staff apart, so treat guild members as
  // support rather than silently dropping every reply.
  const roleOrDefault = (member) => roleOf(member) || (cfg.ownerRoleId || cfg.supportRoleId ? null : "Support");

  async function downloadAttachment(att) {
    if (!att.url || (att.size && att.size > MAX_RELAY_BYTES)) return null;
    const type = String(att.content_type || "");
    if (!type.startsWith("image/")) return null;
    try {
      const res = await fetchImpl(att.url);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_RELAY_BYTES) return null;
      return { buf, name: att.filename || "image" };
    } catch (err) {
      log.error("Discord attachment download failed:", err.message);
      return null;
    }
  }

  const api = {
    mode,
    hasInteractions: Boolean(mode === "bot" && cfg.publicKey),
    guildId: cfg.guildId || null,

    // Tells Discord which slash commands exist. Safe to run on every start.
    async registerCommands() {
      if (mode !== "bot") return null;
      const appId = await myId();
      return bot("PUT", `/applications/${appId}/guilds/${cfg.guildId}/commands`, COMMANDS);
    },

    // Creates the ticket's channel and posts the opening message.
    async open(t, ownerName, { customerDiscordId, files = [] } = {}) {
      const first = t.messages[0];
      const intro = embedFor(t, ownerName, first ? first.text : "", `#${t.number}: ${t.subject}`);
      const fields = [];
      if (t.dealId) fields.push({ name: "Deal", value: t.dealId, inline: true });
      if (customerDiscordId) fields.push({ name: "Customer", value: `<@${customerDiscordId}>`, inline: true });
      if (fields.length) intro.fields = fields;

      if (mode === "bot") {
        const overwrites = customerDiscordId ? [{ id: customerDiscordId, type: 1, allow: CUSTOMER_PERMS }] : undefined;
        const channel = await bot("POST", `/guilds/${cfg.guildId}/channels`, {
          name: `ticket-${t.number}-${slug(t.subject)}`,
          type: 0,
          parent_id: cfg.categoryId || undefined,
          topic: `Valence ticket #${t.number} from ${ownerName}. Use /claim, then reply here to answer on the website. /close when done.`,
          permission_overwrites: overwrites,
        });
        const help = "New support ticket. **/claim** it first, then anything you type here goes to the customer on the website. **/close** when you're done.";
        const msg = files.length
          ? await botUpload(channel.id, { content: help, embeds: [intro] }, files)
          : await bot("POST", `/channels/${channel.id}/messages`, { content: help, embeds: [intro], allowed_mentions: NO_PINGS });
        return { channelId: channel.id, lastMessageId: msg.id, customerInvited: Boolean(customerDiscordId) };
      }
      if (mode === "webhook") {
        let res = await hook("", { thread_name: `#${t.number} ${t.subject}`.slice(0, 100), embeds: [intro] });
        if (res.ok) return { threadId: (await res.json()).channel_id };
        res = await hook("", { embeds: [intro] });
        if (!res.ok) throw new Error(`Discord webhook failed: ${res.status}`);
        return {};
      }
      return null;
    },

    // Posts a customer message (or a system note) into the ticket's channel.
    async post(t, author, text, { title, files = [] } = {}) {
      const embed = embedFor(t, author, text, title);
      if (mode === "bot" && t.discord && t.discord.channelId) {
        const msg = files.length
          ? await botUpload(t.discord.channelId, { embeds: [embed] }, files)
          : await bot("POST", `/channels/${t.discord.channelId}/messages`, { embeds: [embed], allowed_mentions: NO_PINGS });
        return { lastMessageId: msg.id };
      }
      if (mode === "webhook") {
        const res = await hook(t.discord && t.discord.threadId ? "&thread_id=" + t.discord.threadId : "", { embeds: [embed] });
        if (!res.ok) throw new Error(`Discord webhook failed: ${res.status}`);
      }
      return null;
    },

    // Lets a customer who linked their Discord account see an existing ticket channel.
    async inviteCustomer(t, discordUserId) {
      if (mode !== "bot" || !t.discord || !t.discord.channelId || !discordUserId) return false;
      await bot("PUT", `/channels/${t.discord.channelId}/permissions/${discordUserId}`, { type: 1, allow: CUSTOMER_PERMS });
      return true;
    },

    async note(t, text, color = GREY) {
      if (mode === "bot" && t.discord && t.discord.channelId) {
        return bot("POST", `/channels/${t.discord.channelId}/messages`, {
          embeds: [{ color, description: text.slice(0, 4000) }],
          allowed_mentions: NO_PINGS,
        });
      }
      if (mode === "webhook") await this.post(t, "Valence", text);
      return null;
    },

    // Posts the transcript file, to the log channel if one is set, otherwise in the ticket.
    async postTranscript(t, { html, summary, toLogChannel = true }) {
      if (mode !== "bot") {
        if (mode === "webhook") await this.post(t, "Valence", summary);
        return null;
      }
      const channelId = (toLogChannel && cfg.transcriptChannelId) || (t.discord && t.discord.channelId);
      if (!channelId) return null;
      return botUpload(channelId, {
        embeds: [{ color: GREEN, title: `Transcript · ticket #${t.number}`, description: summary.slice(0, 4000), timestamp: new Date().toISOString() }],
      }, [{ buf: Buffer.from(html, "utf8"), name: `ticket-${t.number}-transcript.html`, contentType: "text/html" }]);
    },

    async markClosed(t, by) {
      if (mode === "bot" && t.discord && t.discord.channelId) {
        await this.note(t, `Ticket closed by ${by}.`, GREEN);
        await bot("PATCH", `/channels/${t.discord.channelId}`, { name: `closed-${t.number}-${slug(t.subject)}` }).catch((err) => log.error(err.message));
        return;
      }
      if (mode === "webhook") await this.post(t, "Valence", `Ticket closed by ${by}.`);
    },

    // Pulls new staff messages from the ticket's channel, with the author's role and any images.
    // Throttled per ticket, and never runs twice at once for the same ticket.
    async fetchReplies(t, { force = false, customerId = null } = {}) {
      if (mode !== "bot" || !t.discord || !t.discord.channelId) return null;
      const last = lastSync.get(t.id) || 0;
      if (!force && Date.now() - last < SYNC_EVERY_MS) return null;
      if (syncing.has(t.id)) return syncing.get(t.id);
      const job = (async () => {
        lastSync.set(t.id, Date.now());
        const me = await myId();
        const after = t.discord.lastMessageId ? `&after=${t.discord.lastMessageId}` : "";
        const list = await bot("GET", `/channels/${t.discord.channelId}/messages?limit=50${after}`);
        if (!Array.isArray(list) || list.length === 0) return { messages: [], lastMessageId: t.discord.lastMessageId };
        const sorted = [...list].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1)); // Discord returns newest first
        const lastMessageId = sorted[sorted.length - 1].id;
        const messages = [];
        for (const m of sorted) {
          if (!m.author || m.author.id === me || m.webhook_id || m.author.bot) continue;
          if (customerId && m.author.id === customerId) continue; // the customer writes on the website
          const role = roleOrDefault(m.member);
          if (!role) continue; // not staff
          const files = [];
          for (const att of m.attachments || []) {
            const got = await downloadAttachment(att);
            if (got) files.push(got);
          }
          messages.push({
            id: m.id,
            discordUserId: m.author.id,
            author: (m.member && m.member.nick) || m.author.global_name || m.author.username,
            role,
            text: m.content || "",
            files,
          });
        }
        return { messages, lastMessageId };
      })();
      syncing.set(t.id, job);
      try {
        return await job;
      } finally {
        syncing.delete(t.id);
      }
    },

    // ---- slash commands ----
    verify(signature, timestamp, rawBody) {
      return Boolean(cfg.publicKey) && verifyInteraction(cfg.publicKey, signature, timestamp, rawBody);
    },
    roleOf,
    roleOrDefault,
  };
  return api;
}

function discordFromEnv(env = process.env) {
  return createDiscord({
    webhookUrl: env.DISCORD_WEBHOOK_URL,
    botToken: env.DISCORD_BOT_TOKEN,
    guildId: env.DISCORD_GUILD_ID,
    categoryId: env.DISCORD_TICKET_CATEGORY_ID,
    ownerRoleId: env.DISCORD_OWNER_ROLE_ID,
    supportRoleId: env.DISCORD_SUPPORT_ROLE_ID,
    transcriptChannelId: env.DISCORD_TRANSCRIPT_CHANNEL_ID,
    publicKey: env.DISCORD_PUBLIC_KEY,
  });
}

module.exports = { createDiscord, discordFromEnv, verifyInteraction, COMMANDS };
