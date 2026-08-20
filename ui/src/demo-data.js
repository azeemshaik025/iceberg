// Real data captured from one local devnet run — two seeded plans
// (demo-alice: 100 x5, demo-bob: 250 x3) executed against the actual
// Iceberg contract, real tx hashes included. Shown only when there is no
// live status yet (no contract configured, or the RPC hasn't answered), so a
// cold visitor sees the real shape of the product instead of a blank page.
// Always rendered through a visible "demo data" tag — never presented as live.

export const DEMO_SECRET = "demo-alice";

export const DEMO_STATUS = {
  nextInterval: 7n,
  currentInterval: 7n,
  chunkRate: 0n,
};

export const DEMO_BATCHES = [
  {
    interval: 6n,
    inAmount: 0n,
    outAmount: 0n,
    txHash: "0x68d92cb3b3c211e1f913fd6f685e85c83666c69057a3b4bfe8409547ccd2528",
  },
  {
    interval: 5n,
    inAmount: 100000000000000000000n,
    outAmount: 200000000n,
    txHash: "0x74fefe4c5fa7e8829806629034d3b68d825d609562bebe4a926a7aa56cb7ee6",
  },
  {
    interval: 4n,
    inAmount: 100000000000000000000n,
    outAmount: 200000000n,
    txHash: "0x3d03f72a272b7cad22c32db5c747bb6b7bdaeb2d56fb99f9bd8ba3ceacd4143",
  },
  {
    interval: 3n,
    inAmount: 350000000000000000000n,
    outAmount: 700000000n,
    txHash: "0x6770b50ea0b46c64751505861c5f36afc463c9d072223645faee1d54b11d7bc",
  },
  {
    interval: 2n,
    inAmount: 350000000000000000000n,
    outAmount: 700000000n,
    txHash: "0x7a045be78d92e0dfa2866b31e50c4358d81bcdcb949c722b3fe5795ccaa24d9",
  },
  {
    interval: 1n,
    inAmount: 350000000000000000000n,
    outAmount: 700000000n,
    txHash: "0x6f5e980feed5ed899567e9d822d2f7729b46794910802b85a98e53b351d812a",
  },
  {
    interval: 0n,
    inAmount: 0n,
    outAmount: 0n,
    txHash: "0x5a4b6d0808664f11a8d52a3abc41ab1d75a054268325413783f27d461b7fc82",
  },
];

// demo-alice: 100 x5, interval window 1–5. Intervals 1–3 also carried
// demo-bob's chunk (250 each) — the mixing panel picks interval 1, the
// first interval where both plans' chunks became one swap.
export const DEMO_PLAN = {
  exists: true,
  chunkAmount: 100000000000000000000n,
  startInterval: 1n,
  endInterval: 5n,
  claimedOut: 0n,
  accruedOut: 1000000000n,
};
