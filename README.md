# 🧊 Iceberg

**Private accumulation and exit on Starknet.** Iceberg runs scheduled DCA and TWAP orders. The
chain records only that the STRK20 pool made a swap. It never records who was accumulating, how
much they hold, or what their schedule is.

Built for the [STRK20 Private Sprint](https://strk20.starknet.io/hackathon), 14 to 31 August 2026.

## The idea

Traders buy and sell large positions gradually instead of all at once. On a public chain, that
strategy is visible to everyone. Your schedule, your running total, and your identity are all on
display, so anyone can copy you or trade ahead of you.

Iceberg groups many users' scheduled orders into one anonymous pool swap per interval. Each
person's chunk size, schedule, and total stay hidden inside that group. The chain shows only the
combined swap. That swap is the tip of the iceberg.

1. Deposit into the STRK20 shielded pool. Then tell Iceberg privately to buy a token in N chunks.
2. Each interval, a keeper sums the chunks due from every active plan. It executes one swap for
   the whole group.
3. Claim your share back into the shielded pool whenever you want. You claim with a secret that
   only you hold.

## What is actually private

| Public | Private |
|---|---|
| Each interval's combined swap amount and its timing | Who created any plan |
| Net flow in and out of the pool | Per-user totals and schedules, mixed across the group |
| That a swap happened | Who claims |

STRK20 always shows swap amounts and timing. Private DeFi routes through shared anonymizer
contracts into public venues. So Iceberg claims identity privacy plus mixing. It does not claim
amount privacy.

Read [`SPEC.md`](SPEC.md) for the full design and the known tradeoffs.

## Repo layout

- [`contracts/`](contracts/) holds the Cairo code. It contains the `Iceberg` core and the
  `EkuboAdapter`, with 20 unit tests and 1 mainnet-fork test.
  [Read more](contracts/README.md).
- [`keeper/`](keeper/) holds the batch executor. It quotes AVNU for slippage protection and adds
  random timing jitter. It also deploys the local demo. [Read more](keeper/README.md).
- [`ui/`](ui/) holds the demo interface. It shows what the chain sees above a waterline, and what
  only you can decode below it. [Read more](ui/README.md).

## Run it locally

The toolchain versions match the pins in StarkWare's `starknet-privacy` repo. You need scarb
2.17.0, starknet-foundry 0.59.0, universal-sierra-compiler, starknet-devnet 0.8.0-rc.3, and Node
24 or later.

Run the contract tests. One of them forks mainnet and swaps against real Ekubo liquidity.

```bash
cd contracts
snforge test        # 21 tests
scarb build         # required before you deploy: snforge builds test targets only
```

Run the full demo loop. This starts devnet, deploys the contracts, seeds two plans, runs the
keeper, and serves the interface.

```bash
starknet-devnet --seed 0 --port 5050          # terminal 1

# terminal 2. Devnet freezes chain time between transactions, so advance it.
while true; do curl -s localhost:5050 -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"devnet_createBlock","params":{},"id":1}' >/dev/null; sleep 20; done

cd keeper && npm i && node deploy-devnet.mjs   # deploys everything and seeds 2 plans
npm start                                      # the keeper. See keeper/README.md for the env

cd ../ui && npm i && npm run dev               # set the RPC and contract address in Settings
```

The seeded plan secrets are `demo-alice` and `demo-bob`. Intervals last 60 seconds on devnet.
Enter either secret in the lower half of the interface to decode that plan.

## Status

The contracts, the keeper, and the interface all work against a local devnet. The test suite
includes a fork test that swaps against real mainnet Ekubo liquidity.

The private create and claim flow is written against the StarkWare privacy SDK, but it is not live
yet. StarkWare has not published the mainnet proving and discovery service URLs. The starter kit
ships no Sepolia equivalents either. Until those exist, the deployed interface stays read-only.

## License

[MIT](LICENSE)
