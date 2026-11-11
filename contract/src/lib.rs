//! Curve Ledger: a continuous-expiry power perpetual on NEAR.
//!
//! One USDC treasury, two sides, priced only by the oracle:
//!
//! * **Curve** holds *units* of the power index `I(P) = (P / P_ref)^p`.
//!   One unit is worth `NF × I(P)` raw USDC, where the normalization factor
//!   `NF` (1e18 at launch) decays at the funding rate. Curve Long pays funding by
//!   shrinking. It can't be liquidated and has no margin.
//! * **Curve Short** owns shares of the residual `F = R − C`, where `R` is the
//!   risk pool and `C` the long claims. NF decay flows into `F` automatically.
//!
//! Solvency comes from the structure: `C_eff = min(C_raw, R)` (pro-rata haircut),
//! so `free + C_eff + F + fees == treasury` always holds. Every mutation checks
//! it. Nothing is blocked by utilization: funding rises steeply instead. If a rally
//! pushes long claims past the pool, the excess is written off (NF is cut so claims
//! equal the pool) and Curve Short starts a fresh epoch that new shorts can join.
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

use math::{annual_funding_rate_e18, exp_neg_e18, mul_div, power_index_e18, sat_u128, BPS, ONE, U256, YEAR_SECS};
pub use oracle::OracleConfig;

/// $1,000,000 at 6dp.
pub const MAX_PRICE: u128 = 1_000_000_000_000;
pub const MAX_SNAPSHOTS: u64 = 1_000;
pub const MAX_OPERATORS: usize = 4;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Params {
    /// Payoff exponent p (1..=10). Can't change while long units exist.
    pub power: u8,
    /// Implied volatility σ (annualized, bps). Funding/yr = p(p−1)/2 · σ² + base.
    pub implied_vol_bps: u32,
    /// Extra annual funding (bps) on top of the fair convexity rate.
    pub base_funding_bps: u32,
    /// Utilization multiplier on funding, u = long claims / pool:
    /// `m(u) = base + slope·u + kink_slope·max(0, u − kink)/(1 − kink)`, in bps (10000 = 1×).
    /// Cheaper than fair below the kink (attracts longs), steeper above it (attracts shorts).
    /// Set base = 10000 and both slopes = 0 to switch it off.
    pub util_mult_base_bps: u32,
    pub util_mult_slope_bps: u32,
    pub util_kink_bps: u16,
    pub util_mult_kink_slope_bps: u32,
    /// Largest single long open, as a share of the pool before the open (bps).
    /// Not a wall: repeated opens are allowed, but each one raises utilization and funding.
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

impl Default for Params {
    fn default() -> Self {
        Self {
            power: 2,
            implied_vol_bps: 8_000,
            base_funding_bps: 0,
            // 0.5× at u = 0, 1× (fair) at the 50% kink, 11× at 75%, 21.5× at u = 100%.
            util_mult_base_bps: 5_000,
            util_mult_slope_bps: 10_000,
            util_kink_bps: 5_000,
            util_mult_kink_slope_bps: 200_000,
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

#[near(serializers = [borsh])]
#[derive(Clone, Default, Debug)]
pub struct Account {
    pub free: u128,
    pub long_units: u128,
    /// Gross USDC paid for the units still held (cost basis, includes fees).
    pub long_cost: u128,
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

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub ts: u64,
    pub price: U128,
    pub nf: U128,
    pub risk_pool: U128,
    pub long_claims: U128,
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
    pub(crate) ref_price: u128,
    pub(crate) price: u128,
    pub(crate) price_ts: u64,
    /// Normalization factor, 1e18 at launch, decays with funding.
    pub(crate) nf: u128,
    pub(crate) last_accrual_ts: u64,
    pub(crate) total_units: u128,
    /// R: USDC backing long claims + Curve Short equity.
    pub(crate) risk_pool: u128,
    pub(crate) short_shares: u128,
    /// Bumped when Curve Short is wiped out and a new short joins; older shares are worth 0.
    pub(crate) short_epoch: u64,
    pub(crate) free_total: u128,
    pub(crate) fees: u128,
    /// Tracked USDC we owe in total. Must be ≤ the real token balance.
    pub(crate) treasury: u128,
    pub(crate) open_paused: bool,
    pub(crate) accounts: IterableMap<AccountId, Account>,
    pub(crate) managers: IterableSet<AccountId>,
    pub(crate) snapshots: LookupMap<u64, Snapshot>,
    pub(crate) snapshot_count: u64,
    pub(crate) last_snapshot_ts: u64,
    pub(crate) stats: Stats,
}

/// Market state including funding that is pending but not yet written.
pub(crate) struct Live {
    pub nf: u128,
    pub fee_pending: u128,
    pub funding_pending: u128,
    pub unit_value_e18: U256,
    pub c_raw: u128,
    pub c_eff: u128,
    pub risk_pool: u128,
    pub short_equity: u128,
}

pub(crate) fn now_secs() -> u64 {
    env::block_timestamp() / 1_000_000_000
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
        Self {
            owner,
            token,
            oracle,
            params,
            ref_price: ref_price.0,
            price: 0,
            price_ts: 0,
            nf: ONE,
            last_accrual_ts: now_secs(),
            total_units: 0,
            risk_pool: 0,
            short_shares: 0,
            short_epoch: 0,
            free_total: 0,
            fees: 0,
            treasury: 0,
            open_paused: false,
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
    pub(crate) fn unit_value_e18(&self, nf: u128) -> U256 {
        if self.price == 0 {
            return U256::zero();
        }
        U256::from(nf) * power_index_e18(self.price, self.ref_price, self.params.power) / U256::from(ONE)
    }

    pub(crate) fn units_value(units: u128, unit_value_e18: U256) -> u128 {
        match U256::from(units).checked_mul(unit_value_e18) {
            Some(v) => sat_u128(v / U256::from(ONE)),
            None => u128::MAX,
        }
    }

    /// Steep curves move the index by orders of magnitude. Re-anchor it at the current price
    /// (ref_price = price, NF absorbs the old index) so neither NF nor the index loses precision.
    /// Unit values don't change.
    pub(crate) fn maybe_rebase(&mut self) {
        if self.price == 0 {
            return;
        }
        let idx = power_index_e18(self.price, self.ref_price, self.params.power);
        let lo = U256::from(1_000_000_000_000u128); // 1e-6
        let hi = U256::from(1_000_000_000_000_000_000_000_000_000u128); // 1e9
        if idx >= lo && idx <= hi && self.nf >= 1_000_000_000_000 {
            return;
        }
        let vpu = U256::from(self.nf) * idx / U256::from(ONE);
        if vpu.is_zero() || vpu > U256::from(u128::MAX) {
            return;
        }
        events::emit(
            "rebase",
            near_sdk::serde_json::json!({ "old_ref": self.ref_price.to_string(), "ref": self.price.to_string(), "nf": vpu.as_u128().to_string() }),
        );
        self.nf = vpu.as_u128();
        self.ref_price = self.price;
    }

    /// Fair convexity rate before the utilization multiplier.
    pub(crate) fn base_funding_rate_e18(&self) -> u128 {
        annual_funding_rate_e18(self.params.power, self.params.implied_vol_bps, self.params.base_funding_bps)
    }

    /// Utilization u = long claims / pool, in bps, capped at 100%.
    pub(crate) fn utilization_bps(c_raw: u128, risk_pool: u128) -> u128 {
        if c_raw == 0 {
            0
        } else if risk_pool == 0 {
            BPS
        } else {
            mul_div(c_raw, BPS, risk_pool).min(BPS)
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

    /// Effective annual funding rate (1e18) at the given utilization.
    pub(crate) fn funding_rate_at_e18(&self, util_bps: u128) -> u128 {
        mul_div(self.base_funding_rate_e18(), self.util_multiplier_bps(util_bps), BPS)
    }

    /// (new NF, funding paid by Curve Long, protocol fee) for time since the last accrual.
    /// The rate uses utilization at the start of the interval; keepers poke often.
    pub(crate) fn pending_accrual(&self) -> (u128, u128, u128) {
        let now = now_secs();
        if now <= self.last_accrual_ts || self.price == 0 || self.total_units == 0 {
            return (self.nf, 0, 0);
        }
        let dt = (now - self.last_accrual_ts) as u128;
        let c_raw = Self::units_value(self.total_units, self.unit_value_e18(self.nf));
        let rate = self.funding_rate_at_e18(Self::utilization_bps(c_raw, self.risk_pool));
        let x = mul_div(rate, dt, YEAR_SECS);
        let nf_new = mul_div(self.nf, exp_neg_e18(x), ONE);
        let before = c_raw.min(self.risk_pool);
        let after = Self::units_value(self.total_units, self.unit_value_e18(nf_new)).min(self.risk_pool);
        let funding = before - after;
        let fee = funding * self.params.funding_fee_bps as u128 / BPS;
        (nf_new, funding, fee)
    }

    pub(crate) fn live(&self) -> Live {
        let (nf, funding_pending, fee_pending) = self.pending_accrual();
        let risk_pool = self.risk_pool - fee_pending;
        let unit_value_e18 = self.unit_value_e18(nf);
        let c_raw = Self::units_value(self.total_units, unit_value_e18);
        let c_eff = c_raw.min(risk_pool);
        Live {
            nf,
            fee_pending,
            funding_pending,
            unit_value_e18,
            c_raw,
            c_eff,
            risk_pool,
            short_equity: risk_pool - c_eff,
        }
    }

    /// Books pending funding: NF decays, and the protocol fee moves from R to fees.
    pub(crate) fn accrue(&mut self) {
        let (nf, funding, fee) = self.pending_accrual();
        let now = now_secs();
        if now > self.last_accrual_ts {
            self.last_accrual_ts = now;
        }
        if funding == 0 && nf == self.nf {
            return;
        }
        self.nf = nf;
        self.risk_pool -= fee;
        self.fees += fee;
        self.sweep_orphan_equity();
        self.stats.funding_paid.0 += funding;
        self.stats.fees_earned.0 += fee;
        if funding > 0 {
            events::emit(
                "funding",
                near_sdk::serde_json::json!({
                    "ts": now, "nf": nf.to_string(), "funding": funding.to_string(),
                    "fee": fee.to_string(), "price": self.price.to_string(),
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
            nf: U128(l.nf),
            risk_pool: U128(l.risk_pool),
            long_claims: U128(l.c_eff),
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

    /// Writes off Curve Short shares from a wiped-out epoch (realized loss = their cost).
    pub(crate) fn normalize(&self, acc: &mut Account) {
        if acc.short_epoch != self.short_epoch {
            if acc.short_shares > 0 {
                acc.realized_pnl -= acc.short_cost as i128;
                acc.short_shares = 0;
                acc.short_cost = 0;
            }
            acc.short_epoch = self.short_epoch;
        }
    }

    /// If a rally pushed long claims past the pool, cut NF so claims equal the pool.
    /// The excess claim is gone for good; Curve Short equity is exactly 0 afterwards.
    pub(crate) fn write_down_if_capped(&mut self) {
        if self.total_units == 0 || self.risk_pool == 0 {
            return;
        }
        let c_raw = Self::units_value(self.total_units, self.unit_value_e18(self.nf));
        if c_raw < self.risk_pool {
            return;
        }
        let nf_old = self.nf;
        // NF such that units × NF × idx / 1e36 = pool, computed in U256 (c_raw may have saturated).
        let idx = power_index_e18(self.price, self.ref_price, self.params.power);
        let denom = U256::from(self.total_units) * idx;
        self.nf = sat_u128(U256::from(self.risk_pool) * U256::from(ONE) * U256::from(ONE) / denom).min(self.nf);
        let c_new = Self::units_value(self.total_units, self.unit_value_e18(self.nf));
        let dust = self.risk_pool - c_new.min(self.risk_pool);
        self.risk_pool -= dust;
        self.fees += dust;
        events::emit(
            "longs_written_down",
            near_sdk::serde_json::json!({
                "claim": c_raw.to_string(), "pool": (c_new + dust).to_string(),
                "nf_old": nf_old.to_string(), "nf": self.nf.to_string(), "price": self.price.to_string(),
            }),
        );
    }

    /// With no Curve Short shares, any equity left in the pool belongs to nobody: sweep it to fees.
    pub(crate) fn sweep_orphan_equity(&mut self) {
        if self.short_shares > 0 {
            return;
        }
        let c = Self::units_value(self.total_units, self.unit_value_e18(self.nf)).min(self.risk_pool);
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
