# Curve — continuous-expiry power product on NEAR (2-day build plan)

Branch: `curve` (forked from `perpetual`, which is the old `main`).

## The product in one paragraph

One USDC treasury, two sides, priced only by the oracle.

- **Curve** buys *units* of a power index `I(P) = (P / P_ref)^p` (p = 2 by default,
  configurable 1–4). A unit's value is `NF × I(P)`. The normalization factor `NF`
  decays continuously at the funding rate, so a Curve holder pays funding by having
  the position shrink. Nobody liquidates it, and there is no margin call.
- **Flat/Earn** deposits into the same pool and owns the residual:
  `Flat equity = risk pool − Curve claims`. Every bit of `NF` decay lands in
  Flat equity automatically, with no transfers. Flat earns when the market is
  quiet (realized vol < implied vol) and loses when the market rips upward.
- **Funding** follows the closed-form fair rate for a power perp under GBM:
  `rate/yr = p(p−1)/2 · σ²_implied + base`. With p = 2 and σ = 80%, longs pay
  about 0.18%/day.
- **Solvency is built into the structure.** Curve claims are capped at the risk
  pool (`C_eff = min(C_raw, R)`, with a pro-rata haircut), so total claims ≤ treasury
  always holds. Curve opens and Flat exits are refused above `max_util_bps`
  (default 50%), which keeps a buffer in place.

> ⚠ **Flat is not delta-neutral in v1.** Flat is short `P^p`, which means short
> delta *and* short gamma. The Lego upgrade that makes it truly "flat" is a hedge
> module where the treasury holds `p × C_raw` worth of the underlying (nice-to-have).

## Milestones (~2 days)

| # | When | Deliverable | Done = |
|---|------|-------------|--------|
| M0 | Day 1 AM | Branch rename, plan, contract skeleton | ✅ this commit |
| M1 | Day 1 | **Ledger + treasury contract** (`curve/contract`): deposit via `ft_transfer_call`, withdraw with refund callback, Curve and Flat open/close, funding accrual, invariant checks, NEP-297 events, bot views | `cargo test` green |
| M2 | Day 1 PM | **Oracle adapter**: Pyth pull (`get_price_unsafe` + our own staleness and confidence checks), pusher fallback for testnet, keeper script | price lands on-chain on testnet |
| M3 | Day 2 AM | **Testnet deploy** with a mock USDC (the near-contract-standards FT example), scripted e2e: seed Flat → open Curve → move price → poke funding → close → withdraw | e2e script passes on testnet |
| M4 | Day 2 AM | **Intents relayer** (`curve/intents`): 1Click deposit quote → status watch → `ft_transfer_call` into the ledger; withdraw → 1Click quote → `withdraw` to the deposit address | dry-run quotes plus one real $5 mainnet round-trip |
| M5 | Day 2 PM | Telegram/bot surface: a thin HTTP wrapper over the relayer and views; submission README and demo video | judge-ready demo |

### Must ship for the hackathon
1. Ledger + treasury contract with unit tests (M1)
2. Oracle price on-chain with staleness gating (M2, pusher allowed on testnet)
3. Testnet e2e: deposit → open Curve/Flat → PnL moves with the oracle → withdraw (M3)
4. 1Click deposit/withdraw wiring, shown with dry-run quotes plus one real mainnet round-trip (M4)
5. View functions and events a bot can index (part of M1)

### Nice to have
- Delta-hedge module (makes Flat truly flat)
- Utilization-based funding premium (funding rises as the pool fills up)
- Flat withdrawal cooldown/queue (stops Flat from front-running a pump)
- Telegram mini-app UI with a payoff chart (`quote_payoff` view is ready for it)
- Fractional `p` (needs on-chain `ln`/`exp`; integer p only in v1)
- Timelocked params and DAO owner; NF rebase for very long-lived markets
- Indexer/subgraph for historical PnL (events are already NEP-297)

## Thinnest end-to-end path

```
User (ETH/Base/Sol…)                 Platform relayer                 NEAR
───────────────────                 ────────────────                 ────
1. "deposit 50 USDC from Base" ──►  1Click /v0/quote (USDC.base →
                                    USDC.near, recipient = relayer)
   sends to depositAddress  ──────► 1Click solvers deliver USDC ───► relayer.near
                                    poll /v0/status = SUCCESS
                                    usdc.ft_transfer_call(curve, amt,
                                      {"receiver_id":"tg-42.relayer.near",
                                       "action":"open_curve"})  ───► curve.ft_on_transfer
2. Oracle keeper: pyth.update_price_feeds → curve.refresh_price (or push_price on testnet)
3. Bot/Telegram reads curve.get_account("tg-42.relayer.near") → value, PnL, funding
4. "withdraw to Solana" ──────────► 1Click quote (USDC.near → USDC.sol,
                                    recipient = user's SOL address)
                                    usdc.storage_deposit(depositAddr)
                                    curve.withdraw({account_id, amount,
                                      receiver_id: depositAddr}) ───► ft_transfer
                                    1Click delivers on Solana ◄──────
```

The user never sees NEAR. `tg-42.relayer.near` is a **virtual ledger account**. It
doesn't need to exist on-chain, because the relayer is a registered *manager* of
its own sub-namespace. The relayer pays all gas.

## What we reuse (battle-tested) vs. what is new

| Piece | Reused / audited | New code |
|---|---|---|
| Contract framework | `near-sdk` 5.x, `near-contract-standards` (NEP-141 receiver and `ext_ft_core`) | – |
| Collateral | Native USDC on NEAR (`17208628…36133a1`, Circle) | – |
| Cross-chain in/out | NEAR Intents 1Click API, the `intents.near` verifier, and the solver network (Omni Bridge / PoA underneath) | Relayer script (off-chain glue only, no custody logic on-chain) |
| Oracle | Pyth on NEAR (`pyth-oracle.near`), with Wormhole-verified price updates from Hermes | ~80-line adapter: staleness, confidence, and exponent checks |
| Math | `uint` U256 (used by Ref/Burrow) | Power index, NF decay (Taylor + halving), shares accounting |
| Ledger | – | **~600 lines. This is the unaudited critical path; keep it small.** |

## Security assumptions (read before real money)

1. **Oracle.** Pyth is trusted for price. We reject prices that are stale
   (`max_price_age_secs`), wide-confidence (`max_conf_bps`), or non-monotonic. If the
   oracle is stale, opens and closes revert, but deposits and free-balance withdrawals
   still work. Funds inside positions are stuck until the oracle recovers (there's
   no emergency close at a stale price, by design). The testnet `Pusher` mode is
   a trusted key with a jump guard, and must not be used on mainnet.
2. **Managed (Telegram) accounts are custodial.** A manager has full control
   over `*.manager` accounts, withdrawals included. Users who want non-custodial
   use their own NEAR account. An *approved operator* (bot) can trade but **cannot
   withdraw**.
3. **Owner powers.** The owner can change params within hard bounds, switch the oracle,
   pause *opens*, add or remove managers, and claim protocol fees. The owner can't
   touch balances, block closes, or block withdrawals. For mainnet: a multisig/DAO owner,
   a timelock on params, and no full-access key on the contract account.
4. **Flat bears the tail.** A large upward move can wipe out Flat equity. The
   curve haircut means Curve holders get paid pro-rata from what exists. The
   utilization cap is the only buffer in v1.
5. **Withdraw safety.** Balances are debited before the transfer and restored in
   the callback if `ft_transfer` fails. `withdraw` requires 1 yoctoNEAR, which forces
   a full-access key, so a leaked bot function-call key can't move funds out.
6. **Deposit attribution.** `ft_transfer_call` with `{"receiver_id": X}` credits
   X. That's safe because you can only gift your own tokens. Only the configured
   USDC contract is accepted. A minimum deposit makes account-spam storage attacks
   expensive.
7. **1Click relayer hop.** Between the 1Click delivery and `ft_transfer_call`, USDC
   sits in the relayer hot wallet, so the relayer is trusted for that hop. If 1Click's
   `customRecipientMsg` (ft_transfer_call to a NEAR contract) is available for
   USDC, deposit directly into the ledger and the hop goes away.
8. **Not verified from this machine:** Pyth's NEAR method names and the JSON shape
   (`get_price_unsafe(price_identifier) -> {price, conf, expo, publish_time}`),
   1Click JWT requirements, and `customRecipientMsg`. Check all of them on the first testnet deploy.

## What's built (M1 done, M2 and M4 wired)

```
curve/
  contract/            curve-ledger (Rust, near-sdk 5): 25 unit tests, 393 KB wasm
    src/lib.rs         state, funding accrual, invariant, authorization
    src/trade.rs       open/close Curve and Flat (pure quote_* shared with previews)
    src/treasury.rs    ft_on_transfer deposits, withdraw + refund callback, fees, audit
    src/oracle.rs      Pyth pull adapter + testnet pusher
    src/views.rs       bot/UI views
    src/admin.rs       bounded owner params, operators, managers
    src/events.rs      NEP-297 events
  intents/
    oneclick.js        1Click quotes (deposit/withdraw), status, waitFor
    relayer.js         Telegram → ledger: deposit, withdraw, trade on behalf of tg-<id>.<relayer>
    keeper.js          Pyth/Hermes → ledger price, plus poke() for funding
```

### Contract interface (for bots)

| Method | Who | Notes |
|---|---|---|
| `ft_on_transfer` (via `usdc.ft_transfer_call`) | anyone | msg `{"receiver_id"?, "action"?: "open_curve"/"open_flat", "min_out"?}`; atomic |
| `withdraw(amount, account_id?, receiver_id?, memo?, msg?)` | self / manager, **1 yocto** | `msg` set → `ft_transfer_call` (e.g. into `intents.near`) |
| `open_curve(amount, account_id?, min_units?)` | self / manager / operator | returns units |
| `close_curve(units?, account_id?, min_out?)` | self / manager / operator | all if `units` is omitted |
| `open_flat(amount, account_id?, min_shares?)` / `close_flat(shares?, …)` | same | Flat exit is refused above `max_util_bps` |
| `approve_operator(operator, account_id?)` / `revoke_operator` | self / manager | operators can trade, never withdraw |
| `refresh_price()` / `push_price(price)` / `poke()` | keeper / pusher / anyone | |
| `get_market` · `get_account` · `get_accounts` · `get_solvency` · `get_snapshots` · `get_stats` · `get_config` · `can_act` | view | all amounts are strings and include pending funding |
| `preview_open_curve` · `preview_close_curve` · `preview_open_flat` · `preview_close_flat` · `quote_payoff` | view | same math as execution |
| `audit_treasury()` | anyone | compares the tracked treasury with `usdc.ft_balance_of(self)` |
| `set_params` · `set_oracle` · `set_open_paused` · `add_manager` · `claim_fees` · `set_owner` | owner | bounded; can't touch balances or block exits |

Events: `deposit`, `withdraw`, `transfer_refund`, `open_curve`, `close_curve`, `open_flat`,
`close_flat`, `funding`, `price`, `price_rejected`, `audit`, plus the admin events.

### Next up (M3)
1. Deploy a mock USDC on testnet (near-contract-standards FT example) plus `curve-ledger`, with `Pusher` oracle mode.
2. `add_manager(relayer)`, run `keeper.js`, then `relayer.js settle-deposit tg-1 --simulate 1000000000` to seed Flat and Curve.
3. Write a testnet e2e script that reuses `demo/e2e-test.js`'s assertion style.
