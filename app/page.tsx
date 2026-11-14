"use client";

import { FormEvent, useEffect, useLayoutEffect, useMemo, useState } from "react";
import WalletConnect from "@/components/WalletConnect";

type IntentNetwork = "mainnet" | "testnet";

type Asset = {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price?: string;
  priceUpdatedAt?: string;
};

type DryRunStatus = "PASSED" | "BLOCKED" | "UNVERIFIED" | "ERROR";

type Plan = {
  id: string;
  sourceAssetId: string;
  destinationAssetId: string;
  sourceSymbol: string;
  destinationSymbol: string;
  sourceChain: string;
  destinationChain: string;
  amount: string;
  recipient: string;
  refundTo: string;
  frequency: "Daily" | "Weekly" | "Monthly";
  network?: IntentNetwork;
  slippage: number;
  nextRunAt: string;
  createdAt: string;
  lastDryRun?: {
    checkedAt: string;
    status: DryRunStatus;
    message: string;
    output?: string;
    minimumOutput?: string;
    quoteReference?: string;
    deadline?: string;
  };
};

type QuoteResult = {
  dry: boolean;
  network?: IntentNetwork;
  provider?: string;
  quote: {
    correlationId?: string;
    quote?: {
      amountInFormatted?: string;
      amountOut?: string;
      amountOutFormatted?: string;
      minAmountOut?: string;
      amountOutUsd?: string;
      amountInUsd?: string;
      timeEstimate?: number;
      deadline?: string;
    };
    amountInFormatted?: string;
    amountOut?: string;
    amountOutFormatted?: string;
    minAmountOut?: string;
    amountOutUsd?: string;
    amountInUsd?: string;
    timeEstimate?: number;
    deadline?: string;
  };
  assets: {
    origin: { symbol: string; blockchain: string; decimals?: number };
    destination: { symbol: string; blockchain: string; decimals?: number };
  };
  quoteControls?: {
    slippageTolerance: number;
    slippagePercent: string;
    deadline: string;
    depositType: string;
    recipientType: string;
    refundType: string;
  };
  feeNote: string;
};

const PLANS_KEY = "meridian-dca-plans-v1";

type SlippageAssessment = {
  status: "PASSED" | "BLOCKED" | "UNVERIFIED";
  message: string;
};

function assessSlippage(amountOutRaw: string | undefined, minimumOutRaw: string | undefined, limitBps: number): SlippageAssessment {
  if (!/^\d+$/.test(amountOutRaw || "") || !/^\d+$/.test(minimumOutRaw || "")) {
    return {
      status: "UNVERIFIED",
      message: "A minimum-output value was not returned, so MERIDIAN could not verify the slippage limit.",
    };
  }

  const amountOut = BigInt(amountOutRaw!);
  const minimumOut = BigInt(minimumOutRaw!);
  if (amountOut <= 0n || minimumOut > amountOut || !Number.isInteger(limitBps) || limitBps < 1) {
    return { status: "BLOCKED", message: "The quote returned output values that failed validation." };
  }

  // 1Click returns integer base units. Its minimum output is rounded down
  // to the destination token's smallest unit, so compare against the
  // floored allowed minimum rather than reverse-calculating a rounded-up
  // percentage from amountOut/minAmountOut.
  const expectedMinimumOut = (amountOut * BigInt(10000 - limitBps)) / 10000n;
  if (minimumOut < expectedMinimumOut) {
    return {
      status: "BLOCKED",
      message: "Minimum output is below the 1Click minimum permitted by the " + (limitBps / 100).toFixed(2) + "% slippage limit.",
    };
  }

  return {
    status: "PASSED",
    message: "1Click minimum output satisfies the " + (limitBps / 100).toFixed(2) + "% slippage limit after base-unit rounding.",
  };
}

function nextOccurrence(frequency: Plan["frequency"]) {
  const date = new Date();
  if (frequency === "Daily") date.setDate(date.getDate() + 1);
  if (frequency === "Weekly") date.setDate(date.getDate() + 7);
  if (frequency === "Monthly") date.setMonth(date.getMonth() + 1);
  return date.toISOString();
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function shorten(value: string) {
  if (value.length <= 22) return value;
  return value.slice(0, 10) + "…" + value.slice(-8);
}

function formatBaseUnits(value: string, decimals: number) {
  try {
    const units = BigInt(value);
    const scale = 10n ** BigInt(decimals);
    const whole = units / scale;
    const remainder = units % scale;
    if (remainder === 0n) return whole.toString();
    const fraction = remainder.toString().padStart(decimals, "0").replace(/0+$/, "");
    return whole.toString() + "." + fraction.slice(0, 8);
  } catch {
    return value;
  }
}

function validatePlanAmount(value: string, decimals: number) {
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
  if (BigInt(whole) * scale + fractionalUnits <= 0n) {
    throw new Error("Amount must be greater than zero.");
  }
}


export default function Home() {
  // A browser refresh can restore the previous scroll position (or a saved
  // section hash such as #plans). Always start a fresh dashboard load at top.
  useLayoutEffect(() => {
    if ("scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }
    window.scrollTo(0, 0);
  }, []);

  const [network, setNetwork] = useState<IntentNetwork>("testnet");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(true);
  const [assetError, setAssetError] = useState("");
  const [assetSearch, setAssetSearch] = useState("");
  const [originAssetId, setOriginAssetId] = useState("");
  const [destinationAssetId, setDestinationAssetId] = useState("");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [refundTo, setRefundTo] = useState("");
  const [slippage, setSlippage] = useState("100");
  const [frequency, setFrequency] = useState<Plan["frequency"]>("Weekly");
  const [quoteResult, setQuoteResult] = useState<QuoteResult | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [checkingPlanId, setCheckingPlanId] = useState<string | null>(null);
  const [planSaveMessage, setPlanSaveMessage] = useState("");
  const [storageWarning, setStorageWarning] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const [liveSwapQuote, setLiveSwapQuote] = useState<any>(null);
  const [liveSwapStatus, setLiveSwapStatus] = useState("");
  const [liveSwapMessage, setLiveSwapMessage] = useState("");
  const [liveSwapPreparing, setLiveSwapPreparing] = useState(false);
  const [refRouteQuote, setRefRouteQuote] = useState<any>(null);
  const [refRouteLoading, setRefRouteLoading] = useState(false);
  const [refRouteError, setRefRouteError] = useState("");

  useEffect(() => {
    let active = true;
    setAssetsLoading(true);
    setAssetError("");
    setQuoteResult(null);
    fetch("/api/tokens?network=" + network)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to load supported assets.");
        return data;
      })
      .then((data) => {
        if (!active) return;
        setAssets(data.assets || []);
        setAssetsLoading(false);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setAssetError(error instanceof Error ? error.message : "Unable to load supported assets.");
        setAssetsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [network]);

  useEffect(() => {
    function handleWalletAccount(event: Event) {
      const detail = (event as CustomEvent<{ accountId?: string }>).detail;
      if (!detail?.accountId) return;
      setRecipient(detail.accountId);
      setRefundTo(detail.accountId);
    }
    window.addEventListener("meridian:wallet-account", handleWalletAccount);
    return () => window.removeEventListener("meridian:wallet-account", handleWalletAccount);
  }, []);

  useEffect(() => {
    function handleSwapUpdate(event: Event) {
      const detail = (event as CustomEvent<{ status?: string; message?: string }>).detail;
      setLiveSwapStatus(detail?.status || "");
      setLiveSwapMessage(detail?.message || "");
    }
    window.addEventListener("meridian:swap-update", handleSwapUpdate);
    return () => window.removeEventListener("meridian:swap-update", handleSwapUpdate);
  }, []);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(PLANS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) setPlans(parsed);
      }
    } catch {
      setPlans([]);
    }
    setStorageReady(true);
  }, []);

  useEffect(() => {
    if (!assets.length) return;
    if (!originAssetId || !assets.some((asset) => asset.assetId === originAssetId)) {
      const preferred =
        (network === "testnet" && assets.find((asset) => asset.symbol.toUpperCase() === "WNEAR")) ||
        assets.find((asset) => asset.symbol.toUpperCase() === "USDC") ||
        assets[0];
      setOriginAssetId(preferred.assetId);
    }
    if (!destinationAssetId || !assets.some((asset) => asset.assetId === destinationAssetId)) {
      const preferred =
        (network === "testnet" && assets.find((asset) => asset.symbol.toUpperCase() === "WBTC")) ||
        assets.find((asset) => asset.symbol.toUpperCase() === "BTC") ||
        assets.find((asset) => asset.symbol.toUpperCase() === "WNEAR") ||
        assets.find((asset) => asset.symbol.toUpperCase() === "NEAR") ||
        assets.find((asset) => asset.symbol.toUpperCase() === "ETH") ||
        assets.find((asset) => asset.assetId !== originAssetId);
      if (preferred) setDestinationAssetId(preferred.assetId);
    }
  }, [assets, originAssetId, destinationAssetId, network]);

  useEffect(() => {
    if (!storageReady) return;
    try {
      window.localStorage.setItem(PLANS_KEY, JSON.stringify(plans));
      setStorageWarning("");
    } catch {
      setStorageWarning("This browser blocked local storage. Keep this tab open; this plan may not survive a refresh.");
    }
  }, [plans, storageReady]);

  const visibleAssets = useMemo(() => {
    const query = assetSearch.trim().toLowerCase();
    const list = query
      ? assets.filter((asset) =>
          (asset.symbol + " " + asset.blockchain).toLowerCase().includes(query) ||
          asset.assetId === originAssetId ||
          asset.assetId === destinationAssetId
        )
      : assets;
    return list;
  }, [assets, assetSearch, originAssetId, destinationAssetId]);

  const origin = assets.find((asset) => asset.assetId === originAssetId);
  const destination = assets.find((asset) => asset.assetId === destinationAssetId);
  const quoteData = quoteResult?.quote?.quote || quoteResult?.quote;
  const quoteSlippageCheck = quoteData
    ? assessSlippage(quoteData.amountOut, quoteData.minAmountOut, Number(slippage))
    : null;

  async function previewQuote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuoteError("");
    setQuoteResult(null);
    setLiveSwapQuote(null);
    setLiveSwapStatus("");
    setLiveSwapMessage("");
    setQuoteLoading(true);

    try {
      const response = await fetch("/api/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originAsset: originAssetId,
          destinationAsset: destinationAssetId,
          network,
          amount,
          recipient,
          refundTo,
          slippageTolerance: Number(slippage),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Quote request failed.");
      if (data.dry !== true) throw new Error("Safety check failed: MERIDIAN only accepts dry-run quote responses.");
      setQuoteResult(data as QuoteResult);
    } catch (error) {
      setQuoteError(error instanceof Error ? error.message : "Unable to preview this route.");
    } finally {
      setQuoteLoading(false);
    }
  }

  async function prepareFirstSwap() {
    setQuoteError("");
    setLiveSwapPreparing(true);
    setLiveSwapQuote(null);
    setLiveSwapStatus("PREPARING");
    setLiveSwapMessage("Creating a fresh executable testnet quote. No funds are moving yet.");
    try {
      if (network !== "testnet") throw new Error("Live swap execution is disabled on mainnet.");
      if (!origin || !destination || origin.blockchain !== "near" || destination.blockchain !== "near") {
        throw new Error("The first live-swap release supports NEAR testnet assets only.");
      }
      if (!recipient.trim() || !refundTo.trim()) throw new Error("Enter your wallet address in both recipient and refund fields.");
      const response = await fetch("/api/swap/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originAsset: originAssetId,
          destinationAsset: destinationAssetId,
          network,
          amount,
          recipient: recipient.trim(),
          refundTo: refundTo.trim(),
          slippageTolerance: Number(slippage),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not prepare the live testnet swap.");
      if (data.dry !== false || !data.quote?.quote?.depositAddress) {
        throw new Error("The provider did not return a live deposit quote. No transaction was sent.");
      }
      setLiveSwapQuote(data);
      setLiveSwapStatus("PREPARED");
      setLiveSwapMessage("Live quote ready. Review the output and quote expiry before approving the wallet transaction.");
    } catch (error) {
      setLiveSwapStatus("ERROR");
      setLiveSwapMessage(error instanceof Error ? error.message : "Unable to prepare the live testnet swap.");
    } finally {
      setLiveSwapPreparing(false);
    }
  }

  async function prepareRefFinanceQuote() {
    setRefRouteError("");
    setRefRouteQuote(null);
    setRefRouteLoading(true);
    setLiveSwapStatus("");
    setLiveSwapMessage("");
    try {
      if (network !== "testnet") throw new Error("Ref Finance route is only available on NEAR testnet.");
      if (origin?.symbol.toUpperCase() !== "WNEAR") {
        throw new Error("For the immediate Ref Finance purchase, select wNEAR as the source asset. The Ref route buys USDT.e directly.");
      }
      if (!amount.trim()) throw new Error("Enter the wNEAR amount you want to swap.");
      if (!recipient.trim()) throw new Error("Connect your NEAR testnet wallet and use its address as the recipient.");
      const response = await fetch("/api/ref/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: recipient.trim(),
          amount,
          slippageBps: Number(slippage),
        }),
      });
      const data = await response.json();
      if (!response.ok || data.available !== true) throw new Error(data.error || "No Ref Finance route is currently available.");
      setRefRouteQuote(data);
    } catch (error) {
      setRefRouteError(error instanceof Error ? error.message : "Could not check the Ref Finance testnet route.");
    } finally {
      setRefRouteLoading(false);
    }
  }

  function executeRefFinanceSwap() {
    if (!refRouteQuote) return;
    if (refRouteQuote.accountId !== recipient.trim()) {
      setRefRouteError("Wallet account changed. Check the route again before swapping.");
      return;
    }
    if (Date.now() - Date.parse(refRouteQuote.checkedAt) > 60000) {
      setRefRouteError("This quote is more than one minute old. Check the route again before approving.");
      setRefRouteQuote(null);
      return;
    }
    setLiveSwapStatus("AWAITING_WALLET");
    setLiveSwapMessage("Waiting for your wallet to approve the USDT.e registration (if needed) and swap.");
    window.dispatchEvent(new CustomEvent("meridian:execute-ref-swap", {
      detail: {
        accountId: refRouteQuote.accountId,
        amountIn: refRouteQuote.amountIn,
        minimumOut: refRouteQuote.bestQuote.minimumOut,
        poolId: refRouteQuote.bestQuote.poolId,
        protocol: refRouteQuote.protocol === "ref-v1" ? "ref-v1" : "ref-dcl-v2",
        inputRegistered: refRouteQuote.inputRegistered,
        outputRegistered: refRouteQuote.outputRegistered,
        outputStorageMinimum: refRouteQuote.outputStorageMinimum,
        outputContractId: refRouteQuote.outputToken.contractId,
        outputSymbol: refRouteQuote.outputToken.symbol,
      },
    }));
  }

  function approveFirstSwap() {
    if (!liveSwapQuote || !origin || !destination) return;
    if (Date.parse(liveSwapQuote.quote?.quote?.deadline || "") <= Date.now() + 15000) {
      setLiveSwapQuote(null);
      setLiveSwapStatus("EXPIRED");
      setLiveSwapMessage("This live quote has expired. Prepare a new one before approving.");
      return;
    }
    setLiveSwapStatus("AWAITING_WALLET");
    setLiveSwapMessage("Waiting for your wallet approval. Check the token contract and NEAR deposit carefully.");
    window.dispatchEvent(new CustomEvent("meridian:execute-swap", {
      detail: {
        liveQuote: liveSwapQuote.quote,
        originAsset: liveSwapQuote.origin,
        destinationAsset: liveSwapQuote.destination,
        recipient: recipient.trim(),
        refundTo: refundTo.trim(),
      },
    }));
  }


  function createPlan() {
    setPlanSaveMessage("");
    setQuoteError("");
    if (!origin || !destination || !amount || !recipient.trim() || !refundTo.trim()) {
      setQuoteError("Choose both assets and enter the amount, destination and refund addresses before saving a plan.");
      return;
    }
    try {
      validatePlanAmount(amount, origin.decimals);
    } catch (error) {
      setQuoteError(error instanceof Error ? error.message : "Enter a valid amount for the selected token.");
      return;
    }
    const newPlan: Plan = {
      id: window.crypto?.randomUUID?.() || String(Date.now()),
      sourceAssetId: network === "testnet" && liveSwapStatus === "SUCCESS" ? "wrap.testnet" : origin.assetId,
      destinationAssetId: network === "testnet" && liveSwapStatus === "SUCCESS" ? "usdt.fakes.testnet" : destination.assetId,
      sourceSymbol: network === "testnet" && liveSwapStatus === "SUCCESS" ? "wNEAR" : origin.symbol,
      destinationSymbol: network === "testnet" && liveSwapStatus === "SUCCESS" ? "USDT.e" : destination.symbol,
      sourceChain: origin.blockchain,
      destinationChain: destination.blockchain,
      amount,
      recipient: recipient.trim(),
      refundTo: refundTo.trim(),
      frequency,
      network,
      slippage: Number(slippage),
      nextRunAt: nextOccurrence(frequency),
      createdAt: new Date().toISOString(),
    };
    const nextPlans = [newPlan, ...plans];
    try {
      window.localStorage.setItem(PLANS_KEY, JSON.stringify(nextPlans));
    } catch {
      setStorageWarning("This browser could not save the plan to local storage. Check browser privacy settings and try again.");
      setQuoteError("Plan was not saved. Your browser blocked local storage.");
      return;
    }
    setStorageWarning("");
    setPlans(nextPlans);
    setQuoteError("");
    setPlanSaveMessage("Saved " + newPlan.sourceSymbol + " → " + newPlan.destinationSymbol + " · " + newPlan.amount + " " + newPlan.sourceSymbol + " · " + newPlan.frequency.toLowerCase() + ". This is a local reminder, not an automated purchase.");
  }

  function removePlan(id: string) {
    setPlans((current) => current.filter((plan) => plan.id !== id));
  }

  async function previewSavedPlan(plan: Plan) {
    if (checkingPlanId) return;
    setCheckingPlanId(plan.id);

    try {
      if (plan.network === "testnet" && plan.sourceAssetId === "wrap.testnet" && plan.destinationAssetId === "usdt.fakes.testnet") {
        const response = await fetch("/api/ref/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accountId: plan.recipient,
            amount: plan.amount,
            slippageBps: plan.slippage,
          }),
        });
        const data = await response.json();
        if (!response.ok || data.available !== true) throw new Error(data.error || "Ref Finance quote check failed.");
        const quote = data.bestQuote;
        const assessment = assessSlippage(quote.amountOut, quote.minimumOut, plan.slippage);
        setPlans((current) => current.map((item) => item.id === plan.id ? {
          ...item,
          lastDryRun: {
            checkedAt: new Date().toISOString(),
            status: assessment.status,
            message: "Ref Finance testnet · " + assessment.message,
            output: quote.amountOutFormatted + " USDT.e",
            minimumOutput: formatBaseUnits(quote.minimumOut, 6) + " USDT.e",
            quoteReference: quote.poolId,
          },
        } : item));
        return;
      }

      const response = await fetch("/api/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originAsset: plan.sourceAssetId,
          destinationAsset: plan.destinationAssetId,
          network: plan.network || "mainnet",
          amount: plan.amount,
          recipient: plan.recipient,
          refundTo: plan.refundTo,
          slippageTolerance: plan.slippage,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Quote request failed.");

      const result = data as QuoteResult;
      if (result.dry !== true) throw new Error("The API did not confirm dry-run mode. No plan check was saved.");
      const quoteData = result.quote?.quote || result.quote;
      if (!quoteData) throw new Error("The quote response did not contain pricing details.");

      const amountOutRaw = quoteData.amountOut || "";
      const minimumOutRaw = quoteData.minAmountOut || "";
      const assessment = assessSlippage(amountOutRaw, minimumOutRaw, plan.slippage);
      const status: DryRunStatus = assessment.status;
      const message = assessment.message;

      const destinationDecimals = result.assets.destination.decimals ?? 0;
      const output = quoteData.amountOutFormatted || "";
      const minimumOutput = minimumOutRaw
        ? formatBaseUnits(minimumOutRaw, destinationDecimals) + " " + plan.destinationSymbol
        : undefined;

      setPlans((current) => current.map((item) => item.id === plan.id ? {
        ...item,
        lastDryRun: {
          checkedAt: new Date().toISOString(),
          status,
          message,
          output: output ? output + " " + plan.destinationSymbol : undefined,
          minimumOutput,
          quoteReference: result.quote.correlationId,
          deadline: quoteData.deadline,
        },
      } : item));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to check this plan.";
      setPlans((current) => current.map((item) => item.id === plan.id ? {
        ...item,
        lastDryRun: {
          checkedAt: new Date().toISOString(),
          status: "ERROR",
          message,
        },
      } : item));
    } finally {
      setCheckingPlanId(null);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Meridian DCA home">
          <span className="brand-mark"><i /><i /><i /></span>
          <span>MERIDIAN<span className="brand-light"> DCA</span></span>
        </a>
        <nav className="topnav">
          <a href="#markets">Assets</a>
          <a href="#planner">DCA planner</a>
          <a href="#plans">My strategies</a>
          <a href="#how-it-works">How it works</a>
        </nav>
        <div className="topbar-actions">
          <WalletConnect />
          <div className="mode-pill"><span className="pulse-dot" /> {network === "testnet" ? "TESTNET · WALLET-APPROVED SWAPS" : "MAINNET · DRY RUN ONLY"}</div>
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span className="eyebrow-line" /> CROSS-CHAIN INVESTING, MADE STEADY</div>
          <h1>Make every interval<br /><em>count across chains.</em></h1>
          <p>Build a steady crypto-buying strategy across supported networks. Preview each route with a live testnet or mainnet quote before any funds move.</p>
          <div className="hero-actions">
            <a className="primary-link" href="#planner">Create an investment plan <span>↗</span></a>
            <span className="hero-note"><span className="shield">◇</span> No transfers in this demo</span>
          </div>
        </div>
        <div className="hero-art">
          <div className="route-visual">
            <div className="route-visual-top">
              <span>MERIDIAN / ROUTE MONITOR</span>
              <span className="visual-status"><i /> DRY RUN</span>
            </div>
            <div className="route-visual-main">
              <div>
                <span className="visual-kicker">YOUR NEXT ROUTE</span>
                <div className="visual-pair">
                  <span>{origin?.symbol || "USDC"}</span>
                  <b>↗</b>
                  <span>{destination?.symbol || "BTC"}</span>
                </div>
                <p>{origin?.blockchain || "Source network"} <i>to</i> {destination?.blockchain || "Destination network"}</p>
              </div>
              <div className="route-visual-badge">1CLICK<br /><strong>API</strong></div>
            </div>
            <div className="route-visual-flow" aria-hidden="true">
              <div className="flow-node node-left"><span /></div>
              <div className="flow-track"><span /><span /><span /></div>
              <div className="flow-node node-right"><span /></div>
            </div>
            <div className="route-visual-bottom">
              <div><span>ROUTING LAYER</span><strong>NEAR Intents</strong></div>
              <div><span>EXECUTION</span><strong>{network === "testnet" ? "Wallet approval required" : "Preview only"}</strong></div>
            </div>
            <div className="visual-footnote">Illustrative route view · actual output comes from each quote</div>
          </div>
        </div>
      </section>

      <section className="asset-strip" id="markets">
        <div className="asset-strip-heading">
          <strong>SUPPORTED ASSET UNIVERSE</strong>
          <span>{assetsLoading ? "SYNCING ASSET FEED…" : assets.length.toLocaleString() + " ASSETS · " + (network === "testnet" ? "TIDEPOOL TESTNET" : "1CLICK MAINNET")}</span>
        </div>
        <div className="asset-ticker">
          {assets.slice(0, 12).map((asset) => (
            <div className="asset-ticker-item" key={asset.assetId}>
              <span className="ticker-symbol">{asset.symbol.slice(0, 1)}</span>
              <strong>{asset.symbol}</strong>
              <small>{asset.blockchain}</small>
            </div>
          ))}
          {!assetsLoading && !assets.length && <span className="ticker-empty">Asset feed is temporarily unavailable. Retry the asset list below.</span>}
        </div>
      </section>

      <section className="metrics-strip">
        <div><span className="metric-label">ROUTING LAYER</span><strong>NEAR Intents</strong></div>
        <div><span className="metric-label">ASSET UNIVERSE</span><strong>{assetsLoading ? "Loading…" : assets.length.toLocaleString() + " assets"}</strong></div>
        <div><span className="metric-label">QUOTE MODE</span><strong>Real-time preview</strong></div>
        <div><span className="metric-label">EXECUTION</span><strong>{network === "testnet" ? "Testnet · wallet approved" : "Mainnet · preview only"}</strong></div>
      </section>

      <section className="section-heading" id="planner">
        <div><div className="eyebrow">01 / STRATEGY BUILDER</div><h2>Set your investment rhythm.</h2></div>
        <p>Choose what you want to buy, how much to allocate and how often you plan to do it.</p>
      </section>

      <section className="workspace">
        <div className="planner-card">
          <div className="card-heading">
            <div><span className="step-number">01</span><h3>Investment details</h3></div>
            <span className="card-caption">BUY NOW · THEN SET YOUR PLAN</span>
          </div>

          <div className="network-switcher">
            <label htmlFor="quote-network">QUOTE PREVIEW SOURCE</label>
            <select id="quote-network" value={network} onChange={(event) => { setNetwork(event.target.value as IntentNetwork); setQuoteResult(null); setQuoteError(""); setRefRouteQuote(null); setRefRouteError(""); setLiveSwapStatus(""); setLiveSwapMessage(""); setAssetSearch(""); }}>
              <option value="testnet">Testnet sandbox · Tidepool</option>
              <option value="mainnet">Mainnet · NEAR Intents 1Click</option>
            </select>
            <span>{network === "testnet" ? "Tidepool is used for quote previews. Your immediate wNEAR → USDT.e purchase uses the verified Ref Finance pool below." : "Official 1Click mainnet · dry-run quote only · no funds moved"}</span>
          </div>

          {assetError && <div className="alert error">{assetError} <button type="button" onClick={() => window.location.reload()}>Retry</button></div>}

          <form onSubmit={previewQuote}>
            <div className="field">
              <label htmlFor="asset-search">FIND AN ASSET</label>
              <input id="asset-search" value={assetSearch} onChange={(event) => setAssetSearch(event.target.value)} placeholder="Search by token or network, e.g. USDC, ethereum…" />
            </div>

            <div className="asset-grid">
              <div className="field">
                <label htmlFor="origin">I WANT TO INVEST WITH</label>
                <select id="origin" value={originAssetId} onChange={(event) => { const next = event.target.value; setOriginAssetId(next); if (next === destinationAssetId) setDestinationAssetId(assets.find((asset) => asset.assetId !== next)?.assetId || ""); setQuoteResult(null); setRefRouteQuote(null); setRefRouteError(""); setLiveSwapStatus(""); setLiveSwapMessage(""); }} disabled={assetsLoading || !assets.length}>
                  {visibleAssets.map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.symbol} · {asset.blockchain.toUpperCase()}</option>)}
                </select>
                {origin && <span className="field-hint">{origin.blockchain.toUpperCase()} network · {origin.decimals} decimals</span>}
              </div>
              <div className="swap-arrow">→</div>
              <div className="field">
                <label htmlFor="destination">I WANT TO ACCUMULATE</label>
                <select id="destination" value={destinationAssetId} onChange={(event) => { setDestinationAssetId(event.target.value); setQuoteResult(null); setRefRouteQuote(null); setRefRouteError(""); setLiveSwapStatus(""); setLiveSwapMessage(""); }} disabled={assetsLoading || !assets.length}>
                  {visibleAssets.filter((asset) => asset.assetId !== originAssetId).map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.symbol} · {asset.blockchain.toUpperCase()}</option>)}
                </select>
                {destination && <span className="field-hint">{destination.blockchain.toUpperCase()} network · {destination.decimals} decimals</span>}
              </div>
            </div>

            <div className="field amount-field">
              <label htmlFor="amount">AMOUNT TO BUY NOW / PER BUY</label>
              <div className="input-suffix"><input id="amount" inputMode="decimal" value={amount} onChange={(event) => { setAmount(event.target.value); setQuoteResult(null); setRefRouteQuote(null); setRefRouteError(""); setLiveSwapStatus(""); setLiveSwapMessage(""); }} placeholder="Enter amount, e.g. 0.01" /><span>{origin?.symbol || "TOKEN"}</span></div>
              <span className="field-hint">For testnet, enter up to 3 wNEAR. The quote checks the available pool before any wallet approval.</span>
            </div>

            <div className="field">
              <label htmlFor="recipient">DESTINATION WALLET ADDRESS</label>
              <input id="recipient" value={recipient} onChange={(event) => { setRecipient(event.target.value); setQuoteResult(null); setRefRouteQuote(null); setRefRouteError(""); setLiveSwapStatus(""); setLiveSwapMessage(""); }} placeholder="Address on the destination network" autoComplete="off" />
              <span className="field-hint">The address that should receive the purchased asset.</span>
            </div>
            <div className="field">
              <label htmlFor="refund">REFUND WALLET ADDRESS</label>
              <input id="refund" value={refundTo} onChange={(event) => { setRefundTo(event.target.value); setQuoteResult(null); }} placeholder="Address on the source network" autoComplete="off" />
              <span className="field-hint">Used by the routing service if a future swap cannot complete.</span>
            </div>

            <div className="field">
              <div className="label-with-value"><label htmlFor="slippage">MAXIMUM SLIPPAGE</label><strong>{(Number(slippage) / 100).toFixed(2)}%</strong></div>
              <input className="range-input" id="slippage" type="range" min="10" max="500" step="10" value={slippage} onChange={(event) => { setSlippage(event.target.value); setQuoteResult(null); setRefRouteQuote(null); setRefRouteError(""); }} />
              <div className="range-labels"><span>0.10%</span><span>5.00%</span></div>
            </div>

            {network === "testnet" && (
            <div className="ref-direct-panel investment-buy-panel">
            <div className="ref-direct-heading"><strong>MAKE YOUR FIRST BUY NOW</strong><span>REF FINANCE · TESTNET</span></div>
            <p className="live-swap-note">This buy uses your connected wallet's <strong>wrap.testnet wNEAR</strong> and the verified Ref Finance testnet <strong>USDT.e</strong> pool. Select wNEAR as the source above. The destination selector only affects the separate Tidepool quote preview.</p>
            <div className="quote-detail"><span>Swap pair</span><strong>wNEAR → USDT.e</strong></div>
            <div className="quote-detail"><span>Input amount</span><strong>{amount || "—"} wNEAR</strong></div>
            <div className="quote-detail"><span>Wallet account</span><strong>{recipient.trim() || "Enter wallet address above"}</strong></div>
            {!refRouteQuote ? (
            <button className="button button-primary full-button" type="button" onClick={prepareRefFinanceQuote} disabled={refRouteLoading || !amount.trim() || origin?.symbol.toUpperCase() !== "WNEAR" || !recipient.trim()}>
            {refRouteLoading ? "Getting swap quote…" : "Preview immediate swap"}
            </button>
            ) : (
            <>
            <div className="quote-detail"><span>Estimated {refRouteQuote.outputToken.symbol} output</span><strong>{refRouteQuote.bestQuote.amountOutFormatted} {refRouteQuote.outputToken.symbol}</strong></div>
            <div className="quote-detail"><span>Minimum received</span><strong>{formatBaseUnits(refRouteQuote.bestQuote.minimumOut, refRouteQuote.outputToken.decimals)} {refRouteQuote.outputToken.symbol}</strong></div>
            <div className="quote-detail"><span>Pool fee</span><strong>{(refRouteQuote.bestQuote.fee / 10000).toFixed(2)}%</strong></div>
            <div className="quote-detail"><span>Route</span><strong>{refRouteQuote.protocol === "ref-v1" ? "Ref classic exchange" : "Ref DCL v2"}</strong></div>
                    <div className="quote-detail"><span>Pool ID</span><strong className="reference">{refRouteQuote.bestQuote.poolId}</strong></div>
            <div className="quote-detail"><span>{refRouteQuote.outputToken.symbol} wallet registration</span><strong>{refRouteQuote.outputRegistered ? "Already registered" : "Required before swap"}</strong></div>
            {!refRouteQuote.outputRegistered && <p className="fee-note">Your wallet will first ask you to register the {refRouteQuote.outputToken.symbol} token account with a one-time storage deposit of {formatBaseUnits(refRouteQuote.outputStorageMinimum, 24)} NEAR. The swap is a separate approval.</p>}
            <button className="button button-primary full-button" type="button" onClick={executeRefFinanceSwap} disabled={["AWAITING_WALLET","REGISTERING_OUTPUT","SUBMITTED","PENDING","SUCCESS"].includes(liveSwapStatus)}>
            Approve and swap now
            </button>
            <button className="button button-secondary full-button" type="button" onClick={() => { setRefRouteQuote(null); setLiveSwapStatus(""); setLiveSwapMessage(""); }}>Discard Ref quote</button>
            </>
            )}
            {refRouteError && <div className="swap-execution-state error" role="alert"><strong>ROUTE CHECK</strong><span>{refRouteError}</span></div>}
            {liveSwapStatus && <div className={"swap-execution-state " + (liveSwapStatus === "SUCCESS" ? "success" : liveSwapStatus === "ERROR" ? "error" : "")} role="status" aria-live="polite"><strong>{liveSwapStatus.replaceAll("_", " ")}</strong><span>{liveSwapMessage}</span></div>}
            <p className="fee-note">This is a one-time purchase. After it succeeds, choose <strong>Save recurring plan</strong> below to keep a separate daily, weekly or monthly plan.</p>
            </div>
            )}

            <div className="recurring-plan-field">
              <div className="ref-direct-heading"><strong>SET UP YOUR RECURRING PLAN</strong><span>AFTER FIRST BUY</span></div>
              <div className="field">
                <label htmlFor="frequency">RECURRING FREQUENCY</label>
                <select id="frequency" value={frequency} onChange={(event) => setFrequency(event.target.value as Plan["frequency"])}>
                  <option>Daily</option><option>Weekly</option><option>Monthly</option>
                </select>
                <span className="field-hint">This schedule is saved after your immediate purchase. It does not trigger automatic swaps yet.</span>
              </div>
            </div>

            {quoteError && <div className="alert error">{quoteError}</div>}

            <div className="form-actions">
              <button className="button button-primary" type="submit" disabled={quoteLoading || assetsLoading || !origin || !destination || !amount.trim()}>
                {quoteLoading ? <><span className="spinner" /> Fetching live quote…</> : <>Preview live quote <span>↗</span></>}
              </button>
              <button className="button button-secondary" type="button" onClick={createPlan} disabled={assetsLoading || !origin || !destination || !amount.trim() || (network === "testnet" && liveSwapStatus !== "SUCCESS")}>Save recurring plan</button>
            </div>
            {network === "testnet" && liveSwapStatus !== "SUCCESS" && <p className="form-footnote">Complete your first wNEAR → USDT.e purchase above to unlock saving the recurring plan.</p>}
            {planSaveMessage && <div className="plan-save-success" role="status" aria-live="polite"><strong>✓ Plan saved successfully</strong><span>{planSaveMessage}</span><a href="#plans">View saved plan ↓</a></div>}
            {storageWarning && <div className="alert error" role="alert">{storageWarning}</div>}
            <p className="form-footnote"><span>ⓘ</span> Saving a plan stores a reminder in this browser. It does not schedule or execute a blockchain transaction.</p>
          </form>
        </div>

        <aside className="quote-column">
          <div className="quote-card">
            <div className="card-heading">
              <div><span className="step-number">02</span><h3>Quote preview</h3></div>
              <span className="live-tag"><span className="pulse-dot" /> {network === "testnet" ? "TIDEPOOL TESTNET" : "1CLICK MAINNET"}</span>
            </div>

            {!quoteResult && !quoteLoading && (
              <div className="empty-quote">
                <div className="empty-icon">↗</div>
                <h4>Your route, at a glance.</h4>
                <p>Choose your assets and request a quote to see the estimated output, minimum received and route timing.</p>
                <div className="empty-route"><span>{origin?.symbol || "SOURCE"}</span><i>→</i><span>{destination?.symbol || "TARGET"}</span></div>
              </div>
            )}
            {quoteLoading && <div className="quote-loading"><span className="spinner large" /><strong>Checking the route</strong><p>{network === "testnet" ? "Requesting a fresh dry-run quote from the Tidepool testnet sandbox." : "Requesting a fresh dry-run quote from official NEAR Intents 1Click."}</p></div>}
            {quoteResult && quoteData && (
              <div className="quote-content">
                <div className="quote-status"><span className="status-check">✓</span><span>QUOTE RECEIVED</span><b>DRY RUN</b></div>
                <span className="quote-overline">ESTIMATED OUTPUT</span>
                <div className="quote-output">{quoteData.amountOutFormatted || "—"} <small>{destination?.symbol}</small></div>
                <div className="quote-pair">{quoteResult.assets.origin.symbol} on {quoteResult.assets.origin.blockchain.toUpperCase()} <span>→</span> {quoteResult.assets.destination.symbol} on {quoteResult.assets.destination.blockchain.toUpperCase()}</div>
                <div className="quote-divider" />
                <div className="quote-detail"><span>Input amount</span><strong>{quoteData.amountInFormatted || amount} {origin?.symbol}</strong></div>
                <div className="quote-detail"><span>Minimum output</span><strong>{quoteData.minAmountOut ? formatBaseUnits(quoteData.minAmountOut, destination?.decimals || 0) : "Not provided"} {destination?.symbol}</strong></div>
                <div className="quote-detail"><span>Slippage guard</span><strong>{quoteResult.quoteControls?.slippagePercent || (Number(slippage) / 100).toFixed(2)}% maximum</strong></div>
                <div className="quote-detail"><span>Estimated route time</span><strong>{typeof quoteData.timeEstimate === "number" ? Math.max(1, Math.round(quoteData.timeEstimate / 60)) + " min" : "Not provided"}</strong></div>
                {quoteData.deadline && <div className="quote-detail"><span>Quote deadline</span><strong>{formatDate(quoteData.deadline)}</strong></div>}
                <div className="quote-detail"><span>Quote reference</span><strong className="reference">{quoteResult.quote.correlationId ? shorten(quoteResult.quote.correlationId) : "Generated"}</strong></div>
                {quoteSlippageCheck && <div className={"slippage-result " + quoteSlippageCheck.status.toLowerCase()}><strong>{quoteSlippageCheck.status === "PASSED" ? "Slippage check passed" : quoteSlippageCheck.status === "BLOCKED" ? "Quote blocked" : "Slippage not verified"}</strong><p>{quoteSlippageCheck.message}</p></div>}
                <div className="quote-warning"><b>Preview only.</b> No deposit address was generated and no funds were moved.</div>
                <p className="fee-note">{quoteResult.feeNote}</p>
                <button className="button button-secondary full-button" type="button" onClick={() => { setQuoteResult(null); setLiveSwapQuote(null); setLiveSwapStatus(""); setLiveSwapMessage(""); }}>Clear quote</button>
              </div>
            )}
            {quoteResult && !quoteData && <div className="alert error">The quote response did not contain the expected pricing fields. Please try again.</div>}
          </div>
          <div className="integrity-note"><span className="integrity-icon">◇</span><div><strong>Your funds stay yours.</strong><p>MERIDIAN does not hold private keys or custody funds in this demo.</p></div></div>
        </aside>
      </section>

      <section className="section-heading plans-heading" id="plans">
        <div><div className="eyebrow">02 / YOUR STRATEGIES</div><h2>Consistency starts with a plan.</h2></div>
        <p>Your saved plans stay in this browser. Execution is not active in this release.</p>
      </section>

      <section className="plans-panel">
        <div className="plans-topline"><div><strong>{plans.length.toString().padStart(2, "0")}</strong><span> SAVED PLANS</span></div><span className="local-tag">LOCAL PLANNER</span></div>
        {!plans.length ? (
          <div className="plans-empty"><div className="empty-plan-icon">＋</div><strong>No plans yet</strong><p>Your recurring investment plans will appear here after you save one.</p></div>
        ) : (
          <div className="plan-list">
            {plans.map((plan) => (
              <article className="plan-row" key={plan.id}>
                <div className="plan-pair-icon">{plan.sourceSymbol.slice(0, 1)}<span>↗</span>{plan.destinationSymbol.slice(0, 1)}</div>
                <div className="plan-main">
                  <strong>{plan.sourceSymbol} <span>→</span> {plan.destinationSymbol}</strong>
                  <small>{plan.sourceChain.toUpperCase()} to {plan.destinationChain.toUpperCase()} · {plan.frequency.toLowerCase()} · {plan.sourceAssetId === "wrap.testnet" ? "REF FINANCE TESTNET" : (plan.network || "mainnet") === "testnet" ? "TIDEPOOL TESTNET" : "MAINNET"}</small>
                  {plan.lastDryRun && <small className={"plan-check-result " + plan.lastDryRun.status.toLowerCase()}>{plan.lastDryRun.status}: {plan.lastDryRun.message}</small>}
                  {plan.lastDryRun?.output && <small className="plan-check-detail">Expected {plan.lastDryRun.output}{plan.lastDryRun.minimumOutput ? " · Minimum " + plan.lastDryRun.minimumOutput : ""}</small>}
                </div>
                <div className="plan-amount"><strong>{plan.amount} {plan.sourceSymbol}</strong><small>Per interval</small></div>
                <div className="plan-next"><strong>{formatDate(plan.nextRunAt)}</strong><small>Planned next date</small>{plan.lastDryRun && <small>Checked {formatDate(plan.lastDryRun.checkedAt)}</small>}</div>
                <div className="plan-actions">
                  <div className="plan-status">PLANNED ONLY</div>
                  <button className="plan-preview" type="button" onClick={() => previewSavedPlan(plan)} disabled={checkingPlanId !== null} aria-label={"Check next dry-run quote for " + plan.sourceSymbol + " to " + plan.destinationSymbol}>
                    {checkingPlanId === plan.id ? "Checking…" : "Check quote"}
                  </button>
                  <button className="remove-plan" type="button" onClick={() => removePlan(plan.id)} aria-label={"Remove " + plan.sourceSymbol + " to " + plan.destinationSymbol + " plan"}>×</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="how-section" id="how-it-works">
        <div className="eyebrow">03 / THE PROCESS</div>
        <h2>Simple by design.<br /><em>Transparent by default.</em></h2>
        <div className="how-grid">
          <article><span>01</span><div className="how-icon">⌁</div><h3>Choose your route</h3><p>Select a supported asset pair and the wallet addresses for delivery and refunds.</p></article>
          <article><span>02</span><div className="how-icon">↗</div><h3>Preview the quote</h3><p>Preview routing from Tidepool testnet or official NEAR Intents 1Click without creating a deposit address.</p></article>
          <article><span>03</span><div className="how-icon">◷</div><h3>Set your rhythm</h3><p>Save a daily, weekly or monthly plan. This release records your plan locally only.</p></article>
        </div>
      </section>

      <footer className="footer">
        <a className="brand footer-brand" href="/"><span className="brand-mark"><i /><i /><i /></span><span>MERIDIAN<span className="brand-light"> DCA</span></span></a>
        <span>Cross-chain investing, with intention.</span>
        <span>NEAR Intents + Tidepool sandbox <b>·</b> Dry-run release</span>
      </footer>
    </main>
  );
}