# Iceberg — design notes

Iceberg runs DCA and TWAP orders on Starknet. The chain sees that the pool swapped one token for
another. It never sees who bought, how much they hold in total, or what their schedule is. Buying
and selling work the same way.

## What the STRK20 pool provides

Iceberg builds on four properties of the shielded pool. All four are documented behaviour. Iceberg
adds none of them.

| Property | Source |
|---|---|
| **The anonymizer sandwich.** The pool sends tokens to a helper contract. It calls `privacy_invoke` on that helper. It then applies the `Span<OpenNoteDeposit>` the helper returns. The helper approves the pool rather than transferring to it, and measures what arrived by balance delta. Each pool transaction allows one invoke. | [privacy-invoke](https://strk20-by-example.org/helpers/privacy-invoke) |
| **A helper can hold funds across transactions.** It returns an empty span on deposit. It credits notes in a later `privacy_invoke`. The preimage of a Poseidon commitment authorises that later call. | [escrow](https://strk20-by-example.org/helpers/escrow) |
| **Sender privacy costs nothing.** Rotating shared relayers submit private transactions, so the on-chain sender is never the user. | [Day 0 guide](https://github.com/starkience/strk20-hackathon/blob/main/docs/MAINNET-DAY-0.md) |
| **Proofs read finalised state at least 10 blocks old.** One user's private transactions are therefore minutes apart. DCA runs far slower than that, so the limit does not matter here. | [privacy SDK](https://github.com/starkware-libs/starknet-privacy) |

Iceberg depends on the second property. A plan holds funds across many intervals and pays out
later. That is the escrow shape, applied to scheduled trading.

## Contracts

**`Iceberg`** exposes one `privacy_invoke` entry point and one keeper entry point. An operation
enum selects which action the pool call performs.

- `CreatePlan { commitment, chunk_amount, num_chunks }`. The pool has already sent
  `chunk_amount * num_chunks` of the input token. The contract checks its own balance, stores the
  plan under its commitment, and returns an empty span. The plan becomes active at the next
  interval.
- `Claim { secret, note_id }`. The contract recomputes the commitment. It reads the accrued output
  from the price index below, approves the pool, and returns one `OpenNoteDeposit`. Partial claims
  are allowed. The contract tracks how much the plan has claimed.
- `Cancel { secret, note_id }`. The contract refunds the chunks that never swapped as an open note.
  It then truncates the plan, so the intervals that did execute stay claimable.
- `execute_batch(min_out)`. Once per matured interval, the contract sums the chunk due from every
  active plan. It swaps that total once and records the interval's price index.

**`EkuboAdapter`** is a venue adapter. Its constructor pins it to one Ekubo pool. It exposes the
same `swap(in_token, out_token, amount)` shape that the core sends, which keeps the core
independent of any venue. It holds no funds between transactions.

### Why a keeper gates `execute_batch`

The caller supplies `min_out`, and no on-chain price check exists. An open entry point would let
anyone call with `min_out = 0` and sandwich the batch. The gate carries weight. It is not an
oversight.

The cost is liveness, not funds. `cancel()` works whatever the keeper does, so the worst outcome
is a stalled schedule and a refund. Users never lose funds. The constructor fixes the keeper
address and nothing can rotate it, so that key needs real custody from the first day.

### Accounting in constant time

The simple approach walks every interval a plan has lived through. Iceberg writes one number per
executed interval instead. That number is the cumulative out-per-in rate, scaled by WAD.

```
index[i] = index[i-1] + out_received * WAD / in_swapped
accrued  = chunk_amount * (index[matured_end] - index[start - 1]) / WAD
```

A claim is one subtraction, whatever the number of intervals. Scheduling uses the same idea.
`rate_start[i]` and `rate_expiry[i]` record the chunk volume that joins and leaves at interval `i`,
and `execute_batch` folds both into a running total. `create_plan` and `execute_batch` therefore
cost the same no matter how many other plans exist.

## Privacy model

**Hidden:** who created any plan, who claims, per-user totals, and schedules. The batch mixes all
of them.

**Public:** each chunk amount, though it links to nobody. Also each batch's combined swap, its
timing, and the net flow.

Deposits into the pool are public, and a compliance provider screens them. That is the design.
Iceberg claims identity privacy plus mixing. It never claims amount privacy. The Day 0 guide
states the same point: shielding is not private, and only what you do afterwards is.

Three measures reduce correlation. Chunk sizes use fixed denominations. The keeper adds random
jitter to its timing. Every batch carries a min-out guard. Identity privacy is the floor and holds
with a single participant. The mixing on top gets stronger as more plans overlap.

## Known tradeoffs

1. **Claim calldata reveals the secret.** That links the claim to the plan. Both are anonymous, so
   nothing points back to a person. StarkWare's own escrow helper behaves the same way.
   Signature-based claims would remove the link.
2. **Amounts are public.** A distinctive chunk size that executes shortly after a distinctive
   deposit may be correlatable. Fixed denominations are the intended answer.
3. **One deployment serves one trading pair.** A second pair needs a second instance.
4. **Hidden limit and stop orders are out of scope.** Their trigger is a secret price, and the
   chain must compare it privately. That needs confidential compute. A clock is not a secret,
   which is why the scheduled subset works today and the conditional one does not.
