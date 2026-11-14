import { getIntentsApiBase } from "@/lib/intents";

export async function POST(request: Request) {
  let input: { depositAddress?: unknown; txHash?: unknown };
  try {
    input = await request.json() as { depositAddress?: unknown; txHash?: unknown };
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const depositAddress = typeof input.depositAddress === "string" ? input.depositAddress.trim() : "";
  const txHash = typeof input.txHash === "string" ? input.txHash.trim() : "";
  if (!/^[0-9a-f]{64}$/i.test(depositAddress) || !/^[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(txHash)) {
    return Response.json({ error: "A valid deposit address and NEAR transaction hash are required." }, { status: 400 });
  }

  try {
    const response = await fetch(getIntentsApiBase("testnet") + "/v0/deposit/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ depositAddress, txHash }),
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      return Response.json({ error: "Tidepool could not register the deposit notification.", upstreamStatus: response.status, details: data }, { status: 502 });
    }
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to submit the deposit transaction hash.";
    return Response.json({ error: message }, { status: 502 });
  }
}
