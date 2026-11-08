# PRISM — Non-custodial perps on NEAR, settled by Intents

Built at the NEAR Hackathon. PRISM is a perpetual-futures protocol where the
state that matters — positions, margin, mark price, funding, liquidation —
lives in a NEAR smart contract, while **all asset movement is delegated to
NEAR Intents (1Click)**. There is no operator holding user funds, no admin key
that can freeze or seize a position, and settlement still executes even if
every off-chain source is down.

## The problem

Perpetual DEXs solve price discovery but outsource the money to a host chain
or an AMM, and most of them keep a custodial or operator-controlled layer.
If the host chain congests or the operator disappears, your margin is stuck.
Cross-chain perps today require you to manually move collateral before you
can trade or settle.

## What PRISM does

- **Positions, margin, risk, funding, liquidation** are on-chain on NEAR
  (sub-second finality, ~$0.001 fees).
- **Opening, closing and settling positions are Intents**: the user expresses
  "swap 100 USDC for wNEAR" (or "move USDC from Ethereum"), 1Click solvers
  execute it, and the contract's mark price does the accounting.
- **Dual-source price feed** (1Click wNEAR + CoinGecko, median) is pushed to
  the contract; v4 restricts mark pushes to a **designated price pusher
  (owner-governed)** — nobody can manipulate the mark.
- **Liquidation is congestion-proof**: the liquidator calls
  `liquidate_on_mark`, which prices the exit at the *on-chain* mark. A 50%
  equity reward keeps it economically viable. A 24/7 reference bot ships in
  the repo.
- **No custodian, no admin, no freeze**: the only privileged account is the
  owner, and it can only change who pushes prices.

## How to try it (no wallet, no funds needed)

```bash
git clone https://github.com/CansyLand/PRISM.git
cd PRISM/demo && cp ../.deploy.example .deploy.env   # testnet keys are public in .gitignored example
npm install
```

1. **Watch the full trading loop live on testnet** — open, crash, fund,
   close, verify PnL on-chain:
   ```bash
   npm run e2e        # 28 assertions, all against the LIVE v4 contract
   ```
   See: every flow print `PASS`, ending with `28/28`.

2. **Watch the liquidation bot do its job** — it opens a 10× position,
   crashes the mark −7%, and a separate 24/7 process detects and liquidates
   it, taking the 50% reward:
   ```bash
   npm run bot-test   # 5/5
   ```
   See: `bot LIQUIDATING ... position closed by bot ... reward $3,777`.

3. **Open the live dashboard** (zero backend, raw JSON-RPC in the browser):
   ```bash
   cd ui && python3 -m http.server 8000
   ```
   See: `http://localhost:8000` — live mark price, contract params, the v4
   price-push governor (green "restricted to pusher"), and live positions
   from `prism-v4-2026.testnet`.

4. **See the cross-chain intent quote** (dry-run against the production
   1Click mainnet API — it rejects testnet recipients, so no funds move):
   ```bash
   npm run quote
   ```
   See: an executable quote for USDC→wNEAR, including cross-chain routes
   (verified: ETH→USDC on NEAR and Polygon).

Everything above runs against real testnet transactions on
`prism-v4-2026.testnet` — the live dashboard shows the same data the e2e
suite just wrote.

## Where NEAR is the load-bearing part

- **NEAR Intents / 1Click**: funding, entry settlement and exit settlement
  are all intent-routed; PRISM never touches user assets.
- **Contract-side risk**: liquidation prices at the on-chain mark, so a
  congested settlement chain cannot block a liquidation.
- **Owner-governed price pusher** (v4): the only privileged action is
  designating who may push marks — auditable via `get_owner`/`get_pusher`.
- NEAR's sub-second finality is what makes a 5-second liquidation poll loop
  safe at scale.

## Test status

- 33/33 Rust unit tests (risk math, funding, pusher governance)
- 28/28 live e2e userflows on testnet (v4) + 24/24 on v3 for comparison
- 5/5 live liquidation-bot integration test
- Live dashboard verified against both v4 and v3 contracts
