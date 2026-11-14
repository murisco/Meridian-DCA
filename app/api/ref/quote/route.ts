const RPC_URL = "https://rpc.testnet.near.org";
const REF_DCL_CONTRACT = "dclv2.ref-dev.testnet";
const REF_EXCHANGE_CONTRACT = "ref-finance-101.testnet";
const REF_TESTNET_INDEXER = "https://testnet-indexer.ref-finance.com";
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
  if (raw > 3000000000000000000000000n) throw new Error("For this test, the maximum swap size is 3 wNEAR.");
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

    // Check the classic Ref exchange indexer first, following the official
    // SDK's fetchAllPools + instantSwap path. This can serve pairs not on DCL.
    try {
      const indexerResponse = await fetch(REF_TESTNET_INDEXER + "/fetchAllPools", {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(12000),
      });
      if (indexerResponse.ok) {
        const indexerData = await indexerResponse.json() as { simplePools?: any[] };
        const simplePools = Array.isArray(indexerData.simplePools) ? indexerData.simplePools : [];
        const matchingSimplePools = simplePools.filter((pool) =>
          Array.isArray(pool.tokenIds) &&
          pool.tokenIds.includes(INPUT_TOKEN) &&
          pool.tokenIds.includes(OUTPUT_TOKEN) &&
          pool.supplies &&
          /^\d+$/.test(String(pool.supplies[INPUT_TOKEN] || "")) &&
          /^\d+$/.test(String(pool.supplies[OUTPUT_TOKEN] || "")) &&
          Number.isInteger(Number(pool.fee)) &&
          Number(pool.fee) >= 0 &&
          Number(pool.fee) < 10000
        );

        const simpleQuotes = matchingSimplePools.map((pool) => {
          const inputReserve = BigInt(pool.supplies[INPUT_TOKEN]);
          const outputReserve = BigInt(pool.supplies[OUTPUT_TOKEN]);
          const fee = BigInt(pool.fee);
          const amountWithFee = BigInt(amountIn) * (10000n - fee);
          const denominator = inputReserve * 10000n + amountWithFee;
          const amountOut = denominator > 0n ? amountWithFee * outputReserve / denominator : 0n;
          if (inputReserve <= 0n || outputReserve <= 0n || amountOut <= 0n) return null;
          const minimumOut = amountOut * BigInt(10000 - slippageBps) / 10000n;
          return {
            poolId: String(pool.id),
            fee: Number(pool.fee),
            state: "Quote available",
            amountOut: amountOut.toString(),
            minimumOut: minimumOut.toString(),
            amountOutFormatted: formatBaseUnits(amountOut.toString(), 8),
            inputReserve: inputReserve.toString(),
            outputReserve: outputReserve.toString(),
          };
        }).filter((item): item is NonNullable<typeof item> => item !== null);

        simpleQuotes.sort((a, b) =>
          BigInt(a.amountOut) > BigInt(b.amountOut) ? -1 :
          BigInt(a.amountOut) < BigInt(b.amountOut) ? 1 : 0
        );

        if (simpleQuotes.length) {
          return Response.json({
            available: true,
            network: "testnet",
            dex: "Ref Finance",
            protocol: "ref-v1",
            exchangeContract: REF_EXCHANGE_CONTRACT,
            accountId,
            amountIn,
            amountInFormatted: formatBaseUnits(amountIn, 24),
            inputToken: { contractId: INPUT_TOKEN, symbol: inputMeta.symbol, decimals: inputMeta.decimals },
            outputToken: { contractId: OUTPUT_TOKEN, symbol: outputMeta.symbol, decimals: outputMeta.decimals },
            inputRegistered: inputStorage !== null,
            outputRegistered: outputStorage !== null,
            outputStorageMinimum: outputBounds.min,
            slippageBps,
            bestQuote: simpleQuotes[0],
            alternatives: simpleQuotes,
            poolCount: simpleQuotes.length,
            checkedAt: new Date().toISOString(),
          }, { headers: { "Cache-Control": "no-store" } });
        }
      }
    } catch {
      // Fall through to the direct DCL quote check if the indexer is unavailable.
    }

    // Discover the DCL pools that actually exist on Ref testnet.
    // Ref SDK's listDCLPools() calls list_pools with no arguments.
    let dclPools: any[] = [];
    let dclDiscoveryError: string | null = null;
    try {
      const discovered = await view(REF_DCL_CONTRACT, "list_pools");
      if (!Array.isArray(discovered)) {
        throw new Error("Ref DCL list_pools did not return a pool array.");
      }
      dclPools = discovered;
    } catch (error) {
      dclDiscoveryError = error instanceof Error ? error.message : "Unable to list Ref DCL pools.";
    }

    const matchingDclPools = dclPools.filter((pool) => {
      const tokenX = String(pool.token_x || "");
      const tokenY = String(pool.token_y || "");
      const pairMatches =
        (tokenX === INPUT_TOKEN && tokenY === OUTPUT_TOKEN) ||
        (tokenX === OUTPUT_TOKEN && tokenY === INPUT_TOKEN);
      return pairMatches && String(pool.state || "").toLowerCase() === "running" &&
        typeof pool.pool_id === "string";
    });

    const quoteChecks = await Promise.all(matchingDclPools.map(async (pool) => {
      const poolId = String(pool.pool_id);
      try {
        // The Ref SDK passes token contract IDs to the on-chain view method.
        // Its public helper accepts metadata but converts metadata.id before RPC.
        const quote = await view(REF_DCL_CONTRACT, "quote", {
          pool_ids: [poolId],
          input_token: INPUT_TOKEN,
          output_token: OUTPUT_TOKEN,
          input_amount: amountIn,
          tag: "meridian-dca-" + pool.fee + "-" + amountIn,
        });
        if (!quote || !/^\\d+$/.test(String(quote.amount || "")) || BigInt(quote.amount) <= 0n) {
          return {
            fee: Number(pool.fee),
            poolId,
            quote: null,
            error: "Ref returned no positive output for this discovered pool.",
            liquidity: String(pool.liquidity || "0"),
            totalX: String(pool.total_x || "0"),
            totalY: String(pool.total_y || "0"),
          };
        }
        const minimumOut = (BigInt(quote.amount) * BigInt(10000 - slippageBps) / 10000n).toString();
        return {
          fee: Number(pool.fee),
          poolId,
          quote: {
            poolId,
            fee: Number(pool.fee),
            state: String(pool.state || "Running"),
            liquidity: String(pool.liquidity || "0"),
            totalX: String(pool.total_x || "0"),
            totalY: String(pool.total_y || "0"),
            amountOut: String(quote.amount),
            minimumOut,
            amountOutFormatted: formatBaseUnits(String(quote.amount), 8),
          },
          error: null,
        };
      } catch (error) {
        return {
          fee: Number(pool.fee),
          poolId,
          quote: null,
          error: error instanceof Error ? error.message : "DCL quote failed.",
          liquidity: String(pool.liquidity || "0"),
          totalX: String(pool.total_x || "0"),
          totalY: String(pool.total_y || "0"),
        };
      }
    }));

    const validQuotes = quoteChecks
      .map((item) => item.quote)
      .filter((quote): quote is NonNullable<typeof quote> => quote !== null)
      .sort((a, b) => BigInt(a.amountOut) > BigInt(b.amountOut) ? -1 : BigInt(a.amountOut) < BigInt(b.amountOut) ? 1 : 0);

    if (!validQuotes.length) {
      const reason = matchingDclPools.length === 0
        ? "Ref Finance has no running DCL pool for wrap.testnet → wbtc.fakes.testnet."
        : "Ref Finance found " + matchingDclPools.length + " matching DCL pool(s), but none returned a usable quote.";
      return Response.json({
        available: false,
        error: reason + " No transaction was sent.",
        discovery: {
          dclPoolCount: dclPools.length,
          matchingDclPools: matchingDclPools.map((pool) => ({
            poolId: pool.pool_id,
            fee: pool.fee,
            state: pool.state,
            liquidity: pool.liquidity,
            totalX: pool.total_x,
            totalY: pool.total_y,
          })),
          dclDiscoveryError,
          quoteChecks: quoteChecks.map(({fee,poolId,quote,error,liquidity,totalX,totalY}) => ({
            fee, poolId, available: !!quote, error, liquidity, totalX, totalY
          })),
        },
        inputToken: { contractId: INPUT_TOKEN, symbol: inputMeta.symbol, decimals: inputMeta.decimals },
        outputToken: { contractId: OUTPUT_TOKEN, symbol: outputMeta.symbol, decimals: outputMeta.decimals },
      }, { status: 404 });
    }

    return Response.json({
      available: true,
      network: "testnet",
      dex: "Ref Finance",
      protocol: "ref-dcl-v2",
      exchangeContract: REF_EXCHANGE_CONTRACT,
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

  const [dclResult, classicResult] = await Promise.all([
    view(REF_DCL_CONTRACT, "list_pools")
      .then((data) => ({ ok: Array.isArray(data), pools: Array.isArray(data) ? data : [], error: null }))
      .catch((error) => ({ ok: false, pools: [], error: error instanceof Error ? error.message : "DCL pool discovery failed." })),
    fetch(REF_TESTNET_INDEXER + "/fetchAllPools", {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Ref indexer returned HTTP " + response.status);
        const data = await response.json() as { simplePools?: any[] };
        return { ok: true, pools: Array.isArray(data.simplePools) ? data.simplePools : [], error: null };
      })
      .catch((error) => ({ ok: false, pools: [], error: error instanceof Error ? error.message : "Classic pool discovery failed." })),
  ]);

  const matchingDclPools = dclResult.pools.filter((pool) =>
    ((pool.token_x === INPUT_TOKEN && pool.token_y === OUTPUT_TOKEN) ||
     (pool.token_x === OUTPUT_TOKEN && pool.token_y === INPUT_TOKEN)) &&
    String(pool.state || "").toLowerCase() === "running"
  ).map((pool) => ({
    poolId: pool.pool_id,
    fee: pool.fee,
    state: pool.state,
    liquidity: pool.liquidity,
    totalX: pool.total_x,
    totalY: pool.total_y,
  }));

  const matchingClassicPools = classicResult.pools.filter((pool) =>
    Array.isArray(pool.tokenIds) &&
    pool.tokenIds.includes(INPUT_TOKEN) &&
    pool.tokenIds.includes(OUTPUT_TOKEN)
  ).map((pool) => ({
    poolId: String(pool.id),
    fee: pool.fee,
    inputReserve: String(pool.supplies?.[INPUT_TOKEN] || "0"),
    outputReserve: String(pool.supplies?.[OUTPUT_TOKEN] || "0"),
  }));

  return Response.json({
    network: "testnet",
    rpc: RPC_URL,
    dclContract: REF_DCL_CONTRACT,
    metadataChecks,
    poolDiscovery: {
      dcl: {
        ok: dclResult.ok,
        totalPools: dclResult.pools.length,
        matchingPools: matchingDclPools,
        error: dclResult.error,
      },
      classic: {
        ok: classicResult.ok,
        totalPools: classicResult.pools.length,
        matchingPools: matchingClassicPools,
        error: classicResult.error,
      },
    },
    checkedAt: new Date().toISOString(),
  }, { headers: { "Cache-Control": "no-store" } });
}
