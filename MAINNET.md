# PRISM — Mainnet Readiness Runbook

What must be true before PRISM goes live on NEAR mainnet. Status is audited
against the testnet build of 2026-11-08 (contract v3, 25 unit + 24 e2e tests).

## 1. Contract audit checklist

| Area | Status | Notes |
|---|---|---|
| No admin / freeze / seize | ✅ | Only forced mutation is liquidation of an underwater position |
| Reentrancy | ✅ | No external calls from the contract; state mutations are self-contained. (Intent settlement is called *by the user/solver*, not by the contract — no call-back surface.) |
| Price manipulation of the mark | ✅ guarded | 20% fresh / 50% stale deviation gate on `update_mark`; dual-source median pusher off-chain. **Mainnet TODO:** multi-pusher redundancy + attestation before accepting a mark; consider a Timelock on mark source changes (currently: any authorized feed key). |
| `update_mark` authorization | ⬜ **TODO** | Today any account can call `update_mark` (dev simplicity). For mainnet: restrict to a feed-pusher account (or NEP-447 attested oracles). |
| Integer overflow | ✅ | u128 math, NEAR wasm 32-bit `i128`/`u128` is checked in release? — verify `overflow-checks` in Cargo profile (near-sdk enables checked). **Confirm in build flags.** |
| Gas | ✅ | 0.3 TGas per mutation, well under 30 TGas block budget; loops are O(positions) only in `get_positions`. |
| Storage | ✅ | One `Position` per owner; `get_stats` is an aggregation — fine for thousands of positions. **TODO:** cap or paginate if position count grows large (stats scans all). |
| Liquidation edge cases | ✅ | `require!(equity*10000 < notional*500, "healthy")` — healthy positions cannot be touched; reward split is exact integer math. |
| Negative funding / underflow | ✅ | Funding delta clamped to 10% of current margin, margin floors at 0 (cannot go negative). |
| `set_funding_rate` authorization | ⬜ **TODO** | Restrict to oracle/operator role for mainnet. |
| Event logs | ✅ | Structured JSON logs on open/close/liquidate/funding for indexers. |
| Versioning / upgrades | ⬜ **TODO** | Deploy mainnet with an upgrade path (contract owner key held by a multisig) OR freeze the wasm and rely on NEP-330 (state migration) — decide before launch. |

## 2. Off-chain components to make production-grade

| Component | Testnet today | Mainnet requirement |
|---|---|---|
| Price feed (`pricefeed.js`) | single node, 2 sources, median | 2+ independent nodes, alerting, attested source identity, fallback marks |
| Funding-rate oracle | demo script sets it | scheduled off-chain service: `sign(mark−index)/index` per interval, push with same auth as marks |
| Liquidation bots | manual / demo | 24/7 watchers: read `get_stats` + `get_positions` every ~5 s, call `liquidate_on_mark` when `preview_liquidation` ≠ None. Reward = 50% of remaining equity makes this economically viable. |
| Intent solver | 1Click dry-run quotes | real 1Click production keys / or own solver; vaulted collateral account (lego block 8) so margin is custodied on-chain |
| Web UI wallet | CLI-only (testnet) | MyNearWallet connect for open/close/liquidate; same raw-RPC reads work on mainnet (`mainnet.fastnear.com`, check CORS or proxy) |

## 3. Mainnet deployment steps

1. **Fork the repo, create `.deploy.env`** with a **fresh mainnet keypair**
   (never reuse testnet keys).
2. **Create the contract account** on mainnet:
   `near account create-account <prism-contract>.near autogenerate-new-keypair ... network-config mainnet create`
   (sponsored via 1Click/ChainSigner or a bootstrap account with ~$50).
3. **Build** the wasm with `overflow-checks` confirmed on:
   `cargo build --target wasm32-unknown-unknown --release`
4. **Deploy** with the v3 wasm; call `new()`.
5. **Run `e2e-test.js` against mainnet** (point `NODE_URL` at
   `https://mainnet.fastnear.com`) with a small bootstrap account as
   owner + a second account as liquidator. The 24-assertion suite is the
   launch gate.
6. **Fund the mark feed** service and verify `update_mark` lands (2-source
   median, deviation guard).
7. **Deploy one liquidation bot**, open a real 10× position with ~$10 margin,
   verify a full open→crash→liquidation→reward cycle with real USDC.
8. **Ship the UI** on mainnet (same `ui/`, different `NODE_URL`/`contract`),
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

- [ ] 25/25 `cargo test`
- [ ] 24/24 `npm run e2e` **on mainnet**
- [ ] `update_mark` + `set_funding_rate` restricted to authorized pushers
- [ ] Mark feed running from 2 nodes with alerts
- [ ] Liquidation bot live for ≥ 24 h without missed liquidations
- [ ] Real USDC liquidation cycle verified on mainnet
- [ ] UI connected via MyNearWallet, open/close/liquidate all working
- [ ] Wasm hash pinned in the deploy record; no unknown code paths
