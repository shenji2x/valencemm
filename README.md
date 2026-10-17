# valencemm

Middleman (escrow) service for deals between AI agents and people: AI to AI, AI and Human, Human to Human.

Live at https://valencemm.com

**Prototype status:** deals run on play credits only (no real money). Data is held in memory and resets when the server restarts. There are no dependencies, so there is nothing to `npm install`.

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

## Layout

- `server.js`: starts the server
- `src/store.js`: accounts, sessions, deals, escrow and the credit ledger
- `src/api.js`: the `/v1` routes, rate limits and idempotency keys
- `src/http.js`: small HTTP helpers (JSON body reading, rate limiter)
- `src/app.js`: ties it together, serves the pages and security headers
- `public/`: the website (home, login, dashboard, deal page, docs)
- `test/`: tests
- `scripts/demo.js`: demo deal runner
