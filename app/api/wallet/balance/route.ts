const RPC_URL = "https://rpc.testnet.fastnear.com";

const TEST_TOKENS = [
  { symbol: "USDC", contractId: "usdc.tidepool-sandbox.testnet", decimals: 6 },
  { symbol: "USDT", contractId: "usdt.tidepool-sandbox.testnet", decimals: 6 },
  { symbol: "wNEAR", contractId: "wnear.tidepool-sandbox.testnet", decimals: 24 },
  { symbol: "wBTC", contractId: "wbtc.tidepool-sandbox.testnet", decimals: 8 },
  { symbol: "ETH", contractId: "eth.tidepool-sandbox.testnet", decimals: 18 },
  { symbol: "XAUT", contractId: "xaut.tidepool-sandbox.testnet", decimals: 6 },
];

type RpcResponse = {
  result?: { amount?: string; result?: number[] };
  error?: { message?: string };
};

function decodeJsonResult(result: number[] | undefined): unknown {
  if (!Array.isArray(result)) throw new Error("The NEAR wrapper returned an unreadable view response.");
  const encoded = Buffer.from(result).toString("utf8");
  try { return JSON.parse(encoded); } catch {
    throw new Error("The NEAR wrapper returned invalid JSON.");
  }
}

function formatUnits(raw: string, decimals: number, maxFraction = 6) {
  if (!/^\d+$/.test(raw)) return "0";
  const value = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const remainder = value % scale;
  if (remainder === 0n) return whole.toString();
  const fraction = remainder.toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  return fraction ? whole.toString() + "." + fraction : whole.toString();
}

async function rpcQuery(body: Record<string, unknown>): Promise<RpcResponse> {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error("NEAR testnet RPC returned HTTP " + response.status);
  const data = (await response.json()) as RpcResponse;
  if (data.error) throw new Error(data.error.message || "NEAR testnet RPC query failed.");
  return data;
}

export async function GET(request: Request) {
  const accountId = new URL(request.url).searchParams.get("accountId")?.trim() || "";
  const validAccount =
    /^(?:[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*|[0-9a-f]{64})$/.test(accountId);

  if (!validAccount || accountId.length < 2 || accountId.length > 64) {
    return Response.json({ error: "A valid NEAR testnet account ID is required." }, { status: 400 });
  }

  try {
    const account = await rpcQuery({
      jsonrpc: "2.0",
      id: "meridian-wallet-balance",
      method: "query",
      params: { request_type: "view_account", finality: "final", account_id: accountId },
    });

    if (!account.result?.amount) {
      return Response.json({ error: "The testnet account was not found or has no readable balance." }, { status: 404 });
    }

    const [tokenBalances, wrappedNearResult, wrapStorageResult] = await Promise.all([
      Promise.all(TEST_TOKENS.map(async (token) => {
      try {
        const argsBase64 = Buffer.from(JSON.stringify({ account_id: accountId }), "utf8").toString("base64");
        const result = await rpcQuery({
          jsonrpc: "2.0",
          id: "meridian-ft-balance",
          method: "query",
          params: {
            request_type: "call_function",
            finality: "final",
            account_id: token.contractId,
            method_name: "ft_balance_of",
            args_base64: argsBase64,
          },
        });
        const raw = result.result?.result;
        if (!Array.isArray(raw)) return null;
        const balanceRaw = Buffer.from(raw).toString("utf8").replace(/^"|"$/g, "");
        if (!/^\d+$/.test(balanceRaw) || BigInt(balanceRaw) === 0n) return null;
        return {
          symbol: token.symbol,
          contractId: token.contractId,
          balance: formatUnits(balanceRaw, token.decimals, 6),
          rawBalance: balanceRaw,
          decimals: token.decimals,
        };
      } catch {
        return null;
      }
      })),
      rpcQuery({
        jsonrpc: "2.0",
        id: "meridian-wnear-balance",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: "wrap.testnet",
          method_name: "ft_balance_of",
          args_base64: Buffer.from(JSON.stringify({ account_id: accountId }), "utf8").toString("base64"),
        },
      }),
      rpcQuery({
        jsonrpc: "2.0",
        id: "meridian-wnear-storage",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: "wrap.testnet",
          method_name: "storage_balance_of",
          args_base64: Buffer.from(JSON.stringify({ account_id: accountId }), "utf8").toString("base64"),
        },
      }),
    ]);

    const wrapBalanceRaw = decodeJsonResult(wrappedNearResult.result?.result);
    if (typeof wrapBalanceRaw !== "string" || !/^\d+$/.test(wrapBalanceRaw)) {
      throw new Error("Could not verify the testnet wNEAR balance.");
    }
    const wrapStorage = decodeJsonResult(wrapStorageResult.result?.result);
    if (wrapStorage !== null && (typeof wrapStorage !== "object" || !("total" in wrapStorage))) {
      throw new Error("The NEAR wrapper returned an unexpected storage-registration response.");
    }
    const wrapRegistered = wrapStorage !== null;

    return Response.json({
      network: "testnet",
      accountId,
      near: formatUnits(account.result.amount, 24, 4),
      nearRaw: account.result.amount,
      wrapNear: {
        balance: formatUnits(wrapBalanceRaw, 24, 6),
        rawBalance: wrapBalanceRaw,
        contractId: "wrap.testnet",
      },
      wrapRegistered,
      tokens: tokenBalances.filter((token): token is NonNullable<typeof token> => token !== null),
      updatedAt: new Date().toISOString(),
      source: "NEAR testnet RPC and Tidepool test-token contracts",
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read testnet wallet balance.";
    return Response.json({ error: message }, { status: 502 });
  }
}
