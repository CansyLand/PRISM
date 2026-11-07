# Minimal Intent-Based Leveraged Position on NEAR

A prototype where a user can **open** and **close** a leveraged position:

- **Position state lives in a NEAR smart contract** (Rust, near-sdk).
- **Opening/closing funding & settlement go through NEAR Intents** via the
  official [1Click API](https://1click.chaindefuser.com) (dry-run quotes, no funds).
- **Custodial by design:** no freeze or seize. The only state mutation anyone
  other than the owner can force is `liquidate` on an underwater position.

```
 open ──intent(USDC→wNEAR)──> contract.open_position()  → position visible (get_position)
 close ─intent(wNEAR→USDC)──> contract.close_position() → PnL realized, position closed
```

> **Networks, stated honestly:** the position *state* is deployed and verified on
> **NEAR testnet**. The 1Click API is the **production mainnet** intent network —
> it returns real quotes for existing mainnet recipients but rejects `.testnet` /
> non-existent accounts. So the funding/settlement *intents* run as **dry-run
> quotes against the mainnet 1Click solver** using a representative mainnet
> recipient (default `alice.near`). Nothing spends real funds in the demo.

---

## Repository layout

```
near/
├── contract/                 # Rust NEAR smart contract
│   ├── Cargo.toml
│   └── src/lib.rs            # ~93 lines: open/close/get/liquidate
├── demo/
│   ├── deploy.js             # build→deploy→init→open→get→close on testnet
│   ├── intent.js             # 1Click intent wrapper (quote + status + CLI)
│   ├── demo.js               # full loop: open→visible→close (dry-run)
│   └── package.json
├── tools/                    # near-cli-rs binary (optional, not needed)
├── .deploy.env               # testnet credentials (DO NOT COMMIT to public repo)
└── README.md
```

---

## Prerequisites

- **Rust** (with the wasm target) — to build the contract.
  ```bash
  rustup target add wasm32-unknown-unknown
  ```
- **Node.js ≥ 18** — for the demo + intent wrapper.
- An **NEAR testnet account** with a funded balance (≈1 NEAR) to host the
  contract. `.deploy.env` (already present in this repo) holds the account
  `leveraged-pos-1455.testnet`. To create your own headlessly:
  ```bash
  near account create-account sponsor-by-faucet-service <name>.testnet \
    autogenerate-new-keypair print-to-terminal network-config testnet create
  ```
  then put the key in `.deploy.env` (`ACCOUNT_ID`, `PUBLIC_KEY`, `PRIVATE_KEY`).

---

## 1) Build the contract

```bash
cd contract
source "$HOME/.cargo/env" 2>/dev/null; export PATH="$HOME/.cargo/bin:$PATH"
cargo test                                        # 4 unit tests
cargo build --target wasm32-unknown-unknown --release
ls target/wasm32-unknown-unknown/release/leveraged_positions.wasm
```

### Contract methods

| Method | Kind | Args | Returns |
|---|---|---|---|
| `new` | init | – | contract |
| `open_position` | state | `size: i128` (±base units), `price: u128`, `margin: u128` (USDC 6dp) | – |
| `close_position` | state | `exit_price: u128` (USDC 6dp) | `I128` PnL |
| `liquidate` | state | `account_id`, `mark_price: u128` | `I128` PnL |
| `get_position` | view | `account_id` | `Position?` |
| `get_positions` | view | – | `Vec<Position>` |

- `size` is **signed**: positive = long, negative = short.
- Prices/margins are **USDC raw units** (6 decimals).
- **PnL** = `size × (exit − entry)` in USDC raw units.
- **Liquidation**: anyone may call `liquidate` when margin coverage < 50% of
  notional (`margin×10000 < |size|×mark×5000`). Healthy positions panic.
- No admin keys, no `freeze`/`seize` — the owner can always close, and only an
  underwater position can be forced.

---

## 2) Deploy to testnet (and verify the on-chain loop)

```bash
cd demo
npm install
npm run deploy
```

This deploys the wasm, calls `new()`, then performs a **real on-chain**
`open → get_position → close_position` and prints each step. Expected tail:

```
Position after open:  {"owner":"leveraged-pos-1455.testnet","size":1000,"entry_price":200000000,"margin":100000000,"is_open":true}
Position after close: {... "is_open":false}
=== ON-CHAIN LOOP VERIFIED ON TESTNET ===
```

---

## 3) Run the full demo (open → visible → close, dry-run)

```bash
cd demo
npm run demo
```

This pulls a **live wNEAR price** from the 1Click tokens endpoint, requests
**dry-run 1Click quotes** for the funding (open) and settlement (close)
intents, and drives the testnet contract through the full loop:

```
1) LIVE MARKET PRICE ...  wNEAR price = $3.65
2) OPEN INTENT (dry-run): fund margin USDC -> wNEAR ... 3.65 USDC => 0.999 wNEAR
3) OPEN POSITION ON-CHAIN (testnet) ... {"...","is_open":true}
4) SHOW CURRENT POSITION (view call) ... {"...","is_open":true}
5) CLOSE INTENT (dry-run): settle wNEAR -> USDC ... 10.0 wNEAR => 36.35 USDC
6) CLOSE POSITION ON-CHAIN ... {"...","is_open":false}  PnL = $1.83
LOOP COMPLETE ✓
```

---

## 4) Use the intent wrapper directly

Dry-run quote (no funds):
```bash
cd demo
node intent.js open 100000000          # 100 USDC → wNEAR
node intent.js close 10000000000000000000000   # 10 wNEAR → USDC
```

Executable quote (returns a `depositAddress`; you'd then send the origin asset
to it, and it fills or auto-refunds):
```bash
node intent.js open 100000000 alice.near --real
```

Track a real swap's lifecycle (`pending → processing → success / refunded`):
```bash
node intent.js status <depositAddress> [depositMemo]
```

### `intent.js` API

```js
const { tokenPrice, quote, status } = require("./intent");
const near = await tokenPrice("wNEAR");                       // live $/token
const q = await quote({ action: "open", amount: "100000000",  // USDC→wNEAR
                        account: "alice.near", dry: true });
// q.quote: { amountIn, amountOut, amountOutFormatted, timeEstimate, ... }
// q.depositAddress: present only when dry=false
const s = await status(q.depositAddress);                       // filled/refunded?
```

- **open** funds the margin (`USDC → wNEAR`); **close** settles the position
  (`wNEAR → USDC`). `dry=true` (default) only quotes — this is what judges can
  run with no wallet or funds.
- The 1Click quote returns HTTP `201`; the wrapper treats `200/201` as success.

---

## Acceptance criteria

- [x] Contract deployed on testnet (`leveraged-pos-1455.testnet`)
- [x] Can open a position and see it via view call (`get_position`)
- [x] Can close the position (`close_position`, PnL returned)
- [x] Open & close produce valid 1Click intents returning real quotes (dry-run)
- [x] Demo script (`demo/demo.js`) shows the full loop
- [x] README with exact commands

---

## Explicitly NOT built (per brief)

Funding payments (real deposits), a custom solver / matching engine,
cross-chain collateral / Chain Signatures, a price-oracle aggregator,
liquidation penalties or an insurance fund, analytics/history, or an agent
interface. The demo uses **dry-run** quotes so it runs with **no funds**.

## Security / custody

- No admin capability, no `freeze`, no `seize` on the contract.
- All critical state (positions, health/liquidation check) is **on-chain**.
- The 1Click path settles via the `intents.near` verifier; if an intent can't be
  filled it **auto-refunds** to `refundTo`.
