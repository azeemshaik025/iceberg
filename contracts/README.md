# contracts

The Cairo contracts for Iceberg. They cover scheduling, accounting, and the Ekubo venue adapter.

## Prerequisites

- scarb 2.17.0
- snforge 0.59.0, plus universal-sierra-compiler

These versions match the toolchain in `starkware-libs/starknet-privacy`.

## Build

```bash
scarb build
```

Run this before any deploy. `snforge test` compiles the test targets only. It does not produce the
deploy artifacts under `target/dev/` that `keeper/deploy-devnet.mjs` reads.

## Test

```bash
snforge test
```

This runs 21 tests. It runs 16 unit tests for the core in `tests/test_iceberg.cairo` against
`mocks.cairo`. It runs 4 unit tests for the adapter in `tests/test_ekubo_adapter.cairo` against a
mock router. It also runs 1 fork test in `tests/test_ekubo_fork.cairo`.

The fork test runs the full create, batch, and claim pipeline against real mainnet Ekubo
liquidity. It needs RPC access. `Scarb.toml` pins its block and its endpoint under
`[[tool.snforge.fork]]`.

## Contracts

- **`src/iceberg.cairo`** holds `Iceberg`. It creates plans, executes batches, and handles claims
  and cancellations. A cumulative price index keeps the accounting at constant cost per plan, so
  `execute_batch` never iterates over the plans.
- **`src/ekubo_adapter.cairo`** holds `EkuboAdapter`. Its constructor pins Iceberg to one Ekubo
  pool. It measures the output it received by balance delta rather than trusting what the router
  returns.
- **`src/mocks.cairo`** holds `MockERC20` and `MockAMM`. These are for tests. Do not deploy them.

## The `privacy_invoke` wire format

The STRK20 pool calls `Iceberg::privacy_invoke(operation: IcebergOperation)`. `IcebergOperation` is
an enum, and calldata selects the variant by index. Any pool integration must encode this shape.
The client in `ui/src/strk20.js` encodes it the same way.

| Op | Index | Params | Effect |
|---|---|---|---|
| `CreatePlan` | `0x0` | `commitment, chunk_amount, num_chunks` | The pool must transfer `chunk_amount * num_chunks` of the input token to Iceberg in the same transaction. Registers the plan, which becomes active at the next interval. Returns an empty span. |
| `Claim` | `0x1` | `secret, note_id` | `commitment = poseidon('iceberg.plan.v1', secret)` must match a registered plan. Returns `[OpenNoteDeposit { note_id, out_token, amount }]` for the accrual the plan has not yet claimed. |
| `Cancel` | `0x2` | `secret, note_id` | Returns `[OpenNoteDeposit { note_id, in_token, amount }]`, which refunds the chunks that never swapped. Chunks that already executed stay claimable through a separate `Claim`. |

Three pieces of code compute the plan commitment. `iceberg.cairo` exports `plan_commitment(secret)`.
The clients in `ui/src/iceberg.js` and `ui/src/strk20.js` do the same. All three hash
`poseidon_hash_span(['iceberg.plan.v1', secret])`, and all three must stay in sync.
