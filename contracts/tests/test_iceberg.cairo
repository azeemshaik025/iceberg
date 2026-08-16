use iceberg::iceberg::Iceberg::plan_commitment;
use iceberg::iceberg::{
    CancelParams, ClaimParams, CreatePlanParams, IIcebergDispatcher, IIcebergDispatcherTrait,
    IcebergOperation,
};
use iceberg::mocks::{
    IMockAMMDispatcher, IMockAMMDispatcherTrait, IMockERC20Dispatcher, IMockERC20DispatcherTrait,
};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_timestamp_global,
    start_cheat_caller_address, stop_cheat_caller_address,
};
use starknet::ContractAddress;

const GENESIS: u64 = 1_000_000;
const INTERVAL: u64 = 3600;

#[derive(Copy, Drop)]
struct Setup {
    iceberg: IIcebergDispatcher,
    in_token: IMockERC20Dispatcher,
    out_token: IMockERC20Dispatcher,
    amm: IMockAMMDispatcher,
    pool: ContractAddress,
    keeper: ContractAddress,
}

/// Deploys mocks + Iceberg at timestamp GENESIS with a 2:1 out-per-in AMM rate.
fn setup() -> Setup {
    start_cheat_block_timestamp_global(GENESIS);
    let pool: ContractAddress = 'POOL'.try_into().unwrap();
    let keeper: ContractAddress = 'KEEPER'.try_into().unwrap();

    let erc20_class = declare("MockERC20").unwrap().contract_class();
    let (in_token_address, _) = erc20_class.deploy(@array![]).unwrap();
    let (out_token_address, _) = erc20_class.deploy(@array![]).unwrap();

    let amm_class = declare("MockAMM").unwrap().contract_class();
    let (amm_address, _) = amm_class.deploy(@array![2, 1]).unwrap();

    let iceberg_class = declare("Iceberg").unwrap().contract_class();
    let (iceberg_address, _) = iceberg_class
        .deploy(
            @array![
                pool.into(), keeper.into(), in_token_address.into(), out_token_address.into(),
                amm_address.into(), selector!("swap"), INTERVAL.into(),
            ],
        )
        .unwrap();

    let out_token = IMockERC20Dispatcher { contract_address: out_token_address };
    // AMM liquidity for the out side.
    out_token.mint(amm_address, 1_000_000_000);

    Setup {
        iceberg: IIcebergDispatcher { contract_address: iceberg_address },
        in_token: IMockERC20Dispatcher { contract_address: in_token_address },
        out_token,
        amm: IMockAMMDispatcher { contract_address: amm_address },
        pool,
        keeper,
    }
}

/// Simulates the pool's withdraw leg: fund the helper, then create the plan
/// as the pool via privacy_invoke.
fn create_plan(setup: Setup, secret: felt252, chunk_amount: u128, num_chunks: u32) {
    let total: u256 = chunk_amount.into() * num_chunks.into();
    setup.in_token.mint(setup.iceberg.contract_address, total);
    start_cheat_caller_address(setup.iceberg.contract_address, setup.pool);
    let deposits = setup
        .iceberg
        .privacy_invoke(
            IcebergOperation::CreatePlan(
                CreatePlanParams {
                    commitment: plan_commitment(secret), chunk_amount, num_chunks,
                },
            ),
        );
    stop_cheat_caller_address(setup.iceberg.contract_address);
    assert!(deposits.len() == 0, "create must return empty span");
}

fn advance_to_interval(interval: u64) {
    start_cheat_block_timestamp_global(GENESIS + interval * INTERVAL);
}

fn execute_batch(setup: Setup, min_out: u128) -> u128 {
    start_cheat_caller_address(setup.iceberg.contract_address, setup.keeper);
    let out_amount = setup.iceberg.execute_batch(min_out);
    stop_cheat_caller_address(setup.iceberg.contract_address);
    out_amount
}

fn claim(setup: Setup, secret: felt252, note_id: felt252) -> u128 {
    start_cheat_caller_address(setup.iceberg.contract_address, setup.pool);
    let deposits = setup
        .iceberg
        .privacy_invoke(IcebergOperation::Claim(ClaimParams { secret, note_id }));
    stop_cheat_caller_address(setup.iceberg.contract_address);
    assert!(deposits.len() == 1, "claim must return one deposit");
    let deposit = *deposits.at(0);
    assert!(deposit.note_id == note_id, "claim note_id mismatch");
    assert!(deposit.token == setup.out_token.contract_address, "claim token mismatch");
    // Pull like the real pool does when applying OpenNoteDeposit instructions.
    start_cheat_caller_address(setup.out_token.contract_address, setup.pool);
    setup.out_token.transfer_from(setup.iceberg.contract_address, setup.pool, deposit.amount.into());
    stop_cheat_caller_address(setup.out_token.contract_address);
    deposit.amount
}

fn cancel(setup: Setup, secret: felt252, note_id: felt252) -> u128 {
    start_cheat_caller_address(setup.iceberg.contract_address, setup.pool);
    let deposits = setup
        .iceberg
        .privacy_invoke(IcebergOperation::Cancel(CancelParams { secret, note_id }));
    stop_cheat_caller_address(setup.iceberg.contract_address);
    assert!(deposits.len() == 1, "cancel must return one deposit");
    let deposit = *deposits.at(0);
    assert!(deposit.token == setup.in_token.contract_address, "cancel refunds in_token");
    start_cheat_caller_address(setup.in_token.contract_address, setup.pool);
    setup.in_token.transfer_from(setup.iceberg.contract_address, setup.pool, deposit.amount.into());
    stop_cheat_caller_address(setup.in_token.contract_address);
    deposit.amount
}

#[test]
fn test_single_plan_full_lifecycle() {
    let setup = setup();
    // 2 chunks of 100, created during interval 0 -> active intervals [1, 2].
    create_plan(setup, 'secret-1', 100, 2);
    let plan = setup.iceberg.plan(plan_commitment('secret-1'));
    assert!(plan.start_interval == 1 && plan.end_interval == 2, "plan window wrong");

    advance_to_interval(3);
    assert!(execute_batch(setup, 0) == 0, "interval 0 has no active plans");
    assert!(execute_batch(setup, 0) == 200, "interval 1 swaps 100 at 2:1");
    assert!(execute_batch(setup, 0) == 200, "interval 2 swaps 100 at 2:1");
    assert!(setup.iceberg.active_chunk_rate() == 0, "rate must expire after end");

    assert!(setup.iceberg.accrued_out(plan_commitment('secret-1')) == 400, "accrued 2x200");
    assert!(claim(setup, 'secret-1', 'note-1') == 400, "claim full accrual");
    assert!(setup.out_token.balance_of(setup.pool) == 400, "pool pulled the out tokens");
}

#[test]
#[should_panic(expected: 'NOTHING_TO_CLAIM')]
fn test_double_claim_rejected() {
    let setup = setup();
    create_plan(setup, 'secret-1', 100, 1);
    advance_to_interval(2);
    execute_batch(setup, 0);
    execute_batch(setup, 0);
    claim(setup, 'secret-1', 'note-1');
    claim(setup, 'secret-1', 'note-2');
}

#[test]
fn test_two_plans_pro_rata_with_price_change() {
    let setup = setup();
    // A: 2 chunks of 100 -> [1, 2]. B: 1 chunk of 300 -> [1, 1].
    create_plan(setup, 'secret-a', 100, 2);
    create_plan(setup, 'secret-b', 300, 1);

    advance_to_interval(2);
    execute_batch(setup, 0);
    // Interval 1: both active, 400 swapped at 2:1 -> 800 out, shared 1:3.
    assert!(execute_batch(setup, 0) == 800, "batch of both plans");

    // Price moves to 4:1 for interval 2 where only A remains.
    setup.amm.set_rate(4, 1);
    advance_to_interval(3);
    assert!(execute_batch(setup, 0) == 400, "only A's 100 swapped at 4:1");

    // A: 100*2 (interval 1) + 100*4 (interval 2) = 600. B: 300*2 = 600.
    assert!(claim(setup, 'secret-a', 'note-a') == 600, "A pro-rata across both prices");
    assert!(claim(setup, 'secret-b', 'note-b') == 600, "B only at first price");
    // Everything received was distributed exactly.
    assert!(setup.out_token.balance_of(setup.iceberg.contract_address) == 0, "no dust left");
}

#[test]
fn test_claim_midway_then_rest() {
    let setup = setup();
    create_plan(setup, 'secret-1', 100, 2);
    advance_to_interval(2);
    execute_batch(setup, 0);
    execute_batch(setup, 0);
    assert!(claim(setup, 'secret-1', 'note-1') == 200, "first chunk accrued");
    advance_to_interval(3);
    execute_batch(setup, 0);
    assert!(claim(setup, 'secret-1', 'note-2') == 200, "second chunk accrued");
}

#[test]
fn test_cancel_before_start_full_refund() {
    let setup = setup();
    create_plan(setup, 'secret-1', 100, 3);
    assert!(cancel(setup, 'secret-1', 'note-1') == 300, "full refund before start");
    assert!(setup.in_token.balance_of(setup.pool) == 300, "pool pulled the refund");

    // Descheduled: nothing swaps in the plan's former window.
    advance_to_interval(4);
    assert!(execute_batch(setup, 0) == 0, "interval 0 empty");
    assert!(execute_batch(setup, 0) == 0, "interval 1 empty after cancel");
    assert!(setup.iceberg.accrued_out(plan_commitment('secret-1')) == 0, "nothing accrued");
}

#[test]
fn test_cancel_midflight_refunds_unswapped_and_keeps_accrual() {
    let setup = setup();
    create_plan(setup, 'secret-1', 100, 3);
    advance_to_interval(2);
    execute_batch(setup, 0);
    assert!(execute_batch(setup, 0) == 200, "first chunk swapped");

    assert!(cancel(setup, 'secret-1', 'note-1') == 200, "two unswapped chunks refunded");
    assert!(setup.iceberg.active_chunk_rate() == 0, "descheduled from live rate");

    advance_to_interval(3);
    assert!(execute_batch(setup, 0) == 0, "no residue swaps after cancel");
    assert!(claim(setup, 'secret-1', 'note-2') == 200, "executed chunk still claimable");
}

#[test]
#[should_panic(expected: 'NOTHING_TO_REFUND')]
fn test_cancel_after_completion_rejected() {
    let setup = setup();
    create_plan(setup, 'secret-1', 100, 1);
    advance_to_interval(2);
    execute_batch(setup, 0);
    execute_batch(setup, 0);
    cancel(setup, 'secret-1', 'note-1');
}

#[test]
fn test_keeper_catch_up_executes_sequentially() {
    let setup = setup();
    create_plan(setup, 'secret-1', 100, 2);
    // Keeper offline for the whole window; catches up in one go.
    advance_to_interval(5);
    assert!(execute_batch(setup, 0) == 0, "interval 0");
    assert!(execute_batch(setup, 0) == 200, "interval 1 caught up");
    assert!(execute_batch(setup, 0) == 200, "interval 2 caught up");
    assert!(execute_batch(setup, 0) == 0, "interval 3 empty");
    assert!(setup.iceberg.next_interval_to_execute() == 4, "sequential progression");
}

#[test]
#[should_panic(expected: 'INTERVAL_NOT_ELAPSED')]
fn test_execute_before_interval_elapsed_rejected() {
    let setup = setup();
    execute_batch(setup, 0);
}

#[test]
#[should_panic(expected: 'ONLY_KEEPER')]
fn test_execute_by_non_keeper_rejected() {
    let setup = setup();
    advance_to_interval(1);
    setup.iceberg.execute_batch(0);
}

#[test]
#[should_panic(expected: 'ONLY_POOL')]
fn test_privacy_invoke_by_non_pool_rejected() {
    let setup = setup();
    setup
        .iceberg
        .privacy_invoke(
            IcebergOperation::CreatePlan(
                CreatePlanParams { commitment: 123, chunk_amount: 100, num_chunks: 1 },
            ),
        );
}

#[test]
#[should_panic(expected: 'PLAN_NOT_FUNDED')]
fn test_unfunded_plan_rejected() {
    let setup = setup();
    // privacy_invoke without the pool's withdraw leg having sent tokens.
    start_cheat_caller_address(setup.iceberg.contract_address, setup.pool);
    setup
        .iceberg
        .privacy_invoke(
            IcebergOperation::CreatePlan(
                CreatePlanParams { commitment: 123, chunk_amount: 100, num_chunks: 1 },
            ),
        );
}

#[test]
#[should_panic(expected: 'COMMITMENT_EXISTS')]
fn test_duplicate_commitment_rejected() {
    let setup = setup();
    create_plan(setup, 'secret-1', 100, 1);
    create_plan(setup, 'secret-1', 100, 1);
}

#[test]
#[should_panic(expected: 'UNKNOWN_PLAN')]
fn test_claim_with_wrong_secret_rejected() {
    let setup = setup();
    create_plan(setup, 'secret-1', 100, 1);
    advance_to_interval(2);
    execute_batch(setup, 0);
    execute_batch(setup, 0);
    claim(setup, 'wrong-secret', 'note-1');
}

#[test]
#[should_panic(expected: 'MIN_OUT_NOT_MET')]
fn test_min_out_protects_batch() {
    let setup = setup();
    create_plan(setup, 'secret-1', 100, 1);
    advance_to_interval(2);
    execute_batch(setup, 0);
    // 100 in at 2:1 yields 200; demand more.
    execute_batch(setup, 201);
}

#[test]
fn test_claim_before_any_execution_is_zero() {
    let setup = setup();
    create_plan(setup, 'secret-1', 100, 2);
    assert!(setup.iceberg.accrued_out(plan_commitment('secret-1')) == 0, "nothing matured");
}
