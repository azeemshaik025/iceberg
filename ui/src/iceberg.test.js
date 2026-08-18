// Unit tests for fetchBatches' incremental scanning: pagination via
// continuation_token, and the fromBlock/nextFromBlock cursor that lets a
// caller poll without re-scanning already-seen blocks. Mocks provider —
// no devnet/RPC needed.

import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchBatches } from "./iceberg.js";

const event = (blockNumber, interval, inAmount, outAmount, txHash) => ({
  keys: ["0xBATCH_KEY", `0x${interval.toString(16)}`],
  data: [`0x${inAmount.toString(16)}`, `0x${outAmount.toString(16)}`],
  block_number: blockNumber,
  transaction_hash: txHash,
});

test("fetchBatches maps a single page and advances the cursor past the max block seen", async () => {
  const calls = [];
  const provider = {
    getEvents: async (params) => {
      calls.push(params);
      return {
        events: [event(5, 1, 100, 200, "0xa"), event(7, 2, 100, 200, "0xb")],
        continuation_token: undefined,
      };
    },
  };

  const { newBatches, nextFromBlock } = await fetchBatches(provider, "0xaddr", 0);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].from_block, { block_number: 0 });
  assert.equal(newBatches.length, 2);
  assert.deepEqual(newBatches[0], { interval: 1n, inAmount: 100n, outAmount: 200n, txHash: "0xa" });
  assert.equal(nextFromBlock, 8); // max block (7) + 1
});

test("fetchBatches follows continuation_token across multiple pages", async () => {
  const pages = [
    { events: [event(1, 1, 10, 20, "0xa")], continuation_token: "cursor-1" },
    { events: [event(3, 2, 10, 20, "0xb")], continuation_token: undefined },
  ];
  let call = 0;
  const provider = { getEvents: async () => pages[call++] };

  const { newBatches, nextFromBlock } = await fetchBatches(provider, "0xaddr", 0);

  assert.equal(call, 2);
  assert.equal(newBatches.length, 2);
  assert.equal(nextFromBlock, 4); // max block (3) + 1
});

test("fetchBatches leaves nextFromBlock unchanged when nothing new is found", async () => {
  const provider = {
    getEvents: async () => ({ events: [], continuation_token: undefined }),
  };

  const { newBatches, nextFromBlock } = await fetchBatches(provider, "0xaddr", 12);

  assert.deepEqual(newBatches, []);
  assert.equal(nextFromBlock, 12);
});

test("a second poll with the returned cursor never re-requests already-seen blocks", async () => {
  const requestedFromBlocks = [];
  const provider = {
    getEvents: async (params) => {
      requestedFromBlocks.push(params.from_block.block_number);
      if (params.from_block.block_number === 0) {
        return { events: [event(10, 1, 1, 2, "0xa")], continuation_token: undefined };
      }
      return { events: [], continuation_token: undefined };
    },
  };

  const first = await fetchBatches(provider, "0xaddr", 0);
  await fetchBatches(provider, "0xaddr", first.nextFromBlock);

  assert.deepEqual(requestedFromBlocks, [0, 11]);
});
