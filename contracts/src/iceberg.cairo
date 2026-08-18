//! Iceberg: scheduled, batched token swaps driven by the STRK20 privacy pool.
//!
//! A `Plan` splits `chunk_amount * num_chunks` of `in_token` into one chunk per
//! interval, active over `[start_interval, end_interval]`. A permissionless
//! keeper calls `execute_batch` once per matured interval; it swaps the sum of
//! every active plan's `chunk_amount` in a single trade, so no on-chain event
//! ever reveals an individual plan's size or owner — only the batch total.
//!
//! ## O(1) accounting via a cumulative price index
//!
//! Naively, computing what a plan has earned would require iterating every
//! interval it has lived through. Instead, each executed interval writes one
//! number, `index_after[interval]`: the WAD-scaled cumulative out-per-in rate
//! up to and including that interval
//! (`index_after[i] = index_after[i-1] + out_received * WAD / in_swapped`).
//! A plan's accrual is then a single subtraction, independent of how many
//! intervals it has matured over:
//!
//!   accrued = chunk_amount * (index_after[matured_end] - index_after[start - 1]) / WAD
//!
//! The same trick applies to scheduling which chunks are "active" in a given
//! interval: rather than iterating plans, `rate_start[interval]` and
//! `rate_expiry[interval]` record how much chunk volume joins/leaves at that
//! interval, and `execute_batch` folds them into one running `chunk_rate`.
//! Both `create_plan` and `execute_batch` are O(1) regardless of how many
//! other plans exist.

use starknet::ContractAddress;

/// Mirrors `privacy::objects::OpenNoteDeposit` from starkware-libs/starknet-privacy.
/// Serde layout must match exactly — the pool deserializes the return value of
/// `privacy_invoke` into this shape and applies each entry as an open-note deposit.
#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct OpenNoteDeposit {
    pub note_id: felt252,
    pub token: ContractAddress,
    pub amount: u128,
}

#[derive(Serde, Copy, Drop)]
pub struct CreatePlanParams {
    /// poseidon(PLAN_TAG, secret). The secret never goes on-chain at creation.
    pub commitment: felt252,
    pub chunk_amount: u128,
    pub num_chunks: u32,
}

#[derive(Serde, Copy, Drop)]
pub struct ClaimParams {
    pub secret: felt252,
    pub note_id: felt252,
}

#[derive(Serde, Copy, Drop)]
pub struct CancelParams {
    pub secret: felt252,
    pub note_id: felt252,
}

#[derive(Serde, Copy, Drop)]
pub enum IcebergOperation {
    CreatePlan: CreatePlanParams,
    Claim: ClaimParams,
    Cancel: CancelParams,
}

/// A plan occupies intervals [start_interval, end_interval], one chunk each.
/// num_chunks is derived: end_interval - start_interval + 1.
#[derive(Serde, Copy, Drop, starknet::Store)]
pub struct Plan {
    pub chunk_amount: u128,
    pub start_interval: u64,
    pub end_interval: u64,
    pub claimed_out: u128,
}

#[starknet::interface]
pub trait IIceberg<T> {
    /// Entry point called by the privacy pool (anonymizer sandwich):
    /// the pool has already transferred in_token for CreatePlan; Claim/Cancel
    /// return OpenNoteDeposit instructions the pool applies to open notes.
    fn privacy_invoke(ref self: T, operation: IcebergOperation) -> Span<OpenNoteDeposit>;
    /// Executes the next matured interval: swaps the aggregate of all active
    /// plans' chunks in one trade. Returns the received out_token amount.
    fn execute_batch(ref self: T, min_out: u128) -> u128;
    /// The next interval execute_batch will process. Equal to current_interval()
    /// once the keeper is fully caught up.
    fn next_interval_to_execute(self: @T) -> u64;
    /// Elapsed intervals since deployment, derived from the current block
    /// timestamp — independent of how far execute_batch has actually run.
    fn current_interval(self: @T) -> u64;
    /// Sum of chunk_amount across plans active as of the last executed
    /// interval. A plan whose start_interval == next_interval_to_execute()
    /// isn't reflected here until that interval's batch executes.
    fn active_chunk_rate(self: @T) -> u128;
    /// The token every plan's chunks are funded in and swapped from.
    fn in_token(self: @T) -> ContractAddress;
    /// The token every batch swap produces.
    fn out_token(self: @T) -> ContractAddress;
    /// Raw plan state for a commitment; chunk_amount == 0 means no plan has
    /// been created for it (Cairo's default Map value).
    fn plan(self: @T, commitment: felt252) -> Plan;
    /// Total out_token accrued to a plan so far (claimed or not).
    fn accrued_out(self: @T, commitment: felt252) -> u128;
}

pub mod errors {
    pub const ONLY_POOL: felt252 = 'ONLY_POOL';
    pub const ONLY_KEEPER: felt252 = 'ONLY_KEEPER';
    pub const ZERO_COMMITMENT: felt252 = 'ZERO_COMMITMENT';
    pub const ZERO_NOTE_ID: felt252 = 'ZERO_NOTE_ID';
    pub const ZERO_CHUNK_AMOUNT: felt252 = 'ZERO_CHUNK_AMOUNT';
    pub const ZERO_NUM_CHUNKS: felt252 = 'ZERO_NUM_CHUNKS';
    pub const TOO_MANY_CHUNKS: felt252 = 'TOO_MANY_CHUNKS';
    pub const TOTAL_OVERFLOW: felt252 = 'TOTAL_OVERFLOW';
    pub const COMMITMENT_EXISTS: felt252 = 'COMMITMENT_EXISTS';
    pub const PLAN_NOT_FUNDED: felt252 = 'PLAN_NOT_FUNDED';
    pub const UNKNOWN_PLAN: felt252 = 'UNKNOWN_PLAN';
    pub const NOTHING_TO_CLAIM: felt252 = 'NOTHING_TO_CLAIM';
    pub const NOTHING_TO_REFUND: felt252 = 'NOTHING_TO_REFUND';
    pub const INTERVAL_NOT_ELAPSED: felt252 = 'INTERVAL_NOT_ELAPSED';
    pub const MIN_OUT_NOT_MET: felt252 = 'MIN_OUT_NOT_MET';
    pub const RECEIVED_OVERFLOW: felt252 = 'RECEIVED_OVERFLOW';
    pub const ACCRUED_OVERFLOW: felt252 = 'ACCRUED_OVERFLOW';
}

#[starknet::contract]
pub mod Iceberg {
    use core::num::traits::Zero;
    use core::poseidon::poseidon_hash_span;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::syscalls::call_contract_syscall;
    use starknet::{
        ContractAddress, SyscallResultTrait, get_block_timestamp, get_caller_address,
        get_contract_address,
    };
    use super::{
        CancelParams, ClaimParams, CreatePlanParams, IIceberg, IcebergOperation, OpenNoteDeposit,
        Plan, errors,
    };

    /// Fixed-point scale for the cumulative out-per-in price index.
    const WAD: u256 = 1_000_000_000_000_000_000;
    /// Domain tag for plan commitments: commitment = poseidon(PLAN_TAG, secret).
    const PLAN_TAG: felt252 = 'iceberg.plan.v1';
    /// Adversarial-input cap; also bounds chunk_amount * num_chunks arithmetic.
    const MAX_CHUNKS: u32 = 1000;

    #[starknet::interface]
    trait IERC20<T> {
        fn balance_of(self: @T, account: ContractAddress) -> u256;
        fn approve(ref self: T, spender: ContractAddress, amount: u256) -> bool;
    }

    #[storage]
    struct Storage {
        pool_address: ContractAddress,
        keeper: ContractAddress,
        in_token: ContractAddress,
        out_token: ContractAddress,
        swap_router: ContractAddress,
        swap_selector: felt252,
        genesis_timestamp: u64,
        interval_seconds: u64,
        next_interval: u64,
        /// Sum of chunk_amount over plans active in the interval being executed.
        chunk_rate: u128,
        /// chunk_amount joining at interval key (plans whose start_interval == key).
        rate_start: Map<u64, u128>,
        /// chunk_amount leaving after interval key executes (end_interval == key).
        rate_expiry: Map<u64, u128>,
        /// Cumulative WAD-scaled out-per-in after each executed interval.
        index_after: Map<u64, u256>,
        plans: Map<felt252, Plan>,
        /// in_token held for not-yet-executed chunks; balance must cover it.
        accounted_in: u128,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        PlanCreated: PlanCreated,
        BatchExecuted: BatchExecuted,
        PlanClaimed: PlanClaimed,
        PlanCancelled: PlanCancelled,
    }

    /// All event fields are already public in transaction calldata; events exist
    /// for indexers and the UI, and leak nothing beyond the calldata itself.
    #[derive(Drop, starknet::Event)]
    pub struct PlanCreated {
        #[key]
        pub commitment: felt252,
        pub chunk_amount: u128,
        pub start_interval: u64,
        pub end_interval: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct BatchExecuted {
        #[key]
        pub interval: u64,
        pub in_amount: u128,
        pub out_amount: u128,
    }

    #[derive(Drop, starknet::Event)]
    pub struct PlanClaimed {
        #[key]
        pub commitment: felt252,
        pub amount: u128,
    }

    #[derive(Drop, starknet::Event)]
    pub struct PlanCancelled {
        #[key]
        pub commitment: felt252,
        pub refund: u128,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        pool_address: ContractAddress,
        keeper: ContractAddress,
        in_token: ContractAddress,
        out_token: ContractAddress,
        swap_router: ContractAddress,
        swap_selector: felt252,
        interval_seconds: u64,
    ) {
        assert(pool_address.is_non_zero(), 'ZERO_POOL');
        assert(keeper.is_non_zero(), 'ZERO_KEEPER');
        assert(in_token.is_non_zero() && out_token.is_non_zero(), 'ZERO_TOKEN');
        assert(in_token != out_token, 'SAME_TOKEN');
        assert(swap_router.is_non_zero(), 'ZERO_ROUTER');
        assert(swap_selector.is_non_zero(), 'ZERO_SELECTOR');
        assert(interval_seconds.is_non_zero(), 'ZERO_INTERVAL');
        self.pool_address.write(pool_address);
        self.keeper.write(keeper);
        self.in_token.write(in_token);
        self.out_token.write(out_token);
        self.swap_router.write(swap_router);
        self.swap_selector.write(swap_selector);
        self.genesis_timestamp.write(get_block_timestamp());
        self.interval_seconds.write(interval_seconds);
    }

    #[abi(embed_v0)]
    pub impl IcebergImpl of IIceberg<ContractState> {
        fn privacy_invoke(
            ref self: ContractState, operation: IcebergOperation,
        ) -> Span<OpenNoteDeposit> {
            assert(get_caller_address() == self.pool_address.read(), errors::ONLY_POOL);
            match operation {
                IcebergOperation::CreatePlan(params) => self.create_plan(params),
                IcebergOperation::Claim(params) => self.claim(params),
                IcebergOperation::Cancel(params) => self.cancel(params),
            }
        }

        fn execute_batch(ref self: ContractState, min_out: u128) -> u128 {
            assert(get_caller_address() == self.keeper.read(), errors::ONLY_KEEPER);
            let interval = self.next_interval.read();
            assert(self.current_interval_number() > interval, errors::INTERVAL_NOT_ELAPSED);

            let chunk_rate = self.chunk_rate.read() + self.rate_start.read(interval);
            let in_due = chunk_rate;
            let mut out_received: u128 = 0;
            let mut index_delta: u256 = 0;
            if in_due > 0 {
                out_received = self.swap(in_due);
                assert(out_received >= min_out, errors::MIN_OUT_NOT_MET);
                self.accounted_in.write(self.accounted_in.read() - in_due);
                index_delta = out_received.into() * WAD / in_due.into();
            }
            let previous_index = if interval == 0 {
                0
            } else {
                self.index_after.read(interval - 1)
            };
            self.index_after.write(interval, previous_index + index_delta);
            self.chunk_rate.write(chunk_rate - self.rate_expiry.read(interval));
            self.next_interval.write(interval + 1);
            self.emit(BatchExecuted { interval, in_amount: in_due, out_amount: out_received });
            out_received
        }

        fn next_interval_to_execute(self: @ContractState) -> u64 {
            self.next_interval.read()
        }

        fn current_interval(self: @ContractState) -> u64 {
            self.current_interval_number()
        }

        fn active_chunk_rate(self: @ContractState) -> u128 {
            self.chunk_rate.read()
        }

        fn in_token(self: @ContractState) -> ContractAddress {
            self.in_token.read()
        }

        fn out_token(self: @ContractState) -> ContractAddress {
            self.out_token.read()
        }

        fn plan(self: @ContractState, commitment: felt252) -> Plan {
            self.plans.read(commitment)
        }

        fn accrued_out(self: @ContractState, commitment: felt252) -> u128 {
            let plan = self.plans.read(commitment);
            if plan.chunk_amount == 0 {
                return 0;
            }
            self.accrued_for(plan)
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn create_plan(
            ref self: ContractState, params: CreatePlanParams,
        ) -> Span<OpenNoteDeposit> {
            assert(params.commitment.is_non_zero(), errors::ZERO_COMMITMENT);
            assert(params.chunk_amount.is_non_zero(), errors::ZERO_CHUNK_AMOUNT);
            assert(params.num_chunks.is_non_zero(), errors::ZERO_NUM_CHUNKS);
            assert(params.num_chunks <= MAX_CHUNKS, errors::TOO_MANY_CHUNKS);
            let existing_plan = self.plans.read(params.commitment);
            assert(existing_plan.chunk_amount == 0, errors::COMMITMENT_EXISTS);

            let total: u256 = params.chunk_amount.into() * params.num_chunks.into();
            let total: u128 = total.try_into().expect(errors::TOTAL_OVERFLOW);

            // The pool's withdraw leg must have funded this plan in the same tx.
            let accounted_in = self.accounted_in.read() + total;
            let in_balance = IERC20Dispatcher { contract_address: self.in_token.read() }
                .balance_of(get_contract_address());
            assert(in_balance >= accounted_in.into(), errors::PLAN_NOT_FUNDED);
            self.accounted_in.write(accounted_in);

            let start_interval = self.current_interval_number() + 1;
            let end_interval = start_interval + params.num_chunks.into() - 1;
            self
                .rate_start
                .write(
                    start_interval, self.rate_start.read(start_interval) + params.chunk_amount,
                );
            self
                .rate_expiry
                .write(end_interval, self.rate_expiry.read(end_interval) + params.chunk_amount);
            self
                .plans
                .write(
                    params.commitment,
                    Plan {
                        chunk_amount: params.chunk_amount,
                        start_interval,
                        end_interval,
                        claimed_out: 0,
                    },
                );
            self
                .emit(
                    PlanCreated {
                        commitment: params.commitment,
                        chunk_amount: params.chunk_amount,
                        start_interval,
                        end_interval,
                    },
                );
            array![].span()
        }

        fn claim(ref self: ContractState, params: ClaimParams) -> Span<OpenNoteDeposit> {
            assert(params.note_id.is_non_zero(), errors::ZERO_NOTE_ID);
            let commitment = plan_commitment(params.secret);
            let mut plan = self.plans.read(commitment);
            assert(plan.chunk_amount.is_non_zero(), errors::UNKNOWN_PLAN);

            let accrued_out = self.accrued_for(plan);
            let claimable = accrued_out - plan.claimed_out;
            assert(claimable > 0, errors::NOTHING_TO_CLAIM);
            plan.claimed_out = accrued_out;
            self.plans.write(commitment, plan);

            let out_token = self.out_token.read();
            IERC20Dispatcher { contract_address: out_token }
                .approve(self.pool_address.read(), claimable.into());
            self.emit(PlanClaimed { commitment, amount: claimable });
            [OpenNoteDeposit { note_id: params.note_id, token: out_token, amount: claimable }]
                .span()
        }

        fn cancel(ref self: ContractState, params: CancelParams) -> Span<OpenNoteDeposit> {
            assert(params.note_id.is_non_zero(), errors::ZERO_NOTE_ID);
            let commitment = plan_commitment(params.secret);
            let mut plan = self.plans.read(commitment);
            assert(plan.chunk_amount.is_non_zero(), errors::UNKNOWN_PLAN);

            let executed_chunk_count = self.executed_chunks_of(plan);
            let total_chunk_count: u64 = plan.end_interval - plan.start_interval + 1;
            let unswapped_chunk_count = total_chunk_count - executed_chunk_count;
            assert(unswapped_chunk_count > 0, errors::NOTHING_TO_REFUND);

            // Deschedule the plan's future chunks. rate_start[start] is folded into
            // chunk_rate when interval `start` executes, so "joined" ⟺ next > start.
            let next_interval = self.next_interval.read();
            if next_interval <= plan.start_interval {
                self
                    .rate_start
                    .write(
                        plan.start_interval,
                        self.rate_start.read(plan.start_interval) - plan.chunk_amount,
                    );
            } else {
                self.chunk_rate.write(self.chunk_rate.read() - plan.chunk_amount);
            }
            self
                .rate_expiry
                .write(
                    plan.end_interval, self.rate_expiry.read(plan.end_interval) - plan.chunk_amount,
                );

            // Truncate the plan so future claims only cover executed intervals.
            // With zero executed chunks this yields end < start, which accrued_for
            // reads as zero accrual (start_interval is always >= 1, no underflow).
            plan.end_interval = plan.start_interval + executed_chunk_count - 1;
            self.plans.write(commitment, plan);

            let refund: u128 = plan.chunk_amount * unswapped_chunk_count.into();
            self.accounted_in.write(self.accounted_in.read() - refund);
            let in_token = self.in_token.read();
            IERC20Dispatcher { contract_address: in_token }
                .approve(self.pool_address.read(), refund.into());
            self.emit(PlanCancelled { commitment, refund });
            [OpenNoteDeposit { note_id: params.note_id, token: in_token, amount: refund }].span()
        }

        /// Swaps `in_amount` of in_token for out_token on the configured router.
        /// Measures the received amount by balance delta rather than trusting the
        /// router's return value (MockSwapExecutor pattern from starknet-privacy).
        fn swap(ref self: ContractState, in_amount: u128) -> u128 {
            let self_address = get_contract_address();
            let in_erc20 = IERC20Dispatcher { contract_address: self.in_token.read() };
            let out_erc20 = IERC20Dispatcher { contract_address: self.out_token.read() };
            let router = self.swap_router.read();

            in_erc20.approve(router, in_amount.into());
            let balance_before = out_erc20.balance_of(self_address);
            call_contract_syscall(
                address: router,
                entry_point_selector: self.swap_selector.read(),
                calldata: [
                    self.in_token.read().into(), self.out_token.read().into(), in_amount.into(), 0,
                ]
                    .span(),
            )
                .unwrap_syscall();
            let balance_after = out_erc20.balance_of(self_address);
            let out_amount: u128 = (balance_after - balance_before)
                .try_into()
                .expect(errors::RECEIVED_OVERFLOW);
            out_amount
        }

        fn current_interval_number(self: @ContractState) -> u64 {
            (get_block_timestamp() - self.genesis_timestamp.read()) / self.interval_seconds.read()
        }

        /// Number of the plan's intervals already executed by batches.
        fn executed_chunks_of(self: @ContractState, plan: Plan) -> u64 {
            let next_interval = self.next_interval.read();
            if next_interval <= plan.start_interval {
                return 0;
            }
            let last_executed = next_interval - 1;
            if last_executed >= plan.end_interval {
                return plan.end_interval - plan.start_interval + 1;
            }
            last_executed - plan.start_interval + 1
        }

        /// Total out_token the plan has earned across executed intervals,
        /// via the cumulative price index: chunk * (index[hi] - index[lo]) / WAD.
        fn accrued_for(self: @ContractState, plan: Plan) -> u128 {
            let next_interval = self.next_interval.read();
            if next_interval <= plan.start_interval || plan.end_interval < plan.start_interval {
                return 0;
            }
            let last_executed = next_interval - 1;
            let matured_end = if last_executed >= plan.end_interval {
                plan.end_interval
            } else {
                last_executed
            };
            let index_high = self.index_after.read(matured_end);
            let index_low = if plan.start_interval == 0 {
                0
            } else {
                self.index_after.read(plan.start_interval - 1)
            };
            let accrued: u256 = plan.chunk_amount.into() * (index_high - index_low) / WAD;
            accrued.try_into().expect(errors::ACCRUED_OVERFLOW)
        }
    }

    /// commitment = poseidon(PLAN_TAG, secret). Domain-separated so plan secrets
    /// cannot collide with other protocols' Poseidon preimages.
    pub fn plan_commitment(secret: felt252) -> felt252 {
        poseidon_hash_span([PLAN_TAG, secret].span())
    }
}
