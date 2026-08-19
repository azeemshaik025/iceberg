// The REAL STRK20 pool flow for Iceberg, via the Wallet API (WalletAccountV6)
// rather than the SDK-direct route: the connected wallet (Ready) does its own
// proving and discovery internally, so this app never touches a proving URL,
// a discovery URL, or a viewing key. That means this flow is NOT blocked on
// StarkWare publishing mainnet proving/discovery endpoints (strk20-hackathon
// issue #31, still unresolved) — only on the user having a STRK20-capable
// wallet installed.
//
// Verified against Philoxenia (github.com/SergioSSantiago/philoxenia), the
// STRK20 Private Sprint project that shipped this exact route on mainnet with
// a working demo; its withdraw+invoke and OPEN-note+invoke action shapes are
// mirrored here for CreatePlan/Claim/Cancel.
//
// Flow shapes:
//   create: withdraw in_token to Iceberg + invoke CreatePlan   (no open note —
//           matches Philoxenia's zero-leftover anonymizer call exactly; the
//           pool asserts UNDEPOSITED_OPEN_NOTES == 0, so opening one with
//           nothing to fill it reverts)
//   claim:  open note for out_token + invoke Claim(secret, ${openNoteIds[0]})
//   cancel: open note for in_token  + invoke Cancel(secret, ${openNoteIds[0]})
// The ${openNoteIds[N]} placeholder is resolved by the wallet at submission
// time to the note id created by the Nth "OPEN" action in the same
// transaction — see strk20-by-example.org/starknet-wallet-api/private-defi.

import { hash, shortString } from "starknet";
import { resolvePrivacyWallet } from "./wallet-account-v6.js";

export const MAINNET_POOL =
  "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";

const OP_CREATE = "0x0";
const OP_CLAIM = "0x1";
const OP_CANCEL = "0x2";

export const secretToFelt = (secretText) =>
  secretText.startsWith("0x") ? secretText : shortString.encodeShortString(secretText);

/// Must match Cairo: poseidon_hash_span(['iceberg.plan.v1', secret]).
const planCommitment = (secret) =>
  hash.computePoseidonHashOnElements([
    shortString.encodeShortString("iceberg.plan.v1"),
    secretToFelt(secret),
  ]);

/// Wallet API FELTs must be 0x-hex — decimal strings are rejected as
/// INVALID_REQUEST_PAYLOAD.
const toWalletFelt = (value) => `0x${BigInt(value).toString(16)}`;

const viewCall = async (provider, contractAddress, entrypoint) => {
  const result = await provider.callContract({ contractAddress, entrypoint, calldata: [] });
  return result[0];
};

/// in_token/out_token are immutable on Iceberg once deployed, so caching by
/// address is always safe — same convention as devnet-writer.js's viewCall.
const tokenCache = new Map();
async function resolveTokens(provider, icebergAddress) {
  if (tokenCache.has(icebergAddress)) return tokenCache.get(icebergAddress);
  const [inToken, outToken] = await Promise.all([
    viewCall(provider, icebergAddress, "in_token"),
    viewCall(provider, icebergAddress, "out_token"),
  ]);
  const tokens = { inToken, outToken };
  tokenCache.set(icebergAddress, tokens);
  return tokens;
}

/// Connects to a STRK20-capable wallet, throwing a clear, user-facing error
/// if none is found or it doesn't support the wallet API — never a silent
/// fallback to a public flow.
async function connectPrivacyWallet(provider) {
  const session = await resolvePrivacyWallet(provider);
  if (!session) {
    throw new Error("No Starknet wallet extension found — install Ready to use the pool flow.");
  }
  if (!session.privacyCapable) {
    throw new Error(
      "Ready is connected but doesn't support STRK20 (wallet API >= 0.10 required) — " +
        "enable Smart Wallet + Private in Ready and reconnect.",
    );
  }
  return session.account;
}

/// Shield in_token into the pool (public step: address+amount visible by design).
export async function shield(provider, token, amount) {
  const account = await connectPrivacyWallet(provider);
  const actions = [{ type: "deposit", token, amount: toWalletFelt(amount) }];
  const { transaction_hash } = await account.strk20InvokeTransaction(actions);
  return transaction_hash;
}

/// Anonymous plan creation: withdraws chunk*numChunks of in_token to the
/// Iceberg helper and invokes privacy_invoke(CreatePlan) in the same proof.
export async function createPlan(provider, params) {
  const account = await connectPrivacyWallet(provider);
  const { icebergAddress, chunkAmount, numChunks, secret } = params;
  const { inToken } = await resolveTokens(provider, icebergAddress);
  const total = chunkAmount * BigInt(numChunks);
  const actions = [
    { type: "withdraw", token: inToken, amount: toWalletFelt(total), recipient: icebergAddress },
    {
      type: "invoke",
      contract: icebergAddress,
      calldata: [
        OP_CREATE,
        planCommitment(secret),
        toWalletFelt(chunkAmount),
        toWalletFelt(numChunks),
      ],
    },
  ];
  const { transaction_hash } = await account.strk20InvokeTransaction(actions);
  return transaction_hash;
}

/// Anonymous claim: opens a note for out_token, then invokes Claim with that
/// note's id — the pool credits it with the plan's accrued OpenNoteDeposit.
export async function claim(provider, params) {
  const account = await connectPrivacyWallet(provider);
  const { icebergAddress, secret } = params;
  const { outToken } = await resolveTokens(provider, icebergAddress);
  const actions = [
    { type: "transfer", token: outToken, amount: "OPEN", recipient: account.address },
    {
      type: "invoke",
      contract: icebergAddress,
      calldata: [OP_CLAIM, secretToFelt(secret), "${openNoteIds[0]}"],
    },
  ];
  const { transaction_hash } = await account.strk20InvokeTransaction(actions);
  return transaction_hash;
}

/// Anonymous cancel: opens a note for in_token, then invokes Cancel with that
/// note's id — the pool credits it with the unswapped refund.
export async function cancel(provider, params) {
  const account = await connectPrivacyWallet(provider);
  const { icebergAddress, secret } = params;
  const { inToken } = await resolveTokens(provider, icebergAddress);
  const actions = [
    { type: "transfer", token: inToken, amount: "OPEN", recipient: account.address },
    {
      type: "invoke",
      contract: icebergAddress,
      calldata: [OP_CANCEL, secretToFelt(secret), "${openNoteIds[0]}"],
    },
  ];
  const { transaction_hash } = await account.strk20InvokeTransaction(actions);
  return transaction_hash;
}
