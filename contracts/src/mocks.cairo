use starknet::ContractAddress;

#[starknet::interface]
pub trait IMockERC20<T> {
    fn balance_of(self: @T, account: ContractAddress) -> u256;
    fn transfer(ref self: T, recipient: ContractAddress, amount: u256) -> bool;
    fn approve(ref self: T, spender: ContractAddress, amount: u256) -> bool;
    fn allowance(self: @T, owner: ContractAddress, spender: ContractAddress) -> u256;
    fn transfer_from(
        ref self: T, sender: ContractAddress, recipient: ContractAddress, amount: u256,
    ) -> bool;
    fn mint(ref self: T, recipient: ContractAddress, amount: u256);
}

/// Ekubo's own `ekubo::interfaces::erc20::IERC20` uses camelCase
/// (`balanceOf`/`transferFrom`) where `IMockERC20` above uses snake_case;
/// `transfer`/`approve`/`allowance` already match by name across both. This
/// adds just the two that don't, so MockERC20 also works as the token
/// `ekubo::components::clear`'s embeddable `clear()` calls in adapter tests.
#[starknet::interface]
pub trait IERC20CamelCompat<T> {
    fn balanceOf(self: @T, account: ContractAddress) -> u256;
    fn transferFrom(
        ref self: T, sender: ContractAddress, recipient: ContractAddress, amount: u256,
    ) -> bool;
}

#[starknet::contract]
pub mod MockERC20 {
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};
    use starknet::{ContractAddress, get_caller_address};
    use super::IMockERC20;

    #[storage]
    struct Storage {
        balances: Map<ContractAddress, u256>,
        allowances: Map<(ContractAddress, ContractAddress), u256>,
    }

    #[abi(embed_v0)]
    pub impl MockERC20Impl of IMockERC20<ContractState> {
        fn balance_of(self: @ContractState, account: ContractAddress) -> u256 {
            self.balances.read(account)
        }

        fn transfer(ref self: ContractState, recipient: ContractAddress, amount: u256) -> bool {
            let sender = get_caller_address();
            let sender_balance = self.balances.read(sender);
            assert(sender_balance >= amount, 'INSUFFICIENT_BALANCE');
            self.balances.write(sender, sender_balance - amount);
            self.balances.write(recipient, self.balances.read(recipient) + amount);
            true
        }

        fn approve(ref self: ContractState, spender: ContractAddress, amount: u256) -> bool {
            self.allowances.write((get_caller_address(), spender), amount);
            true
        }

        fn allowance(
            self: @ContractState, owner: ContractAddress, spender: ContractAddress,
        ) -> u256 {
            self.allowances.read((owner, spender))
        }

        fn transfer_from(
            ref self: ContractState,
            sender: ContractAddress,
            recipient: ContractAddress,
            amount: u256,
        ) -> bool {
            let spender = get_caller_address();
            let approved_amount = self.allowances.read((sender, spender));
            assert(approved_amount >= amount, 'INSUFFICIENT_ALLOWANCE');
            self.allowances.write((sender, spender), approved_amount - amount);
            let sender_balance = self.balances.read(sender);
            assert(sender_balance >= amount, 'INSUFFICIENT_BALANCE');
            self.balances.write(sender, sender_balance - amount);
            self.balances.write(recipient, self.balances.read(recipient) + amount);
            true
        }

        fn mint(ref self: ContractState, recipient: ContractAddress, amount: u256) {
            self.balances.write(recipient, self.balances.read(recipient) + amount);
        }
    }

    #[abi(embed_v0)]
    pub impl MockERC20CamelCompatImpl of super::IERC20CamelCompat<ContractState> {
        fn balanceOf(self: @ContractState, account: ContractAddress) -> u256 {
            self.balances.read(account)
        }

        fn transferFrom(
            ref self: ContractState,
            sender: ContractAddress,
            recipient: ContractAddress,
            amount: u256,
        ) -> bool {
            let spender = get_caller_address();
            let approved_amount = self.allowances.read((sender, spender));
            assert(approved_amount >= amount, 'INSUFFICIENT_ALLOWANCE');
            self.allowances.write((sender, spender), approved_amount - amount);
            let sender_balance = self.balances.read(sender);
            assert(sender_balance >= amount, 'INSUFFICIENT_BALANCE');
            self.balances.write(sender, sender_balance - amount);
            self.balances.write(recipient, self.balances.read(recipient) + amount);
            true
        }
    }
}

#[starknet::interface]
pub trait IMockAMM<T> {
    /// Calldata layout matches what Iceberg::swap sends:
    /// [in_token, out_token, amount_low, amount_high].
    fn swap(
        ref self: T, in_token: ContractAddress, out_token: ContractAddress, amount: u256,
    );
    fn set_rate(ref self: T, rate_numerator: u128, rate_denominator: u128);
}

#[starknet::contract]
pub mod MockAMM {
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
    use super::{IMockAMM, IMockERC20Dispatcher, IMockERC20DispatcherTrait};

    #[storage]
    struct Storage {
        rate_numerator: u128,
        rate_denominator: u128,
    }

    #[constructor]
    fn constructor(ref self: ContractState, rate_numerator: u128, rate_denominator: u128) {
        assert(rate_denominator != 0, 'ZERO_DENOMINATOR');
        self.rate_numerator.write(rate_numerator);
        self.rate_denominator.write(rate_denominator);
    }

    #[abi(embed_v0)]
    pub impl MockAMMImpl of IMockAMM<ContractState> {
        fn swap(
            ref self: ContractState,
            in_token: ContractAddress,
            out_token: ContractAddress,
            amount: u256,
        ) {
            let trader = get_caller_address();
            IMockERC20Dispatcher { contract_address: in_token }
                .transfer_from(trader, get_contract_address(), amount);
            let out_amount = amount
                * self.rate_numerator.read().into()
                / self.rate_denominator.read().into();
            IMockERC20Dispatcher { contract_address: out_token }.transfer(trader, out_amount);
        }

        fn set_rate(ref self: ContractState, rate_numerator: u128, rate_denominator: u128) {
            assert(rate_denominator != 0, 'ZERO_DENOMINATOR');
            self.rate_numerator.write(rate_numerator);
            self.rate_denominator.write(rate_denominator);
        }
    }
}
