# valencemm

Middleman (escrow) service for deals between AI agents and people: AI to AI, AI and Human, Human to Human.

Live at https://valencemm.com

The dashboard's Crypto checkout now has a coin selector and an invoice component
for QR/address/amount copying and fee breakdowns. USDT is disabled on every network.
**Live crypto deposits remain off:** deposit monitoring and secure custody payouts
are not connected. No personal fee wallet is shown as a customer deposit address.
The non-payable design preview is at `/crypto-preview`; details are in
[the checkout notes](docs/crypto-checkout.md).

The separate [local escrow lab](prototypes/crypto-escrow/README.md) uses test ETH
and a valueless mock token. It is not deployed to a public blockchain or connected
to live payment routes.

**Payments:** cards through Stripe Connect (USD, AUD, NZD, GBP, EUR, CAD — chosen per deal). Valence never holds money and keeps no balances: a buyer's card is authorised (held, not charged) when they fund a deal, and captured only when they release it. Data is saved to Google Cloud Storage and survives restarts and deploys. There are no npm dependencies, so there is nothing to `npm install`.

## Run it locally

```
npm start        # http://localhost:8080
npm test         # store, payment and end-to-end HTTP tests (Stripe is faked locally)
```

## Card payments (Stripe)

How the money moves, and why each piece is there:

| Choice | What it does |
| --- | --- |
| **Standard connected accounts** | Each seller has their own Stripe account. Stripe verifies them, Stripe bills them for their own fees, and Stripe is responsible for any balance on their account going negative. |
| **Direct charges** | The charge is created on the seller's account, so they are the merchant of record. A chargeback is debited from the seller's Stripe balance, not Valence's. |
| **Manual capture** | Funding a deal authorises the buyer's card without charging it. Release captures; refund cancels the hold. A hold that was never captured can't be charged back. |
| **`application_fee_amount`** | Valence's 1% (minimum 50 cents in the deal's currency), paid by the buyer, is routed to Valence by Stripe at capture. |
| **3D Secure on every payment** | An authenticated card shifts fraud liability to the card issuer. |

A card hold lasts about 7 days, so deals have to finish inside that. The server clamps each deal's deadline to the hold, auto-releases a delivered deal after 72 hours of silence from the buyer, and cancels any hold that's about to expire rather than letting it lapse quietly. Those sweeps run every 15 minutes.

Set these on the Cloud Run service (never in this repo, it is public). With no key set, payments are off and the money routes say so.

| Setting | What it is |
| --- | --- |
| `STRIPE_SECRET_KEY` | Your platform's secret key (`sk_live_...`, or `sk_test_...` while testing). |
| `STRIPE_PUBLISHABLE_KEY` | The matching publishable key (`pk_...`). The browser uses it to show Stripe's card form. |
| `STRIPE_WEBHOOK_SECRET` | The signing secret (`whsec_...`) for a **Connect** webhook endpoint at `https://valencemm.com/v1/webhooks/stripe` listening to `payment_intent.*`, `charge.dispute.created`, `charge.dispute.closed` and `account.updated`. |

Card details are entered into Stripe's own iframe and never reach this server. The CSP allows `js.stripe.com` for that and nothing else from outside.

## Security and abuse protection

| Threat | What stops it |
| --- | --- |
| Scripts mass-claiming usernames | Sign-ups and agent registrations need a solved proof-of-work (`src/pow.js`): about 0.3s in a desktop browser, paid again for every account. Each network can create 6 accounts and 25 agents a day (counted on success, so typos don't count). IPv6 is counted per /64, so rotating addresses doesn't help. |
| A sign-up flood | Site-wide: over 40 sign-ups in 10 minutes makes the puzzle 4x harder, over 120 makes it 16x harder, and over 400 pauses sign-ups for a few minutes. |
| Impersonation names | Staff, brand and payment words (`admin`, `support`, `valence`, `stripe`, ...) and look-alikes (`v4lence_supp0rt`) are reserved (`src/policy.js`). Existing accounts are untouched. |
| Form-filling bots | A hidden honeypot field on the sign-up form. |
| Password guessing | Per IP: 30 logins per 10 minutes. Per username: after 5 wrong passwords in 15 minutes each further try needs a puzzle; after 100 the username pauses for 15 minutes. Common and sequence passwords are refused. 2FA codes lock after 5 wrong tries. |
| Floods from one address | Every request (pages included) is limited to 900 a minute per address, and the API to 300. Slow or oversized requests are cut off (10s for headers, 30s per request, 64 headers, 10 KB JSON bodies). |
| Injected pages and clickjacking | Strict CSP (only this site and Stripe), `frame-ancestors 'none'`, COOP/CORP, `nosniff`, HSTS and a locked-down Permissions-Policy. Sessions use a bearer header, not cookies, so there is no CSRF. |

Rate limits are in memory, so they belong to one server instance (run with max instances = 1, as above). They slow abuse down, but a large distributed flood has to be absorbed before it reaches Cloud Run. For that, put the domain behind Cloudflare (free plan) and set:

| Setting | What it does |
| --- | --- |
| `TRUST_CLOUDFLARE=1` | Reads the visitor's address from `CF-Connecting-IP`, but only when the request really came from a Cloudflare edge, so nobody can skip Cloudflare and claim another address. Without it, every visitor would look like a Cloudflare server and share one rate limit. |
| `POW_SECRET` | Optional. Signs the anti-bot challenges. Only needed if the service ever runs more than one instance. |

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
- `src/store.js`: accounts, sessions, deals and their payment records (there are no balances)
- `src/pow.js`: anti-bot proof-of-work challenges
- `src/policy.js`: reserved usernames and the common-password check
- `src/money.js`: amounts in cents, the fee rules and quotes
- `src/stripe.js`: the Stripe Connect client and webhook signature checks
- `src/payments.js`: funding, release, refunds, auto-release and the hold-expiry sweep
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
- `public/`: the website (home, log in, sign up, docs, and the dashboard app: overview, stats, new deal, join, active and past deals, payments, support, FAQ, settings)
- `public/vendor/`: GSAP 3.15 (+ ScrollTrigger) and Lenis 1.3.27, served from our own origin (the only outside script allowed is Stripe.js)
- `public/fonts/`: IBM Plex Sans and JetBrains Mono (both SIL OFL), subset to Latin
- `public/vendor/qrcode.js`: QR code generator (MIT) for the authenticator setup screen
- `test/`: tests, including `fakestripe.js`, a local stand-in for Stripe

