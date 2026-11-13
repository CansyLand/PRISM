# Bucketed strengths: x¹–x¹⁰ in one market

One ledger contract holds ten Curve Long buckets (p = 1..10). They share one risk pool and one
hedged vault (the only Curve Short). This folder has the Monte Carlo search that picked the
funding, cap and utilization parameters now set as defaults in `contract/src/lib.rs`.

- `engine.js`: the bucketed market. It mirrors the contract: NF per bucket, pro-rata write-down
  across buckets, delta-weighted utilization, per-bucket caps, and the vault hedging `Σ p·C_p`.
- `scenarios.js`: NEAR-like one-year price paths (see below).
- `search.js`: a three-stage search plus stress tests. Run
  `node sim/buckets/search.js 8 > sim/buckets/search-results.txt` (about 4.5 minutes).
  The seeds are fixed, so every run gives the same numbers.
- `search-results.txt`: the full output.

## Model

Funding per bucket, per year:

```
rate_p = (p(p−1)/2 · σ² · mult_p + base) · m(u)
mult_p = 1 + sur · ((p−1)/9)^shape          x¹ = 1, x¹⁰ = 1 + sur
u      = min(1, Σ w_p · C_p / R),           w_p = 1 + dw · (p−1)
m(u)   = prem + slope·u + steep · max(0, u − kink) / (1 − kink)
```

`σ = max(80% floor, 30-day realized)`. A bucket's open is refused when its claims would exceed
`cap_p = capB / p` of the pool.

- **Market**: 0.1% trade fee and a 10% funding cut to the protocol. The protocol's fees don't count
  toward the vault.
- **Vault**: $1M. Half sits in the pool and half is cash for the hedge. It is re-hedged daily to
  `Σ p·C_eff,p` with 0.05% slippage, and pays 6% a year on any borrowed cash.
- **Retail**: Poisson arrivals give about 200 open positions. The median ticket is $400
  (lognormal). Each position is held for an exponential time with a 30-day mean, and closes early at
  a random take-profit (+30% to +330%) or stop-loss (−40% to −95%). Buckets are picked uniformly
  from x¹ to x¹⁰. One open is limited to 20% of the pool.

Price scenarios, with daily steps. Write-downs are checked at the intraday high as well as at the
close, so a wick that prints at the oracle counts:

| Scenario | Path |
|---|---|
| base | Sideways. Switches between a calm regime (65% vol) and a wild one (130% vol). 8 jumps a year (sd 12%) and 10 upward wicks of 5–25% a year. |
| bull | Base plus a +100%/yr trend. |
| bear | Base plus a −60%/yr trend. |
| mania | Shaped like NEAR in 2021: about +330% in 90 days, then −3/yr for 120 days, with more time in the wild regime. |
| jumpy | 16 jumps a year (sd 20%) and wicks up to +40%. A stress test. |
| btc14 | Real BTC daily OHLC from 2020-07 to 2023-03, with log moves × 1.4 (NEAR moves about 1.4× BTC), in rolling one-year windows. |

Feasible means the vault's median APY is at least 8%, its 10th percentile is at least 3%, and
write-downs happen in at most 5% of path-years. Among feasible settings, the search picks the best
retail payback, using `retail $ back + 0.5 × worst bucket − 2 × write-down frequency`.
Following the product decision, the surcharge was pinned at `sur = 1`, so x¹⁰ pays 2× its
convexity.

## Chosen parameters

| Parameter | Value | Contract field |
|---|---|---|
| Surcharge curve | `1 + ((p−1)/9)²`: 1.00, 1.01, 1.05, 1.11, 1.20, 1.31, 1.44, 1.60, 1.79, 2.00 | `bucket_funding_mult_bps` = 10000 … 20000 |
| Base fee (the only funding x¹ pays) | 10%/yr, multiplied by m(u) | `base_funding_bps` = 1000 |
| Bucket caps | `0.25 / p`: x¹ 25%, x² 12.5%, x³ 8.3%, x⁴ 6.25%, x⁵ 5%, x⁶ 4.2%, x⁷ 3.6%, x⁸ 3.1%, x⁹ 2.8%, x¹⁰ 2.5% of the pool | `bucket_cap_bps` |
| Delta weight | 0.5 (`w_p = 1 + 0.5·(p−1)`, so x¹⁰ counts 5.5×) | `util_delta_weight_bps` = 5000 |
| m(u) | 1× at u = 0, rising 1× per unit of u, plus 10× over the kink from 40% to 100%. That is 1.4× at 40%, 6.7× at 70% and 12× at 100%. | `util_mult_base_bps` 10000, `util_mult_slope_bps` 10000, `util_kink_bps` 4000, `util_mult_kink_slope_bps` 100000 |
| Unchanged | 80% vol floor, realized vol with a 21-day half-life, 20% max open, 0.1% trade fee, 10% funding fee | |

The shape is quadratic (`shape = 2`) rather than linear. Middle buckets then pay close to fair, and
only the steep end pays the full surcharge. Retail payback was higher than with the linear or
square-root shapes at the same `sur`.

## Results for the chosen setting

Validation ran on 32 paths per scenario (192 path-years):

- **Vault APY**: median +30.6%, p10 +18.8%, p5 +13.0%, worst path −15.0%. The 90th-percentile
  drawdown is −10.7%.
- **Write-downs**: in 4.2% of path-years (0.057 events a year), all of them in the `jumpy` stress
  scenario (25% of its paths). Base, bull, bear, mania and btc14 had none.
- **Caps**: 0.2% of opens are refused and 0.1% are clipped. Average delta-weighted utilization is
  21%.

| Scenario | Vault median | Vault p10 | Paths with a write-down |
|---|---|---|---|
| base | +29.6% | +23.3% | 0% |
| bull | +39.5% | +26.8% | 0% |
| bear | +25.9% | +14.9% | 0% |
| mania | +36.9% | +23.8% | 0% |
| jumpy | +20.5% | +2.7% | 25% |
| btc14 | +33.6% | +25.9% | 0% |

Per bucket, for retail ("$1 →" is the total paid out over the total paid in):

| Bucket | $1 → | Win | ≥ 2× | Median | p95 | Funding paid ÷ convexity |
|---|---|---|---|---|---|---|
| x¹ | $1.02 | 46% | 1.5% | 0.99× | 1.56× | base fee only, 13%/yr |
| x² | $1.02 | 42% | 5.4% | 0.94× | 2.06× | 1.51× |
| x³ | $0.98 | 36% | 8.2% | 0.83× | 2.45× | 1.47× |
| x⁴ | $0.94 | 32% | 10.2% | 0.68× | 2.84× | 1.54× |
| x⁵ | $0.88 | 27% | 10.0% | 0.52× | 2.91× | 1.64× |
| x⁶ | $0.81 | 22% | 9.1% | 0.44× | 2.90× | 1.79× |
| x⁷ | $0.72 | 17% | 8.1% | 0.39× | 2.75× | 1.92× |
| x⁸ | $0.64 | 13% | 6.9% | 0.34× | 2.55× | 2.03× |
| x⁹ | $0.58 | 10% | 5.9% | 0.30× | 2.26× | 2.16× |
| x¹⁰ | $0.51 | 8% | 4.5% | 0.26× | 1.79× | 2.26× |

The "Funding paid ÷ convexity" column includes m(u) and the 80% vol floor. So x² pays about 1.5×
even though its surcharge is 1.01×, and x¹⁰ pays 2.26×, which matches "about double".

## What each lever does

These stress runs keep the chosen setting and change one thing, on 16 paths per scenario:

| Change | Vault median / p10 / p5 | Write-down paths | Retail $1 → |
|---|---|---|---|
| Chosen | +30.6% / +18.8% / +13.0% | 4.2% | $0.82 |
| No surcharge (`sur 0`) | +21.8% / +6.2% / −0.5% | 10.4% | $0.89 |
| No delta weight (`dw 0`) | +22.8% / +13.4% / +7.6% | **14.6%** | $0.90 |
| No caps | +33.4% / +19.3% / +14.9% | 7.3% | $0.82 |
| Looser caps (`capB 0.5`) | +32.5% / +19.3% / +14.9% | 7.3% | $0.83 |
| No x¹ base fee | +32.2% / +18.6% / +14.5% | 6.3% | $0.83 |
| 60% vol floor | +28.5% / +14.0% / +9.3% | 9.4% | $0.85 |
| 100% vol floor | +40.0% / +26.6% / +21.6% | 4.2% | $0.78 |
| Hedge slippage 0.3% | +29.2% / +17.5% / +12.1% | 6.3% | $0.83 |
| Steep mix (most retail in x⁸–x¹⁰) | +51.5% / +28.7% / +10.6% | 12.5% | $0.69 |
| Gentle mix (most retail in x¹–x³) | +11.3% / +5.8% / +4.5% | 2.1% | $0.96 |
| 100 open positions | +12.6% / +3.8% / −5.6% | 5.2% | $0.91 |
| 400 open positions | +83.5% / +50.8% / +38.8% | 8.3% | $0.75 |
| Vault puts 80% in the pool | +26.2% / +12.4% / +1.9% | 6.3% | $0.89 |

- **Delta-weighted utilization is the strongest protection.** Without it, write-down risk is about
  3.5× higher (14.6% vs 4.2% of path-years). A steep bucket raises funding for everyone before the
  pool is at risk, and that slows the next steep open.
- **The surcharge is what keeps the vault positive in bad years.** Without it the vault's p5 goes
  negative. It also halves write-downs, because steep positions melt faster.
- **Caps mainly cut write-downs** (from 7.3% to 4.2%). They cost the vault only 1–3 points of APY
  and refuse almost no opens at this flow. They matter more when flow piles into x⁸–x¹⁰.
- **The x¹ base fee barely moves the vault.** x¹ is about 22% of all claims and is hedged
  statically. What it buys is that x¹ isn't free leverage on pool capital. Write-downs fall from
  6.3% to 4.2%, because x¹ melts a little too.
- **The vault's return scales with flow.** At 100 open positions (about $40k of tickets against a
  $1M vault) the median falls to +12.6% and p5 to −5.6%. The 80% vol floor drives a large part of
  the vault's yield: NEAR's calm regime realizes about 65%, below the floor.

## How much capital is stable

`capital.js` sweeps vault size against retail flow (full output in `capital-results.txt`). Run it
with `node sim/buckets/capital.js 8`. The system scales: what matters is the ratio of vault capital
to open retail notional, not the dollar amount. With the same ratio, a $500k vault and a $20M vault
give the same median (+30% to +31%).

The vault can't go insolvent at any size, because claims are capped at the pool. "Stable" here
means three things: write-downs are rare, the vault doesn't lose money in bad years, and retail
gets a fair deal. The middle column is the vault's p5 APY (its worst year in 20).

| Vault : open retail notional | Vault median / p5 | Write-down years | Retail $1 → | Verdict |
|---|---|---|---|---|
| < 3:1 (claims > ~40% of the pool) | +137% to +990% / +69% to +600% | 6–8% | $0.64–0.71 | Fragile: wicks write longs down. Vault drawdowns reach 25–30%. Retail overpays. |
| ~4–6:1 | +50% to +85% / +21% to +46% | 4–8% | $0.74–0.78 | Rich for the vault, still tight |
| **~6–10:1** (claims ~15–25% of the pool) | **+12% to +31% / −8% to +15%** | **4–6%** | **$0.82–0.90** | **Stable band** |
| ~15:1 | +12% / −8% | 6% | $0.90 | Starts to bleed in bad years |
| > 35:1 | +2% to +4% / −4% to −8% | 0% | $0.95–0.97 | Safe but unprofitable, so capital leaves |

With the default flow (200 open positions, about $130k notional at a $660 mean ticket), the band
is a **$0.75M–1.5M vault**. When most retail sits in x⁸–x¹⁰, write-downs stay at 8–12% of years up
to a $2M vault. The steep mix needs about 15–35:1 to get write-downs to the same level, and at that
ratio the vault's p5 is negative. At small scale the averaging stops working: a $100k vault with
20 open positions has the same median as a large one, but its p5 is −2.9% (vs +14.8% at $1M with
200 open). So a few hundred thousand dollars and about 100 open positions is a practical floor.

The model has no deposits or withdrawals chasing yield. In practice the high APY at low ratios
pulls capital in, and the losses at high ratios push it out. That moves the market toward the
band, but only as fast as LPs react.

## Remaining risks

1. **Jump and gap risk at high p.** All write-downs in the search come from the `jumpy` scenario
   (+40% wicks, 20%-sd jumps). One print of +40% multiplies x¹⁰ claims by 29. Caps hold x¹⁰ to
   2.5% of the pool, so a +40% wick alone takes x¹⁰ claims to about 72% of the pool. With other
   buckets also near their caps, the pool is exhausted, and every bucket is written down pro rata.
   The contract tests show this contagion: an x¹ holder loses as much as x¹⁰ in percentage terms.
2. **Retail's expected value is poor at the steep end** (x¹⁰ returns about $0.51 per $1). That is
   by design: the surcharge pays for the pool capital that x¹⁰ puts at risk. It should be shown
   plainly in the app.
3. **The vault's return depends on flow and on the vol floor.** In thin markets its p5 is negative.
   The model has no vault deposits or withdrawals chasing yield, and no liquidity limits on the
   hedge venue.
4. **Model limits.** Daily hedging, no funding feedback on retail demand, and synthetic NEAR paths
   (the only real data is BTC × 1.4). The contract accrues funding every block, while the model
   accrues daily.

To reproduce: `node sim/buckets/search.js 8 > sim/buckets/search-results.txt`.
