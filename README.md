# Uprise

A continuous-expiry power perpetual on NEAR with two products in one pool:

- **🐂 Bull: Curve Long.** Retail buys convex upside on BTC: the stake is worth `NF × (P / P_ref)^p`
  (p = 3 on the testnet deployment, so BTC +10% ≈ +33%). It is **never liquidated**; it pays
  funding by slowly shrinking.
- **🦀 Crab: the hedged vault.** Yield hunters deposit USDC. The vault is the Curve Short side and
  holds `p × long claims` of BTC so price moves mostly cancel out. What's left is the funding the
  longs pay.

Funding is `p(p−1)/2 · σ² · m(u)`, where σ is the higher of a floor and the realized volatility of
the oracle price, and the utilization multiplier `m(u)` never drops below 1× (default 1.25×).

| Path | What |
|---|---|
| [`contract/`](contract) | `uprise-ledger`: the market (Rust, near-sdk 5), 34 tests |
| [`vault/`](vault) | `uprise-vault`: hedged Curve Short vault with queued deposits/withdrawals and keeper-bounded rebalancing, 10 tests |
| [`mock-ft/`](mock-ft), [`mock-swap/`](mock-swap) | Testnet-only: faucet tokens (USDC, BTC) and an oracle-priced USDC↔BTC swap |
| [`ops/`](ops) | Testnet deployment, keeper (price feed + vault rebalancing), test players: see [`ops/README.md`](ops/README.md) |
| [`app/`](app) | The Uprise web app and its small server (device wallet, Bull/Crab tabs, deposits) |
| [`intents/`](intents) | NEAR Intents 1Click client and relayer (mainnet) |
| [`sim/`](sim) | Simulators: payoff, BTC replay, two-sided vault model + parameter search, live game view |
| [`PLAN.md`](PLAN.md) | Design notes, security assumptions, contract interface |

```bash
cargo test --workspace
```

```bash
RUSTC=$(rustup which rustc) RUSTFLAGS="-C link-arg=-s -C target-cpu=mvp" rustup run stable cargo build --workspace --target wasm32-unknown-unknown --release
```

```bash
cd ops && npm install && node keeper.js
```

```bash
node app/server.js
```

The earlier order-book perpetual (PRISM v3–v5) is on the `perpetual` branch.
