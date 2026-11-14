export type IntentToken = {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price?: string;
  priceUpdatedAt?: string;
  contractAddress?: string | null;
};

const API_BASE = "https://1click.chaindefuser.com";

export async function fetchIntentTokens(): Promise<IntentToken[]> {
  const response = await fetch(API_BASE + "/v0/tokens", {
    headers: { Accept: "application/json" },
    next: { revalidate: 300 },
  });

  if (!response.ok) {
    throw new Error("NEAR Intents token service returned HTTP " + response.status);
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

export function getIntentsHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const jwt = process.env.NEAR_INTENTS_JWT;
  if (jwt) headers.Authorization = "Bearer " + jwt;
  return headers;
}