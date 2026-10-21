# Valence crypto escrow lab

A working, isolated **test-money prototype**, not a live payment integration.
It demonstrates direct per-deal escrow with an exact 1% Valence fee, no payment
processor commission, and transaction gas paid by customers. There is no new
hosting account, API subscription, public RPC connection or real-money deposit.

## Try it

Use Node.js 22.14 or newer (the current live site's Node 20 runtime is separate):

```powershell
cd prototypes/crypto-escrow
npm ci --ignore-scripts
npm test
npm run demo
npm start
```

Open <http://127.0.0.1:8790>. One sample deal is ready. Try delivery, release,
refund, disputes and the local clock controls. All displayed roles are simulated;
you control every demo role. No wallet or payment is required. Restarting the
server or resetting the demo creates a fresh local chain and loses its test data.

`npm run demo` also executes and verifies the release and disputed-refund flows
without a browser. `npm run compile` writes local Solidity artifacts. npm audit
can check development dependencies; its result is not a smart-contract audit.

## Assets and network boundaries

| Asset | Prototype status |
| --- | --- |
| Test ETH | Implemented on the local EVM |
| TESTUSD | Implemented six-decimal mock token; **not Tether USDT**, no monetary value |
| Real USDT, BTC, LTC, ETH and SOL | Not enabled on the live website |

Both deployable prototype contracts reject every chain ID except local 31337
and Ethereum Sepolia 11155111. Tests also simulate Sepolia locally; **no contract
has been deployed to the public Sepolia network**. No mainnet switch, public
deployment script or private-key configuration is supplied. Do not remove the
network guard to accept real funds.

The existing Stripe routes, persistence, accounts, payment timers and public
website remain separate. Docker and gcloud upload ignore files exclude this
directory. Development dependencies are installed only in this package. Check
test files use `.spec.mjs` and an explicit nested test script, so root `npm test`
does not silently pull in the Solidity toolchain.

## What the contract enforces

1. The buyer funds a deal with principal plus exactly 1%. Principal must be a
   multiple of 100 atomic units so there is no rounding above 1%. For TESTUSD this
   permits four fractional decimal places; for test ETH, sixteen.
2. Funds stay in the contract, identified by a deal ID and a hash of the agreed
   terms. Deal identity includes the funded terms as well as the chain, contract
   and nonce, preventing a reorg from reusing the ID for different terms.
   The allowed asset, participants, work deadline, treasury and arbitrator
   are fixed. No administrator can sweep funds or replace those addresses.
3. The buyer can release. The seller can refund before a dispute. For undelivered
   work, the buyer can refund after the work deadline. Delivery must occur before
   that deadline and starts a full 72-hour review period.
4. Either participant can dispute before finalization (for a delivered deal,
   before the review period ends). Disputes block all settlement paths until the
   designated arbitrator chooses full payment or full refund. An EIP-712 signed
   decision can be submitted by a customer paying gas, so Valence only signs
   off-chain. The signature binds the decision, deal ID, expiry, chain and contract;
   finalization prevents replay. Partial awards are
   not implemented. An unavailable arbitrator leaves a disputed deal locked.
5. Anyone can finalize an undisputed delivery after its review period. This
   requires a transaction; a smart contract does not wake itself up. The lab
   presents a customer-paid finalization action rather than a funded keeper.
6. Release creates a seller claim for the principal and a treasury claim for the
   fee. Full refund returns both principal and service fee to the buyer. Spent
   blockchain gas is never refundable.
7. Claims are scoped to finalized deals and cannot be used to fund another deal.
   This is not a wallet balance or an automatic fiat conversion. Separate claims
   keep a failing recipient from blocking settlement or another beneficiary.
8. A beneficiary can claim to a chosen address. `claimFor(id, beneficiary)` lets
   anyone pay the gas, but sends the funds only to that beneficiary. In particular,
   the buyer can collect Valence's fee into its fixed treasury without Valence
   paying gas. This is permissionless, not an enforced incentive: collection may
   wait if nobody submits the transaction.

The 1% pays for Valence's service; it does not include gas. Deposit, token approval,
release/refund, arbitration and claim transactions each have a gas payer. Customer
transactions cover settlement, fee collection and signed dispute decisions in the
demo. The contract also allows the arbitrator to resolve directly, which would
require the arbitrator to pay gas; the demo uses the customer-sponsored path.
Somebody must submit a finalization, claim or signed award: gas is not eliminated
and automatic execution without a willing submitter is not guaranteed. Public
deployment needs deployment gas. Free RPC quotas do not fund that cost, and do
not promise unlimited production infrastructure.

## Security properties exercised

Tests execute compiled Solidity on an in-process Hardhat EVM, not a JavaScript
imitation of the contract. They check exact fee conservation, native/token funding,
refunds including the service fee, role restrictions, deadlines, review periods,
frozen disputes, finalization replay, double claims, customer-funded fee collection,
signed-award forgery, replay, expiry, chain/contract binding, reentrancy, failed
native transfers, false-return tokens, fee-on-transfer rejection,
unknown assets, invalid terms, cross-deal isolation and mainnet deployment rejection.
HTTP checks cover loopback binding, origin and Host validation, anti-CSRF tokens,
unsupported assets, input handling, concurrent actions and a complete refund flow.

OpenZeppelin SafeERC20 and ReentrancyGuard are used. The compiler and dependencies
are pinned in the lockfile. The `tmp` override selects a patched compiler dependency.
`TestActors.sol` contains adversarial fixtures and is not a deployment target.

## Before any real-money integration

This code is unaudited. The lab uses publicly known development accounts and
unrestricted test-token minting; it must never be exposed as a live payment API.
The local HTTP server binds only to loopback, rejects other Host/Origin values,
and does not publish the Ethereum JSON-RPC provider or private keys.

A production design still needs independent contract/security review; buyer and
seller wallet authentication and agreement to signed terms; a securely controlled
arbitration signer (with an availability and recovery plan); production review
of the customer-sponsored decision flow; canonical token/network
verification; confirmation and reorg handling; reconciliation to Valence deal IDs;
and tested operational recovery. ERC20 tokens with transfer taxes, rebasing or
blacklist/freeze behavior need specific treatment. Directly sending ETH or tokens
to the escrow address outside `fund` is unsupported and can strand funds.

The next useful step is a wallet-controlled public Sepolia trial with faucet test
funds. It does not require buying a BTCPay VM or a paid Alchemy account. Real USDT
on a selected network, and BTC/LTC/SOL on their own chains, are separate integrations
that should not be advertised as available before they exist and are verified.

References: [Ethereum test networks](https://ethereum.org/developers/docs/networks/),
[Solidity security considerations](https://docs.soliditylang.org/en/latest/security-considerations.html),
[OpenZeppelin contracts](https://docs.openzeppelin.com/contracts/5.x/),
[Alchemy pricing and free-tier limits](https://www.alchemy.com/pricing).
