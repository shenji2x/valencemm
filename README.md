# valencemm

Middleman (escrow) service for deals between AI agents and people: AI to AI, AI and Human, Human to Human.

Live at https://valencemm.com

**Prototype status:** deals run on play credits only (no real money). Data is saved to Google Cloud Storage and survives restarts and deploys. There are no npm dependencies, so there is nothing to `npm install`.

## Run it locally

```
npm start        # http://localhost:8080
npm test         # store tests + end-to-end HTTP tests
npm run demo     # with the server running: plays out one full AI to AI deal and prints each step
```

### Test credits (stand-in for depositing money)

Set `TEST_CREDIT_CODES` before starting the server. Format is `code=credits`, comma separated, codes at least 8 characters. Then type a code into "Add test credits" on the dashboard.

```
# Mac / Linux / Git Bash
TEST_CREDIT_CODES="my-secret-code=500" npm start

# Windows PowerShell
$env:TEST_CREDIT_CODES="my-secret-code=500"; npm start
```

Never commit a real code to this repo (it is public). On Cloud Run, set it as an environment variable on the service instead. With no variable set, the feature is off.

## Saving data

The server keeps its working copy in memory and saves a full snapshot after every change, before it answers the request. On startup it loads the last snapshot. Where it saves depends on the environment:

| Setting | Where data goes |
| --- | --- |
| `STORAGE_BUCKET=<bucket>` | One JSON object (`STORAGE_OBJECT`, default `valence-state.json`) in that Cloud Storage bucket. Used in production. |
| `DATA_FILE=./data/state.json` | A local file. Handy for development. |
| neither | Memory only; everything is lost on restart (tests use this). |

```
DATA_FILE=./data/state.json npm start
```

Cloud Storage writes are conditional (`ifGenerationMatch`), so a second server can never silently overwrite newer data; if that happens, or a save keeps failing, the server exits and Cloud Run restarts it from the last saved snapshot. Run the Cloud Run service with **max instances = 1** so there is only ever one writer. To wipe all data, delete the object from the bucket and redeploy.

## Support tickets and Discord

People open tickets from the dashboard (Support) and can attach screenshots. Each ticket is relayed to the owner's Discord server. Set these on the Cloud Run service (never in this repo, it is public):

| Setting | What it does |
| --- | --- |
| `DISCORD_BOT_TOKEN` + `DISCORD_GUILD_ID` | **Two-way.** The bot creates a channel per ticket, posts the customer's messages and images there, and sends staff replies back to the website. |
| `DISCORD_PUBLIC_KEY` | Turns on slash commands. Copy it from the application's General Information page, and set the **Interactions Endpoint URL** there to `https://valencemm.com/discord/interactions`. Without this, replies still work but `/claim`, `/close` and `/link` do not. |
| `DISCORD_OWNER_ROLE_ID` | Members with this role show to customers as **Owner**, and can reply without claiming first. |
| `DISCORD_SUPPORT_ROLE_ID` | Members with this role show as **Support**, and must `/claim` a ticket before their messages reach the customer, so every reply is attributable. |
| `DISCORD_TICKET_CATEGORY_ID` | Optional. Puts ticket channels under this category (make it private to staff). |
| `DISCORD_TRANSCRIPT_CHANNEL_ID` | Optional. Transcripts are posted here when a ticket closes, instead of in the ticket channel. |
| `DISCORD_WEBHOOK_URL` | One-way fallback when there is no bot: tickets are posted to the webhook's channel, but replies cannot come back. |

Staff commands, in a ticket channel: `/claim`, `/unclaim`, `/close [reason]`, `/transcript`, `/ticket`, `/help`. Customers run `/link <code>` anywhere in the server, using a code from Settings on the website; once linked, the bot gives them access to their own ticket channels.

The bot needs **Manage Channels**, **View Channels**, **Send Messages**, **Read Message History** and **Attach Files**, the **Message Content** intent, and both the `bot` and `applications.commands` scopes. Staff replies are fetched while the customer has their ticket open, so there is no background process to keep running.

Customers never see a staff member's Discord name: replies are labelled with the role. The owner's own records (the Discord channel, `/ticket`, and the transcript posted to Discord) do name who handled it.

Attachments are images only (PNG, JPEG, GIF, WebP), checked by their actual file header rather than the name they were given, up to 8 MB each and 4 per message. They are stored in the same Cloud Storage bucket as the data (under `attachments/`) and served only to the ticket's owner.

## Layout

- `server.js`: starts the server
- `src/store.js`: accounts, sessions, deals, escrow and the credit ledger
- `src/persist.js`: saving and loading snapshots (Cloud Storage, local file or memory)
- `src/discord.js`: relays support tickets to Discord (bot or webhook)
- `src/security.js`: authenticator codes (RFC 6238), email and recovery codes
- `src/support.js`: ties tickets, the Discord relay, attachments and transcripts together
- `src/files.js`: attachment storage (Cloud Storage, local files or memory)
- `src/transcript.js`: builds the transcript page
- `src/email.js`: sends security emails (Resend)
- `src/api.js`: the `/v1` routes, rate limits and idempotency keys
- `src/http.js`: small HTTP helpers (JSON body reading, rate limiter)
- `src/app.js`: ties it together, serves the pages and security headers
- `public/`: the website (home, log in, sign up, docs, and the dashboard app: overview, stats, new deal, join, active and past deals, support, FAQ, settings)
- `public/vendor/`: GSAP 3.15 (+ ScrollTrigger) and Lenis 1.3.27, served from our own origin because the CSP only allows our own scripts
- `public/fonts/`: Roboto (Apache 2.0) and JetBrains Mono (SIL OFL), subset to Latin
- `public/vendor/qrcode.js`: QR code generator (MIT) for the authenticator setup screen
- `test/`: tests
- `scripts/demo.js`: demo deal runner
