# Uprise app

The web app at [uprise.wtf](https://uprise.wtf) and its small Node server (`server.js`). No build step: plain HTML, CSS and ES modules in `public/`.

## Screens

Three tabs: **📊 Analytics**, **🐮 Trade** and **🦀 Yield**. A switch at the top flips between **Demo** (play money, no blockchain) and **Live** (NEAR testnet; on desktop the switch says "Testnet"). Phones get a bottom tab bar; on screens 1000 px and wider the tabs move into the top bar and Trade becomes chart-left, order-panel-right.

- **Trade:** the chart (5M, 1H, 1D, 1W) with a "How it works" link that replays the intro. Next to it:
  - **Curve Long:** the strength slider x¹–x¹⁰ and the amount, with 25/50/75%/Max.
  - **Your profit:** the payoff curve.
  - **Buy.**

  Buying flips the card to your position: value, funding paid so far, entry price, and a bar that shrinks with the funding taken. In Live, every strength x¹–x¹⁰ can be bought; amounts above what the vault allows say so under the field.
- **Yield:** the vault (yield, size, what bulls pay, the USDC/NEAR split; a donut on desktop) and your stake with its chart, Deposit and Withdraw. A Live deposit shows "Settling…" until the vault books it at its next update (about a minute).
- **Analytics:** traders, the vault with its yield, and liquidity providers, with coins flying between them. In Live it shows real accounts, and marks yours with "YOU".
- **Result card** after a trade: market vs your curve on one chart, with a Share button that makes an image for X.
- **x¹⁰ celebration:** sliding to x¹⁰ fires sticker-style $ confetti (`js/celebrate.js`).

Design: "screen print". Rose background, yellow-lime cards, ink text, cobalt for action and gains, Space Grotesk, no borders or shadows. The design studies that led here are in the [lab](https://uprise.wtf/lab).

## Demo

- **First visit:** five intro slides.
  1. Power perpetuals: the curve outgrows the price.
  2. No liquidation on wicks.
  3. Time melts your position.
  4. Demo USDC arrived via NEAR Intents.
  5. Your $1,000 of play money.
- **Replays of real price history in fast-forward,** as animated candles. There are 10 snippets: 7 rallies and 3 dumps, two of which recover too late. Half of them have a deep wick with a "this would liquidate a leveraged perp" hint. The first trade always plays the strongest rally.
- **Melting is a straight timer:** x¹ melts to zero in 40 s, x¹⁰ in 20 s. The market is continuous: each trade continues from the last price.
- **Yield:** you start with $10,000 that has been in the vault for six months; it grows a day per second while you watch.
- **Reset:** open `/?fresh` to reset the demo and all first-visit screens. A live wallet key is kept.
- **Data:** `public/demo-snippets.json`, regenerated with `node ops/make-snippets.js`.

## Live (testnet)

- **New to crypto:** "Create custodial wallet" makes a key on the device (a NEAR implicit account). Every action is a meta-transaction that the server's relayer pays for, so no NEAR is needed. Once the wallet holds money, the app asks for a recovery email. The key is stored encrypted on the server, and a 6-digit code restores it. The code still goes to the server log, not by email.
- **Already on NEAR:** "Connect NEAR wallet" (Meteor, MyNearWallet, Intear). Every transaction asks for approval in the wallet.
- **Getting USDC:**
  - The wallet sheet's "Get 1,000 test USDC" button, which works for any existing testnet account.
  - USDC on NEAR sent to your address.
  - Cross-chain deposits via NEAR Intents (mainnet only).

  A wallet with no USDC gets an "Add USDC to start" window.
- **Chart:** Coinbase's live NEAR price stream; trades use the on-chain price, which the keeper writes every 15 s.

## Server

`server.js` serves `public/`, the simulators under `/sim/` (from the repo's `sim/` folder) and the lab at `/lab`. Its API is listed at the top of the file:

- `/api/config`, `/api/rpc`
- `/api/relay`: pays gas for device wallets.
- `/api/onboard`, `/api/faucet`
- `/api/backup`, `/api/recover/*`
- `/api/history`: chart candles; 5M is built from recent trades.
- `/api/deposit-address`

```bash
cd ops && npm install
```

```bash
node app/server.js
```

Settings: `PORT` (default 8787) and `HOST` (default all interfaces; `127.0.0.1` behind a proxy). State (`.server-state.json`) and the backup encryption key (`.backup-key`, or `BACKUP_KEY`) stay next to the server and are gitignored. The keeper (`node ops/keeper.js`) must run for Live. How it runs in production is in [`../deploy/README.md`](../deploy/README.md).
