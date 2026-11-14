# MERIDIAN DCA

**Cross-chain dollar-cost averaging planner powered by NEAR Intents 1Click.**

MERIDIAN helps a user define a recurring cross-chain buy, inspect a live quote, apply a user-selected slippage limit, save a local DCA plan, and execute a wallet-approved first swap on NEAR testnet. Mainnet execution remains disabled.

## What works in this prototype

- Loads the current supported asset list from the NEAR Intents 1Click `GET /v0/tokens` endpoint.
- Connects NEAR wallets from standard desktop and mobile browsers through NEAR Connect, restricted to **testnet**. The connection only identifies the selected account; it does not request transaction signatures or submit wallet transactions.
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

1. Open the dashboard in Safari, Chrome or a desktop browser. Optionally choose **Connect Wallet** at the top-right and select a supported NEAR testnet wallet. Wait for the supported-asset list to load from NEAR Intents.
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

The implementation follows the [NEAR Intents agent skill](https://github.com/near/agent-skills/tree/main/skills/near-intents) for the token catalogue and quote API path, together with the official [1Click quickstart](https://docs.agentsonintents.com/integration/distribution-channels/1click-api/quickstart/making-a-request) and [NEAR Hackathon Unstoppable DeFi prompt](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/01-defi.md). The testnet swap flow implements committed quotes, deposits and status tracking through Tidepool. Mainnet committed quotes and deposits remain disabled.

## Safety boundary and limitations

Mainnet remains dry-run only. On testnet, a user can request a committed Tidepool quote and approve the token deposit in their connected wallet. MERIDIAN does not hold wallet private keys. Tidepool is a community-operated testnet service and manages the per-quote deposit addresses. Only valueless test assets may be sent there.

Saved plans are browser-local planning records, not on-chain vaults and not server-side scheduled jobs. The first-buy action is separate from saving a plan. It polls Tidepool and reports `SUCCESS` only when the provider confirms settlement.

Future unattended DCA buys are not enabled. To execute future purchases without the user opening the app and approving each transaction, MERIDIAN needs a separate recurring authorization mechanism, such as a narrowly scoped smart-contract vault or delegated key with explicit spending limits. Do not store wallet private keys or describe local plans as automatic execution.

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


## Testnet sandbox mode

The dashboard now defaults to **Tidepool testnet sandbox** for testing with valueless test assets. The quote-environment selector can switch between:

- **Testnet sandbox — Tidepool:** loads Tidepool's testnet token catalogue and supports dry-run previews plus wallet-approved test swaps through `https://www.usetidepool.tech`. This is a community-operated sandbox and is not affiliated with NEAR or Defuse. Its deposit addresses are managed by Tidepool. Never send real assets to it.
- **Mainnet — NEAR Intents 1Click:** loads the official mainnet token catalogue and requests a `dry: true` quote from `https://1click.chaindefuser.com`.

The connected NEAR wallet remains testnet-only. Its menu reads the native NEAR balance and the six Tidepool NEP-141 test-token balances using NEAR testnet RPC. The balance reader is read-only.

**Important:** mainnet remains preview-only. Testnet execution is available only for Tidepool NEAR tokens and requires explicit wallet approval.


## Ref Finance testnet first-buy route

MERIDIAN includes a separate optional route intended to use the existing testnet wrapped NEAR token:

- Input: `wrap.testnet` wNEAR (24 decimals).
- Output: `wbtc.fakes.testnet` WBTC (8 decimals), which is the WBTC entry in Ref Finance's testnet SDK token list.
- Ref Finance testnet DCL contract: `dclv2.ref-dev.testnet`.
- The app reads live pool information and requests quotes directly from the NEAR testnet RPC. It displays a swap option only when a running matching pool returns a positive quote.
- The first test is capped at 0.02 wNEAR. The quote applies the selected slippage tolerance and computes minimum WBTC output using integer base units.
- If the wallet has not registered to receive WBTC, the app first requests the token's exact `storage_balance_bounds.min` deposit, then requests a separate wallet approval for the swap.
- After submission, MERIDIAN verifies that the wallet's WBTC balance increased before showing success.

This is an independent Ref Finance NEAR testnet DEX route, not a NEAR Intents route and not Tidepool. Testnet tokens have no monetary value. Do not send real assets to testnet contracts.

## DCA scheduling status

Saved daily, weekly or monthly plans are still local browser records. They do not trigger future transactions when the user is offline. The first-buy swap is user-approved. Automatic recurring purchases require a separate user-authorized mechanism, such as a scoped smart-contract vault or delegated key with strict amount/frequency limits and appropriate security review. MERIDIAN does not store wallet private keys.

## Native NEAR testnet wrapping

The connected wallet panel includes an opt-in **Wrap 0.02 NEAR → wNEAR** action for the NEAR testnet wrapper contract `wrap.testnet`.

- The app checks the wallet's `wrap.testnet` storage registration status and current native NEAR balance before preparing the transaction.
- If the account is not registered, the wallet transaction includes `storage_deposit` with a 0.00125 NEAR attached deposit, followed by `near_deposit` with exactly 0.02 NEAR.
- If already registered, only the 0.02 NEAR `near_deposit` call is included.
- Each function call uses 30 Tgas. The app keeps a 0.03 NEAR minimum liquid-balance reserve before allowing the action; actual gas is separate.
- The user must review and approve the transaction in their connected wallet. MERIDIAN never has the user's private keys.
- The app only reports wrapping success after the NEAR testnet RPC confirms that the `wrap.testnet` wNEAR balance increased by at least 0.02.
- This creates `wrap.testnet` wNEAR. It is distinct from Tidepool's `wnear.tidepool-sandbox.testnet` token and cannot be used as the input asset for Tidepool's wNEAR/wBTC test routes. Claim the Tidepool wallet-mode faucet tokens for the sandbox swap.

This transaction feature is testnet-only and is not a production financial flow.
