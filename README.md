# MERIDIAN DCA

**A cross-chain dollar-cost averaging planner and testnet swap prototype built around NEAR.**

MERIDIAN lets a user choose an asset to invest with, choose an asset to accumulate, preview a route and its slippage limits, approve a cross-chain testnet deposit from a NEAR wallet, and track the provider's settlement result. It also lets users save daily, weekly or monthly DCA strategies.

> **Important scope note:** the first cross-chain purchase is wallet-approved and has been demonstrated on Tidepool's community testnet sandbox. Saved recurring strategies are currently browser-local plans and do **not** execute automatically. Automatic recurring execution needs a separately authorized vault/keeper design and is not represented as live in this prototype.

Hosted demo: https://meridian-dashboard.up.railway.app/

Public repository: https://github.com/murisco/Meridian-DCA

## What is implemented

- Loads supported assets and decimals from the NEAR Intents 1Click-compatible token catalogue.
- Connects a NEAR testnet wallet through NEAR Connect.
- Lets the user select a source asset and a destination asset independently.
- Requests dry-run route quotes and checks the returned minimum output against the user's slippage limit.
- Requests an executable testnet quote from Tidepool's community sandbox.
- Uses the connected NEAR wallet to approve the exact quoted source-token deposit.
- Accepts a destination address for the selected destination chain, while retaining the connected NEAR account as the source refund address.
- Polls the Tidepool status endpoint and handles success, failed, refunded, expired and pending states.
- Reads native NEAR and test-token balances from NEAR testnet RPC.
- Saves daily, weekly and monthly DCA plans in browser local storage and can request a fresh quote for a saved plan.

## Reproduce the cross-chain demo

The testnet flow uses valueless sandbox tokens. Never send real assets to testnet contracts or testnet deposit addresses.

1. Open the hosted dashboard in a browser and connect Meteor or another supported NEAR testnet wallet.
2. Claim NEAR test tokens using the Tidepool faucet in **Wallet (NEP-141)** mode: https://app.usetidepool.tech/faucet
3. In the asset selector, choose a Tidepool NEAR testnet token as the source, for example **wNEAR · NEAR**. This must be Tidepool's wnear.tidepool-sandbox.testnet asset, not the separate wrap.testnet wrapper token.
4. Choose a destination asset and network, for example **ETH · Ethereum**.
5. Enter an address that belongs to the selected destination network. Keep the connected NEAR wallet as the source refund address.
6. Enter a small test amount, set the maximum slippage and select **Preview selected swap**.
7. Review the source, destination, networks, output amount, minimum received, expiry and provider. Do not approve if any asset or network is wrong.
8. Select **Approve deposit & execute** and approve the exact source-token deposit in the NEAR wallet.
9. Keep the app open while it checks the provider status. A success state is shown only after Tidepool reports the payout as successful.

A test run was completed for **wNEAR on NEAR testnet → ETH on an Ethereum test network**. The dashboard displayed Tidepool's successful payout confirmation. The quote and output values are estimates for that test run, not market prices.

## Quotes and execution paths

MERIDIAN keeps two paths distinct:

### NEAR Intents 1Click quote preview

- The mainnet token catalogue and quote preview use the official NEAR Intents 1Click API.
- Preview requests send dry=true; they do not create a deposit address or move funds.
- The UI displays available quote details and checks minimum output against the configured slippage tolerance.
- Mainnet execution is disabled in this release.

### Tidepool community testnet sandbox

- The testnet asset catalogue and wallet-approved cross-chain test deposits use Tidepool's community-operated sandbox.
- Tidepool is a separate service and is not the official NEAR Intents/Defuse production service.
- Its testnet token contracts and asset IDs are distinct from similarly named NEAR testnet tokens. In particular, wnear.tidepool-sandbox.testnet is not wrap.testnet.
- Tidepool creates a per-quote deposit address and reports the settlement state. MERIDIAN sends the exact source amount to that address only after wallet approval.
- Testnet assets have no monetary value.

The NEAR HACKATHON instructions state that there is no official NEAR Intents testnet; their guidance is to use mainnet with separate development accounts and dry=true quotes. The Tidepool demo is therefore described as a community testnet sandbox, not as an official NEAR Intents testnet.

## DCA scheduling status and limitations

The strategy form supports Daily, Weekly and Monthly intervals. Today, those plans are saved in the current browser's local storage. The app can request a fresh quote when the user returns and selects **Check quote**.

**Automatic recurring purchases are not enabled.** There is no server-side scheduler, persistent plan database, keeper, escrow vault, or recurring spending authorization in this repository. The user must open the app and approve each purchase. A future unattended DCA release needs an explicit, limited authorization design, such as a user-funded NEAR vault with per-interval caps, destination and slippage constraints, cancellation, execution records and a carefully scoped keeper. The application does not store wallet private keys or claim that local browser reminders are automatic execution.

## API overview

- GET /api/health — deployment health.
- GET /api/tokens?network=testnet|mainnet — supported asset catalogue.
- POST /api/quote — dry-run quote preview.
- POST /api/swap/quote — executable Tidepool testnet quote.
- POST /api/swap/submit — submits a source-chain transaction hash to the provider.
- GET /api/swap/status?depositAddress=... — settlement status.

## Local development

Requirements: Node.js 20 or newer.

    npm install
    npm run dev

Open http://localhost:3000.

## Configuration

Optional server-side environment variable:

- NEAR_INTENTS_JWT — partner JWT for official NEAR Intents 1Click requests. Configure it in the hosting environment; never put it in browser code or commit it.

## Deployment

The production service is hosted on Railway and deploys from the main branch.

Health check path: /api/health.

## Built with

- Next.js 15
- React 19
- TypeScript
- NEAR Connect
- NEAR Intents 1Click quote API
- Tidepool community testnet sandbox
- Railway

## NEAR HACKATHON

Track: **Unstoppable DeFi** (defi).

The hackathon prompt describes a cross-chain DCA vault that executes a user-authorized buy on each interval, handles failed/refunded states and shows where funds are held. MERIDIAN currently demonstrates asset selection, quote preview, user-approved cross-chain testnet execution and settlement tracking. The local recurring-plan feature is a planner only; unattended vault execution is future work and is not claimed as implemented.

See the official track prompt: https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/01-defi.md

See the current event instructions: https://nearhackathon.com/HACKATHON.md
