//! Fork tests: the full Iceberg pipeline against REAL mainnet Ekubo liquidity.
//! Funding trick: Ekubo Core holds deep balances of every listed token, so the
//! test impersonates it to fund the helper (simulating the pool's withdraw leg).

use iceberg::ekubo_adapter::{IERC20Dispatcher, IERC20DispatcherTrait};
use iceberg::iceberg::Iceberg::plan_commitment;
use iceberg::iceberg::{
    ClaimParams, CreatePlanParams, IIcebergDispatcher, IIcebergDispatcherTrait, IcebergOperation,
};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_timestamp_global,
    start_cheat_caller_address, stop_cheat_caller_address,
};
use starknet::ContractAddress;

const ETH: felt252 = 0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7;
const USDC: felt252 = 0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8;
const EKUBO_ROUTER: felt252 = 0x0199741822c2dc722f6f605204f35e56dbc23bceed54818168c4c49e4fb8737e;
const EKUBO_CORE: felt252 = 0x00000005dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b;
/// ETH/USDC 0.05% pool (token0 = ETH < USDC numerically).
const POOL_FEE: felt252 = 170141183460469235273462165868118016;
const POOL_TICK_SPACING: felt252 = 1000;

const FORK_GENESIS: u64 = 2_000_000_000;
const INTERVAL: u64 = 3600;
/// 0.005 ETH per chunk — tiny against mainnet pool depth.
const CHUNK: u128 = 5_000_000_000_000_000;

#[test]
#[fork("MAINNET")]
fn test_fork_full_pipeline_on_real_ekubo() {
    start_cheat_block_timestamp_global(FORK_GENESIS);
    let pool: ContractAddress = 'POOL'.try_into().unwrap();
    let keeper: ContractAddress = 'KEEPER'.try_into().unwrap();
    let eth: ContractAddress = ETH.try_into().unwrap();
    let usdc: ContractAddress = USDC.try_into().unwrap();
    let ekubo_core: ContractAddress = EKUBO_CORE.try_into().unwrap();

    let adapter_class = declare("EkuboAdapter").unwrap().contract_class();
    let (adapter_address, _) = adapter_class
        .deploy(@array![EKUBO_ROUTER, ETH, USDC, POOL_FEE, POOL_TICK_SPACING, 0])
        .unwrap();

    let iceberg_class = declare("Iceberg").unwrap().contract_class();
    let (iceberg_address, _) = iceberg_class
        .deploy(
            @array![
                pool.into(), keeper.into(), ETH, USDC, adapter_address.into(), selector!("swap"),
                INTERVAL.into(),
            ],
        )
        .unwrap();
    let iceberg = IIcebergDispatcher { contract_address: iceberg_address };

    // Fund the helper with 2 chunks of real ETH by impersonating Ekubo Core.
    let eth_erc20 = IERC20Dispatcher { contract_address: eth };
    start_cheat_caller_address(eth, ekubo_core);
    eth_erc20.transfer(iceberg_address, (CHUNK * 2).into());
    stop_cheat_caller_address(eth);

    // Create a 2-chunk plan as the privacy pool.
    start_cheat_caller_address(iceberg_address, pool);
    iceberg
        .privacy_invoke(
            IcebergOperation::CreatePlan(
                CreatePlanParams {
                    commitment: plan_commitment('fork-secret'), chunk_amount: CHUNK, num_chunks: 2,
                },
            ),
        );
    stop_cheat_caller_address(iceberg_address);

    // Execute the schedule against the live pool state.
    start_cheat_block_timestamp_global(FORK_GENESIS + 3 * INTERVAL);
    start_cheat_caller_address(iceberg_address, keeper);
    assert!(iceberg.execute_batch(0) == 0, "interval 0 has no active plans");
    let first_out = iceberg.execute_batch(0);
    let second_out = iceberg.execute_batch(0);
    stop_cheat_caller_address(iceberg_address);

    // 0.005 ETH must fetch at least 0.1 USDC each on any sane market.
    assert!(first_out > 100_000, "first batch swapped on real Ekubo");
    assert!(second_out > 100_000, "second batch swapped on real Ekubo");

    let usdc_erc20 = IERC20Dispatcher { contract_address: usdc };
    let iceberg_usdc_balance = usdc_erc20.balance_of(iceberg_address);
    assert!(
        iceberg_usdc_balance == (first_out + second_out).into(),
        "all output custodied by iceberg",
    );

    // Claim as the pool: approve-then-pull, like the real OpenNoteDeposit flow.
    let accrued = iceberg.accrued_out(plan_commitment('fork-secret'));
    assert!(accrued > 0 && accrued <= first_out + second_out, "accrual within received");
    start_cheat_caller_address(iceberg_address, pool);
    let deposits = iceberg
        .privacy_invoke(
            IcebergOperation::Claim(ClaimParams { secret: 'fork-secret', note_id: 'note-1' }),
        );
    stop_cheat_caller_address(iceberg_address);
    let deposit = *deposits.at(0);
    assert!(deposit.token == usdc, "claim pays out USDC");
    assert!(deposit.amount == accrued, "claim pays full accrual");

    start_cheat_caller_address(usdc, pool);
    usdc_erc20.transfer_from(iceberg_address, pool, deposit.amount.into());
    stop_cheat_caller_address(usdc);
    assert!(usdc_erc20.balance_of(pool) == deposit.amount.into(), "pool pulled real USDC");
}
