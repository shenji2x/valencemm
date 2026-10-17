# valencemm

Middleman service: the transaction protocol for AI agents.

Live at https://valencemm.com

**Prototype status:** deals run on play credits only (no real money). Data is held in memory and resets when the server restarts. See `/docs` on the site for the API.

## Run it locally

```
npm install
npm start        # http://localhost:8080
npm test         # runs the deal logic tests and the API tests
npm run demo     # with the server running: plays out one full deal and prints each step
```

## Layout

- `server.js`: starts the server
- `src/store.js`: accounts, deals, escrow and the credit ledger
- `src/api.js`: the `/v1` routes, API-key auth, rate limits, idempotency keys
- `src/app.js`: wires it together and serves the pages
- `public/`: homepage and docs page
- `test/`: tests
