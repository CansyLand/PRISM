# Uprise ops (testnet)

Everything needed to run the full Uprise stack on NEAR testnet: contracts, a price feed, vault
rebalancing, and test players who trade against each other.

## What is deployed

`deployment.json` lists the live testnet accounts (no secrets). Keys are in `.keys.json`
(gitignored, mode 600). The current deployment lives under `uprise-ir12p.testnet`:

| Account | Role |
|---|---|
| `usdc.…`, `btc.…` | Mock USDC (6 dp) and mock BTC (8 dp). Open faucet: `mint(account_id, amount)` |
| `swap.…` | Mock DEX: USDC↔BTC at the keeper's price, 5 bps fee, seeded with $5M + 70 BTC |
| `ledger.…` | Uprise ledger, BTC, power 3, pusher oracle (the keeper) |
| `vault.…` | Hedged Crab vault, keeper = `keeper.…` |
| `keeper.…` | Pushes prices, syncs and rebalances the vault |
| `faucet.…` | Pays gas for new app wallets (demo mode); refills itself from the testnet faucet |
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

- `keeper.js` pushes the live BTC price (Coinbase, Binance fallback) every 10 s and runs a vault
  cycle every 30 s: sync → pay queued withdrawals → bring free ledger cash home → hedge to
  `p × claims` → keep about 50% of the vault in Curve Short.
- For stress tests, `PRICE_MODE=random VOL=1.5 PRICE_SECS=6 node keeper.js` drives a synthetic
  random walk where every push is one simulated hour. Switch back to live afterwards; the ledger's
  20% jump guard rejects a single bigger jump.
- `players.js` also has one-shot commands: `deposit h1 5000`, `withdraw h1`, `long r1 250`, `close r1`.

## Redeploy from scratch

Build the wasm (see the root README), move `deployment.json` and `.keys.json` aside, then run
`node setup.js`. It pulls testnet NEAR from the public faucet, creates every account, deploys and
initializes all contracts, seeds the swap, pushes the first price and funds the test players. Each
step is skipped if it's already done, so it's safe to re-run after a failure.

## Testnet-only shortcuts (do not carry to mainnet)

- Mock tokens with an open faucet, and a mock swap that trades at the keeper's own price.
- The keeper is the price oracle (pusher mode). Mainnet uses Pyth.
- The app's demo server gives every new device wallet 0.5 NEAR of gas and 1,000 test USDC.
