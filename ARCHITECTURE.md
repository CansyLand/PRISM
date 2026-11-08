# PRISM — Architecture & Lego-Piece Tracker

**Vision:** non-custodial, cross-chain perpetual futures with intent-based settlement.
Positions are open/closable by anyone, state lives on NEAR, matching/settlement is
routed by the existing NEAR Intents solver network, and no party can freeze or seize
a position. Built lego-style: each piece has one job, a defined interface, and can be
swapped or added without rewriting the rest.

**Status legend:** ✅ built & verified · 🟡 partial (interface exists, gap noted) · ⬜ not started

---

## 1. Piece inventory (all 9 blocks from the design doc)

| # | Piece | Status | Where it lives | Interface (in → out) |
|---|-------|--------|----------------|----------------------|
| 1 | **Position & Margin Ledger** | ✅ | `contract/src/lib.rs` (deployed: `contract.prism-v2-1455.testnet`, v3) | open/close/liquidate commands → position state, PnL, health |
| 2 | **Intent Factory** | ✅ | `demo/intent.js` (`buildIntent`) | user action + params → formatted 1Click intent (slippage, deadline, refund) |
| 3 | **Solver / Execution Adapter** | ✅ | `demo/intent.js` (`quote`, `status`) + `demo/demo.js` (fill feedback) | intent → quote/depositAddress/status → **fill price written back to ledger via `settle_entry`** |
| 4 | **Risk Engine** | ✅ (folded into ledger) | `contract/src/lib.rs` (equity-based, 5% maintenance margin, 10× cap) | position + ON-CHAIN mark → healthy / liquidatable |
| 5 | **Price Feed** | ✅ | `demo/pricefeed.js` → `update_mark` in contract | **2 sources (1Click + CoinGecko) → median + deviation check → on-chain `mark_price`/`mark_ts`** (20% guard, 50% if stale >1h) |
| 6 | **Liquidation Module** | ✅ | `liquidate_on_mark`/`close_position_at_mark` in contract + `demo/liquidate-demo.js` | stranger force-closes underwater position **at the on-chain mark** (no feed needed, congestion-proof); healthy positions refused (verified); 50% of remaining equity to the liquidator; liquidation expressed as a 1Click intent (dry-run) before on-chain settlement |
| 7 | **Funding & Settlement Engine** | ✅ | `set_funding_rate`/`apply_funding` in contract v3 + `demo/funding-demo.js` | signed bps rate per interval → clamped margin Δ between longs/shorts (10% cap, 0 floor), hourly gate; **demo verified end-to-end** |
| 8 | **Cross-Chain Controller (Chain Signatures)** | 🟡 (routes verified) | `refundType: "INTENTS"` quotes | ETH(Ethereum)→USDC(NEAR) $2232/45s and →USDC(Polygon) $2232.69/51s verified via 1Click dry-run; **gap:** not wired into the ledger yet |
| 9 | **UI / Agent Interface** | ✅ | `ui/` (zero-backend live dashboard) + `demo/full-loop.js` (CLI glue) | browser → raw JSON-RPC reads of live on-chain state (mark, params, positions+health, funding, stats), auto-refresh; full assembled loop in one CLI command |

**Also built (cross-cutting):**
- Deployment tooling: `demo/deploy.js` (wasm deploy + init + on-chain loop verify)
- **E2E userflow suite:** `demo/e2e-test.js` (`npm run e2e`) — 24 assertions of real
  on-chain transactions: trading loop, short symmetry, leverage/min-margin guards,
  full liquidation (crash → preview → stranger liquidates → 50% reward split),
  funding gate, view/stat reconciliation, cleanup. Exit 0 = all verified.
- Testnet faucet tooling: `demo/faucet-fund.js` (helper.nearprotocol.com JSON POST)

---

## 2. The one honest gap in today's demo

The 10× leverage is **modeled** in the ledger (PnL math + liquidation threshold), and the
funding/settlement prices are now the **real solver fill prices** fed back into the
contract (`settle_entry` / `close_position`). What's still a plain swap rather than true
margin exposure: buying the underlying 1× and modeling the 10× in PnL math, instead of a
counterparty or vault lending the extra 9×. That's the "real counterparty for 10×" item
in §4 — the step that turns modeled leverage into actual leverage.

---

## 3. Build order (next → later)

### A. Fill feedback: execution → ledger settlement  ✅ **BUILT & VERIFIED**
- Ledger gained `settle_entry(fill_price)`: only the position owner, while open,
  may overwrite `entry_price` with the **actual solver fill price** from the intent.
- Demo now: open intent → `settle_entry(quoted fill)` → close intent →
  `close_position(quoted fill)` → PnL computed from **real 1Click market prices**
  end-to-end (verified run: entry $3.6757, exit $3.6555, PnL −$0.20 = spread).
- Price rescale (verified): `price_6dp = USDCraw(6dp) × 10²⁴ / wNEARraw(24dp)`.
- Deploy made idempotent: redeploy keeps existing state (`#[init]` trap caught).
- With real funds the same code uses the actual fill amounts, not the quote.

### B. Liquidation demo  ✅ **BUILT & VERIFIED**
- `demo/liquidate-demo.js` — two-account scenario, verified on testnet:
  1. owner opens an underwater position (10×, margin coverage 20% < 50% threshold)
  2. stranger (`liquidator-8842.testnet`, second key, no admin role) attempts
     liquidation at a healthy mark price → **rejected by contract**
  3. same stranger liquidates at the live mark price → **position closed on NEAR**
- Second testnet account created via faucet; creds in `../.deploy.env`
  (LIQUIDATOR_ACCOUNT_ID / LIQUIDATOR_PRIVATE_KEY).
- This demonstrates the core "unstoppable" claim: risk rule + state live in the
  contract; no operator/order book/external sequencer is the source of truth.

### C. Price feed hardening  ✅ **BUILT & VERIFIED**
- `demo/pricefeed.js`: 1Click wNEAR price + CoinGecko NEAR/USD → median →
  on-chain `update_mark(mark)`; deviation guard in the contract (20% fresh /
  50% stale >1 h). Exports `updateMark(rawMark)` for crash simulation.

### D. Single-page UI  ✅ **BUILT & VERIFIED**
- `ui/index.html` + `ui/app.js`: zero-backend static dashboard. The browser
  calls the testnet RPC (CORS `*`) with raw JSON-RPC `fetch` — no SDK, no
  build step. Live mark + age, contract parameters, open positions with
  unrealized PnL and liquidation-health %, funding rate, aggregate stats;
  auto-refresh every 10 s; any contract id inspectable (mainnet-ready).
- State-changing actions stay in the CLI demos on testnet; wallet-signed
  versions join the UI for the mainnet launch (see MAINNET.md §3).

### E. Funding engine  ✅ **BUILT & VERIFIED**
- `set_funding_rate(funding_bps)` + `apply_funding()` in contract v3: hourly
  gate, delta = |size| × mark × rate / 10000, clamped to 10% of current
  margin, margin floors at 0. `demo/funding-demo.js` verified the exact
  margin movement end-to-end; `e2e-test.js` F6 covers the gate.

### F. Cross-chain controller (Chain Signatures)  ⬜ (last)
- Accept collateral on other chains; the ledger holds a Chain-Signatures
  controller key so positions can be settled with foreign-chain assets.
- Only needed once we want "collateral on any chain," not for the core loop.

---

## 4. Path to real money (what "production" actually requires)

| Milestone | What changes |
|-----------|-------------|
| Real fills | `dry=false` end-to-end with funded wallet; verify `/v0/status` → `success` before calling `settle_entry` with the on-chain fill amounts |
| Real counterparty for 10× | The swap becomes a true margin trade: intent buys 10× exposure (or we add a vault/CDP pool on NEAR as the counterparty). This is the step that makes it *actually* leveraged, not just modeled |
| Market makers | Solvers quoting our intents must be incentivized (fee split); monitor 1Click/Partner Portal for MM hooks |
| Oracle | Multi-source mark price (piece C) with on-chain deviation guard — required for dispute-free funding & liquidation |
| Cross-chain collateral | Chain Signatures (piece F) + Omnibridge for cross-chain state reads |
| Non-custody proof | Publish: no admin keys, no pause/freeze fn, liquidation is the only third-party mutation — and it's verifiable on-chain |

---

## 5. File → piece map

```
contract/src/lib.rs   → pieces 1, 4, 6, 7      [NEAR testnet, deployed]
demo/intent.js        → pieces 2, 3            [1Click API, mainnet]
demo/pricefeed.js     → piece 5                [2-source median → on-chain mark]
demo/liquidate-demo.js→ piece 6                [stranger liquidation + intent hedge]
demo/funding-demo.js  → piece 7                [funding engine end-to-end]
demo/full-loop.js     → piece 9 (CLI glue)     [feed → open → intent → close]
demo/e2e-test.js      → launch gate            [24-assertion live userflow suite]
ui/                   → piece 9 (web)          [zero-backend live dashboard]
demo/deploy.js        → deployment + verify
MAINNET.md            → mainnet runbook & audit gate
ARCHITECTURE.md       → this file
```

## 6. Environment facts (don't rediscover)

- Testnet accounts: `contract.prism-v2-1455.testnet` (v3 contract, creds in
  `.deploy.env`, git-ignored), `liquidator-8842.testnet` (stranger key),
  `prism-fund-11111.testnet` (faucet account, contract key).
- 1Click = **mainnet** intent network; `.testnet` recipients → server error. Demo uses
  `alice.near` placeholder recipient for dry-run quotes.
- Quote response: HTTP **201**, `amountOut`/`amountIn` in base units; USDC 6dp, wNEAR 24dp.
- 1Click asset IDs: wNEAR `nep141:wrap.near`, USDC `nep141:17208628…33a1`.
- Testnet RPC: `https://test.rpc.fastnear.com` (CORS `*`; JSON-RPC view calls return
  `result` as a **byte array**, not base64). Faucet: `helper.nearprotocol.com/account`
  (JSON body `{"account_id","public_key"}`). near.org domains don't resolve here.
- near-api-js **v7**: `new Account(id, provider, privateKey)`, `account.createTransaction` +
  `KeyPairSigner.fromSecretKey(...).signTransaction(...)`, `provider.sendTransaction(...)`.
  **`callFunction` returns the return value only** — for tx logs use
  `callFunctionRaw`, logs live at `receipts_outcome[].outcome.logs`.
  `createTransaction` publicKey must be the **signer's** key.
- near-sdk 5: `#[near(contract_state)]` + `#[near]` impl + `#[init]`, `PanicOnDefault` on state.
- Storage rent on testnet ≈ 18 NEAR for the v3 state — top up with `faucet-fund.js`.
