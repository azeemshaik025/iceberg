# keeper

The batch executor. On every tick it checks whether an interval has matured. If one has, it asks
AVNU for a quote, derives a `min_out` that protects against slippage, and calls `execute_batch`. It
waits a random jitter first, so batch timing stays unpredictable.

The keeper holds no user funds. It has no power beyond triggering execution. The contract enforces
the interval spacing, the amounts, and `min_out` by itself.

## Setup

```bash
npm i
cp .env.example .env   # fill in the values. .env.example explains each one
npm start              # or: npm run dry-run
```

`--dry-run` logs what the keeper would do and sends no transactions. It does not need
`KEEPER_ADDRESS` or `KEEPER_PRIVATE_KEY`.

Check one setting before any mainnet run. `MIN_OUT_SOURCE` must be `avnu`, which is the default.
The value `none` sends `min_out=0`. It exists only so you can test against devnet mock tokens,
which AVNU cannot price.

## Local devnet demo

The root [`README.md`](../README.md#run-it-locally) lists the exact commands and toolchain
versions. The sequence is:

1. Start `starknet-devnet`. Also start a block-ticker loop. Devnet freezes chain time between
   transactions, and Iceberg reads its intervals from the block timestamp.
2. Run `cd contracts && scarb build`. Do this before you deploy. `snforge test` builds test
   targets only, not deploy artifacts.
3. Run `cd keeper && node deploy-devnet.mjs`. This deploys two `MockERC20` contracts, one
   `MockAMM`, and `Iceberg`. It then creates two demo plans through `privacy_invoke`, named
   `demo-alice` and `demo-bob`, so each batch mixes more than one plan. It writes
   `../devnet-deployment.json`, which holds every address the keeper and the interface need.
4. Run `node keeper.js` with the environment values from that file. Set `MIN_OUT_SOURCE=none`,
   because AVNU cannot price the mock tokens.
