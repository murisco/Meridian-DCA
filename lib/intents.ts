export type IntentNetwork = "mainnet" | "testnet";

export type IntentToken = {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price?: string;
  priceUpdatedAt?: string;
  contractAddress?: string | null;
};

const API_BASES: Record<IntentNetwork, string> = {
  mainnet: "https://1click.chaindefuser.com",
  testnet: "https://www.usetidepool.tech",
};

export function getIntentsApiBase(network: IntentNetwork = "mainnet") {
  return API_BASES[network];
}

export async function fetchIntentTokens(network: IntentNetwork = "mainnet"): Promise<IntentToken[]> {
  const response = await fetch(getIntentsApiBase(network) + "/v0/tokens", {
    headers: { Accept: "application/json" },
    next: { revalidate: 60 },
  });

  if (!response.ok) {
    throw new Error((network === "testnet" ? "Tidepool testnet" : "NEAR Intents 1Click") + " token service returned HTTP " + response.status);
  }

  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new Error("Unexpected token list response");

  return data.filter((item): item is IntentToken => {
    return Boolean(
      item &&
      typeof item.assetId === "string" &&
      typeof item.symbol === "string" &&
      typeof item.blockchain === "string" &&
      Number.isInteger(item.decimals) &&
      item.decimals >= 0 &&
      item.decimals <= 30
    );
  });
}

export function toBaseUnits(value: string, decimals: number): string {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) {
    throw new Error("Enter a valid positive amount without commas or scientific notation.");
  }

  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) {
    throw new Error("This token supports up to " + decimals + " decimal places.");
  }

  const scale = 10n ** BigInt(decimals);
  const fractionalUnits = BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  const units = BigInt(whole) * scale + fractionalUnits;

  if (units <= 0n) throw new Error("Amount must be greater than zero.");
  return units.toString();
}

export function getIntentsHeaders(network: IntentNetwork = "mainnet"): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  // Never forward the production partner JWT to the community testnet sandbox.
  const jwt = network === "mainnet" ? process.env.NEAR_INTENTS_JWT : undefined;
  if (jwt) headers.Authorization = "Bearer " + jwt;
  return headers;
}
