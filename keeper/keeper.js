// Iceberg keeper: executes matured batch intervals with slippage protection.
//
// Each tick: read next_interval_to_execute vs current_interval; for every
// matured interval, quote the batch on AVNU's public API, derive min_out with
// a slippage haircut, wait a random jitter (so batch timing is not perfectly
// predictable), and call execute_batch(min_out).
//
// The keeper holds no user funds and has no special power beyond triggering
// execution; the contract enforces interval spacing, amounts, and min_out.

import { Account, Contract, RpcProvider } from "starknet";

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`missing env: ${name}`);
  return value;
};

const RPC_URL = env("RPC_URL", "https://starknet-rpc.publicnode.com");
const ICEBERG_ADDRESS = env("ICEBERG_ADDRESS");
const KEEPER_ADDRESS = process.env.KEEPER_ADDRESS;
const KEEPER_PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY;
const IN_TOKEN = env("IN_TOKEN");
const OUT_TOKEN = env("OUT_TOKEN");
const SLIPPAGE_BPS = BigInt(env("SLIPPAGE_BPS", "100")); // 1% default
const JITTER_MAX_S = Number(env("JITTER_MAX_S", "120"));
const POLL_INTERVAL_S = Number(env("POLL_INTERVAL_S", "60"));
const AVNU_BASE = env("AVNU_BASE", "https://starknet.api.avnu.fi");
// "avnu" quotes real tokens; "none" (devnet/mock tokens) sends min_out = 0.
// Explicit so a mainnet keeper can never silently run unprotected.
const MIN_OUT_SOURCE = env("MIN_OUT_SOURCE", "avnu");
const DRY_RUN = process.argv.includes("--dry-run");

const ICEBERG_ABI = [
  {
    type: "function",
    name: "execute_batch",
    inputs: [{ name: "min_out", type: "core::integer::u128" }],
    outputs: [{ type: "core::integer::u128" }],
    state_mutability: "external",
  },
  {
    type: "function",
    name: "next_interval_to_execute",
    inputs: [],
    outputs: [{ type: "core::integer::u64" }],
    state_mutability: "view",
  },
  {
    type: "function",
    name: "current_interval",
    inputs: [],
    outputs: [{ type: "core::integer::u64" }],
    state_mutability: "view",
  },
  {
    type: "function",
    name: "active_chunk_rate",
    inputs: [],
    outputs: [{ type: "core::integer::u128" }],
    state_mutability: "view",
  },
];

const provider = new RpcProvider({ nodeUrl: RPC_URL });
const iceberg = new Contract({
  abi: ICEBERG_ABI,
  address: ICEBERG_ADDRESS,
  providerOrAccount: provider,
});

const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// AVNU aggregator quote as the price oracle for min_out. The trade itself
// executes on Ekubo via the adapter; the quote only bounds acceptable output.
export async function quoteMinOut(sellAmount) {
  if (sellAmount === 0n || MIN_OUT_SOURCE === "none") return 0n;
  const url =
    `${AVNU_BASE}/swap/v2/quotes?sellTokenAddress=${IN_TOKEN}` +
    `&buyTokenAddress=${OUT_TOKEN}&sellAmount=0x${sellAmount.toString(16)}&size=1`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`avnu quote failed: ${response.status}`);
  const quotes = await response.json();
  if (!Array.isArray(quotes) || quotes.length === 0) throw new Error("avnu returned no quotes");
  const buyAmount = BigInt(quotes[0].buyAmount);
  return (buyAmount * (10_000n - SLIPPAGE_BPS)) / 10_000n;
}

async function tick(account) {
  const [nextInterval, currentInterval, chunkRate] = await Promise.all([
    iceberg.next_interval_to_execute(),
    iceberg.current_interval(),
    iceberg.active_chunk_rate(),
  ]);
  console.log(
    `next=${nextInterval} current=${currentInterval} active_chunk_rate=${chunkRate}`,
  );
  if (BigInt(currentInterval) <= BigInt(nextInterval)) return;

  // chunk rate can change once the interval's joiners fold in; quote the known
  // floor and let the contract revert if the market moved past the haircut.
  const minOut = await quoteMinOut(BigInt(chunkRate));
  const jitterSeconds = Math.floor(Math.random() * JITTER_MAX_S);
  console.log(`interval ${nextInterval} matured; min_out=${minOut}; jitter ${jitterSeconds}s`);
  if (DRY_RUN) {
    console.log("[dry-run] would call execute_batch");
    return;
  }
  await sleep(jitterSeconds);
  const call = iceberg.populate("execute_batch", [minOut]);
  const { transaction_hash } = await account.execute(call);
  console.log(`execute_batch sent: ${transaction_hash}`);
  await provider.waitForTransaction(transaction_hash);
  console.log(`interval ${nextInterval} executed`);
}

async function main() {
  let account = null;
  if (!DRY_RUN) {
    if (!KEEPER_ADDRESS || !KEEPER_PRIVATE_KEY)
      throw new Error("KEEPER_ADDRESS and KEEPER_PRIVATE_KEY required (or use --dry-run)");
    account = new Account({
      provider,
      address: KEEPER_ADDRESS,
      signer: KEEPER_PRIVATE_KEY,
    });
  }
  console.log(`iceberg keeper on ${RPC_URL} (${DRY_RUN ? "dry-run" : "live"})`);
  while (true) {
    try {
      await tick(account);
    } catch (error) {
      console.error(`tick failed: ${error.message ?? error}`);
    }
    await sleep(POLL_INTERVAL_S);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
