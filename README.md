# 🧊 Iceberg

**Private accumulation and exit on Starknet.** Scheduled DCA/TWAP where the chain sees only
"the STRK20 pool swapped X" — never who was accumulating, their totals, or their schedules.

Built for the STRK20 Private Sprint (Aug 14–31, 2026). Working repo — full documentation,
demo video, and mainnet addresses land before the deadline.

- `contracts/` — Cairo: Iceberg core + Ekubo adapter, 17 tests incl. a mainnet-fork test
- `keeper/` — batch executor bot + local devnet demo stack
- `ui/` — split-screen demo: what the chain sees vs. what only you see
