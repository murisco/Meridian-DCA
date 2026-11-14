import { fetchIntentTokens, getIntentsHeaders, toBaseUnits } from "@/lib/intents";

type QuoteInput = {
  originAsset?: unknown;
  destinationAsset?: unknown;
  amount?: unknown;
  recipient?: unknown;
  refundTo?: unknown;
  slippageTolerance?: unknown;
};

const cleanText = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

export async function POST(request: Request) {
  let input: QuoteInput;
  try {
    input = (await request.json()) as QuoteInput;
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const originAsset = cleanText(input.originAsset);
  const destinationAsset = cleanText(input.destinationAsset);
  const amount = cleanText(input.amount);
  const recipient = cleanText(input.recipient);
  const refundTo = cleanText(input.refundTo);
  const slippageTolerance = Number(input.slippageTolerance ?? 100);

  if (!originAsset || !destinationAsset || originAsset === destinationAsset) {
    return Response.json({ error: "Choose two different supported assets." }, { status: 400 });
  }
  if (!amount || !recipient || !refundTo) {
    return Response.json({ error: "Amount, destination address and refund address are required." }, { status: 400 });
  }
  if (!Number.isInteger(slippageTolerance) || slippageTolerance < 1 || slippageTolerance > 500) {
    return Response.json({ error: "Slippage must be between 1 and 500 basis points." }, { status: 400 });
  }

  try {
    const assets = await fetchIntentTokens();
    const origin = assets.find((asset) => asset.assetId === originAsset);
    const destination = assets.find((asset) => asset.assetId === destinationAsset);
    if (!origin || !destination) {
      return Response.json({ error: "One of the selected assets is no longer supported. Refresh the asset list." }, { status: 400 });
    }

    const amountInBaseUnits = toBaseUnits(amount, origin.decimals);
    const quoteRequest = {
      dry: true,
      swapType: "EXACT_INPUT",
      originAsset,
      destinationAsset,
      amount: amountInBaseUnits,
      recipient,
      refundTo,
      slippageTolerance,
      referral: "meridian-dca",
    };

    const upstream = await fetch("https://1click.chaindefuser.com/v0/quote", {
      method: "POST",
      headers: getIntentsHeaders(),
      body: JSON.stringify(quoteRequest),
      cache: "no-store",
    });

    const data: unknown = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      const details =
        data && typeof data === "object" && "message" in data && typeof data.message === "string"
          ? data.message
          : "The NEAR Intents quote request failed.";
      return Response.json({ error: details, upstreamStatus: upstream.status }, { status: upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502 });
    }

    return Response.json({
      dry: true,
      quote: data,
      assets: {
        origin: { symbol: origin.symbol, blockchain: origin.blockchain, decimals: origin.decimals },
        destination: { symbol: destination.symbol, blockchain: destination.blockchain, decimals: destination.decimals },
      },
      feeNote: process.env.NEAR_INTENTS_JWT
        ? "Authenticated NEAR Intents fee schedule is in use."
        : "Unauthenticated quotes may include an additional 0.25% NEAR Intents fee on eligible routes.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create quote.";
    return Response.json({ error: message }, { status: 400 });
  }
}