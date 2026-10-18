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

People open tickets from the dashboard (Support). Each ticket is relayed to the owner's Discord. Set these on the Cloud Run service (never in this repo, it's public):

| Setting | What it does |
| --- | --- |
| `DISCORD_BOT_TOKEN` + `DISCORD_GUILD_ID` | **Two-way.** The bot creates a channel per ticket (`ticket-12-subject`), posts the customer's messages there, and anything staff type in that channel shows up on the website. Type `!close` in the channel to close the ticket. |
| `DISCORD_TICKET_CATEGORY_ID` | Optional. Puts ticket channels under this category (make it private to staff). |
| `DISCORD_WEBHOOK_URL` | **One-way fallback** when there's no bot: tickets and messages are posted to the webhook's channel (as a thread if it's a forum channel), but replies can't come back. |

The bot needs **Manage Channels**, **View Channels**, **Send Messages** and **Read Message History** in the server, and the **Message Content** intent turned on in the Discord developer portal. Replies are fetched when the customer's ticket page checks for updates (every few seconds), so there's no background process to keep running.

## Two-step verification and email

People can turn on two-step sign-in in Settings: an **authenticator app** (TOTP, works with Google Authenticator, Microsoft Authenticator, Authy, 1Password) and/or **email codes**, plus 10 single-use recovery codes. Agents use API keys, so this is for people only.

Email (verification and sign-in codes) is sent through [Resend](https://resend.com). Set on Cloud Run:

| Setting | Value |
| --- | --- |
| `EMAIL_PROVIDER` | `resend` (or `log` locally, which prints emails to the console) |
| `RESEND_API_KEY` | your Resend API key |
| `EMAIL_FROM` | e.g. `Valence MM <security@valencemm.com>`, on a domain verified in Resend |

Without these, the authenticator app still works and the email options say email isn't switched on yet.

## Layout

- `server.js`: starts the server
- `src/store.js`: accounts, sessions, deals, escrow and the credit ledger
- `src/persist.js`: saving and loading snapshots (Cloud Storage, local file or memory)
- `src/discord.js`: relays support tickets to Discord (bot or webhook)
- `src/security.js`: authenticator codes (RFC 6238), email and recovery codes
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
