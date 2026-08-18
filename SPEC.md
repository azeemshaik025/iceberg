# Iceberg — private accumulation & exit on STRK20

DCA/TWAP where the chain sees "the pool swapped X USDC→ETH" but never who, their totals, or their schedules. Buy-side and sell-side symmetric.

## Verified foundations (milestone 1)

| Fact | Source |
|---|---|
| Anonymizer sandwich: pool transfers tokens to helper → calls `privacy_invoke` → helper returns `Span<OpenNoteDeposit>`; approve-don't-transfer; balance-delta measurement; **at most one invoke per pool tx** | strk20-by-example.org/helpers/privacy-invoke |
| Helpers may hold funds across txs: return **empty span** on deposit, credit notes in a **later** `privacy_invoke` (claim) authorized by Poseidon commitment preimage (`poseidon(TAG, secret)`), double-claim flag | strk20-by-example.org/helpers/escrow |
| Client side: SDK builder `.withdraw({recipient: helper}) + .transfer({amount: Open}) + .invoke(...)`; op-code multiplexing in calldata (Vesu example); AVNU paymaster gasless flow | refs/starknet-privacy/sdk/README.md |
| Ekubo swap-from-helper reference code exists | refs/starknet-privacy/packages/privacy/src/tests/test_ekubo_swap_anonymizer.cairo, mock_swap_executor.cairo |
| Mainnet pool live at `0x040337b1af…812a`; deposits compliance-screened + public; private txs submitted by rotating shared relayers (sender privacy built in) | strk20-hackathon/docs/MAINNET-DAY-0.md |
| Sequencing: prover needs finalized state ≥10 blocks old → minutes between one user's private txs (fine for DCA cadence) | sdk/README.md |
| Organizers' own leak warning: "a distinctive amount executed shortly after a distinctive deposit is correlatable" — batching + fixed denominations is precisely the mitigation | MAINNET-DAY-0.md |

## Contract design

One Cairo contract, `IcebergHelper`, single `privacy_invoke` entrypoint multiplexed by op enum (escrow + Vesu pattern), plus one public keeper entrypoint.

**Via pool (anonymous):**
- `CreatePlan { commitment_hash, in_token, out_token, chunk_amount, n_chunks }` — pool has already transferred `chunk_amount * n_chunks` of `in_token` to the helper. Validate, store plan keyed by commitment, return empty span. Plan is active from the next interval.
- `Claim { secret, note_id }` — recompute commitment, compute accrued `out_token` via interval index (below), approve pool, return `[OpenNoteDeposit { note_id, out_token, accrued }]`. Partial claims allowed; claimed amount tracked.
- `Cancel { secret, note_id }` — refund unswapped `in_token` remainder as an open note; plan closed.

**Keeper-gated, not permissionless:**
- `execute_batch()` — once per interval: sum due chunks across active plans, swap aggregate on Ekubo router (min-out slippage guard from caller), record interval's price index. Restricted to the single `keeper` address set at construction; contract enforces interval spacing; keeper = cron with random jitter. Deliberately not open to any caller: `min_out` is caller-supplied with no on-chain price check, so an unrestricted caller could set it to zero and sandwich the batch. Tradeoff is liveness, not funds — `cancel()` always works regardless of keeper uptime — but `keeper` can't be rotated post-deployment; losing its key means redeploying.

**Accounting — O(1) claims via prefix sums:** per interval store cumulative `Σ (out/in)` index. A plan holds `start_interval`, `chunk_amount`, `n_chunks`; accrued out = `chunk_amount × (index[last_matured] − index[start−1])`. No per-plan iteration in `execute_batch` beyond aggregating due amounts (tracked with an active-amount schedule: `total_active += chunk` at start, scheduled `−= chunk` at expiry — O(1) per plan via a per-interval expiry map).

## Privacy model (state honestly, everywhere)

- Hidden: who created any plan, who claims, per-user totals and schedules (mixed across the batch).
- Public: each chunk deposit amount (unlinked), each batch's aggregate swap + timing, net flow.
- Mitigations: fixed chunk denominations (e.g. 10/100/1000), keeper jitter, min-out guard. Identity privacy is the floor (shared relayers + pool sender); it never degrades even with one participant.

## Open items / risks

1. **Mainnet discovery + proving service URLs still marked "missing" in day-0 doc** (promised before Aug 14; clone is current as of Aug 15). Check repo issues; M2–M3 run on devnet/Sepolia regardless. Blocker only for M4.
2. Exact `privacy_invoke` ABI + Ekubo router param encoding: copy verbatim from `packages/privacy/src/tests/` at M2 start.
3. Claim calldata reveals the secret publicly → links claim to plan (both anonymous; acceptable — escrow PoC has the same property). If time permits: signature-based claims instead.

## Milestones

- **M2** — Scarb package; `IcebergHelper` + snforge tests against repo's `MockSwapExecutor` (create/batch/claim/cancel, multi-plan pro-rata, slippage, double-claim).
- **M3** — Ekubo router integration; TS keeper (cron + jitter); minimal Next.js UI from starter kit (shield → plan → batches → claim).
- **M4** — Mainnet deploy + ≥3 pool txs (ask before deploying/spending).
- **M5** — Split-screen "what the chain sees vs what you see" dashboard, viewing-key export, README/docs, 3-min video, `strk20.json`, registry PR.
