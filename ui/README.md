# ui

Split-screen demo: the public batch feed (what the chain sees) next to a secret-decoded plan view
(what only you see), plus an action panel to create/claim/cancel plans live against a local devnet.

## Run

```bash
npm i
npm run dev
```

Paste an RPC URL and the deployed Iceberg contract address into the top bar.

## Fields

- **RPC URL** — defaults to `http://localhost:5050`. Against a URL containing `localhost` or
  `127.0.0.1` the demo action panel goes live; against anything else it's read-only and shows the
  pool-mode status instead (see below).
- **In / out decimals** — decimals of `in_token` / `out_token`, used only for display formatting,
  not sent on-chain.
- **Plan secret** — the same secret you'd pass to `Iceberg::privacy_invoke`. Stored in this
  browser's `localStorage` for convenience; the chain only ever sees its Poseidon commitment. This
  is a demo convenience, not a wallet — don't reuse a secret guarding real funds beyond small test
  amounts.

## Source layout

- **`iceberg.js`** — read-only: contract views (`plan`, `accrued_out`, `active_chunk_rate`, …) plus
  a `BatchExecuted` event scan for the public feed. Full from-block-0 scan on every poll — fine on
  a fresh local devnet, would need incremental fetching against real mainnet history.
- **`devnet-writer.js`** — demo-mode writes. Auto-detects devnet's prefunded account from
  `devnet_getPredeployedAccounts` (zero configuration) and signs `privacy_invoke` calls with it,
  standing in for the STRK20 pool so create/claim/cancel can be exercised end-to-end without the
  real privacy SDK.
- **`strk20.js`** — the real pool flow: anonymous `privacy_invoke` calls routed through STRK20 via
  the privacy SDK (viewing-key derivation, shield, create/claim/cancel as private transfers).
  Code-complete; inactive until StarkWare publishes the mainnet proving/discovery service URLs —
  see the file header for the exact activation steps once they land.
