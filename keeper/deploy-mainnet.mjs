// Mainnet deploy: EkuboAdapter + Iceberg, using the same constructor shapes
// and mainnet constants contracts/tests/test_ekubo_fork.cairo already
// verified against real Ekubo liquidity. Direction is fixed to in_token=ETH,
// out_token=USDC (scheduled exit) — the exact direction the fork test
// exercises, so this deploy carries zero new, previously-untested behavior.
//
// SAFETY: dry-run by default. Prints exactly what it would deploy and costs
// nothing. Pass --yes to actually declare+deploy and spend real gas.
//
// Required env (put these in keeper/.env — gitignored, never commit it,
// never paste DEPLOYER_PRIVATE_KEY anywhere else):
//   DEPLOYER_ADDRESS, DEPLOYER_PRIVATE_KEY   funded mainnet account, pays gas
//   KEEPER_ADDRESS                           the keeper bot's account address
//                                             (permanent once deployed — no
//                                             rotation function exists)
// Optional:
//   RPC_URL           default https://starknet-rpc.publicnode.com
//   INTERVAL_SECONDS  default 300 (5 min) — PERMANENT once deployed, no setter

import { readFileSync, writeFileSync } from "node:fs";
import { Account, RpcProvider, hash } from "starknet";

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`missing env: ${name}`);
  return value;
};

const RPC_URL = env("RPC_URL", "https://starknet-rpc.publicnode.com");
const DEPLOYER_ADDRESS = env("DEPLOYER_ADDRESS");
const DEPLOYER_PRIVATE_KEY = env("DEPLOYER_PRIVATE_KEY");
const KEEPER_ADDRESS = env("KEEPER_ADDRESS");
const INTERVAL_SECONDS = BigInt(env("INTERVAL_SECONDS", "300"));
const CONFIRMED = process.argv.includes("--yes");

// Verified mainnet constants — same ones the fork test pins in Scarb.toml
// and asserts real swaps against.
const POOL_ADDRESS = "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";
const EKUBO_ROUTER = "0x0199741822c2dc722f6f605204f35e56dbc23bceed54818168c4c49e4fb8737e";
const ETH = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
const USDC = "0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8";
const POOL_FEE = 170141183460469235273462165868118016n; // 0.05%
const POOL_TICK_SPACING = 1000n;

// Direction fixed to in_token=ETH, out_token=USDC. ETH < USDC numerically,
// so this also happens to be Ekubo's required token0/token1 order for the
// adapter — if this direction is ever flipped, the adapter's token0/token1
// below must stay ETH/USDC regardless (the adapter is bidirectional; only
// Iceberg's in_token/out_token encode a direction).
const IN_TOKEN = ETH;
const OUT_TOKEN = USDC;

const toHex = (value) => `0x${BigInt(value).toString(16)}`;

console.log(`RPC:        ${RPC_URL}`);
console.log(`deployer:   ${DEPLOYER_ADDRESS}`);
console.log(`keeper:     ${KEEPER_ADDRESS}`);
console.log(`direction:  in_token=ETH out_token=USDC (scheduled exit)`);
console.log(`interval:   ${INTERVAL_SECONDS}s`);

if (!CONFIRMED) {
  console.log("\nDRY RUN — nothing declared or deployed, no gas spent.");
  console.log("Would declare + deploy, in order:");
  console.log(
    "  1. EkuboAdapter(router=" +
      EKUBO_ROUTER +
      ", token0=ETH, token1=USDC, fee, tick_spacing, extension=0x0)",
  );
  console.log(
    "  2. Iceberg(pool, keeper, in_token=ETH, out_token=USDC, swap_router=<adapter>, " +
      "selector('swap'), interval_seconds)",
  );
  console.log("\nRe-run with --yes once you're ready to actually broadcast.");
  process.exit(0);
}

const provider = new RpcProvider({ nodeUrl: RPC_URL });
const deployer = new Account({
  provider,
  address: DEPLOYER_ADDRESS,
  signer: DEPLOYER_PRIVATE_KEY,
});

const TARGET = "../contracts/target/dev";
const artifact = (name) => ({
  contract: JSON.parse(readFileSync(`${TARGET}/iceberg_${name}.contract_class.json`, "utf8")),
  casm: JSON.parse(
    readFileSync(`${TARGET}/iceberg_${name}.compiled_contract_class.json`, "utf8"),
  ),
});

async function declareAndDeploy(name, constructorCalldata) {
  const { contract, casm } = artifact(name);
  const result = await deployer.declareAndDeploy({ contract, casm, constructorCalldata });
  const address = result.deploy.contract_address;
  console.log(`${name}: ${address} (tx ${result.deploy.transaction_hash})`);
  await provider.waitForTransaction(result.deploy.transaction_hash);
  return address;
}

const adapterAddress = await declareAndDeploy("EkuboAdapter", [
  EKUBO_ROUTER,
  IN_TOKEN,
  OUT_TOKEN,
  toHex(POOL_FEE),
  toHex(POOL_TICK_SPACING),
  "0x0",
]);

const icebergAddress = await declareAndDeploy("Iceberg", [
  POOL_ADDRESS,
  KEEPER_ADDRESS,
  IN_TOKEN,
  OUT_TOKEN,
  adapterAddress,
  hash.getSelectorFromName("swap"),
  toHex(INTERVAL_SECONDS),
]);

// Read the deployed contract's own state back rather than trust the
// constructor calldata blindly — catches an argument-ordering mistake
// immediately instead of discovering it after funds are already at stake.
const [readInToken, readOutToken] = await Promise.all([
  provider.callContract({ contractAddress: icebergAddress, entrypoint: "in_token", calldata: [] }),
  provider.callContract({ contractAddress: icebergAddress, entrypoint: "out_token", calldata: [] }),
]);
if (BigInt(readInToken[0]) !== BigInt(IN_TOKEN) || BigInt(readOutToken[0]) !== BigInt(OUT_TOKEN)) {
  throw new Error(
    "Deployed Iceberg's in_token/out_token don't match what was intended — " +
      "stop and investigate before doing anything else with this contract.",
  );
}
console.log("verified: deployed contract's in_token/out_token match intent");

const deployment = {
  rpcUrl: RPC_URL,
  pool: POOL_ADDRESS,
  ekuboRouter: EKUBO_ROUTER,
  inToken: IN_TOKEN,
  outToken: OUT_TOKEN,
  ekuboAdapter: adapterAddress,
  iceberg: icebergAddress,
  keeperAddress: KEEPER_ADDRESS,
  intervalSeconds: Number(INTERVAL_SECONDS),
};
writeFileSync("../mainnet-deployment.json", JSON.stringify(deployment, null, 2));
console.log("\nwrote mainnet-deployment.json");
console.log("Next: fund the keeper account with gas STRK, then run keeper.js with MIN_OUT_SOURCE=avnu (never none).");
