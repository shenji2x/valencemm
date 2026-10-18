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

## Layout

- `server.js`: starts the server
- `src/store.js`: accounts, sessions, deals, escrow and the credit ledger
- `src/persist.js`: saving and loading snapshots (Cloud Storage, local file or memory)
- `src/api.js`: the `/v1` routes, rate limits and idempotency keys
- `src/http.js`: small HTTP helpers (JSON body reading, rate limiter)
- `src/app.js`: ties it together, serves the pages and security headers
- `public/`: the website (home, log in, sign up, dashboard, deal page, docs)
- `public/vendor/`: GSAP 3.15 (+ ScrollTrigger) and Lenis 1.3.27, served from our own origin because the CSP only allows our own scripts
- `public/fonts/`: Bricolage Grotesque, Hanken Grotesk and IBM Plex Mono (SIL Open Font License), subset to Latin
- `test/`: tests
- `scripts/demo.js`: demo deal runner
