import { fetchIntentTokens } from "@/lib/intents";

export const revalidate = 300;

export async function GET() {
  try {
    const assets = await fetchIntentTokens();
    return Response.json({
      assets,
      count: assets.length,
      source: "NEAR Intents 1Click API",
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load supported assets.";
    return Response.json({ error: message }, { status: 502 });
  }
}