// Relays support tickets between the website and the owner's Discord server.
//
// Two modes, picked from the environment:
//   bot     DISCORD_BOT_TOKEN + DISCORD_GUILD_ID (+ optional DISCORD_TICKET_CATEGORY_ID)
//           Each ticket gets its own text channel. The customer's messages are posted there,
//           and anything staff type in that channel is pulled back to the website. Typing
//           "!close" in the channel closes the ticket.
//   webhook DISCORD_WEBHOOK_URL
//           One-way: new tickets and messages are posted to the webhook's channel (as a new
//           thread when the webhook belongs to a forum channel). Replies can't come back.
//   off     neither is set.
//
// Replies are fetched when the customer's page asks for the ticket (it polls every few
// seconds), not by a background loop, because Cloud Run only gives the server CPU while
// it is handling a request.

const API = "https://discord.com/api/v10";
const BLUE = 0x2f6bff;
const NO_PINGS = { parse: [] }; // customers can't @everyone the server

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "ticket";
}

function modeFrom(cfg) {
  if (cfg.botToken && cfg.guildId) return "bot";
  if (cfg.webhookUrl) return "webhook";
  return "off";
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

  async function hook(query, body) {
    const res = await call(cfg.webhookUrl + (cfg.webhookUrl.includes("?") ? "&" : "?") + "wait=true" + query, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Valence Support", allowed_mentions: NO_PINGS, ...body }),
    });
    return res;
  }

  function embedFor(t, author, text, title) {
    return {
      color: BLUE,
      title: title || undefined,
      author: { name: author.slice(0, 250) },
      description: text.slice(0, 4000),
      footer: { text: `Ticket #${t.number} · ${t.category}` },
      timestamp: new Date().toISOString(),
    };
  }

  async function myId() {
    if (!botUserId) botUserId = (await bot("GET", "/users/@me")).id;
    return botUserId;
  }

  return {
    mode,

    // Creates the Discord side of a new ticket and posts the first message.
    async open(t, ownerName) {
      const first = t.messages[0];
      const intro = embedFor(t, ownerName, first ? first.text : "", `#${t.number}: ${t.subject}`);
      if (t.dealId) intro.fields = [{ name: "Deal", value: t.dealId, inline: true }];
      if (mode === "bot") {
        const channel = await bot("POST", `/guilds/${cfg.guildId}/channels`, {
          name: `ticket-${t.number}-${slug(t.subject)}`,
          type: 0,
          parent_id: cfg.categoryId || undefined,
          topic: `Valence ticket #${t.number} from ${ownerName}. Reply here to answer on the website. Type !close to close it.`,
        });
        const msg = await bot("POST", `/channels/${channel.id}/messages`, {
          content: "New support ticket. Anything you type in this channel is sent to the customer on the website.",
          embeds: [intro],
          allowed_mentions: NO_PINGS,
        });
        return { channelId: channel.id, lastMessageId: msg.id };
      }
      if (mode === "webhook") {
        // Forum channel: start a thread per ticket. Normal channel: thread_name is refused, so post plainly.
        let res = await hook("", { thread_name: `#${t.number} ${t.subject}`.slice(0, 100), embeds: [intro] });
        if (res.ok) {
          const msg = await res.json();
          return { threadId: msg.channel_id };
        }
        res = await hook("", { embeds: [intro] });
        if (!res.ok) throw new Error(`Discord webhook failed: ${res.status}`);
        return {};
      }
      return null;
    },

    // Posts a customer's follow-up message (or a system note) to the ticket's channel or thread.
    async post(t, author, text, title) {
      const embed = embedFor(t, author, text, title);
      if (mode === "bot" && t.discord && t.discord.channelId) {
        const msg = await bot("POST", `/channels/${t.discord.channelId}/messages`, { embeds: [embed], allowed_mentions: NO_PINGS });
        return { lastMessageId: msg.id };
      }
      if (mode === "webhook") {
        const res = await hook(t.discord && t.discord.threadId ? "&thread_id=" + t.discord.threadId : "", { embeds: [embed] });
        if (!res.ok) throw new Error(`Discord webhook failed: ${res.status}`);
      }
      return null;
    },

    async markClosed(t, by) {
      if (mode === "bot" && t.discord && t.discord.channelId) {
        await this.post(t, "Valence", `Ticket closed by ${by}.`);
        await bot("PATCH", `/channels/${t.discord.channelId}`, { name: `closed-${t.number}-${slug(t.subject)}` }).catch((err) => log.error(err.message));
        return;
      }
      if (mode === "webhook") await this.post(t, "Valence", `Ticket closed by ${by}.`);
    },

    // Pulls new staff messages from the ticket's channel. Bot mode only.
    // Throttled per ticket, and never runs twice at once for the same ticket.
    async fetchReplies(t, { force = false } = {}) {
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
        // Discord returns newest first; ids are snowflakes, so compare as BigInt.
        const sorted = [...list].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        const lastMessageId = sorted[sorted.length - 1].id;
        const messages = sorted
          .filter((m) => m.author && m.author.id !== me && !m.webhook_id && !m.author.bot)
          .map((m) => {
            const files = (m.attachments || []).map((a) => a.url);
            const text = [m.content || "", ...files].filter(Boolean).join("\n");
            return { id: m.id, author: (m.member && m.member.nick) || m.author.global_name || m.author.username, text };
          })
          .filter((m) => m.text.trim());
        return { messages, lastMessageId };
      })();
      syncing.set(t.id, job);
      try {
        return await job;
      } finally {
        syncing.delete(t.id);
      }
    },
  };
}

function discordFromEnv(env = process.env) {
  return createDiscord({
    webhookUrl: env.DISCORD_WEBHOOK_URL,
    botToken: env.DISCORD_BOT_TOKEN,
    guildId: env.DISCORD_GUILD_ID,
    categoryId: env.DISCORD_TICKET_CATEGORY_ID,
  });
}

module.exports = { createDiscord, discordFromEnv };
