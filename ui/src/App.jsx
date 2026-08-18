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

const GLYPHS = "0123456789ABCDEF#·—/";
const TIMELINE_SPAN = 8;

/// Replaces not-yet-revealed characters with random glyphs. Separators are kept
/// so the shape of the value stays readable while it resolves.
const scramble = (text, reveal) => {
  const keep = Math.floor(text.length * reveal);
  let out = "";
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (index < keep || character === " " || character === "/" || character === "–") out += character;
    else out += GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
  }
  return out;
};

const maskValue = (text) => text.replace(/[^ /–]/g, "▪");

export default function App() {
  const [rpcUrl, setRpcUrl] = useState(() => stored("iceberg.rpc", "http://localhost:5050"));
  const [address, setAddress] = useState(() => stored("iceberg.address", ""));
  const [inDecimals, setInDecimals] = useState(() => stored("iceberg.inDec", "18"));
  const [outDecimals, setOutDecimals] = useState(() => stored("iceberg.outDec", "6"));
  const [inSymbol, setInSymbol] = useState(() => stored("iceberg.inSym", "USDC"));
  const [outSymbol, setOutSymbol] = useState(() => stored("iceberg.outSym", "ETH"));
  const [secret, setSecret] = useState(() => stored("iceberg.secret", ""));
  const [status, setStatus] = useState(null);
  const [batches, setBatches] = useState([]);
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem("iceberg.rpc", rpcUrl);
    localStorage.setItem("iceberg.address", address);
    localStorage.setItem("iceberg.inDec", inDecimals);
    localStorage.setItem("iceberg.outDec", outDecimals);
    localStorage.setItem("iceberg.inSym", inSymbol);
    localStorage.setItem("iceberg.outSym", outSymbol);
    localStorage.setItem("iceberg.secret", secret);
  }, [rpcUrl, address, inDecimals, outDecimals, inSymbol, outSymbol, secret]);

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
  // Bumped on every reset. A refresh that started before the bump is reading a
  // different contract, so it must not commit: prepending its batches would mix
  // two contracts' feeds, and its cursor would skip blocks on the new one.
  const feedGenerationRef = useRef(0);

  useEffect(() => {
    feedGenerationRef.current += 1;
    nextFromBlockRef.current = 0;
    setBatches([]);
  }, [provider, address]);

  const refresh = useCallback(async () => {
    if (!address) return;
    const generation = feedGenerationRef.current;
    try {
      const [nextStatus, { newBatches, nextFromBlock }] = await Promise.all([
        fetchStatus(provider, address),
        fetchBatches(provider, address, nextFromBlockRef.current),
      ]);
      const nextPlan = commitment ? await fetchPlan(provider, address, commitment) : null;
      if (generation !== feedGenerationRef.current) return;
      nextFromBlockRef.current = nextFromBlock;
      setStatus(nextStatus);
      if (newBatches.length > 0) {
        setBatches((prev) => [...newBatches.reverse(), ...prev]);
      }
      setPlan(nextPlan);
      setError("");
    } catch (refreshError) {
      if (generation !== feedGenerationRef.current) return;
      setError(String(refreshError.message ?? refreshError));
    }
  }, [provider, address, commitment]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const [chunkInput, setChunkInput] = useState("100");
  const [chunksInput, setChunksInput] = useState("5");
  const [busy, setBusy] = useState(false);
  const [actionResult, setActionResult] = useState("");
  const demoMode = isDevnetRpc(rpcUrl);

  const runAction = async (label, action) => {
    setBusy(true);
    setActionResult(`${label}…`);
    try {
      const txHash = await action();
      setActionResult(`${label} ✓ ${txHash.slice(0, 14)}…`);
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
        chunkAmount:
          BigInt(Math.round(Number(chunkInput) * 100)) * 10n ** (BigInt(inDecimals) - 2n),
        numChunks: Number(chunksInput),
        secret,
      }),
    );
  const onClaim = () =>
    runAction("claim", () => claimDemo({ rpcUrl, icebergAddress: address, secret }));
  const onCancel = () =>
    runAction("cancel", () => cancelDemo({ rpcUrl, icebergAddress: address, secret }));

  const executedChunks = useCallback(
    (currentPlan) => {
      if (!status || !currentPlan?.exists) return 0n;
      if (status.nextInterval <= currentPlan.startInterval) return 0n;
      const lastExecuted = status.nextInterval - 1n;
      if (lastExecuted >= currentPlan.endInterval)
        return currentPlan.endInterval - currentPlan.startInterval + 1n;
      return lastExecuted - currentPlan.startInterval + 1n;
    },
    [status],
  );

  // Decode phase: "locked" masks every value, "decoding" scrambles toward the
  // real one, "open" shows it. The data is already readable by anyone holding
  // the secret — the animation only dramatises that, it does not gate access.
  const [phase, setPhase] = useState("locked");
  const [reveal, setReveal] = useState(0);
  // Timer rather than requestAnimationFrame: rAF is suspended while the tab is
  // hidden, which would strand the reveal mid-scramble and never reach "open".
  const revealTimer = useRef(0);
  const stopReveal = () => clearInterval(revealTimer.current);

  useEffect(() => {
    stopReveal();
    setPhase("locked");
    setReveal(0);
  }, [secret, address]);

  useEffect(() => stopReveal, []);

  const runDecode = () => {
    if (!plan?.exists || phase === "decoding") return;
    stopReveal();
    const start = Date.now();
    setPhase("decoding");
    setReveal(0);
    revealTimer.current = setInterval(() => {
      const progress = Math.min(1, (Date.now() - start) / 1000);
      setReveal(progress);
      if (progress >= 1) {
        stopReveal();
        setPhase("open");
      }
    }, 40);
  };

  const relock = () => {
    stopReveal();
    setPhase("locked");
    setReveal(0);
  };

  const planFields = useMemo(() => {
    if (!plan?.exists) return null;
    const totalChunks = plan.endInterval - plan.startInterval + 1n;
    return {
      chunk: formatAmount(plan.chunkAmount, Number(inDecimals)),
      window: `intervals ${plan.startInterval}–${plan.endInterval}`,
      progress: `${executedChunks(plan)} / ${totalChunks} chunks`,
      accrued: formatAmount(plan.accruedOut, Number(outDecimals)),
      claimed: formatAmount(plan.claimedOut, Number(outDecimals)),
      fraction: totalChunks > 0n ? Number(executedChunks(plan)) / Number(totalChunks) : 0,
    };
  }, [plan, inDecimals, outDecimals, executedChunks]);

  const showField = (key) => {
    if (!planFields) return "—";
    const real = planFields[key];
    if (phase === "open") return real;
    if (phase === "locked") return maskValue(real);
    return scramble(real, reveal);
  };

  // Batch assembly animation: chunks visible → slide out → aggregate resolves.
  const [mixStage, setMixStage] = useState(3);
  const mixTimers = useRef([]);
  const playMix = useCallback(() => {
    mixTimers.current.forEach(clearTimeout);
    setMixStage(0);
    mixTimers.current = [
      setTimeout(() => setMixStage(1), 400),
      setTimeout(() => setMixStage(2), 1500),
      setTimeout(() => setMixStage(3), 2400),
    ];
  }, []);
  useEffect(() => () => mixTimers.current.forEach(clearTimeout), []);

  // The keeper also executes intervals where nothing was due. Those rows carry
  // no information, so the feed lists only intervals that actually swapped and
  // reports how many empty ones were skipped.
  const filledBatches = useMemo(() => batches.filter((batch) => batch.inAmount > 0n), [batches]);
  const emptyCount = batches.length - filledBatches.length;

  // Feature the largest batch rather than the newest: volume is the best proxy
  // we have for "most plans overlapped here", which is what this panel explains.
  const featured = useMemo(
    () =>
      filledBatches.reduce(
        (best, batch) => (best === null || batch.inAmount > best.inAmount ? batch : best),
        null,
      ),
    [filledBatches],
  );
  const featuredKey = featured ? String(featured.interval) : "";
  useEffect(() => {
    if (featuredKey) playMix();
  }, [featuredKey, playMix]);

  // Only the aggregate is on-chain. If a decoded plan was active in this
  // interval we can name our own chunk; everything else stays unattributed.
  const mixChunks = useMemo(() => {
    if (!featured) return [];
    const mine =
      phase === "open" && plan?.exists &&
      featured.interval >= plan.startInterval &&
      featured.interval <= plan.endInterval
        ? plan.chunkAmount
        : 0n;
    const others = featured.inAmount - mine;
    const rows = [];
    if (mine > 0n)
      rows.push({ label: `your plan · due #${featured.interval}`, amount: formatAmount(mine, Number(inDecimals)) });
    if (others > 0n)
      rows.push({
        label: mine > 0n ? "parties unknown" : `due #${featured.interval} · parties unknown`,
        amount: formatAmount(others, Number(inDecimals)),
      });
    return rows;
  }, [featured, plan, phase, inDecimals]);

  const timeline = useMemo(() => {
    if (!status) return [];
    // Anchor the window on the most recent activity, not the current interval,
    // so a long quiet stretch doesn't render as an empty chart.
    const latestFilled = filledBatches.length > 0 ? Number(filledBatches[0].interval) : null;
    const last = latestFilled ?? Number(status.nextInterval) - 1;
    const first = Math.max(0, last - (TIMELINE_SPAN - 1));
    const byInterval = new Map(batches.map((batch) => [Number(batch.interval), batch]));
    const cells = [];
    for (let interval = first; interval <= Math.max(first, last); interval++) {
      const batch = byInterval.get(interval);
      cells.push({ interval, amount: batch ? batch.inAmount : 0n });
    }
    const peak = cells.reduce((max, cell) => (cell.amount > max ? cell.amount : max), 0n);
    return cells.map((cell) => ({
      tick: `#${cell.interval}`,
      label: cell.amount > 0n ? formatAmount(cell.amount, Number(inDecimals)).split(".")[0] : "",
      height: cell.amount > 0n && peak > 0n
        ? Math.max(6, (Number(cell.amount) / Number(peak)) * 66)
        : 2,
      empty: cell.amount === 0n,
    }));
  }, [batches, status, inDecimals, filledBatches]);

  return (
    <div className="page">
      <header className="header">
        <div className="header-left">
          <div className="title-row">
            <h1 className="title serif">Iceberg</h1>
            <span className="badge">STRK20 private sprint</span>
          </div>
          <p className="thesis serif">
            Private scheduled trading on Starknet. The chain records one anonymous swap per interval
            — only you can decode your own schedule out of it.
          </p>
        </div>
        <div className="header-right">
          <div className="waterline-key">
            <span className="lbl">public record</span>
            <span className="lbl on">▲ above waterline</span>
            <span className="lbl spaced">your view</span>
            <span className="lbl on">▼ below waterline</span>
          </div>
          <button className="btn-ghost" onClick={() => setDrawerOpen((open) => !open)}>
            settings
          </button>
        </div>
      </header>

      <div className="metrics">
        <div className="metric">
          <span className="lbl">current interval</span>
          <span className="metric-value">{status ? String(status.currentInterval) : "—"}</span>
        </div>
        <div className="metric">
          <span className="lbl">next to execute</span>
          <span className="metric-value">{status ? String(status.nextInterval) : "—"}</span>
        </div>
        <div className="metric">
          <span className="lbl">active batch size / interval</span>
          <span className="metric-value">
            {status ? formatAmount(status.chunkRate, Number(inDecimals)) : "—"}
            <span className="metric-unit">{inSymbol}</span>
          </span>
        </div>
        <div className="metric">
          <span className="lbl">rpc</span>
          <span className="metric-rpc">
            <span className="pulse" />
            {address ? "polling · 10s" : "no contract set"}
          </span>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <section className="section">
        <div className="section-head">
          <div className="section-head-left">
            <span className="lbl lbl-wide">above the waterline</span>
            <h2 className="serif">What the chain sees</h2>
          </div>
          <p className="section-note">
            The complete public record. Aggregate swaps only: no addresses, no owners, no schedules,
            no way to tell one plan from three.
          </p>
        </div>

        {timeline.length > 0 && (
          <div className="card timeline">
            <span className="lbl">executed volume by interval</span>
            <div className="timeline-bars">
              {timeline.map((cell) => (
                <div className="timeline-col" key={cell.tick}>
                  <span className="timeline-val">{cell.label}</span>
                  <div
                    className={cell.empty ? "timeline-bar empty" : "timeline-bar"}
                    style={{ height: `${cell.height}px` }}
                  />
                </div>
              ))}
            </div>
            <div className="timeline-ticks">
              {timeline.map((cell) => (
                <span className="timeline-tick" key={cell.tick}>
                  {cell.tick}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="card feed-scroll">
          <div className="feed-cols feed-head lbl">
            <span>interval</span>
            <span>swapped in</span>
            <span>received out</span>
            <span>counterparties</span>
            <span>tx</span>
          </div>
          {filledBatches.length === 0 && (
            <div className="empty-note">No batches with volume executed yet.</div>
          )}
          {filledBatches.map((batch) => (
            <div className="feed-cols feed-row" key={String(batch.interval)}>
              <span className="feed-interval">#{String(batch.interval)}</span>
              <span>
                {formatAmount(batch.inAmount, Number(inDecimals))}
                <span className="unit">{inSymbol}</span>
              </span>
              <span>
                {formatAmount(batch.outAmount, Number(outDecimals))}
                <span className="unit">{outSymbol}</span>
              </span>
              <span className="counterparty">
                <span className="redact" />
                <span className="lbl">unknown</span>
              </span>
              <span className="tx">{batch.txHash.slice(0, 10)}…</span>
            </div>
          ))}
          <div className="feed-end">
            — end of public record —
            {emptyCount > 0 && ` ${emptyCount} interval${emptyCount === 1 ? "" : "s"} executed with nothing due`}
          </div>
        </div>
      </section>

      {featured && (
        <section className="section-tight">
          <div className="card assembly">
            <div className="assembly-head">
              <span className="lbl lbl-wide">
                batch assembly · interval #{String(featured.interval)}
              </span>
              <button className="btn-ghost" onClick={playMix}>
                replay mixing
              </button>
            </div>
            <div className="assembly-grid">
              <div className="assembly-chunks">
                {mixChunks.map((chunk, index) => (
                  <div
                    className="chunk-row"
                    key={chunk.label}
                    style={{
                      transform:
                        mixStage >= 2
                          ? `translate(26px, ${(1 - index) * 46}px)`
                          : "translate(0, 0)",
                      opacity: mixStage >= 2 ? 0.14 : 1,
                    }}
                  >
                    <span className="lbl">{mixStage >= 3 ? "—" : chunk.label}</span>
                    <span style={{ fontSize: "17px" }}>{mixStage >= 2 ? "—" : chunk.amount}</span>
                  </div>
                ))}
              </div>
              <div className="assembly-agg">
                <div
                  className="agg-card"
                  style={{
                    border: `1px solid ${mixStage >= 2 ? "var(--ink)" : "var(--border-soft)"}`,
                    opacity: mixStage >= 2 ? 1 : 0.2,
                    transform: `scale(${mixStage >= 2 ? 1 : 0.97})`,
                  }}
                >
                  <span className="lbl">single anonymous swap</span>
                  <div className="agg-amounts">
                    <span className="agg-value">
                      {formatAmount(featured.inAmount, Number(inDecimals))}
                    </span>
                    <span className="agg-pair">
                      {inSymbol} → {formatAmount(featured.outAmount, Number(outDecimals))}{" "}
                      {outSymbol}
                    </span>
                  </div>
                  <div className="agg-identity">
                    <span className="redact" />
                    <span className="lbl">
                      {mixStage >= 3 ? "counterparties · unknown" : "resolving…"}
                    </span>
                  </div>
                </div>
                <p className="assembly-caption">
                  Every plan with a chunk due in this interval is summed and executed once. Chunk
                  amounts stay public; who they belong to never exists on-chain.
                </p>
              </div>
            </div>
          </div>
        </section>
      )}

      <div className="waterline">
        <div className="waterline-line" />
        <div className="waterline-tag">waterline</div>
        <div className="waterline-tip">visible tip ends here</div>
      </div>

      <section className="deep">
        <div className="section-head">
          <div className="section-head-left">
            <span className="lbl lbl-wide">below the waterline</span>
            <h2 className="serif">What only you see</h2>
          </div>
          <p className="section-note">
            Your plan secret never leaves this browser. On-chain it exists only as a Poseidon
            commitment.
          </p>
        </div>

        <div className="deep-grid">
          <div className="deep-card">
            <span className="lbl">decode with plan secret</span>
            <div className="field-row">
              <input
                className="secret-input"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                placeholder="text or 0x felt"
              />
              <button className="btn-accent" disabled={!plan?.exists} onClick={runDecode}>
                decode
              </button>
            </div>
            <div className="btn-row">
              <button className="btn-dark" onClick={() => setSecret(randomSecret())}>
                new secret
              </button>
              <button className="btn-dark" onClick={relock}>
                re-lock
              </button>
            </div>
            <div className="commitment-block">
              <span className="lbl">commitment (public)</span>
              <span className="commitment-value">
                {commitment ? (phase === "locked" ? `${commitment.slice(0, 22)}…` : commitment) : "—"}
              </span>
            </div>
            {commitment && !plan?.exists && (
              <p className="act-line" style={{ marginTop: "14px" }}>
                No plan exists for this secret yet.
              </p>
            )}
          </div>

          <div className="deep-card plan-card">
            <div className="plan-head">
              <span className="lbl">your decoded plan</span>
              <span className={phase === "open" ? "state-badge open" : "state-badge"}>
                {phase === "open" ? "decoded" : phase === "decoding" ? "decoding" : "locked"}
              </span>
            </div>
            <div className="plan-values">
              <div className="plan-field">
                <span className="lbl">chunk</span>
                <span className={phase === "locked" ? "plan-value locked" : "plan-value"}>
                  {showField("chunk")}
                </span>
              </div>
              <div className="plan-field">
                <span className="lbl">window</span>
                <span className={phase === "locked" ? "plan-value locked" : "plan-value"}>
                  {showField("window")}
                </span>
              </div>
              <div className="plan-field">
                <span className="lbl">progress</span>
                <span className={phase === "locked" ? "plan-value locked" : "plan-value"}>
                  {showField("progress")}
                </span>
              </div>
              <div className="plan-field">
                <span className="lbl">accrued out</span>
                <span
                  className={
                    phase === "open"
                      ? "plan-value accrued-open"
                      : phase === "locked"
                        ? "plan-value locked"
                        : "plan-value"
                  }
                >
                  {showField("accrued")}
                </span>
              </div>
              <div className="plan-field">
                <span className="lbl">claimed</span>
                <span className={phase === "locked" ? "plan-value locked" : "plan-value"}>
                  {showField("claimed")}
                </span>
              </div>
            </div>
            <div className="plan-progress">
              <div
                className="plan-progress-fill"
                style={{
                  width: phase === "open" && planFields ? `${planFields.fraction * 100}%` : "0%",
                }}
              />
            </div>
          </div>
        </div>

        <div className="deep-grid">
          <div className="deep-card act-card">
            <span className="lbl">act on this plan</span>
            <div className="act-inputs">
              <label>
                <span className="lbl">chunk size</span>
                <input value={chunkInput} onChange={(event) => setChunkInput(event.target.value)} />
              </label>
              <label>
                <span className="lbl">chunks</span>
                <input
                  value={chunksInput}
                  onChange={(event) => setChunksInput(event.target.value)}
                />
              </label>
              <button
                className="btn-accent"
                disabled={!demoMode || busy || !secret}
                onClick={onCreate}
              >
                create plan
              </button>
            </div>
            <div className="act-buttons">
              <button
                className="btn-dark strong"
                disabled={!demoMode || busy || !plan?.exists}
                onClick={onClaim}
              >
                claim accrued
              </button>
              <button
                className="btn-dark"
                disabled={!demoMode || busy || !plan?.exists}
                onClick={onCancel}
              >
                cancel &amp; refund
              </button>
            </div>
            <span className="act-line">
              {actionResult ||
                (demoMode
                  ? "Devnet demo mode — the prefunded account stands in for the STRK20 pool."
                  : "Pool mode: flows implemented, waiting on StarkWare's mainnet proving and discovery endpoints (strk20-hackathon issue #31).")}
            </span>
          </div>

          <div className="deep-card">
            <span className="lbl">privacy model, stated exactly</span>
            <div className="privacy-grid">
              <div className="privacy-col">
                <span className="lbl hidden-lbl">hidden</span>
                <span className="privacy-text">
                  Who created any plan · per-user totals · schedules · claim identity
                </span>
              </div>
              <div className="privacy-col">
                <span className="lbl">public</span>
                <span className="privacy-text dim">
                  Individual chunk amounts, unlinked to anyone · each batch's aggregate swap and
                  timing · net flow
                </span>
              </div>
            </div>
            <p className="privacy-foot">
              Deposits into the pool are public and compliance-screened by design. Iceberg claims
              identity privacy plus mixing — not amount privacy.
            </p>
          </div>
        </div>
      </section>

      <div className="drawer" style={{ transform: `translateX(${drawerOpen ? "0" : "102%"})` }}>
        <div className="drawer-head">
          <span className="lbl lbl-wide">settings</span>
          <button className="btn-ghost" onClick={() => setDrawerOpen(false)}>
            close
          </button>
        </div>
        <div className="drawer-fields">
          <label>
            <span className="lbl">rpc url</span>
            <input value={rpcUrl} onChange={(event) => setRpcUrl(event.target.value)} />
          </label>
          <label>
            <span className="lbl">iceberg contract</span>
            <input
              value={address}
              placeholder="0x…"
              onChange={(event) => setAddress(event.target.value)}
            />
          </label>
          <div className="drawer-pair">
            <label>
              <span className="lbl">in decimals</span>
              <input value={inDecimals} onChange={(event) => setInDecimals(event.target.value)} />
            </label>
            <label>
              <span className="lbl">out decimals</span>
              <input value={outDecimals} onChange={(event) => setOutDecimals(event.target.value)} />
            </label>
          </div>
          <div className="drawer-pair">
            <label>
              <span className="lbl">in symbol</span>
              <input value={inSymbol} onChange={(event) => setInSymbol(event.target.value)} />
            </label>
            <label>
              <span className="lbl">out symbol</span>
              <input value={outSymbol} onChange={(event) => setOutSymbol(event.target.value)} />
            </label>
          </div>
          <p className="drawer-note">
            Devnet demo mode: the prefunded account stands in for the STRK20 pool. Stored locally,
            never transmitted anywhere but your RPC.
          </p>
        </div>
      </div>
    </div>
  );
}
