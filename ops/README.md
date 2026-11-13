# Uprise ops (testnet)

Everything needed to run the full Uprise stack on NEAR testnet: contracts, a price feed, vault
rebalancing, and test players who trade against each other.

## What is deployed

`deployment.json` lists the live testnet accounts (no secrets). Keys are in `.keys.json` (gitignored, mode 600). Everything lives under the master account `uprise-ir12p.testnet` and runs on **NEAR/USD**:

| Account | Role |
|---|---|
| `ledger-b.…` | The market: ten Curve Long buckets x¹–x¹⁰ in one shared pool. The price comes from the keeper (pusher oracle). |
| `vault-b.…` | The hedged 🦀 vault, the only Curve Short. It hedges `delta_claims × its share` (Σ p · C over all buckets) with wNEAR. |
| `swap-b.…` | Mock DEX: USDC↔wNEAR at the keeper's price. |
| `usdc.…`, `wnear.…` | Mock USDC (6 dp) and mock wNEAR (24 dp), shared with the older stacks. Open faucet: `mint(account_id, amount)`. |
| `keeper-b.…` | Pushes prices, syncs and rebalances the vault. |
| `relayer-b.…` | Pays gas for app users (meta-transactions) and creates new wallets. |
| `rb1…rb6`, `hb1…hb3` | Test traders and liquidity providers (the bots). |

The keeper hedges to within 2% of the target. Before it puts anything into Curve Short, it keeps 25% headroom on the hedge and 5% of the vault's value in cash, and it closes part of the short when the hedge needs cash it doesn't have.

**In production** the keeper and the bots run on the server as the `uprise-keeper` and `uprise-bots` services (see [`../deploy/README.md`](../deploy/README.md)). Don't also run them locally, or prices get written twice.

**Older deployments**, kept for history: `deployment-x3.json` is the single-strength x³ stack (`ledger-near`, `vault-near`, `keeper`, `faucet`, `r1…r6`, `h1…h3`), and `deployment-btc.json` the first BTC/USD stack. To use one, copy it over `deployment.json`.

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

- `keeper.js` pushes the live NEAR price (Coinbase, Binance fallback) every 15 s. Every 45 s it runs a vault
  cycle: sync, pay queued withdrawals, bring free cash home, hedge to `delta_claims`, then put spare cash into
  Curve Short. Every 10 minutes it also tops up gas: when the keeper, the market, the vault or the relayer run low
  on free testnet NEAR, it gets 10 NEAR from the testnet faucet (or 5 from the master account).
- For stress tests, `PRICE_MODE=random VOL=1.5 PRICE_SECS=6 node keeper.js` drives a synthetic
  random walk where every push is one simulated hour. Switch back to live afterwards; the ledger's
  20% jump guard rejects a single bigger jump.
- `players.js` also has one-shot commands: `deposit h1 5000`, `withdraw h1`, `long r1 250`, `close r1`.

## Redeploy from scratch

Build the wasm (see the root README), move `deployment.json` aside (keep `.keys.json`), then run
`node setup-buckets.js` for the x¹–x¹⁰ market (or the older `ASSET=NEAR node setup.js` for a single-strength one). It pulls testnet NEAR from the public faucet, creates every account, deploys and
initializes all contracts, seeds the swap, pushes the first price and funds the test players. Each
step is skipped if it's already done, so it's safe to re-run after a failure.

## Testnet-only shortcuts (do not carry to mainnet)

- Mock tokens with an open faucet, and a mock swap that trades at the keeper's own price.
- The keeper is the price oracle (pusher mode). A mainnet launch would use Pyth (see `../archive/MAINNET.md`).
- The app server gives every new device wallet 1,000 test USDC. Gas is sponsored on both networks.
- `node make-snippets.js` regenerates the demo's chart snippets (`app/public/demo-snippets.json`).
