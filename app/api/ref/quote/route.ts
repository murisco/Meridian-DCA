const RPC_URL = "https://rpc.testnet.near.org";
const REF_DCL_CONTRACT = "dclv2.ref-dev.testnet";
const REF_EXCHANGE_CONTRACT = "ref-finance-101.testnet";
const REF_TESTNET_INDEXER = "https://testnet-indexer.ref-finance.com";
const INPUT_TOKEN = "wrap.testnet";
const OUTPUT_TOKEN = "usdt.fakes.testnet";
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

    if (inputMeta.decimals !== 24 || outputMeta.decimals !== 6) {
      throw new Error("Ref Finance testnet token metadata did not match the expected wNEAR/USDT.e decimals.");
    }
    if (typeof outputBounds?.min !== "string" || !/^\d+$/.test(outputBounds.min)) {
      throw new Error("Ref Finance did not return a valid USDT.e storage-registration minimum.");
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
            amountOutFormatted: formatBaseUnits(amountOut.toString(), outputMeta.decimals),
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

    // Ref's full list_pools view exceeds the testnet view-gas limit.
    // Query only the four exact candidate IDs with the SDK's getDCLPool() method.
    const feeTiers = [100, 400, 2000, 10000];
    const candidatePoolChecks = await Promise.all(feeTiers.map(async (fee) => {
      const poolId = [INPUT_TOKEN, OUTPUT_TOKEN].sort().join("|") + "|" + fee;
      try {
        const pool = await view(REF_DCL_CONTRACT, "get_pool", { pool_id: poolId });
        const matchesPair =
          (pool?.token_x === INPUT_TOKEN && pool?.token_y === OUTPUT_TOKEN) ||
          (pool?.token_x === OUTPUT_TOKEN && pool?.token_y === INPUT_TOKEN);
        const running = String(pool?.state || "").toLowerCase() === "running";
        if (!pool || !matchesPair || !running) {
          return { fee, poolId, pool: null, error: !pool ? "Pool was not returned." : "Pool exists but is not running or does not match the requested pair." };
        }
        return { fee, poolId, pool, error: null };
      } catch (error) {
        return { fee, poolId, pool: null, error: error instanceof Error ? error.message : "Pool lookup failed." };
      }
    }));

    const matchingDclPools = candidatePoolChecks
      .filter((item) => item.pool !== null)
      .map((item) => ({ fee: item.fee, poolId: item.poolId, ...item.pool }));

    const quoteChecks = await Promise.all(matchingDclPools.map(async (pool) => {
      const poolId = String(pool.pool_id || pool.poolId);
      try {
        const quote = await view(REF_DCL_CONTRACT, "quote", {
          pool_ids: [poolId],
          // Ref DCL quote expects TokenMetadata objects, not contract-ID strings.
          // NEP-141 ft_metadata omits the SDK's required id field, so add it explicitly.
          input_token: { ...inputMeta, id: INPUT_TOKEN },
          output_token: { ...outputMeta, id: OUTPUT_TOKEN },
          input_amount: amountIn,
          tag: "meridian-dca-" + pool.fee + "-" + amountIn,
        });
        if (!quote || !/^\d+$/.test(String(quote.amount || "")) || BigInt(quote.amount) <= 0n) {
          return { fee: Number(pool.fee), poolId, quote: null, error: "Ref returned no positive output for this pool." };
        }
        // Reject impossible output larger than the pool's reported output-token reserves.
        const outputReserveRaw = pool.token_x === OUTPUT_TOKEN
          ? String(pool.total_x || "0")
          : pool.token_y === OUTPUT_TOKEN
            ? String(pool.total_y || "0")
            : "0";
        if (/^\d+$/.test(outputReserveRaw) && BigInt(outputReserveRaw) > 0n &&
            BigInt(quote.amount) > BigInt(outputReserveRaw)) {
          return { fee: Number(pool.fee), poolId, quote: null, error: "Ref quote exceeds the pool's reported output-token reserves. Quote rejected." };
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
            amountOutFormatted: formatBaseUnits(String(quote.amount), outputMeta.decimals),
          },
          error: null,
        };
      } catch (error) {
        return { fee: Number(pool.fee), poolId, quote: null, error: error instanceof Error ? error.message : "DCL quote failed." };
      }
    }));

    const validQuotes = quoteChecks
      .map((item) => item.quote)
      .filter((quote): quote is NonNullable<typeof quote> => quote !== null)
      .sort((a, b) => BigInt(a.amountOut) > BigInt(b.amountOut) ? -1 : BigInt(a.amountOut) < BigInt(b.amountOut) ? 1 : 0);

    if (!validQuotes.length) {
      return Response.json({
        available: false,
        error: "No running Ref Finance DCL pool returned a usable wNEAR/USDT.e quote. No transaction was sent.",
        discovery: {
          method: "get_pool by exact pool ID",
          attemptedPoolIds: candidatePoolChecks.map((item) => item.poolId),
          poolChecks: candidatePoolChecks.map(({fee,poolId,pool,error}) => ({
            fee, poolId, found: !!pool, state: pool?.state || null,
            tokenX: pool?.token_x || null, tokenY: pool?.token_y || null,
            liquidity: pool?.liquidity || null, error
          })),
          quoteChecks: quoteChecks.map(({fee,poolId,quote,error}) => ({fee,poolId,available:!!quote,error})),
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
    { step: "USDT.e metadata", contract: OUTPUT_TOKEN, method: "ft_metadata" },
    
    { step: "USDT.e storage bounds", contract: OUTPUT_TOKEN, method: "storage_balance_bounds" },
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

  const candidateIds = [
    {
      pair: "wrap.testnet / usdt.fakes.testnet",
      poolId: "usdt.fakes.testnet|wrap.testnet|2000",
    },
  ];

  const poolChecks = await Promise.all(candidateIds.map(async ({pair,poolId}) => {
    const contract = poolId.includes("usdt.fakes.testnet") ? REF_DCL_CONTRACT : REF_DCL_CONTRACT;
    try {
      const pool = await view(contract, "get_pool", { pool_id: poolId });
      return {
        pair,
        poolId,
        ok: !!pool,
        pool: pool ? {
          poolId: pool.pool_id || poolId,
          tokenX: pool.token_x,
          tokenY: pool.token_y,
          fee: pool.fee,
          state: pool.state,
          liquidity: pool.liquidity,
          totalX: pool.total_x,
          totalY: pool.total_y,
        } : null,
        error: null,
      };
    } catch (error) {
      return { pair, poolId, ok: false, pool: null, error: error instanceof Error ? error.message : "Pool lookup failed." };
    }
  }));

  return Response.json({
    network: "testnet",
    rpc: RPC_URL,
    dclContract: REF_DCL_CONTRACT,
    metadataChecks,
    poolDiscovery: {
      method: "targeted get_pool calls (avoids full list_pools gas limit)",
      checks: poolChecks,
    },
    checkedAt: new Date().toISOString(),
  }, { headers: { "Cache-Control": "no-store" } });
}
