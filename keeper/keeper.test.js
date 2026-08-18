// Unit tests for quoteMinOut, the AVNU-quoted slippage floor that protects
// every execute_batch call. Uses node:test (built into Node >=18) rather
// than a new dependency, and mocks global.fetch instead of hitting AVNU.
//
// keeper.js reads ICEBERG_ADDRESS/IN_TOKEN/OUT_TOKEN from the environment at
// import time with no fallback, and constructs a starknet.js Contract as a
// module-level side effect — so these must be set, and the import must be
// dynamic (static imports are hoisted before any top-level code in this
// file would run, which would defeat setting them first).

import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ICEBERG_ADDRESS ??= "0x1";
process.env.IN_TOKEN ??= "0x2";
process.env.OUT_TOKEN ??= "0x3";
process.env.MIN_OUT_SOURCE ??= "avnu";
process.env.SLIPPAGE_BPS ??= "100"; // 1%, matches the module's own default

const { quoteMinOut } = await import("./keeper.js");

function withMockFetch(mock, run) {
  const original = global.fetch;
  global.fetch = mock;
  return run().finally(() => {
    global.fetch = original;
  });
}

test("quoteMinOut returns 0n for a zero sell amount without calling fetch", async () => {
  await withMockFetch(
    async () => {
      throw new Error("fetch should not be called for a zero sell amount");
    },
    async () => {
      assert.equal(await quoteMinOut(0n), 0n);
    },
  );
});

test("quoteMinOut applies the slippage haircut to the AVNU quote", async () => {
  await withMockFetch(
    async (url) => {
      assert.match(String(url), /sellAmount=0x64/); // 100 in hex
      return { ok: true, json: async () => [{ buyAmount: "1000" }] };
    },
    async () => {
      // 1000 * (10000 - 100) / 10000 = 990
      assert.equal(await quoteMinOut(100n), 990n);
    },
  );
});

test("quoteMinOut throws when AVNU responds with a non-ok status", async () => {
  await withMockFetch(
    async () => ({ ok: false, status: 500 }),
    async () => {
      await assert.rejects(() => quoteMinOut(100n), /avnu quote failed: 500/);
    },
  );
});

test("quoteMinOut throws when AVNU returns no quotes", async () => {
  await withMockFetch(
    async () => ({ ok: true, json: async () => [] }),
    async () => {
      await assert.rejects(() => quoteMinOut(100n), /avnu returned no quotes/);
    },
  );
});
