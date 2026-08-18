# contracts

Cairo contracts for Iceberg: the core scheduling/accounting contract and the Ekubo venue adapter.

## Prerequisites

- scarb 2.17.0
- snforge 0.59.0 (+ universal-sierra-compiler)

Versions are pinned to match `starkware-libs/starknet-privacy`'s toolchain.

## Build

```bash
scarb build
```

Required before any deploy — `snforge test` compiles test targets only, not the deploy artifacts
under `target/dev/` that `keeper/deploy-devnet.mjs` reads.

## Test

```bash
snforge test
```

Runs 16 unit tests (`tests/test_iceberg.cairo`, against `mocks.cairo`) plus 1 mainnet-fork test
(`tests/test_ekubo_fork.cairo`) that runs the full create → batch → claim pipeline against real
mainnet Ekubo liquidity. The fork test needs RPC access — its block and endpoint are pinned in
`[[tool.snforge.fork]]` in `Scarb.toml`.

## Contracts

- **`src/iceberg.cairo`** — `Iceberg`: plan creation, batch execution, claims, and cancellation.
  Accounting is O(1) per plan via a cumulative price index rather than per-plan iteration in
  `execute_batch`.
- **`src/ekubo_adapter.cairo`** — `EkuboAdapter`: pins Iceberg to one fixed Ekubo pool at
  construction; measures received output by balance delta rather than trusting the router's return
  value.
- **`src/mocks.cairo`** — `MockERC20` / `MockAMM`, test-only, not for deployment.

## `privacy_invoke` wire format

The STRK20 pool calls `Iceberg::privacy_invoke(operation: IcebergOperation)`. `IcebergOperation` is
an enum multiplexed by variant index in calldata — this is the shape any pool integration (or the
`ui/src/strk20.js` client) needs to encode:

| Op | Index | Params | Effect |
|---|---|---|---|
| `CreatePlan` | `0x0` | `commitment, chunk_amount, num_chunks` | Pool must have already transferred `chunk_amount * num_chunks` of `in_token` to Iceberg in the same tx. Registers the plan, active from the next interval. Returns an empty span. |
| `Claim` | `0x1` | `secret, note_id` | `commitment = poseidon('iceberg.plan.v1', secret)` must match a registered plan. Returns `[OpenNoteDeposit { note_id, out_token, amount }]` for the plan's unclaimed accrual. |
| `Cancel` | `0x2` | `secret, note_id` | Returns `[OpenNoteDeposit { note_id, in_token, amount }]` refunding unswapped chunks. Already-executed chunks stay claimable via a separate `Claim`. |

`plan_commitment(secret)`, exported from `iceberg.cairo`, and its client-side equivalents in
`ui/src/iceberg.js` / `ui/src/strk20.js` must stay in sync — all three hash
`poseidon_hash_span(['iceberg.plan.v1', secret])`.
