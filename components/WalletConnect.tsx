"use client";

import { useEffect, useRef, useState } from "react";
import type { NearConnector as NearConnectorType } from "@hot-labs/near-connect";

type WalletBalance = {
  near: string;
  tokens: { symbol: string; balance: string; decimals: number }[];
  updatedAt: string;
};

export default function WalletConnect() {
  const connectorRef = useRef<NearConnectorType | null>(null);
  const [accountId, setAccountId] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState("");
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState("");
  const [balanceRefresh, setBalanceRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    let connector: NearConnectorType | null = null;

    async function initialise() {
      const { NearConnector } = await import("@hot-labs/near-connect");
      const instance = new NearConnector({
        network: "testnet",
        features: { testnet: true },
      });

      await instance.whenManifestLoaded;
      if (!active) return;

      connector = instance;
      connectorRef.current = instance;

      instance.on("wallet:signIn", ({ accounts }) => {
        if (active) setAccountId(accounts[0]?.accountId ?? "");
      });
      instance.on("wallet:signOut", () => {
        if (active) {
          setAccountId("");
          setBalance(null);
          setMenuOpen(false);
        }
      });

      try {
        const wallet = await instance.wallet();
        const accounts = await wallet.getAccounts();
        if (active) setAccountId(accounts[0]?.accountId ?? "");
      } catch {
        // No saved wallet session is a normal first-visit state.
      }

      if (active) setReady(true);
    }

    initialise().catch((cause: unknown) => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : "Wallet connector could not be initialized.");
      setReady(true);
    });

    return () => {
      active = false;
      connector?.removeAllListeners();
      if (connectorRef.current === connector) connectorRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!accountId) {
      setBalance(null);
      setBalanceError("");
      return;
    }

    let active = true;
    setBalance(null);
    setBalanceLoading(true);
    setBalanceError("");
    fetch("/api/wallet/balance?accountId=" + encodeURIComponent(accountId), { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to load wallet balance.");
        return data as WalletBalance;
      })
      .then((data) => {
        if (active) setBalance(data);
      })
      .catch((cause: unknown) => {
        if (active) setBalanceError(cause instanceof Error ? cause.message : "Unable to load wallet balance.");
      })
      .finally(() => {
        if (active) setBalanceLoading(false);
      });

    return () => {
      active = false;
    };
  }, [accountId, balanceRefresh]);

  async function connect() {
    if (busy) return;
    const connector = connectorRef.current;
    if (!connector) {
      setError("Wallet connector is still loading. Try again.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      await connector.connect();
      const wallet = await connector.wallet();
      const accounts = await wallet.getAccounts();
      const account = accounts[0]?.accountId ?? "";
      if (!account) throw new Error("The wallet connected but did not return an account.");

      setAccountId(account);
      setMenuOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wallet connection was cancelled or failed.");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (busy) return;
    const connector = connectorRef.current;
    if (!connector) {
      setError("Wallet connector is not available.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      await connector.disconnect();
      setAccountId("");
      setBalance(null);
      setMenuOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to disconnect this wallet.");
    } finally {
      setBusy(false);
    }
  }

  const shortAccount = accountId.length > 20
    ? accountId.slice(0, 8) + "…" + accountId.slice(-6)
    : accountId;

  return (
    <div className="wallet-connect-area">
      <span className="wallet-network-label">NEAR TESTNET</span>
      {accountId ? (
        <>
          <button
            className="wallet-connect-button connected"
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-label="Show connected wallet details"
          >
            <span className="wallet-connected-dot" />
            <span>{shortAccount}</span>
            <span className="wallet-chevron">⌄</span>
          </button>
          {menuOpen && (
            <div className="wallet-connect-menu">
              <span className="wallet-menu-label">CONNECTED TESTNET ACCOUNT</span>
              <strong>{accountId}</strong>
              <div className="wallet-balance-panel">
                <div className="wallet-balance-heading">
                  <span>LIVE TESTNET BALANCE</span>
                  <button type="button" onClick={() => setBalanceRefresh((value) => value + 1)} disabled={balanceLoading}>
                    {balanceLoading ? "Updating…" : "Refresh"}
                  </button>
                </div>
                {balanceLoading && <small className="wallet-balance-muted">Reading balances from NEAR testnet…</small>}
                {balanceError && <small className="wallet-balance-error">{balanceError}</small>}
                {balance && (
                  <>
                    <div className="wallet-balance-row"><span>NEAR</span><strong>{balance.near}</strong></div>
                    {balance.tokens.map((token) => (
                      <div className="wallet-balance-row" key={token.symbol}><span>{token.symbol}</span><strong>{token.balance}</strong></div>
                    ))}
                    {!balance.tokens.length && (
                      <small className="wallet-balance-muted">No Tidepool test tokens found in this wallet yet.</small>
                    )}
                    <small className="wallet-balance-time">Updated {new Date(balance.updatedAt).toLocaleTimeString()}</small>
                  </>
                )}
                {!balanceLoading && !balance && !balanceError && <small className="wallet-balance-muted">Balance has not loaded yet.</small>}
                <a className="wallet-faucet-link" href="https://app.usetidepool.tech/faucet" target="_blank" rel="noreferrer">
                  Get free test tokens ↗
                </a>
              </div>
              <button type="button" onClick={disconnect} disabled={busy}>
                {busy ? "Disconnecting…" : "Disconnect wallet"}
              </button>
            </div>
          )}
        </>
      ) : (
        <button
          className="wallet-connect-button"
          type="button"
          onClick={connect}
          disabled={!ready || busy}
        >
          {busy ? "Connecting…" : ready ? "Connect Wallet" : "Loading wallet…"}
          <span aria-hidden="true">↗</span>
        </button>
      )}
      {error && <span className="wallet-connect-error" role="status">{error}</span>}
    </div>
  );
}
