# MERIDIAN DCA

**Cross-chain recurring investment planning, powered by NEAR Intents.**

MERIDIAN DCA helps users plan recurring purchases across supported chains, preview real swap quotes, set investment parameters and keep a transparent record of their plans.

## Current capabilities

- Live supported-asset list from the NEAR Intents 1Click API.
- Decimal-safe input conversion using each token's API-provided precision.
- Real 1Click quote previews with \`dry: true\`.
- Configurable source and destination assets, destination/refund addresses and slippage tolerance.
- Local recurring-plan planner for daily, weekly and monthly strategies.
- Railway health endpoint at \`/api/health\`.

## Safety boundary

This release is **dry-run only**. Quote requests are forced server-side to \`dry: true\`. The app does not request deposit addresses, initiate transfers, custody assets, sign transactions or run unattended recurring swaps. Plans are saved in the user's browser and are planning records, not active on-chain automation.

NEAR Intents documents that \`dry: true\` validates and previews a swap without generating a deposit address. A future execution release must add explicit wallet authorization, committed quotes, chain-specific deposit handling, status tracking and refund/failure handling before it can be described as live DCA.

## Run locally

Requirements: Node.js 20 or newer.

\`\`\`bash
npm install
npm run dev
\`\`\`

Open http://localhost:3000.

## Optional partner JWT

Set \`NEAR_INTENTS_JWT\` in the server environment to use a partner JWT. Keep this value server-side; never expose it in browser code. Without a JWT, NEAR Intents documents an additional 0.25% fee on eligible non-ANY_INPUT quotes.

## Deploy on Railway

Deploy the \`main\` branch as a Node.js service. Railway should detect Next.js and run the package build/start scripts. The app listens on the port supplied by Railway through Next.js.

Health check path: \`/api/health\`.

## API routes

- \`GET /api/tokens\` — cached supported assets.
- \`POST /api/quote\` — server-side dry-run quote only.
- \`GET /api/health\` — deployment health.

## Roadmap

1. Wallet connection and verified address ownership.
2. User-authorized quote commitment and chain-specific deposits.
3. Swap status history, explorer links, refund and failure states.
4. Secure server-side schedule execution with durable storage and explicit approvals.
5. NEAR contract-based vault ownership as a later stretch goal.
