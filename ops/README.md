# Uprise ops (testnet)

Everything needed to run the full Uprise stack on NEAR testnet: contracts, a price feed, vault
rebalancing, and test players who trade against each other.

## What is deployed

**Bucketed market (x¹–x¹⁰, branch `bucketed-strengths`).** `deployment.json` now points at the bucketed
contracts `ledger-b`, `vault-b`, `swap-b`, with their own `keeper-b`, `relayer-b` and test players `rb1…rb6` /
`hb1…hb3`. They share the USDC and wNEAR tokens with the old stack. `setup-buckets.js` creates them and is safe
to re-run. The previous single-power x³ deployment (`ledger-near`, `vault-near`, …) is untouched; its file is kept as
`deployment-x3.json`. To run its keeper or bots, copy that file back over `deployment.json`.

The keeper hedges `delta_claims × vault share` (Σ p · C over all buckets) to within 2% of the target. It keeps the
hedge gap, 25% headroom on the target and 5% of NAV in cash before it puts anything into Curve Short, and it closes
short when the hedge needs cash it doesn't have.

The single-power table below describes the x³ stack:

`deployment.json` lists the live testnet accounts (no secrets). Keys are in `.keys.json`
(gitignored, mode 600). The current deployment runs on **NEAR/USD** (like mainnet will) under
`uprise-ir12p.testnet`; the earlier BTC deployment is kept in `deployment-btc.json`:

| Account | Role |
|---|---|
| `usdc.…`, `wnear.…` | Mock USDC (6 dp) and mock wNEAR (24 dp). Open faucet: `mint(account_id, amount)` |
| `swap-near.…` | Mock DEX: USDC↔wNEAR at the keeper's price, 5 bps fee, seeded with $5M + 1.4M NEAR |
| `ledger-near.…` | Uprise ledger, NEAR/USD, power 3, pusher oracle (the keeper) |
| `vault-near.…` | Hedged Crab vault (wNEAR hedge), keeper = `keeper.…` |
| `keeper.…` | Pushes prices, syncs and rebalances the vault |
| `faucet.…` | Relayer: pays gas for app users (meta-transactions) and creates new wallets |
| `r1…r6`, `h1…h3` | Test retail players ($2k each) and yield hunters ($25k each) |

## Run

```bash
npm install
```

```bash
node keeper.js
```

```bash
node players.js run
```

```bash
node players.js status
```

- `keeper.js` pushes the live NEAR price (Coinbase, Binance fallback) every 15 s and runs a vault
  cycle every 45 s: sync → pay queued withdrawals → bring free ledger cash home → hedge to
  `p × claims` → keep about 50% of the vault in Curve Short.
- For stress tests, `PRICE_MODE=random VOL=1.5 PRICE_SECS=6 node keeper.js` drives a synthetic
  random walk where every push is one simulated hour. Switch back to live afterwards; the ledger's
  20% jump guard rejects a single bigger jump.
- `players.js` also has one-shot commands: `deposit h1 5000`, `withdraw h1`, `long r1 250`, `close r1`.

## Redeploy from scratch

Build the wasm (see the root README), move `deployment.json` aside (keep `.keys.json`), then run
`ASSET=NEAR node setup.js` (or `ASSET=BTC`). It pulls testnet NEAR from the public faucet, creates every account, deploys and
initializes all contracts, seeds the swap, pushes the first price and funds the test players. Each
step is skipped if it's already done, so it's safe to re-run after a failure.

## Testnet-only shortcuts (do not carry to mainnet)

- Mock tokens with an open faucet, and a mock swap that trades at the keeper's own price.
- The keeper is the price oracle (pusher mode). Mainnet uses Pyth.
- The app server gives every new device wallet 1,000 test USDC. Gas is sponsored on both networks.
- `node make-snippets.js` regenerates the demo's chart snippets (`app/public/demo-snippets.json`).
