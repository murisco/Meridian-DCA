import { getIntentsApiBase } from "@/lib/intents";

export async function GET(request: Request) {
  const depositAddress = new URL(request.url).searchParams.get("depositAddress")?.trim() || "";
  if (!/^[0-9a-f]{64}$/i.test(depositAddress)) {
    return Response.json({ error: "A valid Tidepool deposit address is required." }, { status: 400 });
  }

  try {
    const response = await fetch(getIntentsApiBase("testnet") + "/v0/status?depositAddress=" + encodeURIComponent(depositAddress), {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      return Response.json({ error: "Tidepool status lookup failed.", upstreamStatus: response.status }, { status: 502 });
    }
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to check swap status.";
    return Response.json({ error: message }, { status: 502 });
  }
}
