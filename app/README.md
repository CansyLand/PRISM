# Uprise app

One page, two tabs: **🐂 Bull** (BTC chart and a buy button for Curve Long) and **🦀 Crab** (the
hedged vault). No browser wallet needed: the app creates an ed25519 key on first visit, keeps it
in the browser's local storage and uses the matching NEAR implicit account (64 hex characters).
The same device finds the same wallet again. **Backup** in the wallet sheet shows the key so it
can be restored on another device.

## Deposits

- **Demo (testnet):** new wallets get 0.5 NEAR of gas and 1,000 test USDC; **Get 1,000 test USDC**
  adds more every 10 minutes.
- **Any mode:** send USDC on NEAR to the wallet address shown in the wallet sheet.
- **Live (mainnet):** **From another chain** asks NEAR Intents 1Click for a deposit address
  (USDC on Ethereum, Solana, Base or Arbitrum, ETH, SOL or BTC). The user pays there; USDC arrives
  in the wallet.

## Run locally

```bash
cd ops && npm install
```

```bash
node app/server.js
```

Open http://localhost:8787. The keeper (`ops/keeper.js`) must be running, or the ledger price goes
stale and trades revert.

## Server deployment (uprise.wtf)

1. Copy the repo with `ops/deployment.json` and an `ops/.keys.json` that holds only the
   `keeper` and `faucet` keys (the keeper runs the market, the faucet pays demo gas and mints
   test USDC). Keep the master key off the server. File mode 600.
2. Run three processes (systemd or pm2): `node ops/keeper.js`, `node app/server.js`, and
   optionally `node ops/players.js run` (needs the `r1…r6` and `h1…h3` keys too) so the demo market is never empty.
3. Put the server behind Caddy or nginx with HTTPS and forward `X-Forwarded-For` (rate limits use it).
4. Demo mode is the default. `MODE=live` switches off the faucet and enables 1Click deposits, but
   live mode needs a mainnet deployment first. See the open items below.

## Before live mode with real money

- Mainnet contracts: the ledger and vault against real USDC, with a **Pyth** oracle instead of the
  pusher.
- The vault's hedge swap must point at a real venue (an adapter for Ref Finance or another DEX).
  The mock swap is testnet-only.
- Gas: mainnet users have no NEAR. Use a relayer for meta-transactions (NEP-366), or have the
  server fund new accounts with a small amount.
- Caps: start with low open-interest and vault limits. None of this code is audited.
