//! Uprise ledger: a continuous-expiry power perpetual on NEAR (Curve Long / Curve Short),
//! with every curve strength x¹..x¹⁰ in one market.
//!
//! One USDC treasury, one shared risk pool, ten Curve Long buckets, priced only by the oracle:
//!
//! * **Bucket p** (p = 1..10) holds *units* of the power index `I_p(P) = (P / P_ref,p)^p`.
//!   One unit is worth `NF_p × I_p(P)` raw USDC, where each bucket's normalization factor
//!   `NF_p` decays at that bucket's funding rate. Curve Long pays funding by shrinking.
//!   It can't be liquidated and has no margin.
//! * **Curve Short** owns shares of the residual `F = R − C`, where `R` is the shared risk pool
//!   and `C = Σ_p C_p` all long claims. NF decay in any bucket flows into `F` automatically.
//!
//! Funding per bucket, per year: `(p(p−1)/2 · σ² · mult_p + base) · m(u)`. `mult_p` is a
//! progressive surcharge (steeper buckets pay more than their convexity, protecting the pool for
//! everyone else), `base` is a flat fee (the only funding x¹ pays), and `m(u)` rises with the
//! delta-weighted utilization `u = Σ w_p C_p / R`, `w_p = 1 + dw·(p−1)`.
//!
//! Solvency comes from the structure: `C_eff = min(C_raw, R)` (pro-rata haircut across all
//! buckets), so `free + C_eff + F + fees == treasury` always holds. Every mutation checks it.
//! Per-bucket caps stop one bucket from taking over the pool. If a rally still pushes total
//! claims past the pool, every bucket's NF is cut by the same factor so claims equal the pool,
//! and Curve Short starts a fresh epoch that new shorts can join.
//!
//! Modules: `math` (fixed point), `oracle` (Pyth adapter + testnet pusher),
//! `treasury` (NEP-141 deposits, withdrawals, fees), `trade` (open/close),
//! `views` (bot/UI reads), `admin` (bounded owner params), `events` (NEP-297).
//!
//! Units: USDC raw (6 decimals) for amounts and prices, unix seconds for time.

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

pub mod admin;
pub mod events;
pub mod math;
pub mod oracle;
pub mod trade;
pub mod treasury;
pub mod views;

#[cfg(test)]
mod tests;

use math::{convexity_rate_e18, exp_neg_e18, mul_div, power_index_e18, sat_u128, BPS, ONE, U256, YEAR_SECS};
pub use oracle::OracleConfig;

/// $1,000,000 at 6dp.
pub const MAX_PRICE: u128 = 1_000_000_000_000;
pub const MAX_SNAPSHOTS: u64 = 1_000;
pub const MAX_OPERATORS: usize = 4;
/// Curve strengths x¹..x¹⁰, one bucket each.
pub const BUCKETS: usize = 10;
/// Unit value (raw USDC × 1e18 per unit) is kept inside [UV_LO, UV_HI] by re-scaling units, so a
/// $1 open always gets ≥ 1e4 units and a $1B position still fits in u128 (x¹⁰ melts by ~25 orders
/// of magnitude a year at fair funding, so this matters).
pub const UV_LO: u128 = 1_000_000_000_000; // 1e12
pub const UV_HI: u128 = 100_000_000_000_000_000_000; // 1e20
/// Units are re-scaled by 10^6 per step.
pub const SCALE_STEP: u128 = 1_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Params {
    /// Volatility floor σ (annualized, bps). σ is the higher of this floor and the realized
    /// volatility of the oracle price (see `rv_halflife_secs`).
    pub implied_vol_bps: u32,
    /// Flat annual fee (bps) every bucket pays on top of its convexity rate. x¹ has no convexity,
    /// so this is the only funding it pays.
    pub base_funding_bps: u32,
    /// Progressive surcharge on the convexity rate, per bucket (index p−1, 10000 = 1×, ≥ 10000).
    /// x¹⁰ pays about 2× what its convexity alone needs.
    pub bucket_funding_mult_bps: Vec<u32>,
    /// Per-bucket open cap: after an open, bucket p's claims may be at most this share of the pool
    /// (bps, index p−1). Price moves can push a bucket past its cap; then only closes are possible.
    pub bucket_cap_bps: Vec<u16>,
    /// Delta weight of utilization: `u = Σ w_p C_p / R`, `w_p = 1 + dw·(p−1)` with dw in bps
    /// (0 = plain claims / pool, 10000 = full delta, w_p = p).
    pub util_delta_weight_bps: u32,
    /// Utilization multiplier on funding:
    /// `m(u) = base + slope·u + kink_slope·max(0, u − kink)/(1 − kink)`, in bps (10000 = 1×).
    /// `base` must be at least 10000: a hedged short loses roughly p(p−1)/2 · realized variance to
    /// rebalancing, so funding below fair pays shorts less than their cost.
    pub util_mult_base_bps: u32,
    pub util_mult_slope_bps: u32,
    pub util_kink_bps: u16,
    pub util_mult_kink_slope_bps: u32,
    /// Half-life of the realized-volatility estimate (EWMA of squared oracle returns). 0 = off.
    pub rv_halflife_secs: u64,
    /// Ceiling on the realized volatility used for funding (bps), so one bad print can't spike funding.
    pub rv_cap_bps: u32,
    /// Largest single long open, as a share of the pool before the open (bps).
    pub max_open_bps: u16,
    /// Protocol share of funding paid by Curve Long (bps of funding).
    pub funding_fee_bps: u16,
    /// Fee on every open/close (bps of amount).
    pub trade_fee_bps: u16,
    /// Trades revert when the oracle price is older than this.
    pub max_price_age_secs: u64,
    /// Pyth: reject when conf / price exceeds this (bps).
    pub max_conf_bps: u16,
    /// Pusher mode: max jump vs. the last fresh price (bps).
    pub max_jump_bps: u16,
    /// Minimum deposit / trade size (USDC raw). Makes storage-spam expensive.
    pub min_amount: U128,
    /// Minimum spacing between on-chain snapshots.
    pub snapshot_interval_secs: u64,
}

/// Monte Carlo defaults (sim/buckets/README.md): surcharge `1 + ((p−1)/9)^shape`, x¹⁰ = 2×.
pub const DEFAULT_FUNDING_MULT_BPS: [u32; BUCKETS] = [10_000, 10_123, 10_494, 11_111, 11_975, 13_086, 14_444, 16_049, 17_901, 20_000];
/// Per-bucket caps `capB / p` with capB = 0.25: x¹ 25%, x² 12.5%, … x¹⁰ 2.5% of the pool.
pub const DEFAULT_CAP_BPS: [u16; BUCKETS] = [2_500, 1_250, 833, 625, 500, 416, 357, 312, 277, 250];

impl Default for Params {
    fn default() -> Self {
        Self {
            implied_vol_bps: 8_000,
            base_funding_bps: 1_000,
            bucket_funding_mult_bps: DEFAULT_FUNDING_MULT_BPS.to_vec(),
            bucket_cap_bps: DEFAULT_CAP_BPS.to_vec(),
            util_delta_weight_bps: 5_000,
            // 1× at u = 0, 1.4× at the 40% kink, 6.7× at 70%, 12× at u = 100% (u is delta-weighted).
            util_mult_base_bps: 10_000,
            util_mult_slope_bps: 10_000,
            util_kink_bps: 4_000,
            util_mult_kink_slope_bps: 100_000,
            rv_halflife_secs: 1_814_400,
            rv_cap_bps: 30_000,
            max_open_bps: 2_000,
            funding_fee_bps: 1_000,
            trade_fee_bps: 10,
            max_price_age_secs: 120,
            max_conf_bps: 200,
            max_jump_bps: 2_000,
            min_amount: U128(1_000_000),
            snapshot_interval_secs: 300,
        }
    }
}

/// One curve strength. `scale` counts unit re-scalings (each one divides every holder's units by 10^6).
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Bucket {
    pub power: u8,
    pub nf: u128,
    pub ref_price: u128,
    pub total_units: u128,
    pub scale: i32,
}

/// A long position in one bucket. `scale` is the bucket scale the units are expressed in.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct LongPosition {
    pub power: u8,
    pub units: u128,
    /// Gross USDC paid for the units still held (cost basis, includes fees).
    pub cost: u128,
    pub scale: i32,
}

#[near(serializers = [borsh])]
#[derive(Clone, Default, Debug)]
pub struct Account {
    pub free: u128,
    /// At most one position per bucket.
    pub longs: Vec<LongPosition>,
    pub short_shares: u128,
    pub short_cost: u128,
    /// Shares from an older epoch were wiped out by a long write-down.
    pub short_epoch: u64,
    pub realized_pnl: i128,
    pub deposited: u128,
    pub withdrawn: u128,
    /// Bots allowed to trade (never withdraw) for this account.
    pub operators: Vec<AccountId>,
}

impl Account {
    pub(crate) fn long(&self, power: u8) -> Option<&LongPosition> {
        self.longs.iter().find(|l| l.power == power)
    }
    pub(crate) fn long_mut(&mut self, power: u8, scale: i32) -> &mut LongPosition {
        if let Some(i) = self.longs.iter().position(|l| l.power == power) {
            return &mut self.longs[i];
        }
        self.longs.push(LongPosition { power, units: 0, cost: 0, scale });
        self.longs.last_mut().unwrap()
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub ts: u64,
    pub price: U128,
    pub risk_pool: U128,
    pub long_claims: U128,
    /// Σ p · C_eff,p: the asset exposure a full hedge holds.
    pub delta_claims: U128,
    pub short_equity: U128,
    pub short_share_price_e18: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub volume: U128,
    pub funding_paid: U128,
    pub fees_earned: U128,
    pub trades: u64,
    pub accounts: u64,
    pub write_downs: u64,
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Accounts,
    Managers,
    Snapshots,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub(crate) owner: AccountId,
    /// The only accepted collateral (USDC NEP-141).
    pub(crate) token: AccountId,
    pub(crate) oracle: OracleConfig,
    pub(crate) params: Params,
    pub(crate) price: u128,
    pub(crate) price_ts: u64,
    /// Realized variance of the oracle price, annualized, 1e18 (EWMA of squared returns).
    pub(crate) realized_var_e18: u128,
    /// Last price and time folded into `realized_var_e18`.
    pub(crate) rv_price: u128,
    pub(crate) rv_ts: u64,
    /// x¹..x¹⁰, index p−1.
    pub(crate) buckets: Vec<Bucket>,
    pub(crate) last_accrual_ts: u64,
    /// R: USDC backing long claims + Curve Short equity, shared by every bucket.
    pub(crate) risk_pool: u128,
    pub(crate) short_shares: u128,
    /// Bumped when Curve Short is wiped out and a new short joins; older shares are worth 0.
    pub(crate) short_epoch: u64,
    pub(crate) free_total: u128,
    pub(crate) fees: u128,
    /// Tracked USDC we owe in total. Must be ≤ the real token balance.
    pub(crate) treasury: u128,
    pub(crate) open_paused: bool,
    /// Set by `emergency_withdraw`: every trade and withdrawal stops for good.
    pub(crate) emergency: bool,
    pub(crate) accounts: IterableMap<AccountId, Account>,
    pub(crate) managers: IterableSet<AccountId>,
    pub(crate) snapshots: LookupMap<u64, Snapshot>,
    pub(crate) snapshot_count: u64,
    pub(crate) last_snapshot_ts: u64,
    pub(crate) stats: Stats,
}

/// Market state including funding that is pending but not yet written.
pub(crate) struct Live {
    pub nf: Vec<u128>,
    /// Unit value per bucket (raw USDC × 1e18).
    pub uv: Vec<U256>,
    /// Raw claims per bucket, before any haircut.
    pub c_raw_p: Vec<u128>,
    pub fee_pending: u128,
    pub funding_pending: u128,
    pub c_raw: u128,
    pub c_eff: u128,
    /// Σ p · C_eff,p.
    pub delta_eff: u128,
    /// Σ w_p · C_raw,p (utilization numerator).
    pub weighted_raw: u128,
    pub risk_pool: u128,
    pub short_equity: u128,
}

impl Live {
    /// Pro-rata haircut when total claims exceed the pool.
    pub fn haircut(&self, v: u128) -> u128 {
        if self.c_raw > self.risk_pool {
            mul_div(v, self.risk_pool, self.c_raw)
        } else {
            v
        }
    }
}

pub(crate) fn now_secs() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

/// Bucket index for a power, panicking on anything outside 1..=10.
pub(crate) fn bucket_index(power: u8) -> usize {
    require!((1..=BUCKETS as u8).contains(&power), "power must be 1..=10");
    (power - 1) as usize
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        owner: AccountId,
        token: AccountId,
        oracle: OracleConfig,
        ref_price: U128,
        params: Option<Params>,
    ) -> Self {
        let params = params.unwrap_or_default();
        admin::validate_params(&params);
        require!(ref_price.0 > 0 && ref_price.0 <= MAX_PRICE, "bad ref_price");
        let buckets = (1..=BUCKETS as u8)
            .map(|power| Bucket { power, nf: ONE, ref_price: ref_price.0, total_units: 0, scale: 0 })
            .collect();
        Self {
            owner,
            token,
            oracle,
            params,
            price: 0,
            price_ts: 0,
            realized_var_e18: 0,
            rv_price: 0,
            rv_ts: 0,
            buckets,
            last_accrual_ts: now_secs(),
            risk_pool: 0,
            short_shares: 0,
            short_epoch: 0,
            free_total: 0,
            fees: 0,
            treasury: 0,
            open_paused: false,
            emergency: false,
            accounts: IterableMap::new(StorageKey::Accounts),
            managers: IterableSet::new(StorageKey::Managers),
            snapshots: LookupMap::new(StorageKey::Snapshots),
            snapshot_count: 0,
            last_snapshot_ts: 0,
            stats: Stats::default(),
        }
    }

    /// Keeper heartbeat: books pending funding and takes a snapshot.
    /// Anyone can call it. Safe to call as often as you like.
    pub fn poke(&mut self) -> views::MarketView {
        self.accrue();
        self.maybe_snapshot();
        self.get_market()
    }
}

// ─────────────────────────── internals ───────────────────────────

impl Contract {
    pub(crate) fn unit_value_e18(&self, b: &Bucket, nf: u128) -> U256 {
        if self.price == 0 {
            return U256::zero();
        }
        U256::from(nf) * power_index_e18(self.price, b.ref_price, b.power) / U256::from(ONE)
    }

    pub(crate) fn units_value(units: u128, unit_value_e18: U256) -> u128 {
        match U256::from(units).checked_mul(unit_value_e18) {
            Some(v) => sat_u128(v / U256::from(ONE)),
            None => u128::MAX,
        }
    }

    pub(crate) fn has_longs(&self) -> bool {
        self.buckets.iter().any(|b| b.total_units > 0)
    }

    /// Raw claims per bucket at the given NFs, and their (saturating) sum.
    pub(crate) fn claims_at(&self, nfs: &[u128]) -> (Vec<u128>, u128) {
        let mut total = 0u128;
        let per: Vec<u128> = self
            .buckets
            .iter()
            .zip(nfs)
            .map(|(b, nf)| {
                let c = if b.total_units == 0 { 0 } else { Self::units_value(b.total_units, self.unit_value_e18(b, *nf)) };
                total = total.saturating_add(c);
                c
            })
            .collect();
        (per, total)
    }

    pub(crate) fn nfs(&self) -> Vec<u128> {
        self.buckets.iter().map(|b| b.nf).collect()
    }

    pub(crate) fn raw_claims(&self) -> u128 {
        self.claims_at(&self.nfs()).1
    }

    /// Utilization weight w_p in bps: 1 + dw·(p−1).
    pub(crate) fn util_weight_bps(&self, power: u8) -> u128 {
        BPS + self.params.util_delta_weight_bps as u128 * (power as u128 - 1)
    }

    /// Σ w_p · C_p for per-bucket claims.
    pub(crate) fn weighted_claims(&self, per: &[u128]) -> u128 {
        per.iter()
            .enumerate()
            .fold(0u128, |s, (i, c)| s.saturating_add(mul_div(*c, self.util_weight_bps(i as u8 + 1), BPS)))
    }

    /// Re-anchor each bucket (ref_price = price, NF absorbs the old index) so neither its index nor its
    /// NF loses precision, and re-scale its units when the unit value leaves [UV_LO, UV_HI]. Claims
    /// don't change, except for sub-raw-unit rounding (floor), which stays in the pool.
    pub(crate) fn maintain_buckets(&mut self) {
        if self.price == 0 {
            return;
        }
        let price = self.price;
        let lo = U256::from(1_000_000_000_000u128); // index 1e-6
        let hi = U256::from(1_000_000_000_000_000_000_000_000_000u128); // index 1e9
        for i in 0..BUCKETS {
            let b = &mut self.buckets[i];
            if b.total_units == 0 {
                // Empty bucket: start over at the current price, no history to keep.
                b.nf = ONE;
                b.ref_price = price;
                continue;
            }
            let idx = power_index_e18(price, b.ref_price, b.power);
            let uv = U256::from(b.nf) * idx / U256::from(ONE);
            if uv.is_zero() {
                // A unit is worth less than 1e-18 raw USDC: every claim in this bucket already counts as 0.
                // Zero the holders (their next read re-scales them to 0 units) and start over.
                b.total_units = 0;
                b.scale += 40;
                b.nf = ONE;
                b.ref_price = price;
                events::emit("bucket_reset", near_sdk::serde_json::json!({ "power": b.power, "scale": b.scale }));
                continue;
            }
            let in_range = idx >= lo && idx <= hi && uv >= U256::from(UV_LO) && uv <= U256::from(UV_HI);
            if in_range || uv > U256::from(u128::MAX) {
                continue;
            }
            let before = (b.nf, b.ref_price, b.scale);
            b.nf = uv.as_u128();
            b.ref_price = price;
            // nf is now the unit value. Keep it inside [UV_LO, UV_HI] by re-scaling units.
            while b.nf < UV_LO && b.total_units >= SCALE_STEP && b.nf <= u128::MAX / SCALE_STEP {
                b.nf *= SCALE_STEP;
                b.total_units /= SCALE_STEP;
                b.scale += 1;
            }
            while b.nf > UV_HI {
                let Some(t) = b.total_units.checked_mul(SCALE_STEP) else { break };
                b.nf /= SCALE_STEP;
                b.total_units = t;
                b.scale -= 1;
            }
            if before == (b.nf, b.ref_price, b.scale) {
                continue; // stuck dust bucket (too few units to re-scale): nothing to log
            }
            events::emit(
                "rebase",
                near_sdk::serde_json::json!({
                    "power": b.power, "ref": b.ref_price.to_string(), "nf": b.nf.to_string(),
                    "scale": b.scale, "total_units": b.total_units.to_string(),
                }),
            );
        }
    }

    /// Realized volatility (annualized, bps), capped at `rv_cap_bps`. 0 while switched off.
    pub(crate) fn realized_vol_bps(&self) -> u32 {
        if self.params.rv_halflife_secs == 0 {
            return 0;
        }
        let sigma_e18 = (U256::from(self.realized_var_e18) * U256::from(ONE)).integer_sqrt().as_u128();
        (sigma_e18 * BPS / ONE).min(self.params.rv_cap_bps as u128) as u32
    }

    /// Volatility that funding is priced at: the higher of the floor and realized volatility.
    pub(crate) fn funding_vol_bps(&self) -> u32 {
        self.params.implied_vol_bps.max(self.realized_vol_bps())
    }

    /// Folds a new oracle price into the realized-variance EWMA. Each return adds about
    /// r² · YEAR · ln2 / half-life, so the estimate doesn't depend on how often prices arrive.
    pub(crate) fn update_realized_var(&mut self, price: u128, ts: u64) {
        let hl = self.params.rv_halflife_secs;
        if hl == 0 || self.rv_ts == 0 || self.rv_price == 0 {
            self.rv_price = price;
            self.rv_ts = ts;
            return;
        }
        if ts <= self.rv_ts {
            return; // same second: keep the older anchor so the return isn't lost
        }
        let dt = (ts - self.rv_ts) as u128;
        let r_e18 = mul_div(price.abs_diff(self.rv_price), ONE, self.rv_price);
        let cap = self.params.rv_cap_bps as u128 * ONE / BPS;
        let sample = sat_u128(U256::from(r_e18) * U256::from(r_e18) / U256::from(ONE) * U256::from(YEAR_SECS) / U256::from(dt))
            .min(cap * cap / ONE);
        // w = 1 − exp(−dt · ln2 / half-life)
        const LN2_E18: u128 = 693_147_180_559_945_309;
        let keep = exp_neg_e18(mul_div(dt, LN2_E18, hl as u128));
        self.realized_var_e18 = mul_div(self.realized_var_e18, keep, ONE) + mul_div(sample, ONE - keep, ONE);
        self.rv_price = price;
        self.rv_ts = ts;
    }

    /// Convexity rate p(p−1)/2·σ² of bucket `power` at the funding volatility (1e18/yr).
    pub(crate) fn convexity_rate_e18(&self, power: u8) -> u128 {
        convexity_rate_e18(power, self.funding_vol_bps())
    }

    /// Bucket rate before the utilization multiplier: convexity × surcharge + base fee (1e18/yr).
    pub(crate) fn bucket_base_rate_e18(&self, power: u8) -> u128 {
        let mult = self.params.bucket_funding_mult_bps[bucket_index(power)] as u128;
        mul_div(self.convexity_rate_e18(power), mult, BPS) + self.params.base_funding_bps as u128 * ONE / BPS
    }

    /// Delta-weighted utilization in bps, capped at 100%.
    pub(crate) fn utilization_bps(weighted: u128, risk_pool: u128) -> u128 {
        if weighted == 0 {
            0
        } else if risk_pool == 0 {
            BPS
        } else {
            mul_div(weighted, BPS, risk_pool).min(BPS)
        }
    }

    /// Funding multiplier m(u) in bps (10000 = 1×).
    pub(crate) fn util_multiplier_bps(&self, util_bps: u128) -> u128 {
        let p = &self.params;
        let kink = p.util_kink_bps as u128;
        let above = util_bps.saturating_sub(kink);
        p.util_mult_base_bps as u128
            + p.util_mult_slope_bps as u128 * util_bps / BPS
            + p.util_mult_kink_slope_bps as u128 * above / (BPS - kink)
    }

    /// Effective annual funding rate (1e18) of a bucket at the given utilization.
    pub(crate) fn funding_rate_at_e18(&self, power: u8, util_bps: u128) -> u128 {
        mul_div(self.bucket_base_rate_e18(power), self.util_multiplier_bps(util_bps), BPS)
    }

    /// (new NF per bucket, funding paid by Curve Long, protocol fee) for time since the last accrual.
    /// The rate uses utilization at the start of the interval; keepers poke often.
    pub(crate) fn pending_accrual(&self) -> (Vec<u128>, u128, u128) {
        let now = now_secs();
        let nfs = self.nfs();
        if now <= self.last_accrual_ts || self.price == 0 || !self.has_longs() {
            return (nfs, 0, 0);
        }
        let dt = (now - self.last_accrual_ts) as u128;
        let (per, c_raw) = self.claims_at(&nfs);
        let util = Self::utilization_bps(self.weighted_claims(&per), self.risk_pool);
        let nf_new: Vec<u128> = self
            .buckets
            .iter()
            .map(|b| {
                if b.total_units == 0 {
                    return b.nf;
                }
                let x = mul_div(self.funding_rate_at_e18(b.power, util), dt, YEAR_SECS);
                mul_div(b.nf, exp_neg_e18(x), ONE)
            })
            .collect();
        let before = c_raw.min(self.risk_pool);
        let after = self.claims_at(&nf_new).1.min(self.risk_pool);
        let funding = before.saturating_sub(after);
        let fee = funding * self.params.funding_fee_bps as u128 / BPS;
        (nf_new, funding, fee)
    }

    pub(crate) fn live(&self) -> Live {
        let (nf, funding_pending, fee_pending) = self.pending_accrual();
        let risk_pool = self.risk_pool - fee_pending;
        let uv: Vec<U256> = self.buckets.iter().zip(&nf).map(|(b, n)| self.unit_value_e18(b, *n)).collect();
        let (c_raw_p, c_raw) = self.claims_at(&nf);
        let c_eff = c_raw.min(risk_pool);
        let delta_raw = c_raw_p.iter().enumerate().fold(0u128, |s, (i, c)| s.saturating_add(c.saturating_mul(i as u128 + 1)));
        let weighted_raw = self.weighted_claims(&c_raw_p);
        let mut l = Live {
            nf,
            uv,
            c_raw_p,
            fee_pending,
            funding_pending,
            c_raw,
            c_eff,
            delta_eff: 0,
            weighted_raw,
            risk_pool,
            short_equity: risk_pool - c_eff,
        };
        l.delta_eff = l.haircut(delta_raw);
        l
    }

    /// Books pending funding: NFs decay, and the protocol fee moves from R to fees.
    pub(crate) fn accrue(&mut self) {
        require!(!self.emergency, "market is in emergency shutdown");
        let (nfs, funding, fee) = self.pending_accrual();
        let now = now_secs();
        if now > self.last_accrual_ts {
            self.last_accrual_ts = now;
        }
        if funding == 0 && nfs == self.nfs() {
            return;
        }
        for (b, nf) in self.buckets.iter_mut().zip(nfs) {
            b.nf = nf;
        }
        self.risk_pool -= fee;
        self.fees += fee;
        self.sweep_orphan_equity();
        self.maintain_buckets();
        self.stats.funding_paid.0 += funding;
        self.stats.fees_earned.0 += fee;
        if funding > 0 {
            events::emit(
                "funding",
                near_sdk::serde_json::json!({
                    "ts": now, "nf": self.buckets.iter().map(|b| b.nf.to_string()).collect::<Vec<_>>(),
                    "funding": funding.to_string(), "fee": fee.to_string(), "price": self.price.to_string(),
                }),
            );
        }
    }

    pub(crate) fn maybe_snapshot(&mut self) {
        let now = now_secs();
        if self.price == 0
            || (self.snapshot_count > 0 && now < self.last_snapshot_ts + self.params.snapshot_interval_secs)
        {
            return;
        }
        let l = self.live();
        let snap = Snapshot {
            ts: now,
            price: U128(self.price),
            risk_pool: U128(l.risk_pool),
            long_claims: U128(l.c_eff),
            delta_claims: U128(l.delta_eff),
            short_equity: U128(l.short_equity),
            short_share_price_e18: U128(self.short_share_price_e18(&l)),
        };
        self.snapshots.insert(self.snapshot_count, snap);
        if self.snapshot_count >= MAX_SNAPSHOTS {
            self.snapshots.remove(&(self.snapshot_count - MAX_SNAPSHOTS));
        }
        self.snapshot_count += 1;
        self.last_snapshot_ts = now;
    }

    pub(crate) fn short_share_price_e18(&self, l: &Live) -> u128 {
        if self.short_shares == 0 {
            ONE
        } else {
            mul_div(l.short_equity, ONE, self.short_shares)
        }
    }

    pub(crate) fn require_fresh_price(&self) {
        require!(self.price > 0, "no oracle price yet");
        require!(
            now_secs().saturating_sub(self.price_ts) <= self.params.max_price_age_secs,
            "oracle price is stale"
        );
    }

    /// Core solvency invariant: every USDC we track is claimed exactly once.
    pub(crate) fn assert_invariant(&self) {
        require!(
            self.free_total + self.risk_pool + self.fees == self.treasury,
            "invariant violated: claims != treasury"
        );
    }

    pub(crate) fn account(&self, id: &AccountId) -> Account {
        let mut acc = self.accounts.get(id).cloned().unwrap_or_else(|| env::panic_str("unknown account"));
        self.normalize(&mut acc);
        acc
    }

    /// Writes off Curve Short shares from a wiped-out epoch (realized loss = their cost), and brings
    /// every long position to its bucket's current unit scale.
    pub(crate) fn normalize(&self, acc: &mut Account) {
        if acc.short_epoch != self.short_epoch {
            if acc.short_shares > 0 {
                acc.realized_pnl -= acc.short_cost as i128;
                acc.short_shares = 0;
                acc.short_cost = 0;
            }
            acc.short_epoch = self.short_epoch;
        }
        for pos in acc.longs.iter_mut() {
            let b = &self.buckets[bucket_index(pos.power)];
            while pos.scale < b.scale {
                pos.units /= SCALE_STEP;
                pos.scale += 1;
                if pos.units == 0 {
                    pos.scale = b.scale;
                }
            }
            while pos.scale > b.scale {
                pos.units = pos.units.saturating_mul(SCALE_STEP);
                pos.scale -= 1;
            }
        }
        // A position re-scaled down to zero units is rounding dust: its cost is a realized loss.
        let mut lost = 0i128;
        acc.longs.retain(|p| {
            if p.units == 0 {
                lost += p.cost as i128;
            }
            p.units > 0
        });
        acc.realized_pnl -= lost;
    }

    /// If a rally pushed total long claims to the pool, cut every bucket's NF by the same factor so
    /// claims equal the pool (pro rata across buckets). The excess claim is gone for good; Curve
    /// Short equity is exactly 0 afterwards.
    pub(crate) fn write_down_if_capped(&mut self) {
        if !self.has_longs() || self.risk_pool == 0 {
            return;
        }
        let c_raw = self.raw_claims();
        if c_raw < self.risk_pool {
            return;
        }
        let nf_old = self.nfs();
        // Rounding (and saturation of absurd claims) can leave a hair above the pool: repeat.
        let mut c = c_raw;
        for _ in 0..6 {
            if c <= self.risk_pool {
                break;
            }
            let r = self.risk_pool;
            for b in self.buckets.iter_mut() {
                if b.total_units > 0 {
                    b.nf = mul_div(b.nf, r, c).min(b.nf);
                }
            }
            c = self.raw_claims();
        }
        let c_new = c.min(self.risk_pool);
        let dust = self.risk_pool - c_new;
        self.risk_pool -= dust;
        self.fees += dust;
        self.stats.write_downs += 1;
        events::emit(
            "longs_written_down",
            near_sdk::serde_json::json!({
                "claim": c_raw.to_string(), "pool": (c_new + dust).to_string(),
                "nf_old": nf_old.iter().map(|n| n.to_string()).collect::<Vec<_>>(),
                "nf": self.buckets.iter().map(|b| b.nf.to_string()).collect::<Vec<_>>(),
                "price": self.price.to_string(),
            }),
        );
    }

    /// With no Curve Short shares, any equity left in the pool belongs to nobody: sweep it to fees.
    pub(crate) fn sweep_orphan_equity(&mut self) {
        if self.short_shares > 0 {
            return;
        }
        let c = self.raw_claims().min(self.risk_pool);
        let orphan = self.risk_pool - c;
        if orphan > 0 {
            self.risk_pool -= orphan;
            self.fees += orphan;
            events::emit("orphan_equity", near_sdk::serde_json::json!({ "amount": orphan.to_string() }));
        }
    }

    pub(crate) fn save_account(&mut self, id: &AccountId, acc: Account) {
        if self.accounts.insert(id.clone(), acc).is_none() {
            self.stats.accounts += 1;
        }
    }

    /// `caller` manages `target` if the owner registered `caller` as a manager
    /// and `target` sits in its namespace (`*.caller`).
    pub(crate) fn is_manager_of(&self, caller: &AccountId, target: &AccountId) -> bool {
        self.managers.contains(caller) && target.as_str().ends_with(&format!(".{}", caller.as_str()))
    }

    /// Who may trade: the account itself, its manager, or an approved operator.
    pub(crate) fn resolve_trader(&self, account_id: Option<AccountId>) -> AccountId {
        let caller = env::predecessor_account_id();
        let target = account_id.unwrap_or_else(|| caller.clone());
        if target == caller || self.is_manager_of(&caller, &target) {
            return target;
        }
        let ok = self.accounts.get(&target).map(|a| a.operators.contains(&caller)).unwrap_or(false);
        require!(ok, "not authorized to trade for this account");
        target
    }

    /// Who may withdraw: the account itself or its manager. Operators can't.
    pub(crate) fn resolve_withdrawer(&self, account_id: Option<AccountId>) -> AccountId {
        let caller = env::predecessor_account_id();
        let target = account_id.unwrap_or_else(|| caller.clone());
        require!(
            target == caller || self.is_manager_of(&caller, &target),
            "not authorized to withdraw for this account"
        );
        target
    }
}
