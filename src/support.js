// Ties support tickets together: the store, the Discord relay, attachment storage and
// transcripts. The API layer calls into this; nothing here knows about HTTP.

const { transcriptHtml, transcriptSummary } = require("./transcript");

const EPHEMERAL = 64; // only the staff member who ran the command sees the reply
const PONG = { type: 1 };
const reply = (content) => ({ type: 4, data: { content, flags: EPHEMERAL } });

function createSupport({ store, discord, blobs, persistence, siteUrl = "https://valencemm.com", log = console }) {
  const relayError = (what, err) => log.error(`Discord ${what} failed:`, err && err.message ? err.message : err);
  const save = () => (persistence ? persistence.commit() : Promise.resolve());

  // Attachments are stored by us; Discord needs the actual bytes to show a picture.
  async function filesFor(attachments) {
    const files = [];
    for (const a of attachments || []) {
      try {
        const blob = await blobs.get(a.id);
        if (blob) files.push({ buf: blob.buf, name: a.name, contentType: blob.contentType });
      } catch (err) {
        relayError("attachment read", err);
      }
    }
    return files;
  }

  async function openRelay(t) {
    try {
      const d = await discord.open(t, store.ticketOwnerName(t), {
        customerDiscordId: store.discordIdFor(t),
        files: await filesFor(t.messages[0] && t.messages[0].attachments),
      });
      if (d) store.setTicketDiscord(t, { ...d, error: null });
    } catch (err) {
      relayError("open", err);
      store.setTicketDiscord(t, { error: "open_failed" });
    }
  }

  async function postRelay(t, author, text, attachments) {
    if (discord.mode === "off") return;
    const opened = t.discord && (t.discord.channelId || t.discord.threadId || (discord.mode === "webhook" && !t.discord.error));
    if (!opened) return openRelay(t); // the first attempt failed earlier: open it now
    try {
      await discord.post(t, author, text, { files: await filesFor(attachments) });
    } catch (err) {
      relayError("post", err);
    }
  }

  // Pulls staff replies into the ticket. Returns true if anything changed.
  async function sync(t) {
    if (!t || t.status !== "open") return false;
    try {
      const r = await discord.fetchReplies(t, { customerId: store.discordIdFor(t) });
      if (!r) return false;
      // Store any images the staff sent, so the customer sees them on the website.
      for (const m of r.messages) {
        m.attachments = [];
        for (const f of m.files || []) {
          try {
            m.attachments.push(await storeAttachment(f));
          } catch (err) {
            relayError("attachment store", err);
          }
        }
      }
      const { added, needClaim } = store.addStaffMessages(t, r.messages);
      const moved = r.lastMessageId && r.lastMessageId !== t.discord.lastMessageId;
      if (moved) store.setTicketDiscord(t, { lastMessageId: r.lastMessageId });
      for (const m of needClaim) {
        await discord.note(t, `<@${m.discordUserId}> run **/claim** before replying, so the ticket shows who handled it. Your last message was not sent to the customer.`)
          .catch((err) => relayError("claim note", err));
      }
      if (added || moved) await save();
      return added > 0;
    } catch (err) {
      relayError("sync", err);
      return false;
    }
  }

  async function storeAttachment(file) {
    const { storeImage } = require("./files");
    return storeImage(blobs, file);
  }

  // The customer's copy carries the images inside it, so a saved file still shows them.
  // The staff copy doesn't: those images are already in the Discord channel.
  const EMBED_BUDGET = 4 * 1024 * 1024;
  async function transcriptFor(ticketId, { forStaff = false } = {}) {
    const data = store.transcriptData(ticketId, { includeStaffNames: forStaff });
    const embedded = new Map();
    if (!forStaff) {
      let budget = EMBED_BUDGET;
      for (const m of data.messages) {
        for (const a of m.attachments || []) {
          if (a.size > budget) continue;
          try {
            const blob = await blobs.get(a.id);
            if (!blob) continue;
            embedded.set(a.id, `data:${blob.contentType};base64,${blob.buf.toString("base64")}`);
            budget -= a.size;
          } catch (err) {
            relayError("attachment read", err);
          }
        }
      }
    }
    const html = transcriptHtml(data, { siteUrl, embedded });
    return { data, html, summary: transcriptSummary(data) };
  }

  async function closeAndLog(t, by) {
    const { html, summary } = await transcriptFor(t.id, { forStaff: true });
    await discord.postTranscript(t, { html, summary }).catch((err) => relayError("transcript", err));
    await discord.markClosed(t, by).catch((err) => relayError("close", err));
  }

  // ---- slash commands from Discord ----
  async function handleInteraction(body) {
    if (!body || body.type === 1) return PONG;
    if (body.type !== 2) return reply("That isn't something I handle.");
    const name = body.data && body.data.name;
    const user = (body.member && body.member.user) || body.user || {};
    const option = (key) => {
      const o = ((body.data && body.data.options) || []).find((x) => x.name === key);
      return o ? o.value : null;
    };
    const who = {
      discordUserId: user.id,
      author: (body.member && body.member.nick) || user.global_name || user.username || "Support",
      role: discord.roleOrDefault(body.member),
    };

    if (name === "help") {
      return reply([
        "**Valence support commands**",
        "`/claim` — take this ticket so you can reply to the customer",
        "`/unclaim` — hand it back to the queue",
        "`/close [reason]` — close it, post a transcript and archive the channel",
        "`/transcript` — post a transcript of the conversation so far",
        "`/ticket` — who the ticket belongs to and who is handling it",
        "`/link <code>` — customers link their Discord account to their Valence account",
        "",
        "Type normally in a ticket channel to reply to the customer, once you've claimed it.",
      ].join("\n"));
    }

    if (name === "link") {
      const r = store.completeDiscordLink(option("code"), { id: user.id, username: user.username || user.global_name || user.id });
      if (!r.ok) return reply(r.reason);
      await save();
      return reply(`Linked to your Valence account **${r.accountName}**. You'll be added to your ticket channels from now on.`);
    }

    // Everything below acts on the ticket for this channel, and is staff only.
    const t = store.ticketByChannel(body.channel_id);
    if (!t) return reply("Run this inside a ticket channel.");
    if (!who.role) return reply("Only support staff can use this command.");

    if (name === "claim") {
      const r = store.claimTicket(t, who);
      if (!r.ok) return reply(r.reason);
      await save();
      await discord.note(t, `Claimed by <@${user.id}> (${who.role}). Anything you type here now goes to the customer.`).catch(() => {});
      return reply("Claimed. Your messages in this channel now reach the customer on the website.");
    }

    if (name === "unclaim") {
      const r = store.releaseTicket(t);
      if (!r.ok) return reply(r.reason);
      await save();
      await discord.note(t, `<@${user.id}> handed this ticket back to the queue.`).catch(() => {});
      return reply("Handed back. Someone needs to claim it before replying.");
    }

    if (name === "close") {
      const r = store.closeTicketByStaff(t, who, option("reason"));
      if (!r.ok) return reply(r.reason);
      await save();
      await closeAndLog(t, `${who.role} ${who.author}`);
      return reply("Closed, and the transcript is posted.");
    }

    if (name === "transcript") {
      const { html, summary } = await transcriptFor(t.id, { forStaff: true });
      await discord.postTranscript(t, { html, summary, toLogChannel: false }).catch((err) => relayError("transcript", err));
      return reply("Transcript posted in this channel.");
    }

    if (name === "ticket") {
      const d = store.transcriptData(t.id, { includeStaffNames: true });
      return reply([
        `**#${d.number}: ${d.subject}**`,
        `Customer: ${d.customer.name} (${d.customer.kind === "agent" ? "AI agent" : "person"})${d.customer.discord ? ` · Discord ${d.customer.discord}` : " · Discord not linked"}`,
        `Topic: ${d.category}${d.dealId ? ` · Deal ${d.dealId}` : ""}`,
        `Status: ${d.status}`,
        `Claimed by: ${d.claimedBy ? `${d.claimedBy.name} (${d.claimedBy.role})` : "nobody yet"}`,
        `Messages: ${d.messages.length}`,
      ].join("\n"));
    }
    return reply("Unknown command.");
  }

  return { openRelay, postRelay, sync, storeAttachment, transcriptFor, closeAndLog, handleInteraction, filesFor };
}

module.exports = { createSupport };
