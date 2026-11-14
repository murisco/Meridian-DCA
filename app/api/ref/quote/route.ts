const RPC_URL = "https://rpc.testnet.near.org";
const REF_DCL_CONTRACT = "dclv2.ref-dev.testnet";
const INPUT_TOKEN = "wrap.testnet";
const OUTPUT_TOKEN = "wbtc.fakes.testnet";
const ONE = 10n ** 24n;

type RpcResponse = {
  result?: {
    result?: number[];
    error?: string | { message?: string; name?: string };
    logs?: string[];
  };
  error?: { message?: string; data?: unknown } | string;
  id?: string | number;
};

async function view(contractId: string, methodName: string, args: Record<string, unknown> = {}) {
  const argsBase64 = Buffer.from(JSON.stringify(args), "utf8").toString("base64");
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "meridian-ref-check",
      method: "query",
      params: { request_type: "call_function", finality: "final", account_id: contractId, method_name: methodName, args_base64: argsBase64 },
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("NEAR testnet RPC returned HTTP " + response.status);
  const data = await response.json() as RpcResponse;
  if (!response.ok) {
    const detail = typeof data.error === "string" ? data.error : data.error?.message || "";
    throw new Error("NEAR RPC HTTP " + response.status + " while reading " + contractId + "." + methodName + (detail ? ": " + detail : "."));
  }
  if (data.error) {
    const detail = typeof data.error === "string" ? data.error : data.error.message || JSON.stringify(data.error.data || "");
    throw new Error("NEAR RPC failed for " + contractId + "." + methodName + (detail ? ": " + detail : "."));
  }
  if (data.result?.error) {
    const detail = typeof data.result.error === "string"
      ? data.result.error
      : data.result.error.message || JSON.stringify(data.result.error);
    throw new Error("Contract view failed for " + contractId + "." + methodName + ": " + detail);
  }
  if (!Array.isArray(data.result?.result)) {
    throw new Error("NEAR RPC response for " + contractId + "." + methodName + " did not include a result byte array. Response: " + JSON.stringify(data).slice(0, 500));
  }
  if (data.result.result.length === 0) {
    throw new Error("NEAR contract " + contractId + "." + methodName + " returned an empty result.");
  }
  try {
    return JSON.parse(Buffer.from(data.result.result).toString("utf8")) as any;
  } catch {
    throw new Error("NEAR contract " + contractId + "." + methodName + " returned invalid JSON.");
  }
}

function formatBaseUnits(raw: string, decimals: number, maxFraction = 8) {
  const value = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = value % scale;
  if (fraction === 0n) return whole.toString();
  return whole.toString() + "." + fraction.toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
}

function parsePositiveAmount(value: unknown) {
  const amount = typeof value === "string" ? value.trim() : "";
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,24})?$/.test(amount)) {
    throw new Error("Enter a valid wNEAR amount with up to 24 decimal places.");
  }
  const [whole, fraction = ""] = amount.split(".");
  const raw = BigInt(whole) * ONE + BigInt((fraction + "0".repeat(24)).slice(0, 24));
  if (raw <= 0n) throw new Error("Amount must be greater than zero.");
  if (raw > 20000000000000000000000n) throw new Error("For this first test, the maximum swap size is 0.02 wNEAR.");
  return raw.toString();
}

export async function POST(request: Request) {
  let input: { accountId?: unknown; amount?: unknown; slippageBps?: unknown };
  try { input = await request.json() as typeof input; }
  catch { return Response.json({ error: "Request body must be valid JSON." }, { status: 400 }); }

  const accountId = typeof input.accountId === "string" ? input.accountId.trim() : "";
  if (!/^[a-z0-9._-]{2,64}$/.test(accountId)) {
    return Response.json({ error: "A valid NEAR testnet account ID is required." }, { status: 400 });
  }
  const slippageBps = Number(input.slippageBps ?? 100);
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 500) {
    return Response.json({ error: "Slippage must be between 1 and 500 basis points." }, { status: 400 });
  }

  try {
    const amountIn = parsePositiveAmount(input.amount);
    const [inputMeta, outputMeta, inputStorage, outputStorage, outputBounds] = await Promise.all([
      view(INPUT_TOKEN, "ft_metadata"),
      view(OUTPUT_TOKEN, "ft_metadata"),
      view(INPUT_TOKEN, "storage_balance_of", { account_id: accountId }),
      view(OUTPUT_TOKEN, "storage_balance_of", { account_id: accountId }),
      view(OUTPUT_TOKEN, "storage_balance_bounds"),
    ]);

    if (inputMeta.decimals !== 24 || outputMeta.decimals !== 8) {
      throw new Error("Ref Finance testnet token metadata did not match the expected wNEAR/WBTC decimals.");
    }
    if (typeof outputBounds?.min !== "string" || !/^\d+$/.test(outputBounds.min)) {
      throw new Error("Ref Finance did not return a valid WBTC storage-registration minimum.");
    }

    // Follow Ref Finance SDK's DCLSwapByInputOnBestPool pattern:
    // derive each supported pool ID and call quote directly. Do not scan list_pools.
    const feeTiers = [100, 400, 2000, 10000];
    const quoteChecks = await Promise.all(feeTiers.map(async (fee) => {
      const poolId = [INPUT_TOKEN, OUTPUT_TOKEN].sort().join("|") + "|" + fee;
      try {
        const quote = await view(REF_DCL_CONTRACT, "quote", {
          pool_ids: [poolId],
          input_token: INPUT_TOKEN,
          output_token: OUTPUT_TOKEN,
          input_amount: amountIn,
          tag: "meridian-dca-" + fee + "-" + amountIn,
        });
        if (!quote || !/^\d+$/.test(String(quote.amount || "")) || BigInt(quote.amount) <= 0n) {
          return { fee, poolId, quote: null, error: "No positive quote for this fee tier." };
        }
        const minimumOut = (BigInt(quote.amount) * BigInt(10000 - slippageBps) / 10000n).toString();
        return {
          fee,
          poolId,
          quote: {
            poolId,
            fee,
            state: "Quote available",
            liquidity: "Not exposed by DCL quote",
            totalX: "Not exposed by DCL quote",
            totalY: "Not exposed by DCL quote",
            amountOut: String(quote.amount),
            minimumOut,
            amountOutFormatted: formatBaseUnits(String(quote.amount), 8),
          },
          error: null,
        };
      } catch (error) {
        return { fee, poolId, quote: null, error: error instanceof Error ? error.message : "DCL quote failed." };
      }
    }));

    const validQuotes = quoteChecks
      .map((item) => item.quote)
      .filter((quote): quote is NonNullable<typeof quote> => quote !== null)
      .sort((a, b) => BigInt(a.amountOut) > BigInt(b.amountOut) ? -1 : BigInt(a.amountOut) < BigInt(b.amountOut) ? 1 : 0);

    if (!validQuotes.length) {
      return Response.json({
        available: false,
        error: "Ref Finance returned no usable wNEAR/WBTC quote across its four supported DCL fee tiers. No transaction was sent.",
        inputToken: { contractId: INPUT_TOKEN, symbol: inputMeta.symbol, decimals: inputMeta.decimals },
        outputToken: { contractId: OUTPUT_TOKEN, symbol: outputMeta.symbol, decimals: outputMeta.decimals },
        quoteChecks: quoteChecks.map(({fee,poolId,quote,error}) => ({fee,poolId,available:!!quote,error})),
      }, { status: 404 });
    }

    return Response.json({
      available: true,
      network: "testnet",
      dex: "Ref Finance",
      exchangeContract: "ref-finance-101.testnet",
      dclContract: REF_DCL_CONTRACT,
      accountId,
      amountIn,
      amountInFormatted: (Number(amountIn) / 1e24).toString(),
      inputToken: { contractId: INPUT_TOKEN, symbol: inputMeta.symbol, decimals: inputMeta.decimals },
      outputToken: { contractId: OUTPUT_TOKEN, symbol: outputMeta.symbol, decimals: outputMeta.decimals },
      inputRegistered: inputStorage !== null,
      outputRegistered: outputStorage !== null,
      outputStorageMinimum: outputBounds?.min || null,
      slippageBps,
      bestQuote: validQuotes[0],
      alternatives: validQuotes,
      poolCount: validQuotes.length,
      checkedAt: new Date().toISOString(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to check Ref Finance testnet liquidity.";
    return Response.json({ available: false, error: message }, { status: 502 });
  }
}

export async function GET() {
  const metadataChecks = await Promise.all([
    { step: "wNEAR metadata", contract: INPUT_TOKEN, method: "ft_metadata" },
    { step: "WBTC metadata", contract: OUTPUT_TOKEN, method: "ft_metadata" },
    { step: "WBTC storage bounds", contract: OUTPUT_TOKEN, method: "storage_balance_bounds" },
  ].map(async (item) => {
    try {
      return { step: item.step, ok: true, data: await view(item.contract, item.method) };
    } catch (error) {
      return {
        step: item.step,
        ok: false,
        error: error instanceof Error ? error.message : "Contract view failed.",
      };
    }
  }));

  const amountIn = "10000000000000000000000"; // 0.01 wNEAR
  const quoteChecks = await Promise.all([100, 400, 2000, 10000].map(async (fee) => {
    const poolId = [INPUT_TOKEN, OUTPUT_TOKEN].sort().join("|") + "|" + fee;
    try {
      const quote = await view(REF_DCL_CONTRACT, "quote", {
        pool_ids: [poolId],
        input_token: INPUT_TOKEN,
        output_token: OUTPUT_TOKEN,
        input_amount: amountIn,
        tag: "meridian-diagnostic-" + fee,
      });
      return { fee, poolId, ok: !!quote && /^\d+$/.test(String(quote.amount || "")), amount: quote?.amount || null };
    } catch (error) {
      return { fee, poolId, ok: false, error: error instanceof Error ? error.message : "DCL quote failed." };
    }
  }));

  return Response.json({
    network: "testnet",
    rpc: RPC_URL,
    dclContract: REF_DCL_CONTRACT,
    metadataChecks,
    quoteChecks,
    checkedAt: new Date().toISOString(),
  }, { headers: { "Cache-Control": "no-store" } });
}
