# PRISM — Non-custodial Perpetuals on NEAR, Settled by Intents

PRISM is a **leverage-as-lego** perpetual-futures platform: positions, margin,
risk, funding, and liquidation are independent on-chain modules on NEAR, while
asset movement (funding, settlement, cross-chain collateral) is delegated to
**NEAR Intents** (1Click). No operator is the source of truth: the mark price,
the risk rules, and the positions all live in the contract, and liquidation /
settlement still execute if every off-chain source is down.

```
┌──────────────────── NEAR (state + risk) ────────────────────┐
│  positions · margin · mark price · funding · liquidation    │
└──────────────┬──────────────────────────────────┬───────────┘
               │ open/close/liquidate intents     │ dual-source price
               ▼                                  ▼
     ┌──────────────────┐              ┌─────────────────────┐
     │ 1Click Intents   │              │ 1Click wNEAR price  │
     │ (USDC↔wNEAR,     │              │ + CoinGecko NEAR/USD│
     │  cross-chain)    │              │ → median → on-chain │
     └──────────────────┘              │ mark (update_mark)  │
                                        └─────────────────────┘
```

**Verified on NEAR testnet:**
`prism-v4-2026.testnet` (**v4, pusher-governed** — the deployable build) ·
33 unit tests + **live e2e userflow suite** (`npm run e2e`, 25–28 assertions
depending on the funding-hour branch) · web dashboard · intent quotes are
dry-run against the production 1Click mainnet (it rejects `.testnet`
recipients), so the loop needs **no wallet and no funds** to demo.
The v3 contract (`contract.prism-v2-1455.testnet`, permissionless price feed)
remains deployed for comparison; `e2e-test.js` runs against either via
`E2E_CONTRACT` / `E2E_PUSHER`.

---

## The lego blocks

| # | Block | Status | Where |
|---|-------|--------|-------|
| 1 | Position & margin ledger | ✅ live | `contract/src/lib.rs` |
| 2 | Intent factory | ✅ live | `demo/intent.js` (unsigned dry-run) |
| 3 | Solver / execution adapter | ✅ live | 1Click quote + status + settle |
| 4 | Risk engine | ✅ live | equity-based, on-chain mark, 5% maintenance |
| 5 | Price feed | ✅ live | `demo/pricefeed.js` dual-source median push |
| 6 | Liquidation module | ✅ live | on-chain + intent-routed, 50% equity reward |
| 7 | Funding engine | ✅ live | hourly, clamped, on-chain |
| 8 | Cross-chain controller | ⬜ partial | 1Click routes verified (ETH→USDC on NEAR & Polygon), contract integration pending |
| 9 | UI | ✅ live | `ui/` zero-backend live dashboard |

---

## Contract (v4)

| Method | Kind | Args | Returns |
|---|---|---|---|
| `new` | init | – | contract (owner = caller) |
| `open_position` | state | `size: i128`, `price: u128`, `margin: u128` (USDC 6dp) | – |
| `settle_entry` | state | `fill_price: u128` | – |
| `close_position` | state | `exit_price: u128` | `i128` PnL |
| `close_position_at_mark` | state | – | `i128` PnL at on-chain mark |
| `liquidate_on_mark` | state | `account_id` | `LiquidationResult` |
| `update_mark` | state (**pusher**) | `mark: u128` (USDC 6dp) | – |
| `set_funding_rate` | state (**pusher**) | `funding_bps: i128` (positive = longs pay) | – |
| `apply_funding` | state | – | `u128` transferred |
| `set_pusher` | state (**owner**) | `price_pusher: AccountId?` | – |
| `get_position` | view | `account_id` | `Position?` |
| `get_positions` | view | – | `Vec<Position>` |
| `get_mark` | view | – | `[u128 price, u64 ts]` |
| `get_params` | view | – | constants (liq_bps, max_leverage, …) |
| `get_stats` | view | – | open/notional/margin/penalty earned |
| `preview_liquidation` | view | `account_id` | `LiquidationResult?` (None if healthy) |
| `funding_rate_bps` / `last_funding_ts` | view | – | scalar |
| `get_owner` / `get_pusher` | view | – | governor state |

### Rules (on-chain, no admin, no freeze, no seize)

- **Maintenance margin** `LIQ_BPS = 500` (5% of notional). Liquidatable when
  `equity < 5% × notional` at the mark, where `equity = margin + size×(mark−entry)`.
- **Max leverage** `MAX_LEVERAGE_BPS` → minimum entry margin 10% of notional
  (10×); over-leveraged opens are rejected.
- **Liquidation reward** `LIQ_PENALTY_BPS = 5000`: the liquidator earns 50% of
  the position's remaining equity; the owner keeps the rest. Anyone may call.
- **Funding**: `apply_funding` at most once per `min_funding_interval` (1 h);
  delta = `|size| × mark × rate / 10000`, clamped to 10% of the position's
  current margin; margin floors at 0.
- **Mark freshness**: first mark accepted; subsequent within 20% (fresh) or
  50% (mark older than 1 h) — a deviation guard against a single bad push.
- **Min margin** $1 (USDC 6dp). `size` signed: + long, − short.
- **v4 pusher governance**: `owner` (set at `new()`) may set/clear one
  `price_pusher`. While a pusher is set, **only the pusher** may call
  `update_mark` and `set_funding_rate`; everything else stays
  permissionless — anyone can still open/close positions and liquidate.
  Pusher unset = v3 permissionless mode (testnet convenience). Trading and
  liquidation are never restricted.

> u128 args must be JSON **numbers**, not strings.

---

## Repository layout

```
near/
├── contract/                # Rust NEAR contract (near-sdk)
│   └── src/lib.rs           # ~950 lines, 33 unit tests
├── demo/
│   ├── deploy.js            # build→deploy→init→verify
│   ├── setup-v4.js          # v4: fresh faucet account + deploy + set_pusher + fund
│   ├── faucet-create.js     # helper.nearprotocol.com account w/ our public key
│   ├── pricefeed.js         # dual-source mark feed + on-chain push
│   ├── liquidate-demo.js    # crash → stranger liquidates → intent hedge (dry)
│   ├── funding-demo.js      # funding engine end-to-end
│   ├── full-loop.js         # glue: price→open→intent→close (degrades offline)
│   ├── demo.js              # full loop with real 1Click fills
│   ├── e2e-test.js          # live userflow suite (npm run e2e; E2E_CONTRACT/E2E_PUSHER)
│   ├── liquidation-bot.js   # 24/7 liquidation watcher (npm run bot)
│   ├── bot-live-test.js     # live bot integration test (npm run bot-test)
│   ├── intent.js            # 1Click wrapper (quote + status)
│   ├── faucet-fund.js       # testnet faucet → contract/liquidator funding
│   ├── check-balances.js · check-keys.js · inspect-state.js · topup.js
│   └── package.json
├── ui/
│   ├── index.html           # zero-backend dark dashboard (live on-chain)
│   └── app.js               # raw JSON-RPC reads, no SDK dependency
├── ARCHITECTURE.md          # design + lego status
├── MAINNET.md               # mainnet runbook & audit
├── .deploy.env              # testnet credentials (gitignored — never commit)
└── .account                 # master account (gitignored)
```

---

## Prerequisites

- **Rust** + `rustup target add wasm32-unknown-unknown` (build only)
- **Node.js ≥ 18** (demos, tests, UI)
- `.deploy.env` at `near/.deploy.env` with `ACCOUNT_ID`, `PRIVATE_KEY`,
  `LIQUIDATOR_ACCOUNT_ID`, `LIQUIDATOR_PRIVATE_KEY` (testnet; gitignored)

## Commands

```bash
# 1. Contract unit tests (33)
cd contract && cargo test

# 2. Build + deploy (testnet)
cd demo && npm install && npm run deploy

# 2b. v4: fresh faucet account + deploy + set_pusher + fund (one-shot)
npm run setup-v4

# 3. Live userflow suite (real txs on testnet; target via E2E_CONTRACT/E2E_PUSHER)
npm run e2e

# 3b. Liquidation bot (24/7 watcher) + its live integration test
npm run bot        # polls every 5 s; BOT_ONESHOT=1 for a single pass
npm run bot-test   # opens a 10x, crashes the mark -7%, bot liquidates (5/5 verified)

# 4. Individual userflows
npm run pricefeed     # push live dual-source mark on-chain
npm run liquidate     # crash → stranger liquidation → intent hedge (dry)
npm run funding       # funding engine end-to-end
npm run full          # price → open → intent quote → close glue loop
npm run demo          # full loop with real 1Click fill prices

# 5. Web dashboard (no build, no backend)
cd ui && python3 -m http.server 8642 --bind 127.0.0.1
# → http://127.0.0.1:8642  (talks to test.rpc.fastnear.com directly, CORS *)

# 6. Testnet faucet funding
npm run faucet        # if the contract needs more NEAR for storage rent
```

---

## The e2e userflows (what `npm run e2e` proves on-chain)

- **F1 trading loop** — open 10× long → entry pinned to mark → close at same
  mark → `pnl = 0` exactly → position gone
- **F2 short symmetry** — open short → close at same mark → `pnl = 0`
- **F3 leverage guard** — over-leveraged open rejected; 1× still legal
- **F4 min-margin guard** — sub-$1 margin rejected
- **F5 liquidation** — healthy 10× not liquidatable → −7% crash puts equity
  below 5% → `preview_liquidation` matches → **stranger** liquidates on mark →
  reward = exactly 50% of remaining equity → position closed
- **F6 funding engine** — rate set on-chain; hourly gate enforced; (when the
  gate is open) margin moves exactly per model
- **F7 views & stats** — `get_params`, `get_mark`, `get_stats` reconcile with
  `get_positions`
- **F9 pusher governance (v4)** — `get_owner`/`get_pusher` set; a stranger's
  `update_mark` and `set_funding_rate` are **rejected on-chain** (skipped on
  v3, where the feed is permissionless)
- **F8 cleanup** — zero open positions remain

Exit code 0 = all flows verified; any ✗ fails the run.

---

## The web dashboard (`ui/`)

Zero-backend on purpose: the browser calls `test.rpc.fastnear.com` (CORS `*`)
with plain JSON-RPC `fetch` — **no SDK, no build step, no server**. It renders
live on-chain state: mark price + age, contract parameters, open positions
(size, entry, margin, unrealized PnL, liquidation health vs the 5% floor),
funding rate, and aggregate stats — auto-refreshing every 10 s. Any deployed
contract can be inspected via the contract-id field (mainnet included).

State-changing actions (open/close/liquidate) run through the CLI demos and
will go through a connected NEAR wallet (MyNearWallet) once the contract is
on mainnet — the UI's RPC layer is network-agnostic.

---

## Explicitly honest about scope

- **Intents are dry-run** in the testnet loop: the production 1Click API
  rejects `.testnet` recipients, so quotes use a representative mainnet
  recipient (`alice.near`) and never spend funds. On mainnet the same code
  path becomes real.
- **Leverage is modeled**: margin, PnL, funding and liquidation are enforced
  on-chain; the actual token custody is currently in the user's wallet (the
  intent route for vaulted collateral is the next integration, lego block 8).
- **Storage rent**: NEAR testnet charges rent on the whole state blob (~18
  NEAR for the v3 state); `faucet-fund.js` tops the contract up when needed.
- Mainnet readiness checklist: see **MAINNET.md**.

## Security / custody

- No `freeze`, no `seize`, no pausing. The only forced mutation anyone other
  than the owner can cause is liquidation of an underwater position.
- **v4 price-push authorization**: the single mutable input that would let an
  attacker manipulate PnL — the mark price — is gated to one pusher account
  that the owner (and only the owner) can change. With no pusher set the
  contract falls back to v3's permissionless feed (dev convenience, never use
  on mainnet). The owner cannot trade, liquidate, or read user funds — they
  only choose who feeds the price.
- All risk state (positions, mark, health check) is on-chain; liquidation does
  not depend on any off-chain price or operator.
- Intent settlement routes through the `intents.near` verifier — unfilled
  intents auto-refund.
