# PRISM — Mainnet Readiness Runbook

What must be true before PRISM goes live on NEAR mainnet. Status is audited
against the testnet build of 2026-11-08 (**contract v4, pusher-governed**,
33 unit + live e2e userflow suite on `prism-v4-2026.testnet`).

## 1. Contract audit checklist

| Area | Status | Notes |
|---|---|---|
| No admin / freeze / seize | ✅ | Only forced mutation is liquidation of an underwater position |
| Reentrancy | ✅ | No external calls from the contract; state mutations are self-contained. (Intent settlement is called *by the user/solver*, not by the contract — no call-back surface.) |
| Price manipulation of the mark | ✅ guarded | 20% fresh / 50% stale deviation gate on `update_mark`; dual-source median pusher off-chain. **Mainnet TODO:** run 2+ independent pusher nodes + attestation before accepting a mark. |
| `update_mark` authorization | ✅ **v4** | Gated to `price_pusher` (set by owner via `set_pusher`). `None` = permissionless dev mode — **must be set before mainnet**. |
| Integer overflow | ✅ | u128 math, NEAR wasm 32-bit `i128`/`u128` is checked in release. **Confirm `overflow-checks` in Cargo profile.** |
| Gas | ✅ | 0.3 TGas per mutation, well under 30 TGas block budget; loops are O(positions) only in `get_positions`. |
| Storage | ✅ | One `Position` per owner; `get_stats` is an aggregation — fine for thousands of positions. **TODO:** cap or paginate if position count grows large (stats scans all). |
| Liquidation edge cases | ✅ | `require!(equity*10000 < notional*500, "healthy")` — healthy positions cannot be touched; reward split is exact integer math. |
| Negative funding / underflow | ✅ | Funding delta clamped to 10% of current margin, margin floors at 0 (cannot go negative). |
| `set_funding_rate` authorization | ✅ **v4** | Gated to the same `price_pusher`. |
| Pusher-governance edge cases | ✅ **v4** | `set_pusher` is owner-only; changing the pusher cannot open/close/liquidate or read funds. Unset = v3 dev fallback. |
| Event logs | ✅ | Structured JSON logs on open/close/liquidate/funding for indexers. |
| Versioning / upgrades | ⬜ **TODO** | Deploy mainnet with an upgrade path (contract owner key held by a multisig) OR freeze the wasm and rely on NEP-330 (state migration) — decide before launch. |

## 2. Off-chain components to make production-grade

| Component | Testnet today | Mainnet requirement |
|---|---|---|
| Price feed (`pricefeed.js`) | single node, 2 sources, median | 2+ independent nodes, alerting, attested source identity, fallback marks |
| Funding-rate oracle | demo script sets it | scheduled off-chain service: `sign(mark−index)/index` per interval, push with same auth as marks |
| Liquidation bots | **live: `demo/liquidation-bot.js`** (5 s poll, on-chain-only, one-shot mode for cron) | 24/7 on a real node: `npm run bot`; `bot-live-test.js` proves the full detect→liquidate→reward cycle live |
| Intent solver | 1Click dry-run quotes | real 1Click production keys / or own solver; vaulted collateral account (module 8) so margin is custodied on-chain |
| Web UI wallet | CLI-only (testnet) | MyNearWallet connect for open/close/liquidate; same raw-RPC reads work on mainnet (`mainnet.fastnear.com`, check CORS or proxy) |

## 3. Mainnet deployment steps

1. **Fork the repo, create `.deploy.env`** with a **fresh mainnet keypair**
   (never reuse testnet keys).
2. **Create the contract account** on mainnet:
   `near account create-account <prism-contract>.near autogenerate-new-keypair ... network-config mainnet create`
   (sponsored via 1Click/ChainSigner or a bootstrap account with ~$50).
3. **Build** the wasm with `overflow-checks` confirmed on:
   `cargo build --target wasm32-unknown-unknown --release`
4. **Deploy** with the **v4** wasm; call `new()` (caller becomes owner).
5. **Call `set_pusher` (owner)** to designate the mark-feed service account.
   Until then the feed is permissionless — never leave it unset on mainnet.
6. **Run `e2e-test.js` against mainnet** (point `NODE_URL` at
   `https://mainnet.fastnear.com`, `E2E_PUSHER=<pusher account>`) with a small
   bootstrap account as owner + a second account as liquidator. The full
   suite (incl. F9 governance rejections) is the launch gate.
7. **Fund the mark feed** service and verify `update_mark` lands (2-source
   median, deviation guard) **from the pusher key only**.
8. **Deploy one liquidation bot**, open a real 10× position with ~$10 margin,
   verify a full open→crash→liquidation→reward cycle with real USDC.
9. **Ship the UI** on mainnet (same `ui/`, different `NODE_URL`/`contract`),
   with MyNearWallet for state-changing calls.

## 4. Economics to finalize before launch

- **Fee layer**: currently 0% fee on open/close; the liquidator's 50% equity
  reward is the only fee. Decide: bps fee on realized PnL (to an insurance
  fund or treasury) — contract change, needs its own test pass.
- **Insurance fund**: liquidations where remaining equity < 0 (impossible with
  the 20% mark gate but possible with gap risk) currently forfeit to the
  liquidator. A mainnet version routes the shortfall to a named fund account.
- **Storage rent**: ~18 NEAR on testnet for the v3 state; mainnet rent is
  charged differently — measure after first state write and top the contract
  account accordingly.

## 5. Launch gate (all must be green)

- [x] 33/33 `cargo test` (v4, incl. pusher-governance tests)
- [x] `npm run e2e` green on testnet against v4 (incl. F9 governance rejections)
- [ ] `npm run e2e` green **on mainnet**
- [x] `update_mark` + `set_funding_rate` restricted to authorized pushers (v4)
- [ ] `set_pusher` called on mainnet before any real volume
- [ ] Mark feed running from 2 nodes with alerts
- [x] Liquidation bot built + live-tested (detect→liquidate→reward verified on testnet); still needs ≥ 24 h uninterrupted uptime before launch
- [ ] Real USDC liquidation cycle verified on mainnet
- [ ] UI connected via MyNearWallet, open/close/liquidate all working
- [ ] Wasm hash pinned in the deploy record; no unknown code paths
