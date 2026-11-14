"use client";

import { useEffect, useRef, useState } from "react";
import type { NearConnector as NearConnectorType } from "@hot-labs/near-connect";

type WalletBalance = {
  near: string;
  nearRaw: string;
  wrapNear: { balance: string; rawBalance: string; contractId: string };
  wrapRegistered: boolean;
  refWbtc: { contractId: string; balance: string; rawBalance: string; decimals: number; registered: boolean; storageMinimum: string } | null;
  refUsdt: { contractId: string; balance: string; rawBalance: string; decimals: number; registered: boolean; storageMinimum: string } | null;
  tokens: { symbol: string; contractId: string; balance: string; rawBalance: string; decimals: number }[];
  updatedAt: string;
};

const WRAP_CONTRACT_ID = "wrap.testnet";
const WRAP_RESERVE_RAW = 500000000000000000000000n; // keep 0.5 NEAR liquid for gas
const STORAGE_DEPOSIT_RAW = "1250000000000000000000"; // 0.00125 NEAR

function parseNearToYocto(value: string): bigint {
  const amount = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,24})?$/.test(amount)) {
    throw new Error("Enter a valid NEAR amount with up to 24 decimal places.");
  }
  const [whole, fraction = ""] = amount.split(".");
  const raw = BigInt(whole) * 10n ** 24n + BigInt((fraction + "0".repeat(24)).slice(0, 24));
  if (raw <= 0n) throw new Error("The amount must be greater than zero.");
  return raw;
}

function formatNearAmount(raw: bigint): string {
  const whole = raw / 10n ** 24n;
  const fraction = (raw % (10n ** 24n)).toString().padStart(24, "0").replace(/0+$/, "");
  return fraction ? whole.toString() + "." + fraction : whole.toString();
}
const FUNCTION_CALL_GAS = "30000000000000"; // 30 Tgas

type RefSwapExecutionPayload = {
  accountId: string;
  amountIn: string;
  minimumOut: string;
  poolId: string;
  protocol?: "ref-v1" | "ref-dcl-v2";
  inputRegistered: boolean;
  outputRegistered: boolean;
  outputStorageMinimum: string;
  outputContractId: string;
  outputSymbol: string;
};

type SwapExecutionPayload = {
  liveQuote: {
    correlationId?: string;
    quote?: { depositAddress?: string; amountIn?: string; deadline?: string };
  };
  originAsset: { assetId: string; contractAddress: string; symbol: string };
  destinationAsset: { assetId: string; contractAddress: string; symbol: string };
  recipient: string;
  refundTo: string;
};

function publishSwapUpdate(status: string, message: string, extra: Record<string, unknown> = {}) {
  window.dispatchEvent(new CustomEvent("meridian:swap-update", {
    detail: { status, message, ...extra },
  }));
}

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
  const [wrapAmount, setWrapAmount] = useState("");
  const [wrapMessage, setWrapMessage] = useState("");
  const [wrapError, setWrapError] = useState("");
  const [swapBusy, setSwapBusy] = useState(false);
  const [refSwapBusy, setRefSwapBusy] = useState(false);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("meridian:wallet-account", { detail: { accountId } }));
  }, [accountId]);

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

  useEffect(() => {
    async function handleRefSwap(event: Event) {
      const payload = (event as CustomEvent<RefSwapExecutionPayload>).detail;
      if (!payload || refSwapBusy) return;

      try {
        if (!accountId || !connectorRef.current) throw new Error("Connect your NEAR testnet wallet before swapping.");
        if (payload.accountId !== accountId) throw new Error("The route account does not match the connected wallet.");
        const swapProtocol = payload.protocol || "ref-dcl-v2";
        if (swapProtocol === "ref-v1") {
          if (!/^\d{1,12}$/.test(payload.poolId)) {
            throw new Error("The Ref Finance classic pool ID is invalid.");
          }
        } else if (payload.poolId !== "usdt.fakes.testnet|wrap.testnet|2000") {
          throw new Error("The Ref Finance DCL pool ID is not the verified wNEAR/USDT.e testnet route.");
        }
        if (payload.outputContractId !== "usdt.fakes.testnet" || payload.outputSymbol !== "USDT.e") {
          throw new Error("The Ref Finance output token is not the verified USDT.e testnet asset.");
        }
        if (!/^\d+$/.test(payload.amountIn) || !/^\d+$/.test(payload.minimumOut) ||
            !/^\d+$/.test(payload.outputStorageMinimum)) {
          throw new Error("The swap quote contained an invalid token amount.");
        }
        if (BigInt(payload.amountIn) > 3000000000000000000000000n) {
          throw new Error("This test swap is capped at 3 wNEAR.");
        }
        if (payload.inputRegistered !== true || balance?.wrapRegistered !== true) {
          throw new Error("Your wallet is not registered for wrap.testnet wNEAR. Refresh the wallet and try again.");
        }
        if (!balance || BigInt(balance.wrapNear.rawBalance) < BigInt(payload.amountIn)) {
          throw new Error("Your wrap.testnet wNEAR balance is lower than the quoted input amount.");
        }
        if (BigInt(balance.nearRaw) < BigInt(payload.outputStorageMinimum) + 10000000000000000000000n) {
          throw new Error("Keep enough native NEAR for USDT.e storage registration and transaction gas.");
        }
        if (!balance.refUsdt) throw new Error("Ref Finance USDT.e balance could not be read. Refresh your wallet and try again.");
        if (payload.outputRegistered !== balance.refUsdt.registered) {
          throw new Error("Your USDT.e registration status changed. Refresh your wallet and request a new quote.");
        }

        setRefSwapBusy(true);
        const wallet = await connectorRef.current.wallet();

        if (!payload.outputRegistered) {
          publishSwapUpdate("REGISTERING_OUTPUT", "Your wallet will first register the USDT.e token account. This is a separate one-time storage deposit.");
          const registration = await wallet.signAndSendTransaction({
            receiverId: payload.outputContractId,
            actions: [{
              type: "FunctionCall" as const,
              params: {
                methodName: "storage_deposit",
                args: { account_id: accountId, registration_only: true },
                gas: FUNCTION_CALL_GAS,
                deposit: payload.outputStorageMinimum,
              },
            }],
          });
          const registrationResult = registration as unknown as { status?: { Failure?: unknown } } | undefined;
          if (registrationResult?.status?.Failure) throw new Error("USDT.e storage registration failed: " + JSON.stringify(registrationResult.status.Failure));
        }

        publishSwapUpdate("AWAITING_WALLET", "Review the Ref Finance " + (swapProtocol === "ref-v1" ? "classic pool" : "DCL") + " swap. It sends only the exact quoted wNEAR amount from wrap.testnet.");
        const swapMessage = swapProtocol === "ref-v1"
          ? JSON.stringify({
              force: 0,
              actions: [{
                pool_id: Number(payload.poolId),
                token_in: "wrap.testnet",
                token_out: payload.outputContractId,
                amount_in: payload.amountIn,
                min_amount_out: payload.minimumOut,
              }],
            })
          : JSON.stringify({
              Swap: {
                pool_ids: [payload.poolId],
                output_token: payload.outputContractId,
                min_output_amount: payload.minimumOut,
                referral_id: "",
                client_id: "",
              },
            });
        const swapResult = await wallet.signAndSendTransaction({
          receiverId: "wrap.testnet",
          actions: [{
            type: "FunctionCall" as const,
            params: {
              methodName: "ft_transfer_call",
              args: {
                receiver_id: swapProtocol === "ref-v1" ? "ref-finance-101.testnet" : "dclv2.ref-dev.testnet",
                amount: payload.amountIn,
                msg: swapMessage,
              },
              gas: swapProtocol === "ref-v1" ? "300000000000000" : "180000000000000",
              deposit: "1",
            },
          }],
        });
        const outcome = swapResult as unknown as {
          status?: { Failure?: unknown };
          transaction?: { hash?: string };
          transaction_outcome?: { id?: string };
        } | undefined;
        const nestedFailure = (outcome as any)?.transaction_outcome?.outcome?.status?.Failure ||
          (outcome as any)?.status?.Failure ||
          (outcome as any)?.transaction?.outcome?.status?.Failure;
        if (nestedFailure) throw new Error("Ref Finance swap transaction failed: " + JSON.stringify(nestedFailure));

        const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id || "";
        publishSwapUpdate("SUBMITTED", "The Ref Finance swap was submitted. Waiting for the USDT.e balance to update.", { txHash, protocol: swapProtocol });
        for (let attempt = 0; attempt < 12; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 2000));
          const response = await fetch("/api/wallet/balance?accountId=" + encodeURIComponent(accountId), { cache: "no-store" });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Could not verify the USDT.e payout.");
          const updated = data as WalletBalance;
          setBalance(updated);
          if (updated.refUsdt && balance.refUsdt && BigInt(updated.refUsdt.rawBalance) > BigInt(balance.refUsdt.rawBalance)) {
            publishSwapUpdate("SUCCESS", "Ref Finance confirmed the swap: USDT.e balance increased.", {
              txHash, receivedRaw: (BigInt(updated.refUsdt.rawBalance) - BigInt(balance.refUsdt.rawBalance)).toString(),
            });
            setBalanceRefresh((value) => value + 1);
            return;
          }
        }
        publishSwapUpdate("PENDING", "The transaction was submitted but the USDT.e balance increase is not confirmed yet. Do not send it again. Check the transaction and refresh your wallet before retrying.", { txHash });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : JSON.stringify(cause) || "The Ref Finance swap failed or was cancelled.";
        publishSwapUpdate("ERROR", message);
      } finally {
        setRefSwapBusy(false);
      }
    }

    window.addEventListener("meridian:execute-ref-swap", handleRefSwap);
    return () => window.removeEventListener("meridian:execute-ref-swap", handleRefSwap);
  }, [accountId, balance, refSwapBusy]);

  useEffect(() => {
    async function handleSwap(event: Event) {
      const payload = (event as CustomEvent<SwapExecutionPayload>).detail;
      if (!payload || swapBusy) return;

      const depositAddress = payload.liveQuote?.quote?.depositAddress || "";
      const amountIn = payload.liveQuote?.quote?.amountIn || "";
      const deadline = payload.liveQuote?.quote?.deadline || "";
      const originContract = payload.originAsset?.contractAddress || "";
      const destinationContract = payload.destinationAsset?.contractAddress || "";

      try {
        if (!accountId || !connectorRef.current) throw new Error("Connect your NEAR testnet wallet before executing the swap.");
        if (payload.recipient !== accountId || payload.refundTo !== accountId) {
          throw new Error("The recipient and refund addresses must both match your connected wallet.");
        }
        if (!/^[0-9a-f]{64}$/i.test(depositAddress) || !/^\\d+$/.test(amountIn)) {
          throw new Error("The live quote is missing a valid deposit address or exact input amount.");
        }
        if (!originContract || !destinationContract || payload.originAsset.assetId === payload.destinationAsset.assetId) {
          throw new Error("The selected token contracts are not valid for this testnet swap.");
        }
        if (deadline && Date.parse(deadline) <= Date.now() + 15000) {
          throw new Error("This quote is expired or too close to expiry. Request a fresh quote.");
        }
        if (!balance) throw new Error("Wallet balances are not loaded. Refresh your wallet balance and try again.");

        const source = balance.tokens.find((token) => token.contractId === originContract);
        const destination = balance.tokens.find((token) => token.contractId === destinationContract);
        if (!source || BigInt(source.rawBalance) < BigInt(amountIn)) {
          throw new Error("Your wallet does not have enough Tidepool " + payload.originAsset.symbol + ". The wNEAR on wrap.testnet is a different token. Claim Tidepool wallet-mode test tokens first.");
        }
        if (!destination) {
          throw new Error("Your wallet is not yet registered for Tidepool " + payload.destinationAsset.symbol + ". Claim the Tidepool faucet in wallet mode so the destination token is registered before swapping.");
        }

        const minimumReserve = 20000000000000000000000n; // keep at least 0.02 NEAR for gas
        const storageDeposit = 1250000000000000000000n; // Tidepool NEP-141 registration deposit
        if (BigInt(balance.nearRaw) < minimumReserve + storageDeposit) {
          throw new Error("Keep at least 0.02 NEAR plus the 0.00125 NEAR deposit-account registration amount in your wallet for this testnet swap.");
        }

        setSwapBusy(true);
        publishSwapUpdate("AWAITING_WALLET", "Review the wallet request. It registers the Tidepool deposit account and transfers the exact quoted amount of " + payload.originAsset.symbol + " to the quote deposit address.");
        const wallet = await connectorRef.current.wallet();
        const actions = [
          {
            type: "FunctionCall" as const,
            params: {
              methodName: "storage_deposit",
              args: { account_id: depositAddress, registration_only: true },
              gas: FUNCTION_CALL_GAS,
              deposit: storageDeposit.toString(),
            },
          },
          {
            type: "FunctionCall" as const,
            params: {
              methodName: "ft_transfer",
              args: { receiver_id: depositAddress, amount: amountIn, memo: "MERIDIAN DCA first purchase" },
              gas: FUNCTION_CALL_GAS,
              deposit: "1",
            },
          },
        ];

        const result = await wallet.signAndSendTransaction({ receiverId: originContract, actions });
        const outcome = result as unknown as {
          status?: { Failure?: unknown };
          transaction?: { hash?: string };
          transaction_outcome?: { id?: string };
        } | undefined;
        if (outcome?.status?.Failure) {
          throw new Error("The token deposit transaction failed: " + JSON.stringify(outcome.status.Failure));
        }

        const txHash = outcome?.transaction?.hash || outcome?.transaction_outcome?.id || "";
        publishSwapUpdate("DEPOSIT_SUBMITTED", "Wallet submitted the testnet deposit. MERIDIAN is checking the swap settlement.", { txHash, depositAddress });

        if (txHash) {
          await fetch("/api/swap/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ depositAddress, txHash }),
          }).catch(() => null);
        }

        for (let attempt = 0; attempt < 24; attempt += 1) {
          const response = await fetch("/api/swap/status?depositAddress=" + encodeURIComponent(depositAddress), { cache: "no-store" });
          const statusData = await response.json();
          if (!response.ok) throw new Error(statusData.error || "Could not retrieve Tidepool swap status.");
          const status = typeof statusData.status === "string" ? statusData.status : "PROCESSING";
          publishSwapUpdate(status, "Tidepool swap status: " + status.replaceAll("_", " ").toLowerCase() + ".", {
            txHash,
            depositAddress,
            correlationId: payload.liveQuote.correlationId,
            statusData,
          });
          if (status === "SUCCESS") {
            publishSwapUpdate("SUCCESS", "Swap confirmed by Tidepool. Your " + payload.destinationAsset.symbol + " payout has completed.", {
              txHash, depositAddress, correlationId: payload.liveQuote.correlationId, statusData,
            });
            setBalanceRefresh((value) => value + 1);
            return;
          }
          if (["REFUNDED", "FAILED", "EXPIRED", "INCOMPLETE_DEPOSIT", "REFUNDING_FAILED"].includes(status)) {
            throw new Error("Tidepool ended the swap with status " + status + ". Check the transaction details before trying again.");
          }
          await new Promise((resolve) => window.setTimeout(resolve, 2500));
        }
        publishSwapUpdate("PENDING", "The deposit was sent, but settlement is still pending. Do not send it again. Check the swap status before retrying.", {
          txHash, depositAddress, correlationId: payload.liveQuote.correlationId,
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "The testnet swap was cancelled or failed.";
        publishSwapUpdate("ERROR", message);
      } finally {
        setSwapBusy(false);
      }
    }

    window.addEventListener("meridian:execute-swap", handleSwap);
    return () => window.removeEventListener("meridian:execute-swap", handleSwap);
  }, [accountId, balance, swapBusy]);

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

    let wrapAmountRaw: bigint;
    try {
      wrapAmountRaw = parseNearToYocto(wrapAmount);
    } catch (error) {
      setWrapError(error instanceof Error ? error.message : "Enter a valid NEAR amount.");
      return;
    }
    const totalAttached = wrapAmountRaw + (balance.wrapRegistered ? 0n : BigInt(STORAGE_DEPOSIT_RAW));
    const liquidBalance = BigInt(balance.nearRaw);
    if (liquidBalance < totalAttached + WRAP_RESERVE_RAW) {
      setWrapError("Not enough liquid NEAR. This action keeps at least 0.5 NEAR in your wallet for gas and future transactions.");
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
          deposit: wrapAmountRaw.toString(),
        },
      });

      const result = await wallet.signAndSendTransaction({
        receiverId: WRAP_CONTRACT_ID,
        actions,
      });

      const outcome = result as unknown as { status?: { Failure?: unknown }; transaction?: { hash?: string }; transaction_outcome?: { id?: string } } | undefined;
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
        const expected = BigInt(balance.wrapNear.rawBalance) + wrapAmountRaw;
        if (BigInt(updated.wrapNear.rawBalance) >= expected) {
          setWrapMessage("Verified on NEAR testnet: " + formatNearAmount(wrapAmountRaw) + " wNEAR received in your wallet.");
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
                    {balance.refUsdt ? (
                      <>
                        <div className="wallet-balance-row"><span>USDT.e · Ref Finance testnet</span><strong>{balance.refUsdt.balance}</strong></div>
                        <small className="wallet-balance-muted">USDT.e account {balance.refUsdt.registered ? "registered" : "not registered yet"} · registration is required before receiving USDT.e.</small>
                      </>
                    ) : <small className="wallet-balance-muted">Ref Finance USDT.e balance is not available right now.</small>}
                    {balance.wrapNear.balance !== "0" && <small className="wallet-balance-muted">This is wrapper wNEAR for the Ref Finance first-buy route. It is different from Tidepool's separate wNEAR test asset.</small>}
                    {balance.tokens.map((token) => (
                      <div className="wallet-balance-row" key={token.contractId}><span>{token.symbol} · Tidepool</span><strong>{token.balance}</strong></div>
                    ))}
                    {!balance.tokens.length && (
                      <small className="wallet-balance-muted">No Tidepool test tokens found in this wallet yet.</small>
                    )}
                    <small className="wallet-balance-time">Updated {new Date(balance.updatedAt).toLocaleTimeString()}</small>
                  </>
                )}
                {!balanceLoading && !balance && !balanceError && <small className="wallet-balance-muted">Balance has not loaded yet.</small>}
                <div className="wallet-wrap-action">
                  <label className="wallet-wrap-label" htmlFor="wallet-wrap-amount">NEAR TO WRAP</label>
                  <input
                    id="wallet-wrap-amount"
                    className="wallet-wrap-input"
                    type="number"
                    inputMode="decimal"
                    min="0.000000000000000000000001"
                    step="0.01"
                    value={wrapAmount}
                    onChange={(event) => { setWrapAmount(event.target.value); setWrapError(""); setWrapMessage(""); }}
                    disabled={wrapBusy}
                  />
                  <div className="wallet-wrap-note">
                    Enter any amount of NEAR to convert into wNEAR on <strong>wrap.testnet</strong>. At least <strong>0.5 NEAR</strong> stays liquid for gas.
                    {balance?.wrapRegistered === false ? " First-time storage registration also attaches 0.00125 NEAR." : ""}
                    The wallet will show the exact amount for your approval.
                  </div>
                  <button type="button" className="wallet-wrap-button" onClick={wrapNear} disabled={wrapBusy || balanceLoading || !balance || balance.wrapRegistered === null || !wrapAmount.trim()}>
                    {wrapBusy ? "Waiting for wallet / confirming…" : "Wrap " + (wrapAmount.trim() || "—") + " NEAR → wNEAR"}
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
