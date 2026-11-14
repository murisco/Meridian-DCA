import { fetchIntentTokens, getIntentsApiBase, getIntentsHeaders, toBaseUnits } from "@/lib/intents";

type Input = {
  originAsset?: unknown;
  destinationAsset?: unknown;
  amount?: unknown;
  recipient?: unknown;
  refundTo?: unknown;
  slippageTolerance?: unknown;
  network?: unknown;
};

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

export async function POST(request: Request) {
  let input: Input;
  try {
    input = await request.json() as Input;
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  // Live execution is deliberately restricted to the community testnet sandbox.
  if (input.network !== "testnet") {
    return Response.json({ error: "Live swaps are disabled on mainnet in this release." }, { status: 403 });
  }

  const originAsset = text(input.originAsset);
  const destinationAsset = text(input.destinationAsset);
  const amount = text(input.amount);
  const recipient = text(input.recipient);
  const refundTo = text(input.refundTo);
  const slippageTolerance = Number(input.slippageTolerance ?? 100);

  if (!originAsset || !destinationAsset || originAsset === destinationAsset) {
    return Response.json({ error: "Choose two different supported assets." }, { status: 400 });
  }
  if (!amount || !recipient || !refundTo) {
    return Response.json({ error: "Amount, recipient wallet and refund wallet are required." }, { status: 400 });
  }
  // The source deposit and refund wallet are NEAR testnet. The recipient
  // belongs to the selected destination chain and may be an EVM, Bitcoin,
  // Solana, Stellar, Sui, XRP or NEAR address; Tidepool validates that format.
  if (!/^[a-z0-9._-]{2,64}$/.test(refundTo)) {
    return Response.json({ error: "The refund address must be a valid NEAR testnet account." }, { status: 400 });
  }
  if (!recipient || recipient.length > 200) {
    return Response.json({ error: "Enter the destination address for the selected network." }, { status: 400 });
  }
  if (!Number.isInteger(slippageTolerance) || slippageTolerance < 1 || slippageTolerance > 500) {
    return Response.json({ error: "Slippage must be between 1 and 500 basis points." }, { status: 400 });
  }

  try {
    const assets = await fetchIntentTokens("testnet");
    const origin = assets.find((asset) => asset.assetId === originAsset);
    const destination = assets.find((asset) => asset.assetId === destinationAsset);
    if (!origin || !destination) {
      return Response.json({ error: "One of the selected assets is no longer supported. Refresh the asset list." }, { status: 400 });
    }
    // Meridian signs the source deposit with NEAR Connect for this release.
    // The selected destination may be on any chain exposed by the live Tidepool
    // testnet catalogue; native destination assets need not have a contractAddress.
    if (origin.blockchain !== "near" || !origin.contractAddress) {
      return Response.json({ error: "For wallet-approved execution, choose a NEAR testnet source token. The destination can be on any supported testnet chain." }, { status: 400 });
    }

    const amountInBaseUnits = toBaseUnits(amount, origin.decimals);
    const deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const quoteRequest = {
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance,
      originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset,
      amount: amountInBaseUnits,
      recipient,
      recipientType: "DESTINATION_CHAIN",
      refundTo,
      refundType: "ORIGIN_CHAIN",
      deadline,
      referral: "meridian-dca",
    };

    const upstream = await fetch(getIntentsApiBase("testnet") + "/v0/quote", {
      method: "POST",
      headers: getIntentsHeaders("testnet"),
      body: JSON.stringify(quoteRequest),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    const data: unknown = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      const message = data && typeof data === "object" && "message" in data && typeof data.message === "string"
        ? data.message
        : "Tidepool could not create an executable testnet quote.";
      return Response.json({ error: message, upstreamStatus: upstream.status }, { status: upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502 });
    }

    const responseData = data as { quote?: { depositAddress?: string; amountIn?: string; deadline?: string }; correlationId?: string };
    if (!/^[0-9a-f]{64}$/i.test(responseData.quote?.depositAddress || "") || !/^\d+$/.test(responseData.quote?.amountIn || "")) {
      return Response.json({ error: "Tidepool returned an incomplete live quote. No transaction was sent." }, { status: 502 });
    }

    return Response.json({
      dry: false,
      network: "testnet",
      provider: "Tidepool community testnet sandbox",
      origin: { assetId: origin.assetId, contractAddress: origin.contractAddress, symbol: origin.symbol, decimals: origin.decimals, blockchain: origin.blockchain },
      destination: { assetId: destination.assetId, contractAddress: destination.contractAddress || null, symbol: destination.symbol, decimals: destination.decimals, blockchain: destination.blockchain },
      quote: data,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create a live testnet quote.";
    return Response.json({ error: message }, { status: 400 });
  }
}
