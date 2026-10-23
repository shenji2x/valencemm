const DEFAULT_INVITE = "https://discord.gg/eVYyxbyy22";

// Temporary pause: existing tickets stay stored. Set WEBSITE_TICKETS_ENABLED=1
// to restore the website ticket endpoints and forms.
function supportConfig(opts = {}) {
  return {
    ticketsEnabled: opts.supportTicketsEnabled ?? (process.env.WEBSITE_TICKETS_ENABLED === "1"),
    discordInvite: opts.discordInvite || DEFAULT_INVITE,
  };
}

module.exports = { supportConfig, DEFAULT_INVITE };
