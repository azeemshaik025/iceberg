# ui

The demo interface. A waterline splits the page. Above it sits the public batch feed, which is
what the chain sees. Below it sits your decoded plan, which is what only you can see. An action
panel creates, claims, and cancels plans live against a local devnet.

## Run

```bash
npm i
npm run dev
```

Open the Settings drawer from the header. Enter an RPC URL and the deployed Iceberg contract
address.

## Settings

- **RPC URL.** The default is `http://localhost:5050`. If the URL contains `localhost` or
  `127.0.0.1`, the action panel goes live. Any other URL makes the page read-only and shows the
  pool-mode status instead. The section below explains why.
- **In and out decimals.** These are the decimals of the input and output tokens. The interface
  uses them to format numbers. It never sends them on-chain.
- **In and out symbols.** These label the amounts, for example USDC and ETH. They are display
  labels only.
- **Plan secret.** This is the same secret you pass to `Iceberg::privacy_invoke`. The browser keeps
  it in `localStorage` for convenience, and the chain only ever sees its Poseidon commitment. Treat
  this as a demo convenience and not a wallet. Do not reuse a secret that guards real funds beyond
  small test amounts.

## Source layout

- **`iceberg.js`** reads only. It calls the contract views, which include `plan`, `accrued_out`,
  and `active_chunk_rate`. It also scans `BatchExecuted` events for the public feed. The scan is
  incremental. It takes the block to resume from and returns the next cursor, so polling never
  re-reads blocks it already fetched.
- **`devnet-writer.js`** performs the demo-mode writes. It finds devnet's prefunded account through
  `devnet_getPredeployedAccounts`, which needs no configuration. It signs `privacy_invoke` calls
  with that account. The account stands in for the STRK20 pool, so you can exercise create, claim,
  and cancel from end to end without the real privacy SDK.
- **`strk20.js`** performs the real pool flow. It derives the viewing key, shields tokens, and
  sends create, claim, and cancel as anonymous private transfers through the SDK. The code is
  complete but inactive. It stays inactive until StarkWare publishes the mainnet proving and
  discovery service URLs. The file header lists the exact steps to activate it.
