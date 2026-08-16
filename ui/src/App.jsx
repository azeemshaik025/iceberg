import React, { useCallback, useEffect, useMemo, useState } from "react";
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

  const refresh = useCallback(async () => {
    if (!address) return;
    try {
      const [nextStatus, nextBatches] = await Promise.all([
        fetchStatus(provider, address),
        fetchBatches(provider, address),
      ]);
      setStatus(nextStatus);
      setBatches(nextBatches.reverse());
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
      <style>{CSS}</style>
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
          <p className="footnote">
            Plans are created and claimed through the STRK20 privacy pool, so no wallet address ever
            touches this contract.
          </p>
        </section>
      </main>
    </div>
  );
}

const CSS = `
* { box-sizing: border-box; margin: 0; }
body { background: #0b1020; color: #dfe7ff; font: 15px/1.5 -apple-system, "Segoe UI", sans-serif; }
.page { max-width: 1060px; margin: 0 auto; padding: 28px 20px 60px; }
header h1 { font-size: 30px; letter-spacing: 0.5px; }
.tag { color: #8fa3d0; margin-top: 6px; }
.config { display: flex; gap: 12px; flex-wrap: wrap; margin: 22px 0 10px; }
.config label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #8fa3d0; flex: 1 1 260px; }
.config label.narrow { flex: 0 1 110px; }
input { background: #141b33; border: 1px solid #26304f; color: #dfe7ff; border-radius: 8px; padding: 8px 10px; font-size: 14px; }
button { background: #2b57ff; border: 0; color: white; border-radius: 8px; padding: 8px 14px; cursor: pointer; }
.error { background: #3a1b26; border: 1px solid #7c2f47; padding: 8px 12px; border-radius: 8px; margin: 8px 0; font-size: 13px; }
.statusbar { display: flex; gap: 26px; background: #121936; border-radius: 10px; padding: 10px 16px; margin: 12px 0 20px; color: #9db1e0; font-size: 14px; }
.statusbar b { color: #ffffff; }
.split { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
@media (max-width: 800px) { .split { grid-template-columns: 1fr; } }
.panel { background: #10172e; border: 1px solid #1e2947; border-radius: 14px; padding: 18px; }
.panel h2 { font-size: 17px; margin-bottom: 6px; }
.hint { color: #7d90bd; font-size: 13px; margin-bottom: 14px; }
.empty { color: #5d6f99; font-style: italic; }
.batch { display: flex; justify-content: space-between; gap: 10px; padding: 8px 10px; background: #151d3a; border-radius: 8px; margin-bottom: 6px; font-size: 14px; }
.batch .interval { color: #6ee7ff; }
.mono { font-family: ui-monospace, monospace; font-size: 12px; color: #7d90bd; }
.secretrow { display: flex; gap: 8px; }
.secretrow input { flex: 1; }
.commitment { margin: 10px 0; }
.plandetail { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.plandetail div { display: flex; justify-content: space-between; background: #151d3a; padding: 8px 12px; border-radius: 8px; }
.plandetail span { color: #8fa3d0; }
.footnote { margin-top: 16px; font-size: 12px; color: #5d6f99; }
`;
