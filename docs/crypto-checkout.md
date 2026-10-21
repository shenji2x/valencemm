# Crypto deposit checkout

The customer flow is choose a coin, receive a deal-specific deposit invoice,
scan the QR or copy the address and exact amount, wait for on-chain confirmation,
then complete the deal. Release pays the seller; refund pays the buyer. Sending
to a personal Exodus address does not itself implement those actions.

The dashboard's Crypto panel uses `public/crypto-checkout.js`. The visual preview
at `/crypto-preview` shares the same component, but its addresses and QR payloads
are deliberately not payable. Sample amounts and network reserves are not live
market quotes. The QR is generated locally with the existing vendored QR library;
no address or invoice is sent to an external image/QR service.

USDT is disabled in both the UI and server policy, on every network. There is no
environment flag that bypasses this. Its future payout flow must display the
selected token/network, native-gas requirement and a fresh payout fee quote, and
require explicit acknowledgement before signing. Other coins also have outgoing
network fees; they must be quoted and acknowledged too.

The native deposit amount is principal plus exactly 1% plus an explicitly quoted
payout network-fee reserve. Sender transaction fees are charged by the sending
wallet separately. There is no swap when deposit and payout use the same asset
and network. A conversion must obtain a real swap quote and approval before it
is included; the application must never invent a rate or call an unknown fee zero.
Atomic integer arithmetic avoids floating-point loss. Amounts that cannot express
an exact 1% fee in atomic units are rejected. There is no 50-cent card-fee minimum
in the crypto quote helper.

The reserve quote must cover every planned outgoing transaction, including
service-fee collection if that requires another transfer. A backend unable to
quote those costs must refuse to issue a live deposit invoice.

The reserve is an estimate, not a guarantee of gas days later. A release/refund
quote must show the destination, network, actual payout fee, recipient net amount,
and any reserve surplus or shortfall, with an expiry and explicit confirmation.
If fees increase, request consent for a top-up or revised payout; never silently
deduct more from the seller's agreed amount or from Valence's 1% fee.

Live deposits remain blocked. `GET /v1/crypto/methods` reports readiness and policy.
`POST /v1/deals/:id/crypto/invoice` authenticates the buyer and checks deal state,
then returns 503 for native coins or 409 for disabled USDT, with no wallet address.
It cannot transition a deal to funded. Client-supplied amounts, addresses, networks
and transaction claims cannot activate payments or modify card funding state.

Before accepting deposits, implement a custody adapter with secure payout signing,
wallet access controls, persistent per-deal invoice/deposit accounting, unique
payment attribution, supported-chain confirmation and reorg checks, time-limited
server exchange/fee quotes, wallet-controlled recipient verification, and tested
release/refund recovery. A customer clicking Refresh or providing a transaction
hash is not proof of payment. Settlement must remain pending until the backend
confirms the actual payout transaction. Use dedicated holding wallets rather
than mixing customer deposits into the owner's personal spending wallet. Public
fee-recipient addresses do not supply signing authority or deposit monitoring.

No private key or recovery phrase belongs in chat, public source code, browser
storage, or the checkout form. No live custody adapter or wallet signer is included
in this change. The older local EVM/signing lab remains an independent developer
test tool, not the customer checkout.

## Deal payment selection and backend boundaries

New deals accept `paymentType: "stripe"` (default for existing clients) or
`paymentType: "crypto"` with `cryptoAsset: "BTC" | "ETH" | "LTC" | "SOL"`.
The server fixes the corresponding native network; other networks and USDT are
rejected. The choice is persisted in the deal snapshot, returned in invite
previews, and cannot be changed after creation. The agreed fiat value is a
reference value, not a crypto exchange quote. Browser-supplied destinations,
fee rates, confirmation counts and payment states are not saved as payment facts.

Stripe funding, confirmation, capture, cancellation, refund, webhook lookup and
timer sweeps exclude crypto deals. Stripe intent confirmations validate the
stored intent, amount, currency and deal metadata; Connect payment webhooks must
match the seller account and fetch current provider state to handle stale events.

**Live custody is not implemented or enabled.** These boundaries are defense in
depth, not a claim that automatic crypto payouts are production ready. There is
no browser, environment flag or API request that enables a live crypto invoice.
No deposit destination is issued until a chain-specific observer, durable payout
worker and independently secured signer are connected and tested. Do not put
seed phrases or wallet keys into the browser, GitHub or chat.

