# Uprise app

Three tabs: **🐂 Bull** (chart + buy Curve Long, strength 1×–10×), **🦀 Crab** (the vault) and
**📊 Analytics** (traders, the vault with its yield, and liquidity providers, with coins flying between them). A switch at the top
flips between **Demo** and **Live**.

## Demo (no blockchain)

- First visit: three ELI5 screens (Continuous-Expiry Power Perpetuals; growth with 1×/5×/10×;
  no liquidation on wicks), then $1,000 of play money.
- Buying flips the card to your position and starts fast-forward (badge top right): real price
  history plays at one day per ⅓ second as animated candles. 10 snippets, 7 rallies and 3 dumps,
  first trade always a rally. Melting is a straight timer: 1× melts to zero in 40 s, 10× in 20 s.
- One continuous market: each trade continues from the last price (the next snippet is scaled to it).
  Half the snippets have a deep wick early on, with a hint that it would liquidate a leveraged perp.
- Result card: market vs your curve on one chart; design options in `public/result-designs.html`.
- One position at a time. After the first trade a hand points at **Live**.
- The **?** button (header, and next to Crab Vault) replays the intros. Open `/?fresh` to reset
  the demo and all first-visit screens (the live wallet key is kept).
- Crab demo: deposit play money, it grows a day per second while you watch.
- Data: `public/demo-snippets.json` (regenerate with `node ops/make-snippets.js`).

## Live

- **New to crypto:** "Create my wallet" makes a key on the device (NEAR implicit account). Every
  call is a meta-transaction that the server's relayer pays for, so no NEAR is ever needed. When the
  wallet first holds money, the app asks for a recovery email (encrypted key backup on the server,
  restore with a 6-digit code).
- **Already on NEAR:** "Connect NEAR wallet" (Meteor, MyNearWallet, Intear via Wallet Selector).
  Each transaction asks for approval in the wallet.
- Add money: test USDC (testnet), USDC on NEAR to the shown address, or NEAR Intents from other
  chains (mainnet).

## Run

```bash
cd ops && npm install
```

```bash
node app/server.js
```

The keeper (`node ops/keeper.js`) must run for live mode. Server endpoints are listed at the top
of `server.js`. State (`.server-state.json`) and the backup encryption key (`.backup-key`, or
`BACKUP_KEY` env) stay next to the server and are gitignored.

## Deploying to uprise.wtf

1. Copy the repo plus `ops/deployment.json` and an `ops/.keys.json` with only the `keeper` and
   `faucet` (relayer) keys. Keep the master key off the server.
2. Run `node ops/keeper.js` and `node app/server.js` under systemd or pm2 (optionally
   `node ops/players.js run` for a busy testnet market).
3. HTTPS via Caddy or nginx, forwarding `X-Forwarded-For`.
4. Set `BACKUP_KEY` (64 hex chars) from a secret store and connect SMTP for recovery codes.

See [`../MAINNET.md`](../MAINNET.md) for the live-money checklist.
