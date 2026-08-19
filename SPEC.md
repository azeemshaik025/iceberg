# Iceberg — design notes

DCA and TWAP on Starknet where the chain sees "the pool swapped X USDC→ETH" but never who was
buying, their totals, or their schedules. Buy-side and sell-side are symmetric.

## What the STRK20 pool gives us

Iceberg is built on four properties of the shielded pool, all of them documented behaviour rather
than anything we added:

| Property | Where it comes from |
|---|---|
| **The anonymizer sandwich.** The pool transfers tokens to a helper contract, calls `privacy_invoke` on it, and applies the `Span<OpenNoteDeposit>` it returns. The helper approves rather than transfers, and measures what actually arrived by balance delta. At most one invoke per pool transaction. | [privacy-invoke](https://strk20-by-example.org/helpers/privacy-invoke) |
| **Helpers may hold funds across transactions.** Return an empty span on deposit, then credit notes in a *later* `privacy_invoke`, authorised by the preimage of a Poseidon commitment. | [escrow](https://strk20-by-example.org/helpers/escrow) |
| **Sender privacy is free.** Private transactions are submitted by rotating shared relayers, so the on-chain sender is never the user. | [Day 0 guide](https://github.com/starkience/strk20-hackathon/blob/main/docs/MAINNET-DAY-0.md) |
| **Proofs read finalised state ≥10 blocks old**, so one user's private transactions are minutes apart. Irrelevant at DCA cadence. | [privacy SDK](https://github.com/starkware-libs/starknet-privacy) |

The second property is the one Iceberg depends on. Holding a plan's funds across many intervals and
paying out later is exactly the escrow shape, applied to scheduled trading.

## Contracts

**`Iceberg`** — one `privacy_invoke` entrypoint multiplexed by an operation enum, plus one
keeper entrypoint.

- `CreatePlan { commitment, chunk_amount, num_chunks }` — the pool has already transferred
  `chunk_amount * num_chunks` of `in_token`. Validate against the contract's own balance, store the
  plan under its commitment, return an empty span. The plan is active from the next interval.
- `Claim { secret, note_id }` — recompute the commitment, compute accrued `out_token` from the
  price index below, approve the pool, and return one `OpenNoteDeposit`. Partial claims are allowed
  and the claimed total is tracked.
- `Cancel { secret, note_id }` — refund the unswapped remainder as an open note and truncate the
  plan so executed intervals stay claimable.
- `execute_batch(min_out)` — once per matured interval: sum every active plan's due chunk, swap the
  aggregate once, record the interval's price index.

**`EkuboAdapter`** — a venue adapter pinned to one Ekubo pool at construction, exposing the same
`swap(in_token, out_token, amount)` shape the core sends. Keeps `Iceberg` venue-agnostic and holds
no funds between transactions.

### `execute_batch` is keeper-gated on purpose

`min_out` is supplied by the caller and there is no on-chain price check, so an open entrypoint
would let anyone call with `min_out = 0` and sandwich the batch. The gate is load-bearing, not an
oversight.

The cost is liveness, not funds: `cancel()` works regardless of keeper uptime, so the worst case is
a stalled schedule and a refund, never a loss. The keeper address is fixed at construction and
cannot be rotated, which means its key needs real custody from day one.

### O(1) accounting

Naively, working out what a plan has earned means iterating every interval it lived through.
Instead each executed interval writes one number — the cumulative WAD-scaled out-per-in rate:

```
index[i] = index[i-1] + out_received * WAD / in_swapped
accrued  = chunk_amount * (index[matured_end] - index[start - 1]) / WAD
```

So a claim is one subtraction regardless of how many intervals have passed. The same trick handles
scheduling: `rate_start[i]` and `rate_expiry[i]` record how much chunk volume joins and leaves at
interval `i`, and `execute_batch` folds them into a running total. Both `create_plan` and
`execute_batch` are O(1) no matter how many other plans exist.

## Privacy model

**Hidden:** who created any plan, who claims, per-user totals, and schedules — all mixed across the
batch.

**Public:** each chunk amount (unlinked to anyone), each batch's aggregate swap and its timing, and
net flow.

Deposits into the pool are public and compliance-screened by design. The claim is identity privacy
plus mixing, never amount privacy — the Day 0 guide is explicit that shielding is not private, only
what you do afterwards is.

Mitigations against correlation: fixed chunk denominations, random jitter on keeper timing, and a
min-out guard on every batch. Identity privacy is the floor and holds even with a single
participant; the mixing on top strengthens as more plans overlap.

## Known tradeoffs

1. **Claim calldata reveals the secret**, which links that claim to that plan. Both are anonymous,
   so nothing points back to a person, and the documented escrow helper has the same property.
   Signature-based claims would remove it.
2. **Amounts are public**, so a distinctive chunk size executed shortly after a distinctive deposit
   is correlatable. Fixed denominations are the intended answer.
3. **One deployment serves one trading pair.** Another pair means another instance.
4. **Hidden limit and stop orders are out of scope.** Their trigger is a secret price the chain must
   compare privately, which needs confidential compute. A clock is not a secret, which is why the
   scheduled subset is buildable today and the conditional one is not.
