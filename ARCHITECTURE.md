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
| 1 | **Position & Margin Ledger** | ✅ | `contract/src/lib.rs` (deployed: `leveraged-pos-1455.testnet`) | open/close/liquidate commands → position state, PnL, health |
| 2 | **Intent Factory** | ✅ | `demo/intent.js` (`buildIntent`) | user action + params → formatted 1Click intent (slippage, deadline, refund) |
| 3 | **Solver / Execution Adapter** | ✅ | `demo/intent.js` (`quote`, `status`) + `demo/demo.js` (fill feedback) | intent → quote/depositAddress/status → **fill price written back to ledger via `settle_entry`** |
| 4 | **Risk Engine** | ✅ (folded into ledger) | `contract/src/lib.rs` (liquidation threshold 50%) | position + price → healthy / liquidatable |
| 5 | **Price Feed** | 🟡 | `demo/intent.js` (`tokenPrice`) | 1Click `/v0/tokens` → live $/token. **Gap:** single source, no index vs mark distinction |
| 6 | **Liquidation Module** | ✅ | `liquidate` in contract + `demo/liquidate-demo.js` | stranger force-closes underwater position on NEAR; healthy positions refused (verified). **Gap:** no intent/penalty flow yet |
| 7 | **Funding & Settlement Engine** | ⬜ | — | schedule → funding Δ on positions (needs mark vs index) |
| 8 | **Cross-Chain Controller (Chain Signatures)** | ⬜ | — | commands → signed foreign-chain txs (collateral on ETH/BTC etc.) |
| 9 | **UI / Agent Interface** | 🟡 | `demo/demo.js` (CLI script) | user actions → open/close/show. **Gap:** no single-page UI yet |

**Also built (cross-cutting):**
- Deployment tooling: `demo/deploy.js` (wasm deploy + init + on-chain loop verify)
- 1Click API knowledge: `recipientType: DESTINATION_CHAIN` required; quotes return HTTP 201;
  API is the **mainnet** intent network (errors on `.testnet` recipients); status endpoint `/v0/status`

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

### C. Price feed hardening  ⬜ **NEXT PIECE**
- Second source (NEAR DEX via RPC) → median of two, store `mark_price` + `timestamp`
  in the ledger via an `update_price` method anyone may call (with deviation guard).
  This also creates the mark/index split funding needs later.

### D. Single-page UI  ⬜
- One static HTML page (no backend): open / show / close buttons → same functions as
  `demo.js`, signed via wallet (MetaMask-ish NEAR wallet) or a testnet dev key.
  Judges click buttons instead of reading terminal output.

### E. Funding engine  ⬜ (only after A–D)
- Hourly cron calls `apply_funding(positions, mark, index)` on the ledger;
  longs pay shorts (or vice versa) proportionally to open interest. Pure ledger math —
  payment flows through an intent (`PayFunding`).

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
contract/src/lib.rs   → pieces 1, 4, (6)        [NEAR testnet]
demo/intent.js        → pieces 2, 3, 5          [1Click API, mainnet]
demo/deploy.js        → deployment + verify
demo/demo.js          → piece 9 (CLI flavor)
ARCHITECTURE.md       → this file
```

## 6. Environment facts (don't rediscover)

- Testnet account: `leveraged-pos-1455.testnet` (creds in `.deploy.env`, git-ignored)
- 1Click = **mainnet** intent network; `.testnet` recipients → server error. Demo uses
  `alice.near` placeholder recipient for dry-run quotes.
- Quote response: HTTP **201**, `amountOut`/`amountIn` in base units; USDC 6dp, wNEAR 24dp.
- 1Click asset IDs: wNEAR `nep141:wrap.near`, USDC `nep141:17208628…33a1`.
- near-api-js **v7**: `new Account(id, provider, privateKey)`, `account.createTransaction` +
  `KeyPairSigner.fromSecretKey(...).signTransaction(...)`, `provider.sendTransaction(...)`.
- near-sdk 5: `#[near(contract_state)]` + `#[near]` impl + `#[init]`, `PanicOnDefault` on state.
