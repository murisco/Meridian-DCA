export async function GET() {
  return Response.json({
    status: "ok",
    app: "meridian-dca",
    capabilities: {
      mainnet: "dry-run-only",
      testnet: "wallet-approved-swaps",
      recurring: "local-plan-only",
    },
    timestamp: new Date().toISOString(),
  });
}
