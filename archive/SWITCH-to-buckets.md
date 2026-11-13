# Switching the app and ops to the bucketed ledger

> **Status (2026-11-13):** done on this branch. The bucketed ledger and vault run on testnet as
> `ledger-b` / `vault-b`. The app, `keeper.js` and `players.js` use them. The list below is what changed.

On this branch the contracts support x¹–x¹⁰ in one ledger. Testnet still runs the single-power x³
ledger, and the app wasn't changed. This list covers what has to change before a redeploy.

## Redeploy, don't migrate

The ledger's and the vault's Borsh state layouts both changed: buckets replace `nf`, `ref_price`
and `total_units`, accounts hold `longs: Vec<LongPosition>`, and the vault's `Snapshot` has
`delta_claims` in place of `power`. Deploy a fresh `ledger-near` and `vault-near` (new accounts,
or delete and recreate the old ones). There is no migration code.

## Contract API changes the app has to follow

| Before | After |
|---|---|
| `open_long({ amount, account_id?, min_units? })` | `open_long({ power, amount, account_id?, min_units? })`, where `power` is 1..=10 |
| `close_long({ units?, account_id?, min_out? })` | `close_long({ power, units?, account_id?, min_out? })` |
| `ft_transfer_call` msg `{"action":"open_long"}` | `{"action":"open_long","power":N}`. Without `power` the transfer is refunded. |
| `preview_open_long({ amount })`, `preview_close_long({ units })` | Both take `power` as well |
| `quote_payoff({ units, prices })` | `quote_payoff({ power, units, prices })` |
| `get_market().power`, `.nf`, `.ref_price`, `.unit_value_e18`, `.total_units` | Removed. Use `get_market().buckets[p-1]` or `get_buckets()`. Each entry has `power`, `nf`, `ref_price`, `total_units`, `scale`, `unit_value_e18`, `claims`, `claims_raw`, `delta_claims`, `share_of_pool_bps`, `cap_bps`, `max_open`, `funding_convexity_annual_bps`, `funding_mult_bps` and `funding_rate_annual_bps`. |
| `get_market().funding_rate_annual_bps` (one rate) | Per bucket: `buckets[p-1].funding_rate_annual_bps`. The market-level `funding_base_annual_bps` is now the flat base fee. |
| `get_market().max_long_open` | Per bucket: `buckets[p-1].max_open`. It is the smaller of 20% of the pool and the bucket cap. |
| `get_market().utilization_bps` (claims / pool) | Now delta-weighted (`Σ w_p C_p / R`, capped at 100%). The plain ratio is `claims_to_pool_bps`. |
| — | `get_market().delta_claims`: Σ p · C_eff,p. The vault hedges this. |
| `get_account().long_units` | Removed. Use `longs: [{ power, units, value, cost, pnl }]`, one entry per bucket held. `long_value`, `long_cost` and `long_pnl` are now sums over the buckets. |
| `Snapshot.nf` | Removed. `Snapshot.delta_claims` is new. |
| New errors | "bucket cap reached…" and "power must be 1..=10". |
| `get_stats()` | Adds `write_downs`. |

## File by file

- **`ops/setup.js`**
  - Drop `POWER` and `power` from the ledger `params`, and `power: POWER` from `deployment.json`.
  - Pass the new fields, or omit `params` to use the contract defaults from this research:
    `base_funding_bps: 1000`,
    `bucket_funding_mult_bps: [10000,10123,10494,11111,11975,13086,14444,16049,17901,20000]`,
    `bucket_cap_bps: [2500,1250,833,625,500,416,357,312,277,250]`, `util_delta_weight_bps: 5000`,
    `util_mult_base_bps: 10000`, `util_mult_slope_bps: 10000`, `util_kink_bps: 4000` and
    `util_mult_kink_slope_bps: 100000`.
  - The current script still sends `util_mult_*` values from the old single-power tuning. Replace
    them with the values above.
  - Keep `implied_vol_bps: ASSET.volFloorBps`, `trade_fee_bps`, `max_price_age_secs` and
    `snapshot_interval_secs`, which are deployment-specific.
- **`app/server.js`**: `/api/config` returns `power: d.power`. Remove it, or return
  `powers: [1..10]`.
- **`app/public/js/live.js`**
  - `buy()` (lines ~100–105) has to pass `power` to `open_long` and put `"power"` into the
    `ft_transfer_call` msg.
  - `sell()` (line ~108) has to pass `power` to `close_long`. It needs a per-position sell, or a
    loop over `ledgerAcc.longs` for "close all".
- **`app/public/js/app.js`**
  - Remove the "The live market offers x³ right now" mismatch note and the "Pick xN" error
    (lines ~39–40 and ~80). Every strength is now live.
  - The position card (~268–277) reads `long_units` and `m.power`. Switch it to
    `ledgerAcc.longs`: one card or row per bucket, with the funding meter from
    `m.buckets[p-1].funding_rate_annual_bps`.
  - Funding previews (~63 and ~74) need the selected bucket's rate.
  - The `long_units > 0` checks (~331, ~334, ~353) become `longs.length > 0`.
  - The entry-price estimate (~274) uses `m.power`. Use the position's `power`.
  - The vault card's yield estimate (~380) uses `long_claims × rate`. It should sum
    `buckets[i].claims × buckets[i].funding_rate_annual_bps`, or read the vault's realized yield.
  - Show each bucket's `max_open` and cap in the amount slider, so opens don't revert with "bucket
    cap reached".
- **`app/public/js/analytics.js`**: line ~74 maps `open: long_units > 0` and `p: market.power`.
  Use `longs`, with one circle per bucket position or the account's largest. The vault "owed"
  figure (~75) can stay `long_claims`. The funding estimate (~81) should sum per bucket.
- **`ops/players.js`**: test bots. `open_long` and `close_long` need `power` (lines ~17 and ~22).
  The status line (~37) prints `m.power`. The `long_units` checks (~45 and ~65) become `longs`.
- **`ops/keeper.js`**: the vault keeper already uses `snapshot.hedge_target_usd`, so the hedge
  logic needs no change. The log line (~137) prints one `funding_rate_annual_bps`, which should
  print the per-bucket rates or the x¹/x¹⁰ range.
