// Devnet demo writer: exercises the exact same privacy_invoke entrypoints as
// the real pool flow, but signed by devnet's prefunded account standing in for
// the STRK20 pool (which is how the local stack deploys Iceberg). Auto-detects
// the account from the devnet RPC — zero configuration.

import { Account, RpcProvider, hash, shortString } from "starknet";
import { secretToFelt } from "./strk20.js";

const OP_CREATE = "0x0";
const OP_CLAIM = "0x1";
const OP_CANCEL = "0x2";
// Real note ids come from the pool; any non-zero felt works for the demo.
const DEMO_NOTE_ID = shortString.encodeShortString("demo-note");

export const isDevnetRpc = (rpcUrl) =>
  rpcUrl.includes("localhost") || rpcUrl.includes("127.0.0.1");

async function devnetAccount(rpcUrl) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "devnet_getPredeployedAccounts",
      params: {},
      id: 1,
    }),
  });
  const [first] = (await response.json()).result;
  const provider = new RpcProvider({ nodeUrl: rpcUrl });
  return {
    provider,
    account: new Account({ provider, address: first.address, signer: first.private_key }),
  };
}

const viewCall = async (rpcUrl, contractAddress, entrypoint) => {
  const provider = new RpcProvider({ nodeUrl: rpcUrl });
  const result = await provider.callContract({ contractAddress, entrypoint, calldata: [] });
  return result[0];
};

/// Fund (mint, simulating the pool's withdraw leg) + create in ONE multicall,
/// mirroring the atomicity of the real anonymizer sandwich.
export async function createPlanDemo({ rpcUrl, icebergAddress, chunkAmount, numChunks, secret }) {
  const { account, provider } = await devnetAccount(rpcUrl);
  const inToken = await viewCall(rpcUrl, icebergAddress, "in_token");
  const total = chunkAmount * BigInt(numChunks);
  const commitment = hash.computePoseidonHashOnElements([
    shortString.encodeShortString("iceberg.plan.v1"),
    secretToFelt(secret),
  ]);
  const { transaction_hash } = await account.execute([
    {
      contractAddress: inToken,
      entrypoint: "mint",
      calldata: [icebergAddress, `0x${total.toString(16)}`, "0x0"],
    },
    {
      contractAddress: icebergAddress,
      entrypoint: "privacy_invoke",
      calldata: [
        OP_CREATE,
        commitment,
        `0x${chunkAmount.toString(16)}`,
        `0x${BigInt(numChunks).toString(16)}`,
      ],
    },
  ]);
  await provider.waitForTransaction(transaction_hash);
  return transaction_hash;
}

export async function claimDemo({ rpcUrl, icebergAddress, secret }) {
  const { account, provider } = await devnetAccount(rpcUrl);
  const { transaction_hash } = await account.execute({
    contractAddress: icebergAddress,
    entrypoint: "privacy_invoke",
    calldata: [OP_CLAIM, secretToFelt(secret), DEMO_NOTE_ID],
  });
  await provider.waitForTransaction(transaction_hash);
  return transaction_hash;
}

export async function cancelDemo({ rpcUrl, icebergAddress, secret }) {
  const { account, provider } = await devnetAccount(rpcUrl);
  const { transaction_hash } = await account.execute({
    contractAddress: icebergAddress,
    entrypoint: "privacy_invoke",
    calldata: [OP_CANCEL, secretToFelt(secret), DEMO_NOTE_ID],
  });
  await provider.waitForTransaction(transaction_hash);
  return transaction_hash;
}
