//! Minimal Ekubo router double for unit-testing EkuboAdapter's error paths
//! without a mainnet fork. `swap` behavior is fully configurable (how much
//! of the input to consume, how much output to mint); every other IRouter
//! method is unused by the adapter and panics if ever called. `clear` /
//! `clear_minimum` / `clear_minimum_to_recipient` reuse Ekubo's own
//! embeddable IClear impl verbatim, so clearing behavior matches the real
//! router exactly.

use starknet::ContractAddress;

#[starknet::interface]
pub trait IMockEkuboRouterAdmin<T> {
    /// Token this router mints as swap output, how much per `swap()` call,
    /// and whether it disposes of the received input (a full fill) or
    /// leaves it sitting in the router (simulating a partial/failed fill).
    fn configure(ref self: T, out_token: ContractAddress, out_amount: u256, consume_input: bool);
}

#[starknet::contract]
pub mod MockEkuboRouter {
    use core::num::traits::Zero;
    use ekubo::interfaces::router::{Depth, IRouter, RouteNode, Swap, TokenAmount};
    use ekubo::types::delta::Delta;
    use ekubo::types::i129::i129;
    use ekubo::types::keys::PoolKey;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_contract_address};
    use super::IMockEkuboRouterAdmin;
    use crate::mocks::{IMockERC20Dispatcher, IMockERC20DispatcherTrait};

    #[storage]
    struct Storage {
        out_token: ContractAddress,
        out_amount: u256,
        consume_input: bool,
    }

    #[abi(embed_v0)]
    impl ClearImpl = ekubo::components::clear::ClearImpl<ContractState>;

    #[abi(embed_v0)]
    impl AdminImpl of IMockEkuboRouterAdmin<ContractState> {
        fn configure(
            ref self: ContractState,
            out_token: ContractAddress,
            out_amount: u256,
            consume_input: bool,
        ) {
            self.out_token.write(out_token);
            self.out_amount.write(out_amount);
            self.consume_input.write(consume_input);
        }
    }

    #[abi(embed_v0)]
    impl RouterImpl of IRouter<ContractState> {
        fn swap(ref self: ContractState, node: RouteNode, token_amount: TokenAmount) -> Delta {
            let _ = node;
            if self.consume_input.read() {
                // "Consume" the input by moving it out of this contract, so a
                // subsequent clear() on in_token sees a zero balance — a real
                // full fill. Where it ends up doesn't matter to the mock.
                let held = IMockERC20Dispatcher { contract_address: token_amount.token }
                    .balance_of(get_contract_address());
                if held.is_non_zero() {
                    let sink: ContractAddress = 'sink'.try_into().unwrap();
                    IMockERC20Dispatcher { contract_address: token_amount.token }
                        .transfer(sink, held);
                }
            }
            let out_amount = self.out_amount.read();
            if out_amount.is_non_zero() {
                IMockERC20Dispatcher { contract_address: self.out_token.read() }
                    .mint(get_contract_address(), out_amount);
            }
            Delta {
                amount0: i129 { mag: 0, sign: false }, amount1: i129 { mag: 0, sign: false },
            }
        }

        fn multihop_swap(
            ref self: ContractState, route: Array<RouteNode>, token_amount: TokenAmount,
        ) -> Array<Delta> {
            let _ = (route, token_amount);
            panic!("not mocked")
        }

        fn multi_multihop_swap(
            ref self: ContractState, swaps: Array<Swap>,
        ) -> Array<Array<Delta>> {
            let _ = swaps;
            panic!("not mocked")
        }

        fn quote_multi_multihop_swap(
            self: @ContractState, swaps: Array<Swap>,
        ) -> Array<Array<Delta>> {
            let _ = swaps;
            panic!("not mocked")
        }

        fn quote_multihop_swap(
            self: @ContractState, route: Array<RouteNode>, token_amount: TokenAmount,
        ) -> Array<Delta> {
            let _ = (route, token_amount);
            panic!("not mocked")
        }

        fn quote_swap(self: @ContractState, node: RouteNode, token_amount: TokenAmount) -> Delta {
            let _ = (node, token_amount);
            panic!("not mocked")
        }

        fn get_delta_to_sqrt_ratio(
            self: @ContractState, pool_key: PoolKey, sqrt_ratio: u256,
        ) -> Delta {
            let _ = (pool_key, sqrt_ratio);
            panic!("not mocked")
        }

        fn get_market_depth(
            self: @ContractState, pool_key: PoolKey, sqrt_percent: u128,
        ) -> Depth {
            let _ = (pool_key, sqrt_percent);
            panic!("not mocked")
        }

        fn get_market_depth_v2(
            self: @ContractState, pool_key: PoolKey, percent_64x64: u128,
        ) -> Depth {
            let _ = (pool_key, percent_64x64);
            panic!("not mocked")
        }

        fn get_market_depth_at_sqrt_ratio(
            self: @ContractState, pool_key: PoolKey, sqrt_ratio: u256, percent_64x64: u128,
        ) -> Depth {
            let _ = (pool_key, sqrt_ratio, percent_64x64);
            panic!("not mocked")
        }
    }
}
