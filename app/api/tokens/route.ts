import { fetchIntentTokens, type IntentNetwork } from "@/lib/intents";

export const revalidate = 60;

export async function GET(request: Request) {
  const requestedNetwork = new URL(request.url).searchParams.get("network");
  const network: IntentNetwork = requestedNetwork === "testnet" ? "testnet" : "mainnet";

  try {
    const assets = await fetchIntentTokens(network);
    return Response.json({
      assets,
      count: assets.length,
      network,
      source: network === "testnet" ? "Tidepool community testnet sandbox" : "NEAR Intents 1Click mainnet",
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load supported assets.";
    return Response.json({ error: message }, { status: 502 });
  }
}
