// Local demo deployment: mock tokens + MockAMM + Iceberg on starknet-devnet,
// plus two demo plans so batches genuinely mix. Writes devnet-deployment.json.

import { readFileSync, writeFileSync } from "node:fs";
import { Account, Contract, RpcProvider, hash, shortString } from "starknet";

const RPC_URL = "http://localhost:5050";
const TARGET = "../contracts/target/dev";
const INTERVAL_SECONDS = 60n;

const provider = new RpcProvider({ nodeUrl: RPC_URL });

const artifact = (name) => ({
  contract: JSON.parse(readFileSync(`${TARGET}/iceberg_${name}.contract_class.json`, "utf8")),
  casm: JSON.parse(
    readFileSync(`${TARGET}/iceberg_${name}.compiled_contract_class.json`, "utf8"),
  ),
});

const planCommitment = (secretText) =>
  hash.computePoseidonHashOnElements([
    shortString.encodeShortString("iceberg.plan.v1"),
    shortString.encodeShortString(secretText),
  ]);

const accountsResponse = await fetch(RPC_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    method: "devnet_getPredeployedAccounts",
    params: {},
    id: 1,
  }),
});
const accounts = (await accountsResponse.json()).result;
const deployer = new Account({
  provider,
  address: accounts[0].address,
  signer: accounts[0].private_key,
});
console.log(`deployer: ${deployer.address}`);

async function declareAndDeploy(name, constructorCalldata = []) {
  const { contract, casm } = artifact(name);
  const result = await deployer.declareAndDeploy({ contract, casm, constructorCalldata });
  const address = result.deploy.contract_address;
  console.log(`${name}: ${address}`);
  return address;
}

const inTokenAddress = await declareAndDeploy("MockERC20");
// Same class, second instance: deployAndDeclare would re-declare; use UDC deploy.
const { deploy: outDeploy } = await deployer.declareAndDeploy({
  ...artifact("MockERC20"),
  constructorCalldata: [],
  salt: "0x2",
});
const outTokenAddress = outDeploy.contract_address;
console.log(`MockERC20(out): ${outTokenAddress}`);

// 1 in-token (18 dec) = 2 out-tokens (6 dec): out = in * 2 / 1e12.
const ammAddress = await declareAndDeploy("MockAMM", ["0x2", "0xe8d4a51000"]);
const icebergAddress = await declareAndDeploy("Iceberg", [
  deployer.address, // pool  (deployer stands in for the STRK20 pool locally)
  deployer.address, // keeper
  inTokenAddress,
  outTokenAddress,
  ammAddress,
  hash.getSelectorFromName("swap"),
  `0x${INTERVAL_SECONDS.toString(16)}`,
]);

const erc20Abi = [
  {
    type: "function",
    name: "mint",
    inputs: [
      { name: "recipient", type: "core::starknet::contract_address::ContractAddress" },
      { name: "amount", type: "core::integer::u256" },
    ],
    outputs: [],
    state_mutability: "external",
  },
];
const inToken = new Contract({
  abi: erc20Abi,
  address: inTokenAddress,
  providerOrAccount: deployer,
});
const outToken = new Contract({
  abi: erc20Abi,
  address: outTokenAddress,
  providerOrAccount: deployer,
});

// AMM out-side liquidity.
await deployer.execute(outToken.populate("mint", [ammAddress, 10n ** 15n]));

// Two demo plans, funded then created through privacy_invoke (deployer = pool).
const plans = [
  { secret: "demo-alice", chunk: 100n * 10n ** 18n, chunks: 5n },
  { secret: "demo-bob", chunk: 250n * 10n ** 18n, chunks: 3n },
];
for (const plan of plans) {
  const total = plan.chunk * plan.chunks;
  await deployer.execute(inToken.populate("mint", [icebergAddress, total]));
  await deployer.execute({
    contractAddress: icebergAddress,
    entrypoint: "privacy_invoke",
    calldata: [
      "0x0", // IcebergOperation::CreatePlan
      planCommitment(plan.secret),
      `0x${plan.chunk.toString(16)}`,
      `0x${plan.chunks.toString(16)}`,
    ],
  });
  console.log(`plan '${plan.secret}': ${plan.chunk / 10n ** 18n} x${plan.chunks}`);
}

const deployment = {
  rpcUrl: RPC_URL,
  inToken: inTokenAddress,
  outToken: outTokenAddress,
  amm: ammAddress,
  iceberg: icebergAddress,
  keeperAddress: deployer.address,
  keeperPrivateKey: accounts[0].private_key,
};
writeFileSync("../devnet-deployment.json", JSON.stringify(deployment, null, 2));
console.log("wrote devnet-deployment.json");
