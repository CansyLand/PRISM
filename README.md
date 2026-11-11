# Curve: a continuous-expiry power perpetual on NEAR

An oracle-priced, fully collateralized ledger with two sides:

- **Curve** gets convex upside, a value of `NF × (P / P_ref)^p` (p = 2 by default). It pays
  funding continuously by shrinking, and it is **never liquidated**.
- **Flat/Earn** owns what's left of the pool and collects that funding. It does best in quiet markets.

Users deposit and withdraw from any chain through **NEAR Intents (1Click)**. A platform relayer
pays all gas, so users never see NEAR.

| Path | What |
|---|---|
| [`PLAN.md`](PLAN.md) | 2-day build plan, end-to-end path, reused components, security assumptions, contract interface |
| [`contract/`](contract) | `curve-ledger`: Rust, near-sdk 5 |
| [`intents/`](intents) | 1Click client, relayer for Telegram accounts, oracle/funding keeper |
| [`sim/curve-simulator.html`](sim/curve-simulator.html) | Interactive simulator: Curve Long, Curve Short, both hedged variants, the exchange, and a Monte Carlo panel |
| [`sim/MONTECARLO.md`](sim/MONTECARLO.md) | Monte Carlo findings on long vs short balance (`node sim/montecarlo.js`) |
| [`sim/btc-replay.html`](sim/btc-replay.html) | Exchange mockup replayed on real BTC prices: daily Jul 2020 – Mar 2023 and 1-minute for the 16–23 May 2021 crash week (data: `sim/btc-*.json`, Binance) |

```bash
cd contract && cargo test
```

```bash
cd contract && RUSTC=$(rustup which rustc) RUSTFLAGS="-C link-arg=-s -C target-cpu=mvp" rustup run stable cargo build --target wasm32-unknown-unknown --release
```

```bash
cd intents && npm install && cp .env.example .env
```

The earlier order-book perpetual (PRISM v3–v5, liquidation bot, dashboard, business docs) is on the
`perpetual` branch.
