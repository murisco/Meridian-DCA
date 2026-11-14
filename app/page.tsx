"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Asset = {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price?: string;
  priceUpdatedAt?: string;
};

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
  slippage: number;
  nextRunAt: string;
  createdAt: string;
};

type QuoteResult = {
  dry: boolean;
  quote: {
    correlationId?: string;
    quote?: {
      amountInFormatted?: string;
      amountOutFormatted?: string;
      minAmountOut?: string;
      amountOutUsd?: string;
      amountInUsd?: string;
      timeEstimate?: number;
      deadline?: string;
    };
    amountInFormatted?: string;
    amountOutFormatted?: string;
    minAmountOut?: string;
    amountOutUsd?: string;
    amountInUsd?: string;
    timeEstimate?: number;
    deadline?: string;
  };
  assets: {
    origin: { symbol: string; blockchain: string };
    destination: { symbol: string; blockchain: string };
  };
  feeNote: string;
};

const PLANS_KEY = "meridian-dca-plans-v1";

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

export default function Home() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(true);
  const [assetError, setAssetError] = useState("");
  const [assetSearch, setAssetSearch] = useState("");
  const [originAssetId, setOriginAssetId] = useState("");
  const [destinationAssetId, setDestinationAssetId] = useState("");
  const [amount, setAmount] = useState("25");
  const [recipient, setRecipient] = useState("");
  const [refundTo, setRefundTo] = useState("");
  const [slippage, setSlippage] = useState("100");
  const [frequency, setFrequency] = useState<Plan["frequency"]>("Weekly");
  const [quoteResult, setQuoteResult] = useState<QuoteResult | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [storageReady, setStorageReady] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/tokens")
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

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!assets.length) return;
    if (!originAssetId || !assets.some((asset) => asset.assetId === originAssetId)) {
      const preferred = assets.find((asset) => asset.symbol.toUpperCase() === "USDC") || assets[0];
      setOriginAssetId(preferred.assetId);
    }
    if (!destinationAssetId || !assets.some((asset) => asset.assetId === destinationAssetId)) {
      const preferred =
        assets.find((asset) => asset.symbol.toUpperCase() === "BTC") ||
        assets.find((asset) => asset.symbol.toUpperCase() === "NEAR") ||
        assets.find((asset) => asset.symbol.toUpperCase() === "ETH") ||
        assets.find((asset) => asset.assetId !== originAssetId);
      if (preferred) setDestinationAssetId(preferred.assetId);
    }
  }, [assets, originAssetId, destinationAssetId]);

  useEffect(() => {
    if (storageReady) window.localStorage.setItem(PLANS_KEY, JSON.stringify(plans));
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
  }, [assets, assetSearch]);

  const origin = assets.find((asset) => asset.assetId === originAssetId);
  const destination = assets.find((asset) => asset.assetId === destinationAssetId);
  const quoteData = quoteResult?.quote?.quote || quoteResult?.quote;

  async function previewQuote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuoteError("");
    setQuoteResult(null);
    setQuoteLoading(true);

    try {
      const response = await fetch("/api/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originAsset: originAssetId,
          destinationAsset: destinationAssetId,
          amount,
          recipient,
          refundTo,
          slippageTolerance: Number(slippage),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Quote request failed.");
      setQuoteResult(data as QuoteResult);
    } catch (error) {
      setQuoteError(error instanceof Error ? error.message : "Unable to preview this route.");
    } finally {
      setQuoteLoading(false);
    }
  }

  function createPlan() {
    if (!origin || !destination || !amount || !recipient.trim() || !refundTo.trim()) {
      setQuoteError("Choose both assets and enter the amount, destination and refund addresses before saving a plan.");
      return;
    }
    const newPlan: Plan = {
      id: window.crypto?.randomUUID?.() || String(Date.now()),
      sourceAssetId: origin.assetId,
      destinationAssetId: destination.assetId,
      sourceSymbol: origin.symbol,
      destinationSymbol: destination.symbol,
      sourceChain: origin.blockchain,
      destinationChain: destination.blockchain,
      amount,
      recipient: recipient.trim(),
      refundTo: refundTo.trim(),
      frequency,
      slippage: Number(slippage),
      nextRunAt: nextOccurrence(frequency),
      createdAt: new Date().toISOString(),
    };
    setPlans((current) => [newPlan, ...current]);
    setQuoteError("");
  }

  function removePlan(id: string) {
    setPlans((current) => current.filter((plan) => plan.id !== id));
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
        <div className="mode-pill"><span className="pulse-dot" /> DRY RUN · NO FUNDS MOVED</div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span className="eyebrow-line" /> CROSS-CHAIN INVESTING, MADE STEADY</div>
          <h1>Make every interval<br /><em>count across chains.</em></h1>
          <p>Build a steady crypto-buying strategy across supported networks. Preview each route with a live NEAR Intents quote before any funds move.</p>
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
              <div><span>EXECUTION</span><strong>Not enabled</strong></div>
            </div>
            <div className="visual-footnote">Illustrative route view · actual output comes from each quote</div>
          </div>
        </div>
      </section>

      <section className="asset-strip" id="markets">
        <div className="asset-strip-heading">
          <strong>SUPPORTED ASSET UNIVERSE</strong>
          <span>{assetsLoading ? "SYNCING WITH NEAR INTENTS…" : assets.length.toLocaleString() + " ASSETS · 1CLICK API"}</span>
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
        <div><span className="metric-label">EXECUTION</span><strong className="muted-value">Not enabled</strong></div>
      </section>

      <section className="section-heading" id="planner">
        <div><div className="eyebrow">01 / STRATEGY BUILDER</div><h2>Set your investment rhythm.</h2></div>
        <p>Choose what you want to buy, how much to allocate and how often you plan to do it.</p>
      </section>

      <section className="workspace">
        <div className="planner-card">
          <div className="card-heading">
            <div><span className="step-number">01</span><h3>Investment details</h3></div>
            <span className="card-caption">PLAN YOUR NEXT BUY</span>
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
                <select id="origin" value={originAssetId} onChange={(event) => { const next = event.target.value; setOriginAssetId(next); if (next === destinationAssetId) setDestinationAssetId(assets.find((asset) => asset.assetId !== next)?.assetId || ""); setQuoteResult(null); }} disabled={assetsLoading || !assets.length}>
                  {visibleAssets.map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.symbol} · {asset.blockchain.toUpperCase()}</option>)}
                </select>
                {origin && <span className="field-hint">{origin.blockchain.toUpperCase()} network · {origin.decimals} decimals</span>}
              </div>
              <div className="swap-arrow">→</div>
              <div className="field">
                <label htmlFor="destination">I WANT TO ACCUMULATE</label>
                <select id="destination" value={destinationAssetId} onChange={(event) => { setDestinationAssetId(event.target.value); setQuoteResult(null); }} disabled={assetsLoading || !assets.length}>
                  {visibleAssets.filter((asset) => asset.assetId !== originAssetId).map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.symbol} · {asset.blockchain.toUpperCase()}</option>)}
                </select>
                {destination && <span className="field-hint">{destination.blockchain.toUpperCase()} network · {destination.decimals} decimals</span>}
              </div>
            </div>

            <div className="field-row">
              <div className="field amount-field">
                <label htmlFor="amount">AMOUNT PER BUY</label>
                <div className="input-suffix"><input id="amount" inputMode="decimal" value={amount} onChange={(event) => { setAmount(event.target.value); setQuoteResult(null); }} placeholder="25.00" /><span>{origin?.symbol || "TOKEN"}</span></div>
              </div>
              <div className="field">
                <label htmlFor="frequency">REPEAT EVERY</label>
                <select id="frequency" value={frequency} onChange={(event) => setFrequency(event.target.value as Plan["frequency"])}>
                  <option>Daily</option><option>Weekly</option><option>Monthly</option>
                </select>
              </div>
            </div>

            <div className="field">
              <label htmlFor="recipient">DESTINATION WALLET ADDRESS</label>
              <input id="recipient" value={recipient} onChange={(event) => { setRecipient(event.target.value); setQuoteResult(null); }} placeholder="Address on the destination network" autoComplete="off" />
              <span className="field-hint">The address that should receive the purchased asset.</span>
            </div>
            <div className="field">
              <label htmlFor="refund">REFUND WALLET ADDRESS</label>
              <input id="refund" value={refundTo} onChange={(event) => { setRefundTo(event.target.value); setQuoteResult(null); }} placeholder="Address on the source network" autoComplete="off" />
              <span className="field-hint">Used by the routing service if a future swap cannot complete.</span>
            </div>

            <div className="field">
              <div className="label-with-value"><label htmlFor="slippage">MAXIMUM SLIPPAGE</label><strong>{(Number(slippage) / 100).toFixed(2)}%</strong></div>
              <input className="range-input" id="slippage" type="range" min="10" max="500" step="10" value={slippage} onChange={(event) => { setSlippage(event.target.value); setQuoteResult(null); }} />
              <div className="range-labels"><span>0.10%</span><span>5.00%</span></div>
            </div>

            {quoteError && <div className="alert error">{quoteError}</div>}

            <div className="form-actions">
              <button className="button button-primary" type="submit" disabled={quoteLoading || assetsLoading || !origin || !destination}>
                {quoteLoading ? <><span className="spinner" /> Fetching live quote…</> : <>Preview live quote <span>↗</span></>}
              </button>
              <button className="button button-secondary" type="button" onClick={createPlan} disabled={assetsLoading || !origin || !destination}>Save recurring plan</button>
            </div>
            <p className="form-footnote"><span>ⓘ</span> Saving a plan stores a reminder in this browser. It does not schedule or execute a blockchain transaction.</p>
          </form>
        </div>

        <aside className="quote-column">
          <div className="quote-card">
            <div className="card-heading">
              <div><span className="step-number">02</span><h3>Quote preview</h3></div>
              <span className="live-tag"><span className="pulse-dot" /> NEAR INTENTS
            </div>
            {!quoteResult && !quoteLoading && (
              <div className="empty-quote">
                <div className="empty-icon">↗</div>
                <h4>Your route, at a glance.</h4>
                <p>Choose your assets and request a quote to see the estimated output, minimum received and route timing.</p>
                <div className="empty-route"><span>{origin?.symbol || "SOURCE"}</span><i>→</i><span>{destination?.symbol || "TARGET"}</span></div>
              </div>
            )}
            {quoteLoading && <div className="quote-loading"><span className="spinner large" /><strong>Checking the route</strong><p>Requesting a fresh dry-run quote from NEAR Intents 1Click.</p></div>}
            {quoteResult && quoteData && (
              <div className="quote-content">
                <div className="quote-status"><span className="status-check">✓</span><span>QUOTE RECEIVED</span><b>DRY RUN</b></div>
                <span className="quote-overline">ESTIMATED OUTPUT</span>
                <div className="quote-output">{quoteData.amountOutFormatted || "—"} <small>{destination?.symbol}</small></div>
                <div className="quote-pair">{quoteResult.assets.origin.symbol} on {quoteResult.assets.origin.blockchain.toUpperCase()} <span>→</span> {quoteResult.assets.destination.symbol} on {quoteResult.assets.destination.blockchain.toUpperCase()}</div>
                <div className="quote-divider" />
                <div className="quote-detail"><span>Input amount</span><strong>{quoteData.amountInFormatted || amount} {origin?.symbol}</strong></div>
                <div className="quote-detail"><span>Minimum output</span><strong>{quoteData.minAmountOut ? formatBaseUnits(quoteData.minAmountOut, destination?.decimals || 0) : "See quote details"} {destination?.symbol}</strong></div>
                <div className="quote-detail"><span>Estimated route time</span><strong>{typeof quoteData.timeEstimate === "number" ? Math.max(1, Math.round(quoteData.timeEstimate / 60)) + " min" : "Not provided"}</strong></div>
                <div className="quote-detail"><span>Quote reference</span><strong className="reference">{quoteResult.quote.correlationId ? shorten(quoteResult.quote.correlationId) : "Generated"}</strong></div>
                <div className="quote-warning"><b>Preview only.</b> No deposit address was generated and no funds were moved.</div>
                <p className="fee-note">{quoteResult.feeNote}</p>
                <button className="button button-secondary full-button" type="button" onClick={() => setQuoteResult(null)}>Clear quote</button>
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
                <div className="plan-main"><strong>{plan.sourceSymbol} <span>→</span> {plan.destinationSymbol}</strong><small>{plan.sourceChain.toUpperCase()} to {plan.destinationChain.toUpperCase()} · {plan.frequency.toLowerCase()}</small></div>
                <div className="plan-amount"><strong>{plan.amount} {plan.sourceSymbol}</strong><small>Per interval</small></div>
                <div className="plan-next"><strong>{formatDate(plan.nextRunAt)}</strong><small>Planned next date</small></div>
                <div className="plan-status">PLANNED ONLY</div>
                <button className="remove-plan" type="button" onClick={() => removePlan(plan.id)} aria-label={"Remove " + plan.sourceSymbol + " to " + plan.destinationSymbol + " plan"}>×</button>
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
          <article><span>02</span><div className="how-icon">↗</div><h3>Preview the quote</h3><p>Get real market routing data from NEAR Intents without creating a deposit address.</p></article>
          <article><span>03</span><div className="how-icon">◷</div><h3>Set your rhythm</h3><p>Save a daily, weekly or monthly plan. This release records your plan locally only.</p></article>
        </div>
      </section>

      <footer className="footer">
        <a className="brand footer-brand" href="/"><span className="brand-mark"><i /><i /><i /></span><span>MERIDIAN<span className="brand-light"> DCA</span></span></a>
        <span>Cross-chain investing, with intention.</span>
        <span>Powered by NEAR Intents <b>·</b> Dry-run release</span>
      </footer>
    </main>
  );
}