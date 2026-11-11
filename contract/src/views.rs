//! Read-only views for bots, the Telegram app and indexers. All amounts are
//! decimal strings (U128). Values include funding accrued since the last poke,
//! so a view is exact at the current block, with no keeper needed for reads.

use crate::math::{mul_div, power_index_e18, BPS, ONE, U256};
use crate::oracle::OracleConfig;
use crate::trade::TradeQuote;
use crate::{now_secs, Account, Contract, ContractExt, Live, Params, Snapshot, Stats};
use near_sdk::json_types::{I128, U128};
use near_sdk::{near, AccountId};

#[near(serializers = [json])]
pub struct MarketView {
    pub timestamp: u64,
    pub price: U128,
    pub price_ts: u64,
    pub price_fresh: bool,
    pub ref_price: U128,
    pub power: u8,
    pub nf: U128,
    /// Value of one Curve unit (USDC raw × 1e18).
    pub unit_value_e18: U128,
    pub total_units: U128,
    pub risk_pool: U128,
    /// long claims after any haircut.
    pub long_claims: U128,
    pub long_claims_raw: U128,
    pub short_equity: U128,
    pub short_shares: U128,
    pub short_share_price_e18: U128,
    pub utilization_bps: u32,
    /// Largest single long open allowed right now (max_open_bps of the pool).
    pub max_long_open: U128,
    /// Curve Short epoch; bumps when wiped-out shorts are replaced by new ones.
    pub short_epoch: u64,
    /// Funding Curve Long pays per year right now, as a fraction of its value (bps).
    pub funding_rate_annual_bps: u32,
    /// Fair convexity rate p(p−1)/2·σ² before the utilization multiplier (bps/yr).
    pub funding_base_annual_bps: u32,
    /// Current utilization multiplier (10000 = 1×).
    pub funding_multiplier_bps: u32,
    pub funding_pending: U128,
    pub free_total: U128,
    pub fees: U128,
    pub treasury: U128,
    pub open_paused: bool,
}

#[near(serializers = [json])]
pub struct AccountView {
    pub account_id: AccountId,
    pub free: U128,
    pub long_units: U128,
    pub long_value: U128,
    pub long_cost: U128,
    pub long_pnl: I128,
    pub short_shares: U128,
    pub short_value: U128,
    pub short_cost: U128,
    pub short_pnl: I128,
    pub realized_pnl: I128,
    pub deposited: U128,
    pub withdrawn: U128,
    /// free + long_value + short_value
    pub equity: U128,
    /// equity + withdrawn − deposited (lifetime PnL, net of fees and funding)
    pub total_pnl: I128,
    pub operators: Vec<AccountId>,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub owner: AccountId,
    pub token: AccountId,
    pub oracle: OracleConfig,
    pub params: Params,
    pub managers: Vec<AccountId>,
}

#[near(serializers = [json])]
pub struct Solvency {
    pub treasury: U128,
    pub free_total: U128,
    pub long_claims: U128,
    pub short_equity: U128,
    pub fees: U128,
    pub claims_total: U128,
    pub ok: bool,
}

#[near(serializers = [json])]
pub struct Preview {
    pub ok: bool,
    pub error: Option<String>,
    pub quote: Option<TradeQuote>,
}

fn preview(r: Result<TradeQuote, &'static str>) -> Preview {
    match r {
        Ok(q) => Preview { ok: true, error: None, quote: Some(q) },
        Err(e) => Preview { ok: false, error: Some(e.to_string()), quote: None },
    }
}

impl Contract {
    fn account_view(&self, id: &AccountId, a: &Account, l: &Live) -> AccountView {
        let mut a = a.clone();
        self.normalize(&mut a);
        let a = &a;
        let raw = Self::units_value(a.long_units, l.unit_value_e18);
        let long_value = if l.c_raw > l.risk_pool { mul_div(raw, l.risk_pool, l.c_raw) } else { raw };
        let short_value = if self.short_shares == 0 { 0 } else { mul_div(a.short_shares, l.short_equity, self.short_shares) };
        let equity = a.free + long_value + short_value;
        AccountView {
            account_id: id.clone(),
            free: U128(a.free),
            long_units: U128(a.long_units),
            long_value: U128(long_value),
            long_cost: U128(a.long_cost),
            long_pnl: I128(long_value as i128 - a.long_cost as i128),
            short_shares: U128(a.short_shares),
            short_value: U128(short_value),
            short_cost: U128(a.short_cost),
            short_pnl: I128(short_value as i128 - a.short_cost as i128),
            realized_pnl: I128(a.realized_pnl),
            deposited: U128(a.deposited),
            withdrawn: U128(a.withdrawn),
            equity: U128(equity),
            total_pnl: I128(equity as i128 + a.withdrawn as i128 - a.deposited as i128),
            operators: a.operators.clone(),
        }
    }
}

#[near]
impl Contract {
    pub fn get_market(&self) -> MarketView {
        let l = self.live();
        let util = if l.c_raw == 0 || l.risk_pool == 0 { 0 } else { mul_div(l.c_raw, BPS, l.risk_pool) as u32 };
        MarketView {
            timestamp: now_secs(),
            price: U128(self.price),
            price_ts: self.price_ts,
            price_fresh: self.price > 0
                && now_secs().saturating_sub(self.price_ts) <= self.params.max_price_age_secs,
            ref_price: U128(self.ref_price),
            power: self.params.power,
            nf: U128(l.nf),
            unit_value_e18: U128(l.unit_value_e18.as_u128()),
            total_units: U128(self.total_units),
            risk_pool: U128(l.risk_pool),
            long_claims: U128(l.c_eff),
            long_claims_raw: U128(l.c_raw),
            short_equity: U128(l.short_equity),
            short_shares: U128(self.short_shares),
            short_share_price_e18: U128(self.short_share_price_e18(&l)),
            utilization_bps: util,
            max_long_open: U128(self.max_long_open(&l)),
            short_epoch: self.short_epoch,
            funding_rate_annual_bps: (self.funding_rate_at_e18(Self::utilization_bps(l.c_raw, l.risk_pool)) * BPS / ONE) as u32,
            funding_base_annual_bps: (self.base_funding_rate_e18() * BPS / ONE) as u32,
            funding_multiplier_bps: self.util_multiplier_bps(Self::utilization_bps(l.c_raw, l.risk_pool)) as u32,
            funding_pending: U128(l.funding_pending),
            free_total: U128(self.free_total),
            fees: U128(self.fees + l.fee_pending),
            treasury: U128(self.treasury),
            open_paused: self.open_paused,
        }
    }

    pub fn get_account(&self, account_id: AccountId) -> Option<AccountView> {
        let l = self.live();
        self.accounts.get(&account_id).map(|a| self.account_view(&account_id, a, &l))
    }

    pub fn get_accounts(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<AccountView> {
        let l = self.live();
        self.accounts
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(200) as usize)
            .map(|(id, a)| self.account_view(id, a, &l))
            .collect()
    }

    pub fn get_num_accounts(&self) -> u32 {
        self.accounts.len()
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            token: self.token.clone(),
            oracle: self.oracle.clone(),
            params: self.params.clone(),
            managers: self.managers.iter().cloned().collect(),
        }
    }

    pub fn get_stats(&self) -> Stats {
        self.stats.clone()
    }

    pub fn get_solvency(&self) -> Solvency {
        let l = self.live();
        let fees = self.fees + l.fee_pending;
        let claims = self.free_total + l.c_eff + l.short_equity + fees;
        Solvency {
            treasury: U128(self.treasury),
            free_total: U128(self.free_total),
            long_claims: U128(l.c_eff),
            short_equity: U128(l.short_equity),
            fees: U128(fees),
            claims_total: U128(claims),
            ok: claims == self.treasury,
        }
    }

    /// Newest-last snapshots, at most `MAX_SNAPSHOTS` kept on-chain.
    pub fn get_snapshots(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Snapshot> {
        let first = self.snapshot_count.saturating_sub(crate::MAX_SNAPSHOTS);
        let start = from_index.unwrap_or(first).max(first);
        let end = (start + limit.unwrap_or(100).min(500)).min(self.snapshot_count);
        (start..end).filter_map(|i| self.snapshots.get(&i).cloned()).collect()
    }

    pub fn get_snapshot_count(&self) -> u64 {
        self.snapshot_count
    }

    pub fn can_act(&self, caller: AccountId, account_id: AccountId) -> (bool, bool) {
        let manager = caller == account_id || self.is_manager_of(&caller, &account_id);
        let operator = self.accounts.get(&account_id).map(|a| a.operators.contains(&caller)).unwrap_or(false);
        (manager || operator, manager) // (can_trade, can_withdraw)
    }

    pub fn preview_open_long(&self, amount: U128) -> Preview {
        preview(self.quote_open_long(&self.live(), amount.0))
    }

    pub fn preview_close_long(&self, units: U128) -> Preview {
        preview(self.quote_close_long(&self.live(), units.0))
    }

    pub fn preview_open_short(&self, amount: U128) -> Preview {
        preview(self.quote_open_short(&self.live(), amount.0))
    }

    pub fn preview_close_short(&self, shares: U128) -> Preview {
        preview(self.quote_close_short(&self.live(), shares.0))
    }

    /// Payoff curve for charts: value of `units` at each price, at the current NF.
    pub fn quote_payoff(&self, units: U128, prices: Vec<U128>) -> Vec<U128> {
        let nf = self.live().nf;
        prices
            .into_iter()
            .take(200)
            .map(|p| {
                let idx = power_index_e18(p.0.min(crate::MAX_PRICE), self.ref_price, self.params.power);
                let vpu = U256::from(nf) * idx / U256::from(ONE);
                U128(Self::units_value(units.0, vpu))
            })
            .collect()
    }
}
