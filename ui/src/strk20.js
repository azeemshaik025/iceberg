// The REAL STRK20 pool flow for Iceberg: create plans, claim, and cancel as
// anonymous privacy_invoke transactions through StarkWare's shielded pool.
//
// Status: code-complete, awaiting activation. StarkWare has not yet published
// the mainnet proving-service and discovery-service URLs (tracked in
// strk20-hackathon issue #31). Until then `isPoolModeReady` returns false and
// the UI falls back to the devnet demo writer. To activate:
//   1. npm i <starkware privacy SDK>   (@starkware-libs/starknet-privacy-sdk)
//   2. fill provingUrl + discoveryUrl in the UI config
//
// Flow shapes follow the SDK README examples (anonymous Ekubo swap / escrow):
//   create: withdraw in_token to Iceberg + invoke CreatePlan   (no open note)
//   claim:  open note for out_token + invoke Claim(secret, note_id)
//   cancel: open note for in_token  + invoke Cancel(secret, note_id)

import { ec, hash, shortString } from "starknet";

export const MAINNET_POOL =
  "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";

const OP_CREATE = "0x0";
const OP_CLAIM = "0x1";
const OP_CANCEL = "0x2";

export const secretToFelt = (secretText) =>
  secretText.startsWith("0x") ? secretText : shortString.encodeShortString(secretText);

export function isPoolModeReady(config) {
  return Boolean(config.provingUrl && config.discoveryUrl && config.poolAddress);
}

/// Canonical STRK20 viewing-key derivation (from the sprint's day-0 guide):
/// sign `${chainId}:${poolAddress}`, fold the signature with Poseidon, reduce
/// into the Stark curve order. The key never leaves the client.
export async function deriveViewingKey(account, chainId, poolAddress) {
  const typedData = {
    types: {
      StarkNetDomain: [{ name: "name", type: "felt" }],
      Message: [{ name: "message", type: "felt" }],
    },
    primaryType: "Message",
    domain: { name: "STRK20" },
    message: { message: hash.starknetKeccak(`${chainId}:${poolAddress}`) },
  };
  const signature = await account.signMessage(typedData);
  const [r, s] = Array.isArray(signature) ? signature : [signature.r, signature.s];
  const folded = BigInt(hash.computePoseidonHashOnElements([BigInt(r), BigInt(s)]));
  return folded % ec.starkCurve.CURVE.n;
}

/// Lazily loads the privacy SDK and builds a configured PrivateTransfers
/// instance. Throws with a clear message if the SDK is not installed yet.
async function loadTransfers(config, account, viewingKey) {
  let sdk;
  try {
    // M4 activation: install the SDK and replace this with a static import so
    // Vite pre-bundles it. Variable specifier + @vite-ignore keeps Vite from
    // resolving the not-yet-installed package at build time.
    const sdkSpecifier = "@starkware-libs/starknet-privacy-sdk";
    sdk = await import(/* @vite-ignore */ sdkSpecifier);
  } catch {
    throw new Error(
      "privacy SDK not installed - waiting on StarkWare mainnet endpoints (issue #31)",
    );
  }
  const { createPrivateTransfers, IndexerDiscoveryProvider, ProvingServiceProofProvider } = sdk;
  return {
    sdk,
    transfers: createPrivateTransfers({
      account,
      viewingKeyProvider: { getViewingKey: () => viewingKey },
      provingProvider: new ProvingServiceProofProvider(config.provingUrl, config.chainId),
      discoveryProvider: new IndexerDiscoveryProvider(config.discoveryUrl, config.poolAddress),
      poolContractAddress: config.poolAddress,
    }),
  };
}

const buildOptions = {
  autoRegister: true,
  autoSetup: true,
  autoSelectNotes: "all",
  autoDiscover: { notes: "refresh", channels: "refresh" },
};

/// Shield in_token into the pool (public step: address+amount visible by design).
export async function shield(config, account, viewingKey, token, amount) {
  const { transfers } = await loadTransfers(config, account, viewingKey);
  return transfers
    .build(buildOptions)
    .with(token, (tokenBuilder) => tokenBuilder.deposit({ amount }))
    .surplusTo(account.address)
    .execute();
}

/// Anonymous plan creation: the pool withdraws `chunk*numChunks` of in_token to
/// the Iceberg helper and calls privacy_invoke(CreatePlan) in the same proof.
export async function createPlan(config, account, viewingKey, params) {
  const { transfers } = await loadTransfers(config, account, viewingKey);
  const { icebergAddress, inToken, chunkAmount, numChunks, secret } = params;
  const total = chunkAmount * BigInt(numChunks);
  const commitment = hash.computePoseidonHashOnElements([
    shortString.encodeShortString("iceberg.plan.v1"),
    secretToFelt(secret),
  ]);
  return transfers
    .build(buildOptions)
    .with(inToken)
    .withdraw({ recipient: icebergAddress, amount: total })
    .surplusTo(account.address, false)
    .done()
    .invoke({
      contractAddress: icebergAddress,
      calldata: [
        OP_CREATE,
        commitment,
        `0x${chunkAmount.toString(16)}`,
        `0x${BigInt(numChunks).toString(16)}`,
      ],
    })
    .execute();
}

/// Anonymous claim: mint an Open note for out_token; the helper fills it with
/// the plan's accrued amount via the returned OpenNoteDeposit.
export async function claim(config, account, viewingKey, params) {
  const { sdk, transfers } = await loadTransfers(config, account, viewingKey);
  const { icebergAddress, outToken, secret } = params;
  return transfers
    .build(buildOptions)
    .with(outToken)
    .transfer({ recipient: account.address, amount: sdk.Open })
    .done()
    .invoke((args) => ({
      contractAddress: icebergAddress,
      calldata: [OP_CLAIM, secretToFelt(secret), args.openNotes[0].noteId],
    }))
    .execute();
}

/// Anonymous cancel: open note for in_token receives the unswapped refund.
export async function cancel(config, account, viewingKey, params) {
  const { sdk, transfers } = await loadTransfers(config, account, viewingKey);
  const { icebergAddress, inToken, secret } = params;
  return transfers
    .build(buildOptions)
    .with(inToken)
    .transfer({ recipient: account.address, amount: sdk.Open })
    .done()
    .invoke((args) => ({
      contractAddress: icebergAddress,
      calldata: [OP_CANCEL, secretToFelt(secret), args.openNotes[0].noteId],
    }))
    .execute();
}
