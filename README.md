# MERIDIAN DCA

**Cross-chain dollar-cost averaging planner powered by NEAR Intents 1Click.**

MERIDIAN helps a user define a recurring cross-chain buy, inspect a live 1Click quote, apply a user-selected slippage limit, and save a local DCA plan. This hackathon prototype is deliberately **dry-run only**.

## What works in this prototype

- Loads the current supported asset list from the NEAR Intents 1Click `GET /v0/tokens` endpoint.
- Connects NEAR wallets on **testnet** and displays the connected account with a disconnect control. Wallet connection is account-only; it does not sign or send transactions.
- Uses token-provided decimals to convert human-readable amounts into base units without floating-point arithmetic.
- Requests real 1Click quotes from the server-side `POST /v0/quote` endpoint with `dry: true`.
- Sends explicit `ORIGIN_CHAIN` deposit/refund types and `DESTINATION_CHAIN` recipient type for cross-chain quotes.
- Sends the user's maximum slippage in basis points and a short quote deadline.
- Displays expected output, minimum output, the slippage guard, quote reference and expiry when returned by 1Click.
- Lets a user save daily, weekly or monthly DCA plans in browser local storage.
- Lets a user run a fresh dry-run quote for a saved plan. The UI compares the returned expected output and minimum output against the plan's saved slippage limit and records a visible `PASSED`, `BLOCKED`, `UNVERIFIED` or `ERROR` check result.
- Provides `GET /api/health` for deployment health.

## Try it

Hosted demo: https://meridian-dashboard.up.railway.app/

1. Open the dashboard. Optionally connect a wallet using **Connect Wallet** at the top-right. The selector is filtered to NEAR testnet-compatible wallets. Wait for the supported-asset list to load from NEAR Intents.
2. Choose a source asset and a different destination asset.
3. Enter an amount, a destination-chain recipient address, and a source-chain refund address.
4. Set the maximum slippage and select Daily, Weekly or Monthly.
5. Choose **Preview live quote**. The quote card should show the returned output, minimum output, slippage guard and quote reference.
6. Choose **Save recurring plan**. The plan should appear under **My strategies**.
7. Choose **Check quote** on that saved plan. MERIDIAN requests a new dry-run quote using the saved addresses, amount and slippage limit, then shows the local minimum-output check result.
8. Refresh the page. Saved plans and their last dry-run result should remain in that browser.

API checks:

- `GET /api/health` — returns app health and `dry-run-only` mode.
- `GET /api/tokens` — returns the current supported asset list and count.
- `POST /api/quote` — validates input and requests a real 1Click quote with `dry: true`.

## NEAR Intents integration

The application uses the NEAR Intents 1Click API as its cross-chain quote and routing layer. MERIDIAN sends token `assetId` values from the live token endpoint and uses each token's `decimals` field for base-unit conversion. The quote is requested server-side so a partner JWT, when configured, remains secret.

The user-selected slippage is sent as `slippageTolerance` in basis points (100 = 1%). The quote response's `amountOut` and `minAmountOut` are used for the saved-plan dry-run check. The quote request also includes a three-minute deadline.

The implementation follows the [NEAR Intents agent skill](https://github.com/near/agent-skills/tree/main/skills/near-intents) for the token catalogue and quote API path, together with the official [1Click quickstart](https://docs.agentsonintents.com/integration/distribution-channels/1click-api/quickstart/making-a-request) and [NEAR Hackathon Unstoppable DeFi prompt](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/01-defi.md). The skill's committed-quote, deposit, and status-tracking stages are intentionally not enabled in this dry-run prototype.

## Safety boundary and limitations

This release is **dry-run only**. The server forces `dry: true`; it never requests a committed quote or deposit address. The optional wallet connection is restricted to NEAR testnet and is used only to identify the connected account; this release does not request transaction signatures or send wallet transactions. MERIDIAN does not initiate token transfers, custody assets, or run unattended recurring swaps.

Saved plans are browser-local planning records, not on-chain vaults and not server-side scheduled jobs. The **Check quote** action is manually triggered by the user and only obtains a fresh dry-run quote. It does not execute a buy.

Because this demo does not create deposits, it does not currently have real swap history or live `SUCCESS`, `REFUNDED` or `FAILED` transaction states. Those require a separately approved execution flow, deposit tracking and explicit wallet authorization. Do not describe the current prototype as automated on-chain DCA.

## Local development

Requirements: Node.js 20 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Configuration

Optional server-side environment variable:

- `NEAR_INTENTS_JWT` — partner JWT for the 1Click API. Configure it in the hosting environment, never in browser code or a committed file.

Without a JWT, the 1Click documentation currently describes an additional unauthenticated fee on eligible quotes. Check the live [fee documentation](https://docs.agentsonintents.com/integration/distribution-channels/1click-api/authentication) for the applicable schedule.

## Deployment

The production service is hosted on Railway and deploys from the `main` branch. The service listens on the Railway-provided port.

Health check path: `/api/health`.

## Built with

- Next.js 15
- React 19
- TypeScript
- NEAR Intents 1Click API
- Railway

## Hackathon review notes

Track: **Unstoppable DeFi** (`defi`).

Judges can reproduce the core demo using the hosted dashboard and the numbered **Try it** steps above. The key NEAR integration demonstrated is a real cross-chain 1Click quote using the live supported-asset catalogue, server-side quote request, route types, deadline and slippage tolerance, all in dry-run mode.

The current prototype intentionally demonstrates quote generation and plan-level quote checks rather than deposits or live execution. This limitation is visible in the application and is enforced server-side.
