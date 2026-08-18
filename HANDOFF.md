# Iceberg — handoff notes

State as of Aug 18. Contracts, keeper, UI, and the devnet demo loop are done and verified.
What's left is mainnet (M4) and submission polish (M5). Deadline: **Aug 31, 23:59 UTC**.

## Run the demo loop locally

Toolchain (already in `~/.local/bin` on Azeem's machine; versions match StarkWare's repo pins):
scarb 2.17.0 · snforge 0.59.0 · universal-sierra-compiler · starknet-devnet 0.8.0-rc.3 · Node ≥ 24

```bash
cd contracts && snforge test          # 16 unit tests + 1 mainnet-fork test (needs RPC)
scarb build                           # REQUIRED before deploying — snforge does NOT build deploy artifacts

starknet-devnet --seed 0 --port 5050  # terminal 1
# terminal 2 — devnet freezes chain time between txs; this ticker advances it:
while true; do curl -s localhost:5050 -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"devnet_createBlock","params":{},"id":1}' >/dev/null; sleep 20; done

cd keeper && npm i && node deploy-devnet.mjs   # deploys mocks+Iceberg, creates 2 demo plans
# keeper (envs come from ../devnet-deployment.json):
RPC_URL=http://localhost:5050 ICEBERG_ADDRESS=<from json> KEEPER_ADDRESS=<json> \
KEEPER_PRIVATE_KEY=<json> IN_TOKEN=<json> OUT_TOKEN=<json> \
MIN_OUT_SOURCE=none POLL_INTERVAL_S=15 JITTER_MAX_S=5 node keeper.js

cd ui && npm i && npm run dev         # paste RPC + iceberg address in the top bar
# demo plan secrets: demo-alice / demo-bob; interval = 60s on devnet
```

## What's left

### M4 — mainnet (blocked partly on StarkWare)

1. **BLOCKER: StarkWare has not published the proving/discovery service URLs**
   (promised "before Aug 14"; [issue #31](https://github.com/starkience/strk20-hackathon/issues/31)
   is unanswered). Without them no team can build private txs. Watch that issue;
   consider commenting that we're endpoint-blocked with mainnet-ready code.
   Note: AVNU private swaps are live in prod, so the infra exists — only URLs are missing.
2. Deploy `EkuboAdapter` + `Iceberg` (constructor: pool, keeper, in, out, adapter, selector("swap"), interval).
   Mainnet constants: pool `0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a`,
   Ekubo router v3.0.13 `0x0199741822c2dc722f6f605204f35e56dbc23bceed54818168c4c49e4fb8737e`,
   ETH/USDC pool key = (fee `170141183460469235273462165868118016`, tick_spacing `1000`, extension `0`)
   — the exact key the passing fork test uses.
3. Activate the real pool flow in the UI: install the privacy SDK
   (`npm i "starkware-libs/starknet-privacy#<commit>"` or the GitHub-Packages route),
   swap the dynamic import in `ui/src/strk20.js` for a static one, fill proving/discovery
   URLs. The flow code is already written and matches the SDK README examples.
4. Run **3+ mainnet txs that touch the pool** (register → shield → private op). Budget a few
   STRK. Mind the ~10-block rule: wait ~10 blocks between a private tx (or a funding
   transfer) and the next proof.

### Pre-mainnet security review (2026-08-18)

Full writeup: [Iceberg Pre-Mainnet Review](https://claude.ai/code/artifact/783657ca-786d-4e13-b557-25cac5bac578)
— manual line-by-line pass on `iceberg.cairo` + `ekubo_adapter.cairo` against the Cairo/StarkNet
vulnerability checklist, cross-checked with a fresh `snforge test` run (21/21 pass). **No
fund-loss-critical findings.**

Two things to decide on before deploying:

1. `execute_batch` is gated to the single `keeper` address (`iceberg.cairo:266`) — SPEC.md and the
   module docs say permissionless, the code doesn't. No fund risk (`cancel()` always works
   regardless of keeper liveness), but if the keeper dies every active plan silently stalls.
   Either fix the docs to match reality, or actually remove the gate — the function has no
   caller-benefit to exploit, so opening it costs nothing in safety.
2. No admin functions anywhere — `keeper`/`pool_address`/`swap_router`/tokens are permanently
   fixed at construction. If the keeper key is ever lost, there's no rotation path short of a full
   redeploy. Probably fine as a v1 tradeoff, but it means the keeper key needs real custody from
   day one, not a throwaway dev key.

Checklist for the actual deploy tx:
- [ ] Reconcile SPEC.md's "permissionless" wording against the keeper-gated code (or remove the gate)
- [ ] Confirm the deployed keeper's private key is a real, permanent credential, not a dev key
- [ ] Confirm `MIN_OUT_SOURCE=avnu` in the mainnet keeper env, never `none`
- [ ] Re-run `snforge test` (incl. the fork test) immediately before deploying
- [ ] Verify constructor args against real mainnet addresses (pool, Ekubo router, ETH/USDC pool key — same ones the fork test already pins)
- [ ] Confirm the deploy targets `Iceberg`/`EkuboAdapter` by exact class name, not a `Mock*`

### M5 — submission

- Real README (architecture, honest privacy model below, run instructions) + MIT LICENSE
- `strk20.json` at repo root: 3 mainnet tx hashes, contract addresses, 3-min video URL, demo URL
- UI → GitHub Pages (`vite build` is already Pages-compatible, `base: "./"`)
- Register: PR adding repo URL + telegram usernames to strk20-hackathon `registry.json`
- Flip repo public before the deadline (required; Pages needs it too)

## Honest privacy model (use this wording, don't overclaim)

Hidden: who created any plan, per-user totals, schedules (mixed across the batch), claim identity.
Public: individual chunk amounts (unlinked), each batch's aggregate swap and timing, net flow.
Deposits into the pool are public and compliance-screened by design. Never claim amount privacy
for swaps — identity privacy + mixing is the claim (this mirrors the organizers' day-0 doc).

## Gotchas already paid for

- `snforge test` compiles test targets only — **run `scarb build`** before any deploy or the
  script ships stale classes.
- Devnet: use instant blocks + the createBlock ticker. `--block-generation-on 30` breaks
  starknet.js nonce sequencing.
- starknet.js v10: `new Contract({abi, address, providerOrAccount})`, `new Account({provider,
  address, signer})`, `waitForTransaction` lives on the provider.
- Vite: an import of the not-yet-installed SDK must stay a variable-specifier dynamic import.
- Keeper on mainnet: `MIN_OUT_SOURCE=avnu` (never `none`).
- Cancel-then-claim is two txs (one pool invoke per tx — protocol rule).
