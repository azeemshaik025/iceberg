import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { cancelDemo, claimDemo, createPlanDemo, isDevnetRpc } from "./devnet-writer.js";
import { fetchBatches, fetchPlan, fetchStatus, makeProvider, planCommitment } from "./iceberg.js";

const stored = (key, fallback) => localStorage.getItem(key) ?? fallback;

const formatAmount = (raw, decimals) => {
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const fraction = ((raw % divisor) * 10000n) / divisor;
  return `${whole}.${fraction.toString().padStart(4, "0")}`;
};

const randomSecret = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return "0x" + Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export default function App() {
  const [rpcUrl, setRpcUrl] = useState(() => stored("iceberg.rpc", "http://localhost:5050"));
  const [address, setAddress] = useState(() => stored("iceberg.address", ""));
  const [inDecimals, setInDecimals] = useState(() => stored("iceberg.inDec", "18"));
  const [outDecimals, setOutDecimals] = useState(() => stored("iceberg.outDec", "6"));
  const [secret, setSecret] = useState(() => stored("iceberg.secret", ""));
  const [status, setStatus] = useState(null);
  const [batches, setBatches] = useState([]);
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    localStorage.setItem("iceberg.rpc", rpcUrl);
    localStorage.setItem("iceberg.address", address);
    localStorage.setItem("iceberg.inDec", inDecimals);
    localStorage.setItem("iceberg.outDec", outDecimals);
    localStorage.setItem("iceberg.secret", secret);
  }, [rpcUrl, address, inDecimals, outDecimals, secret]);

  const provider = useMemo(() => makeProvider(rpcUrl), [rpcUrl]);
  const commitment = useMemo(() => {
    if (!secret) return null;
    try {
      return planCommitment(secret);
    } catch {
      return null;
    }
  }, [secret]);

  // Cursor for fetchBatches' incremental scan: which block to resume from.
  // Reset (below) only when provider/address change — not on every render,
  // and not when just the plan secret changes — so polling the same
  // contract never re-scans blocks it has already fetched.
  const nextFromBlockRef = useRef(0);

  useEffect(() => {
    nextFromBlockRef.current = 0;
    setBatches([]);
  }, [provider, address]);

  const refresh = useCallback(async () => {
    if (!address) return;
    try {
      const [nextStatus, { newBatches, nextFromBlock }] = await Promise.all([
        fetchStatus(provider, address),
        fetchBatches(provider, address, nextFromBlockRef.current),
      ]);
      nextFromBlockRef.current = nextFromBlock;
      setStatus(nextStatus);
      if (newBatches.length > 0) {
        setBatches((prev) => [...newBatches.reverse(), ...prev]);
      }
      setPlan(commitment ? await fetchPlan(provider, address, commitment) : null);
      setError("");
    } catch (refreshError) {
      setError(String(refreshError.message ?? refreshError));
    }
  }, [provider, address, commitment]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const [chunkInput, setChunkInput] = useState("50");
  const [chunksInput, setChunksInput] = useState("4");
  const [busy, setBusy] = useState(false);
  const [actionResult, setActionResult] = useState("");
  const demoMode = isDevnetRpc(rpcUrl);

  const runAction = async (label, action) => {
    setBusy(true);
    setActionResult(`${label}…`);
    try {
      const txHash = await action();
      setActionResult(`${label} ✓ ${txHash.slice(0, 12)}…`);
      await refresh();
    } catch (actionError) {
      setActionResult(`${label} failed: ${String(actionError.message ?? actionError)}`);
    } finally {
      setBusy(false);
    }
  };

  const onCreate = () =>
    runAction("create", () =>
      createPlanDemo({
        rpcUrl,
        icebergAddress: address,
        chunkAmount: BigInt(Math.round(Number(chunkInput) * 100)) *
          10n ** (BigInt(inDecimals) - 2n),
        numChunks: Number(chunksInput),
        secret,
      }),
    );
  const onClaim = () => runAction("claim", () => claimDemo({ rpcUrl, icebergAddress: address, secret }));
  const onCancel = () =>
    runAction("cancel", () => cancelDemo({ rpcUrl, icebergAddress: address, secret }));

  const executedChunks = (currentPlan) => {
    if (!status || !currentPlan?.exists) return 0n;
    const lastExecuted = status.nextInterval - 1n;
    if (status.nextInterval <= currentPlan.startInterval) return 0n;
    if (lastExecuted >= currentPlan.endInterval)
      return currentPlan.endInterval - currentPlan.startInterval + 1n;
    return lastExecuted - currentPlan.startInterval + 1n;
  };

  return (
    <div className="page">
      <header>
        <h1>🧊 Iceberg</h1>
        <p className="tag">
          Private accumulation on Starknet — scheduled buying nobody can attribute, powered by the
          STRK20 shielded pool.
        </p>
      </header>

      <section className="config">
        <label>
          RPC URL
          <input value={rpcUrl} onChange={(event) => setRpcUrl(event.target.value)} />
        </label>
        <label>
          Iceberg contract
          <input
            placeholder="0x…"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
        <label className="narrow">
          In decimals
          <input value={inDecimals} onChange={(event) => setInDecimals(event.target.value)} />
        </label>
        <label className="narrow">
          Out decimals
          <input value={outDecimals} onChange={(event) => setOutDecimals(event.target.value)} />
        </label>
      </section>

      {error && <div className="error">{error}</div>}

      {status && (
        <section className="statusbar">
          <span>
            interval <b>{String(status.currentInterval)}</b>
          </span>
          <span>
            next to execute <b>{String(status.nextInterval)}</b>
          </span>
          <span>
            active batch size <b>{formatAmount(status.chunkRate, Number(inDecimals))}</b> / interval
          </span>
        </section>
      )}

      <main className="split">
        <section className="panel chain">
          <h2>👁 What the chain sees</h2>
          <p className="hint">
            The complete public record: anonymous aggregate swaps. No addresses, no owners, no
            schedules.
          </p>
          {batches.length === 0 && <p className="empty">No batches executed yet.</p>}
          {batches.map((batch) => (
            <div className="batch" key={String(batch.interval)}>
              <span className="interval">#{String(batch.interval)}</span>
              <span>
                {formatAmount(batch.inAmount, Number(inDecimals))} →{" "}
                <b>{formatAmount(batch.outAmount, Number(outDecimals))}</b>
              </span>
              <span className="mono">{batch.txHash.slice(0, 10)}…</span>
            </div>
          ))}
        </section>

        <section className="panel you">
          <h2>🔑 What only you see</h2>
          <p className="hint">
            Your plan secret stays in this browser. On-chain it is only a Poseidon commitment.
          </p>
          <div className="secretrow">
            <input
              placeholder="plan secret (text or 0x felt)"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
            <button onClick={() => setSecret(randomSecret())}>new</button>
          </div>
          {commitment && (
            <p className="mono commitment">commitment: {commitment.slice(0, 22)}…</p>
          )}
          {plan?.exists ? (
            <div className="plandetail">
              <div>
                <span>chunk</span>
                <b>{formatAmount(plan.chunkAmount, Number(inDecimals))}</b>
              </div>
              <div>
                <span>window</span>
                <b>
                  intervals {String(plan.startInterval)}–{String(plan.endInterval)}
                </b>
              </div>
              <div>
                <span>progress</span>
                <b>
                  {String(executedChunks(plan))} /{" "}
                  {String(plan.endInterval - plan.startInterval + 1n)} chunks
                </b>
              </div>
              <div>
                <span>accrued</span>
                <b>{formatAmount(plan.accruedOut, Number(outDecimals))}</b>
              </div>
              <div>
                <span>claimed</span>
                <b>{formatAmount(plan.claimedOut, Number(outDecimals))}</b>
              </div>
            </div>
          ) : (
            commitment && <p className="empty">No plan found for this secret.</p>
          )}
          <div className="actions">
            <h3>Act on this plan</h3>
            {demoMode ? (
              <>
                <div className="actionrow">
                  <label>
                    chunk
                    <input value={chunkInput} onChange={(event) => setChunkInput(event.target.value)} />
                  </label>
                  <label>
                    chunks
                    <input
                      value={chunksInput}
                      onChange={(event) => setChunksInput(event.target.value)}
                    />
                  </label>
                  <button disabled={busy || !secret} onClick={onCreate}>
                    create plan
                  </button>
                </div>
                <div className="actionrow">
                  <button disabled={busy || !plan?.exists} onClick={onClaim}>
                    claim accrued
                  </button>
                  <button disabled={busy || !plan?.exists} onClick={onCancel}>
                    cancel &amp; refund
                  </button>
                </div>
                <p className="modeline">
                  devnet demo mode — the prefunded account stands in for the STRK20 pool
                </p>
              </>
            ) : (
              <p className="modeline">
                pool mode: flows implemented, waiting on StarkWare's mainnet proving/discovery
                endpoints (strk20-hackathon issue #31)
              </p>
            )}
            {actionResult && <p className="mono">{actionResult}</p>}
          </div>
          <p className="footnote">
            Plans are created and claimed through the STRK20 privacy pool, so no wallet address ever
            touches this contract.
          </p>
        </section>
      </main>
    </div>
  );
}
