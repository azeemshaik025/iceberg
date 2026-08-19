# keeper

Batch executor bot. On every tick it checks whether an interval has matured; if so, it quotes a
slippage-protected `min_out` from AVNU and calls `execute_batch`, waiting a random jitter first so
batch timing isn't perfectly predictable. The keeper holds no user funds and has no special power
beyond triggering execution — the contract enforces interval spacing, amounts, and `min_out` on its
own.

## Setup

```bash
npm i
cp .env.example .env   # fill in the values — see .env.example for what each one does
npm start               # or: npm run dry-run
```

`--dry-run` logs what the keeper would do without sending transactions, and doesn't require
`KEEPER_ADDRESS` / `KEEPER_PRIVATE_KEY`.

The one setting worth double-checking before a mainnet run: `MIN_OUT_SOURCE` must be `avnu` (the
default). `none` sends `min_out=0` and exists only so devnet/mock tokens — which AVNU can't price —
can still be tested.

## Local devnet demo

Full sequence (see the root [`README.md`](../README.md#run-it-locally) for exact commands and
toolchain versions):

1. Start `starknet-devnet` — plus a block-ticker loop, since devnet freezes chain time between
   transactions and Iceberg's intervals are timestamp-based.
2. `cd contracts && scarb build` — required before deploying; `snforge test` only builds test
   targets, not deploy artifacts.
3. `cd keeper && node deploy-devnet.mjs` — deploys `MockERC20` (x2) + `MockAMM` + `Iceberg`, then
   creates two demo plans (`demo-alice`, `demo-bob`) through `privacy_invoke` so a batch actually
   mixes more than one plan. Writes `../devnet-deployment.json` with every address the keeper and
   UI need.
4. `node keeper.js` with envs from that file and `MIN_OUT_SOURCE=none` (mock tokens aren't
   AVNU-priceable).
