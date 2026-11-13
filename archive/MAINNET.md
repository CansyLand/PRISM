# Going live on mainnet

Scouted on 2026-11-12 against NEAR mainnet. Everything here is testnet-proven except where marked.

## Underlying: NEAR

The market tracks NEAR/USD and the Crab vault hedges with **wNEAR** (`wrap.near`, 24 decimals).
The vault contract takes the asset's decimals at init, and the testnet stack already runs on
NEAR (`ledger-near`, `vault-near`, mock `wnear`).

## Swapping NEAR ↔ USDC for the vault

| Venue | Pool | Depth | Use |
|---|---|---|---|
| **Ref Finance DCL** (`dclv2.ref-labs.near`) | `17208628…133a1\|wrap.near\|100` (0.01% fee) | ~$220k USDC + 86k NEAR. 1,000 NEAR → $3,588; 10,000 NEAR → $35,102 (~2% impact) | **Primary.** The vault's `Venue::RefDcl { pool_id }` sends `ft_transfer_call(dclv2.ref-labs.near, amount, {"Swap":{"pool_ids":[…],"output_token":…,"min_output_amount":…}})` and the output comes back to the vault. |
| Ref DCL `…\|wrap.near\|2000` | 0.2% fee | ~$2.8k USDC | too thin |
| Ref V1 simple pools (`v2.ref-finance.near`) | largest wNEAR/USDC pool | ~$17k USDC | backup only |
| NEAR Intents (1Click) | solver network | deep | Good for big rebalances, but it's async (deposit address → delivery), so a keeper would drive it. Not wired into the vault. |

Before mainnet: one small real swap through the DCL message format (not yet executed on mainnet),
then set a per-trade cap in the keeper (for example $5k per step at today's depth).

## Price oracle

`pyth-oracle.near` has the NEAR/USD feed (`c415de8d…6750`), but the last published price was from
**August 2026**: nobody pushes updates. Pyth is a pull oracle, so our keeper has to post updates
(`update_price_feeds` with a Hermes VAA) before reading. Hermes now asks for an API key. Options:
get a Hermes key and push Pyth updates (recommended), or start in the ledger's pusher mode with a
multi-source keeper (Coinbase + Binance + Ref DCL TWAP) and tight jump guards, clearly disclosed.

## Gas: users never pay

Device wallets sign NEP-366 meta-transactions; `/api/relay` submits them from a relayer account
and pays the gas. The relayer only sponsors calls into our own contracts, with at most 1 yoctoNEAR
attached and ≤ 300 Tgas. Tested on testnet: a buy and a close left the user's NEAR balance
unchanged. On mainnet fund `relayer.<our-account>.near` with a few NEAR and alert when it runs low.
New wallets get 0.02 NEAR once for the key's storage, plus a USDC storage registration.

## Two kinds of users

- **Already on NEAR (Meteor, MyNearWallet, Intear):** "Connect NEAR wallet" (Wallet Selector 10.1.4,
  loaded only on click). No standing permission: each deposit, trade and withdrawal opens the wallet
  for approval, which is the standard and safest flow. Not yet tested with a real wallet.
- **Never heard of crypto:** a key is created on the device (an implicit account). When money first
  arrives, the app asks for a recovery email. The server stores the key **encrypted (AES-256-GCM)**
  and returns it after an emailed 6-digit code. SMTP isn't connected yet; codes go to the server log.

**What this means:** with email recovery, the server can recover user keys, so for those users Uprise
is custodial. Ways to reduce that later, in order of effort:
1. Encrypt the backup with a user passkey (WebAuthn PRF) so the server only stores ciphertext.
2. Split the key (server share + email/passkey share).
3. NEAR MPC / chain signatures account abstraction.

**If the browser loses the key:** restore with email (above), or with the key from Security → Show my
key. Without either, the wallet is gone. That's why the app asks for the email as soon as there's money.

## Where new users get money

1. **Any chain, through NEAR Intents (1Click):** in-app "From another chain": USDC on Ethereum,
   Solana, Base, Arbitrum, or ETH/SOL/BTC; delivered as USDC to the wallet. Mainnet only.
2. **USDC on NEAR from an exchange:** send to the wallet address shown in the app (check that the
   exchange supports NEAR-native USDC).
3. **Card on-ramp** (not built): a provider that delivers USDC on NEAR, embedded in "Add money".

## Owner emergency withdraw

`ledger.emergency_withdraw(amount, receiver_id)` and `vault.emergency_withdraw(token, amount,
receiver_id)` let the owner take funds out (the vault owner can also close the short and pull cash).
The ledger then stops for good. This is a full trust assumption: tell users, and before real money,
put the owner behind a multisig and consider a timelock on these calls.

## Checklist

- [ ] Mainnet accounts: `ledger`, `vault`, `relayer`, `keeper` under one master; owner = multisig
- [ ] Ledger: real USDC, NEAR, Pyth (or pusher with disclosure), low caps (`max_open_bps`, vault size)
- [ ] Vault: `asset = wrap.near`, `asset_decimals = 24`, `venue = RefDcl { pool_id: "17208628…|wrap.near|100" }`, registered on USDC and wNEAR
- [ ] Keeper: per-step swap cap, Pyth updates, alerts
- [ ] Relayer funded; SMTP for recovery codes; `BACKUP_KEY` in a secret store
- [ ] One small end-to-end run with real money: deposit, trade, vault, hedge swap, withdraw
