// Read-side helpers for the Iceberg contract. All calls are raw callContract
// (no ABI file needed) plus event scans for the public batch feed.

import { RpcProvider, hash, shortString } from "starknet";

const PLAN_TAG = "iceberg.plan.v1";

export const makeProvider = (nodeUrl) => new RpcProvider({ nodeUrl });

/// Must match Cairo: poseidon_hash_span([PLAN_TAG, secret]).
export function planCommitment(secretText) {
  const secretFelt = secretText.startsWith("0x")
    ? secretText
    : shortString.encodeShortString(secretText);
  return hash.computePoseidonHashOnElements([
    shortString.encodeShortString(PLAN_TAG),
    secretFelt,
  ]);
}

const call = async (provider, address, entrypoint, calldata = []) =>
  provider.callContract({ contractAddress: address, entrypoint, calldata });

export async function fetchStatus(provider, address) {
  const [nextInterval, currentInterval, chunkRate] = await Promise.all([
    call(provider, address, "next_interval_to_execute"),
    call(provider, address, "current_interval"),
    call(provider, address, "active_chunk_rate"),
  ]);
  return {
    nextInterval: BigInt(nextInterval[0]),
    currentInterval: BigInt(currentInterval[0]),
    chunkRate: BigInt(chunkRate[0]),
  };
}

export async function fetchPlan(provider, address, commitment) {
  const [plan, accrued] = await Promise.all([
    call(provider, address, "plan", [commitment]),
    call(provider, address, "accrued_out", [commitment]),
  ]);
  const [chunkAmount, startInterval, endInterval, claimedOut] = plan.map(BigInt);
  return {
    exists: chunkAmount > 0n,
    chunkAmount,
    startInterval,
    endInterval,
    claimedOut,
    accruedOut: BigInt(accrued[0]),
  };
}

/// The public feed: every BatchExecuted event — this is ALL an observer learns.
///
/// Incremental: takes the block to resume from (0 for a first call) and
/// returns both the newly-seen batches and the block to pass in next time,
/// so a caller polling this on an interval never re-scans blocks it has
/// already fetched. Safe to call repeatedly with the same fromBlock (e.g.
/// nothing new happened) — nextFromBlock only advances when events are
/// actually found.
export async function fetchBatches(provider, address, fromBlock = 0) {
  const batchKey = hash.getSelectorFromName("BatchExecuted");
  const events = [];
  let continuationToken;
  do {
    const page = await provider.getEvents({
      address,
      keys: [[batchKey]],
      from_block: { block_number: fromBlock },
      to_block: "latest",
      chunk_size: 100,
      continuation_token: continuationToken,
    });
    events.push(...page.events);
    continuationToken = page.continuation_token;
  } while (continuationToken);
  const newBatches = events.map((event) => ({
    interval: BigInt(event.keys[1]),
    inAmount: BigInt(event.data[0]),
    outAmount: BigInt(event.data[1]),
    txHash: event.transaction_hash,
  }));
  const maxBlock = events.reduce(
    (max, event) => Math.max(max, event.block_number ?? fromBlock),
    fromBlock,
  );
  // +1 so the block we just fully consumed is never re-fetched.
  return { newBatches, nextFromBlock: events.length > 0 ? maxBlock + 1 : fromBlock };
}
