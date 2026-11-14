"use client";

import { useEffect, useRef, useState } from "react";
import type { NearConnector as NearConnectorType } from "@hot-labs/near-connect";

type WalletBalance = {
  near: string;
  nearRaw: string;
  wrapNear: { balance: string; rawBalance: string; contractId: string };
  wrapRegistered: boolean;
  tokens: { symbol: string; balance: string; decimals: number }[];
  updatedAt: string;
};

const WRAP_CONTRACT_ID = "wrap.testnet";
const WRAP_AMOUNT_RAW = "20000000000000000000000"; // exactly 0.02 NEAR
const STORAGE_DEPOSIT_RAW = "1250000000000000000000"; // 0.00125 NEAR
const FUNCTION_CALL_GAS = "30000000000000"; // 30 Tgas

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
  const [wrapBusy, setWrapBusy] = useState(false);
  const [wrapMessage, setWrapMessage] = useState("");
  const [wrapError, setWrapError] = useState("");

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

  async function wrapNear() {
    if (!accountId || wrapBusy) return;
    const connector = connectorRef.current;
    if (!connector) {
      setWrapError("Wallet connector is unavailable. Reconnect your wallet and try again.");
      return;
    }
    if (!balance) {
      setWrapError("Load your wallet balance before wrapping.");
      return;
    }
    if (balance.wrapRegistered !== true && balance.wrapRegistered !== false) {
      setWrapError("Could not verify wNEAR registration. Refresh your balance before continuing.");
      return;
    }

    const minimumReserve = 30000000000000000000000n; // keep at least 0.03 NEAR after attached deposits
    const totalAttached = BigInt(WRAP_AMOUNT_RAW) + (balance.wrapRegistered ? 0n : BigInt(STORAGE_DEPOSIT_RAW));
    const liquidBalance = BigInt(balance.nearRaw);
    if (liquidBalance < totalAttached + minimumReserve) {
      setWrapError("Your testnet balance is too low to wrap 0.02 NEAR while keeping a 0.03 NEAR safety reserve for gas.");
      return;
    }

    setWrapBusy(true);
    setWrapMessage("");
    setWrapError("");
    try {
      const wallet = await connector.wallet();
      const actions: Array<{
        type: "FunctionCall";
        params: {
          methodName: string;
          args: Record<string, unknown>;
          gas: string;
          deposit: string;
        };
      }> = [];

      // Register once before minting wNEAR. The storage deposit is refundable
      // according to the contract's storage rules, but it is still attached value.
      if (!balance.wrapRegistered) {
        actions.push({
          type: "FunctionCall",
          params: {
            methodName: "storage_deposit",
            args: { account_id: accountId, registration_only: true },
            gas: FUNCTION_CALL_GAS,
            deposit: STORAGE_DEPOSIT_RAW,
          },
        });
      }

      actions.push({
        type: "FunctionCall",
        params: {
          methodName: "near_deposit",
          args: {},
          gas: FUNCTION_CALL_GAS,
          deposit: WRAP_AMOUNT_RAW,
        },
      });

      const result = await wallet.signAndSendTransaction({
        receiverId: WRAP_CONTRACT_ID,
        actions,
      });

      const outcome = result as { status?: { Failure?: unknown }; transaction?: { hash?: string }; transaction_outcome?: { id?: string } } | undefined;
      if (outcome?.status?.Failure) {
        throw new Error("The testnet wrapper transaction failed: " + JSON.stringify(outcome.status.Failure));
      }

      setWrapMessage("Wallet approved the transaction. Checking the wNEAR balance on-chain…");
      // Do not report success until RPC confirms that the wNEAR balance increased.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        const response = await fetch("/api/wallet/balance?accountId=" + encodeURIComponent(accountId), { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Transaction was submitted, but the balance check failed.");
        const updated = data as WalletBalance;
        setBalance(updated);
        const expected = BigInt(balance.wrapNear.rawBalance) + BigInt(WRAP_AMOUNT_RAW);
        if (BigInt(updated.wrapNear.rawBalance) >= expected) {
          setWrapMessage("Verified on NEAR testnet: 0.02 wNEAR received in your wallet.");
          setWrapError("");
          return;
        }
      }

      setWrapMessage("The wallet returned, but the new wNEAR balance is not visible yet. Refresh the balance or check your wallet transaction history before retrying.");
    } catch (cause) {
      setWrapError(cause instanceof Error ? cause.message : "The wrapping transaction was cancelled or failed.");
    } finally {
      setWrapBusy(false);
      setBalanceRefresh((value) => value + 1);
    }
  }

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
                    <div className="wallet-balance-row"><span>wNEAR · wrap.testnet</span><strong>{balance.wrapNear.balance}</strong></div>
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
                <div className="wallet-wrap-action">
                  <div className="wallet-wrap-note">
                    Wrap exactly <strong>0.02 NEAR</strong> into wNEAR on <strong>wrap.testnet</strong>.
                    {balance?.wrapRegistered === false ? " First-time storage registration also attaches 0.00125 NEAR." : ""}
                    Network gas is separate. Review every amount in your wallet before approving.
                  </div>
                  <button type="button" className="wallet-wrap-button" onClick={wrapNear} disabled={wrapBusy || balanceLoading || !balance || balance.wrapRegistered === null}>
                    {wrapBusy ? "Waiting for wallet / confirming…" : "Wrap 0.02 NEAR → wNEAR"}
                  </button>
                  {wrapMessage && <small className="wallet-wrap-success" role="status">{wrapMessage}</small>}
                  {wrapError && <small className="wallet-wrap-error" role="alert">{wrapError}</small>}
                </div>
                <a className="wallet-faucet-link" href="https://app.usetidepool.tech/faucet" target="_blank" rel="noreferrer">
                  Get free Tidepool test tokens ↗
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
