use starknet::ContractAddress;

#[starknet::interface]
pub trait IERC20<T> {
    fn balance_of(self: @T, account: ContractAddress) -> u256;
    fn transfer(ref self: T, recipient: ContractAddress, amount: u256) -> bool;
    fn transfer_from(
        ref self: T, sender: ContractAddress, recipient: ContractAddress, amount: u256,
    ) -> bool;
}

/// Venue adapter between Iceberg and the Ekubo Router. Exposes the same
/// `swap(in_token, out_token, amount)` calldata shape Iceberg's batch execution
/// sends, so Iceberg core stays venue-agnostic. One adapter instance is pinned
/// to one Ekubo pool at construction (a fixed, auditable route — same principle
/// as StarkWare's swap executor). Holds no funds between transactions.
#[starknet::interface]
pub trait IEkuboAdapter<T> {
    /// Pulls `amount` of `in_token` from the caller (which must have approved it),
    /// swaps on the pinned Ekubo pool, and transfers all received `out_token`
    /// back to the caller. Slippage is enforced by the caller (Iceberg measures
    /// its own balance delta against min_out); this contract enforces full fills.
    fn swap(ref self: T, in_token: ContractAddress, out_token: ContractAddress, amount: u256);
}

pub mod errors {
    pub const TOKEN_NOT_IN_PAIR: felt252 = 'TOKEN_NOT_IN_PAIR';
    pub const AMOUNT_OVERFLOW: felt252 = 'AMOUNT_OVERFLOW';
    pub const IN_TOKEN_NOT_CLEARED: felt252 = 'IN_TOKEN_NOT_CLEARED';
    pub const ZERO_OUT_AMOUNT: felt252 = 'ZERO_OUT_AMOUNT';
}

#[starknet::contract]
pub mod EkuboAdapter {
    use core::num::traits::Zero;
    use ekubo::components::clear::{IClearDispatcher, IClearDispatcherTrait};
    use ekubo::interfaces::erc20::IERC20Dispatcher as EkuboIERC20Dispatcher;
    use ekubo::interfaces::router::{
        IRouterDispatcher, IRouterDispatcherTrait, RouteNode, TokenAmount,
    };
    use ekubo::types::i129::i129;
    use ekubo::types::keys::PoolKey;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use super::{IERC20Dispatcher, IERC20DispatcherTrait, IEkuboAdapter, errors};

    #[storage]
    struct Storage {
        router: ContractAddress,
        token0: ContractAddress,
        token1: ContractAddress,
        fee: u128,
        tick_spacing: u128,
        extension: ContractAddress,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        router: ContractAddress,
        token0: ContractAddress,
        token1: ContractAddress,
        fee: u128,
        tick_spacing: u128,
        extension: ContractAddress,
    ) {
        assert(router.is_non_zero(), 'ZERO_ROUTER');
        assert(token0.is_non_zero() && token1.is_non_zero(), 'ZERO_TOKEN');
        self.router.write(router);
        self.token0.write(token0);
        self.token1.write(token1);
        self.fee.write(fee);
        self.tick_spacing.write(tick_spacing);
        self.extension.write(extension);
    }

    #[abi(embed_v0)]
    pub impl EkuboAdapterImpl of IEkuboAdapter<ContractState> {
        fn swap(
            ref self: ContractState,
            in_token: ContractAddress,
            out_token: ContractAddress,
            amount: u256,
        ) {
            let token0 = self.token0.read();
            let token1 = self.token1.read();
            let pair_matches = (in_token == token0 && out_token == token1)
                || (in_token == token1 && out_token == token0);
            assert(pair_matches, errors::TOKEN_NOT_IN_PAIR);

            let caller = get_caller_address();
            let router_address = self.router.read();
            IERC20Dispatcher { contract_address: in_token }
                .transfer_from(caller, get_contract_address(), amount);

            // Ekubo router flow (mirrors StarkWare's EkuboSwapAnonymizer):
            // transfer input to the router, swap, then clear both sides.
            // sqrt_ratio_limit = 0 enforces a full swap with no partial fill.
            IERC20Dispatcher { contract_address: in_token }.transfer(router_address, amount);
            let in_amount: u128 = amount.try_into().expect(errors::AMOUNT_OVERFLOW);
            let route_node = RouteNode {
                pool_key: PoolKey {
                    token0,
                    token1,
                    fee: self.fee.read(),
                    tick_spacing: self.tick_spacing.read(),
                    extension: self.extension.read(),
                },
                sqrt_ratio_limit: 0,
                skip_ahead: 0,
            };
            let token_amount = TokenAmount {
                token: in_token, amount: i129 { mag: in_amount, sign: false },
            };
            IRouterDispatcher { contract_address: router_address }
                .swap(node: route_node, token_amount: token_amount);

            let clear = IClearDispatcher { contract_address: router_address };
            let in_token_remaining = clear
                .clear(token: EkuboIERC20Dispatcher { contract_address: in_token });
            assert(in_token_remaining.is_zero(), errors::IN_TOKEN_NOT_CLEARED);
            let out_received = clear
                .clear(token: EkuboIERC20Dispatcher { contract_address: out_token });
            assert(out_received.is_non_zero(), errors::ZERO_OUT_AMOUNT);

            IERC20Dispatcher { contract_address: out_token }.transfer(caller, out_received);
        }
    }
}
