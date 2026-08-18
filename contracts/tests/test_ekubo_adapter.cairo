//! Unit tests for EkuboAdapter's error paths, against MockEkuboRouter —
//! the mainnet-fork test (test_ekubo_fork.cairo) only exercises the happy
//! path against real Ekubo liquidity, so TOKEN_NOT_IN_PAIR, IN_TOKEN_NOT_CLEARED,
//! and ZERO_OUT_AMOUNT were previously untested.

use iceberg::ekubo_adapter::{IEkuboAdapterDispatcher, IEkuboAdapterDispatcherTrait};
use iceberg::ekubo_router_mock::{
    IMockEkuboRouterAdminDispatcher, IMockEkuboRouterAdminDispatcherTrait,
};
use iceberg::mocks::{IMockERC20Dispatcher, IMockERC20DispatcherTrait};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_caller_address,
    stop_cheat_caller_address,
};
use starknet::ContractAddress;

#[derive(Copy, Drop)]
struct Setup {
    adapter: IEkuboAdapterDispatcher,
    router: IMockEkuboRouterAdminDispatcher,
    token0: IMockERC20Dispatcher,
    token1: IMockERC20Dispatcher,
    caller: ContractAddress,
}

fn setup() -> Setup {
    let erc20_class = declare("MockERC20").unwrap().contract_class();
    let (addr_a, _) = erc20_class.deploy(@array![]).unwrap();
    let (addr_b, _) = erc20_class.deploy(@array![]).unwrap();
    let (token0_addr, token1_addr) = if addr_a < addr_b {
        (addr_a, addr_b)
    } else {
        (addr_b, addr_a)
    };

    let router_class = declare("MockEkuboRouter").unwrap().contract_class();
    let (router_addr, _) = router_class.deploy(@array![]).unwrap();

    let adapter_class = declare("EkuboAdapter").unwrap().contract_class();
    let (adapter_addr, _) = adapter_class
        .deploy(@array![router_addr.into(), token0_addr.into(), token1_addr.into(), 0, 0, 0])
        .unwrap();

    Setup {
        adapter: IEkuboAdapterDispatcher { contract_address: adapter_addr },
        router: IMockEkuboRouterAdminDispatcher { contract_address: router_addr },
        token0: IMockERC20Dispatcher { contract_address: token0_addr },
        token1: IMockERC20Dispatcher { contract_address: token1_addr },
        caller: 'CALLER'.try_into().unwrap(),
    }
}

/// Mints `amount` of `token` to the caller and approves the adapter for it,
/// mirroring what a real Iceberg swap() call does before invoking the
/// adapter.
fn fund_and_approve(setup: Setup, token: IMockERC20Dispatcher, amount: u256) {
    token.mint(setup.caller, amount);
    start_cheat_caller_address(token.contract_address, setup.caller);
    token.approve(setup.adapter.contract_address, amount);
    stop_cheat_caller_address(token.contract_address);
}

#[test]
#[should_panic(expected: 'TOKEN_NOT_IN_PAIR')]
fn test_token_not_in_pair_rejected() {
    let setup = setup();
    let other: ContractAddress = 'OTHER_TOKEN'.try_into().unwrap();
    start_cheat_caller_address(setup.adapter.contract_address, setup.caller);
    setup.adapter.swap(other, setup.token1.contract_address, 100);
}

#[test]
fn test_full_fill_swap_succeeds() {
    let setup = setup();
    setup.router.configure(setup.token1.contract_address, 200, true);
    fund_and_approve(setup, setup.token0, 100);

    start_cheat_caller_address(setup.adapter.contract_address, setup.caller);
    setup.adapter.swap(setup.token0.contract_address, setup.token1.contract_address, 100);
    stop_cheat_caller_address(setup.adapter.contract_address);

    assert!(setup.token1.balance_of(setup.caller) == 200, "caller received the swap output");
    assert!(
        setup.token1.balance_of(setup.adapter.contract_address) == 0,
        "adapter holds no residual out_token",
    );
}

#[test]
#[should_panic(expected: 'IN_TOKEN_NOT_CLEARED')]
fn test_in_token_not_cleared_rejected() {
    let setup = setup();
    // Router mints output but leaves the received in_token sitting in
    // itself — a partial/failed fill the adapter must reject.
    setup.router.configure(setup.token1.contract_address, 200, false);
    fund_and_approve(setup, setup.token0, 100);

    start_cheat_caller_address(setup.adapter.contract_address, setup.caller);
    setup.adapter.swap(setup.token0.contract_address, setup.token1.contract_address, 100);
}

#[test]
#[should_panic(expected: 'ZERO_OUT_AMOUNT')]
fn test_zero_out_amount_rejected() {
    let setup = setup();
    // Router fully consumes the input but produces no output.
    setup.router.configure(setup.token1.contract_address, 0, true);
    fund_and_approve(setup, setup.token0, 100);

    start_cheat_caller_address(setup.adapter.contract_address, setup.caller);
    setup.adapter.swap(setup.token0.contract_address, setup.token1.contract_address, 100);
}
