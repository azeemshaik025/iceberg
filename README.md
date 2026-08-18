# 🧊 Iceberg

**Private accumulation and exit on Starknet.** Scheduled DCA/TWAP where the chain sees only
"the STRK20 pool swapped X" — never who was accumulating, their totals, or their schedules.

Built for the [STRK20 Private Sprint](https://strk20.starknet.io/hackathon) (Aug 14–31, 2026).

## The idea

Buying or selling a position gradually instead of all at once is a common strategy — but doing it
on a public chain means broadcasting your entire schedule, running total, and identity to anyone
watching. Iceberg batches many users' recurring orders into one anonymous pool swap per interval:
individually, each person's chunk size, schedule, and total stay hidden. Only the pooled swap is
ever visible on-chain — the tip of the iceberg.

1. Deposit into the STRK20 shielded pool and privately tell Iceberg "buy $X of ETH in N chunks."
2. Every interval, a keeper bot sums that interval's due chunks across *all* active plans and
   executes one swap for the whole group.
3. Claim your share back into the shielded pool whenever you want, using a secret only you know.

## What's actually private

| Public | Private |
|---|---|
| Each interval's aggregate swap amount and timing | Who created any plan |
| Net flow in/out of the pool | Per-user totals and schedules (mixed across the batch) |
| That a swap happened | Claim identity |

Swap **amounts and timing are always visible on STRK20** — private DeFi routes through shared
anonymizer contracts into public venues, so identity privacy plus mixing is the claim here, never
amount privacy. See [`SPEC.md`](SPEC.md) for the full design and known tradeoffs.

## Repo layout

- [`contracts/`](contracts/) — Cairo: `Iceberg` core + `EkuboAdapter`, 16 unit tests + 1
  mainnet-fork test. [→ contracts/README.md](contracts/README.md)
- [`keeper/`](keeper/) — batch executor bot (AVNU-quoted slippage guard, jittered timing) + local
  devnet demo deploy. [→ keeper/README.md](keeper/README.md)
- [`ui/`](ui/) — split-screen demo: what the chain sees vs. what only you see, with a live
  create/claim/cancel action panel on devnet. [→ ui/README.md](ui/README.md)

## Status

Contracts, keeper, and UI are built and tested against a local devnet. Mainnet activation is
code-complete but blocked on StarkWare publishing the mainnet proving/discovery service URLs
(tracked in [strk20-hackathon issue #31](https://github.com/starkience/strk20-hackathon/issues/31)).
See [`HANDOFF.md`](HANDOFF.md) for the live checklist.

## License

[MIT](LICENSE)
