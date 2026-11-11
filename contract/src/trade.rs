//! Open/close for both sides. Each action has a pure `quote_*` (shared by the
//! preview views, so bots see exactly what will execute) and a mutating
//! `internal_*` that applies the quote.

use crate::events::emit;
use crate::math::{mul_div, BPS, ONE, U256};
use crate::{Contract, ContractExt, Live};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{near, require, AccountId};

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct TradeQuote {
    /// USDC in (opens) or gross value out (closes).
    pub amount: U128,
    pub fee: U128,
    /// Units (long open), shares (short open), or USDC credited (closes).
    pub out: U128,
    pub utilization_after_bps: u32,
}

fn util_bps(c_raw: u128, risk_pool: u128) -> u32 {
    if c_raw == 0 {
        0
    } else if risk_pool == 0 {
        u32::MAX
    } else {
        mul_div(c_raw, BPS, risk_pool).min(u32::MAX as u128) as u32
    }
}

impl Contract {
    /// Largest amount a single long open may use right now.
    pub(crate) fn max_long_open(&self, l: &Live) -> u128 {
        mul_div(l.risk_pool, self.params.max_open_bps as u128, BPS)
    }

    fn fee_of(&self, amount: u128) -> u128 {
        amount * self.params.trade_fee_bps as u128 / BPS
    }

    pub(crate) fn quote_open_long(&self, l: &Live, amount: u128) -> Result<TradeQuote, &'static str> {
        if self.open_paused {
            return Err("opens are paused");
        }
        if amount < self.params.min_amount.0 {
            return Err("amount below minimum");
        }
        if l.unit_value_e18.is_zero() {
            return Err("no oracle price yet");
        }
        let fee = self.fee_of(amount);
        let net = amount - fee;
        let units = (U256::from(net) * U256::from(ONE) / l.unit_value_e18).as_u128();
        if units == 0 {
            return Err("amount too small for one unit");
        }
        if self.short_shares == 0 {
            return Err("no Curve Short liquidity yet");
        }
        if amount > self.max_long_open(l) {
            return Err("open too large: one long can be at most max_open_bps of the pool; split it up");
        }
        if l.c_raw > l.risk_pool {
            return Err("pool is capped until the next price update");
        }
        if l.short_equity == 0 {
            return Err("Curve Short is wiped out; wait for new shorts to join");
        }
        let c_after = Self::units_value(self.total_units + units, l.unit_value_e18);
        let util = util_bps(c_after, l.risk_pool + net);
        Ok(TradeQuote { amount: U128(amount), fee: U128(fee), out: U128(units), utilization_after_bps: util })
    }

    pub(crate) fn quote_close_long(&self, l: &Live, units: u128) -> Result<TradeQuote, &'static str> {
        if units == 0 || units > self.total_units {
            return Err("bad units");
        }
        let raw = Self::units_value(units, l.unit_value_e18);
        // Pro-rata haircut if long claims exceed the pool (Curve Short wiped out).
        let value = if l.c_raw > l.risk_pool { mul_div(raw, l.risk_pool, l.c_raw) } else { raw };
        let fee = self.fee_of(value);
        let c_after = l.c_raw - raw;
        Ok(TradeQuote {
            amount: U128(value),
            fee: U128(fee),
            out: U128(value - fee),
            utilization_after_bps: util_bps(c_after, l.risk_pool - value),
        })
    }

    pub(crate) fn quote_open_short(&self, l: &Live, amount: u128) -> Result<TradeQuote, &'static str> {
        if self.open_paused {
            return Err("opens are paused");
        }
        if amount < self.params.min_amount.0 {
            return Err("amount below minimum");
        }
        if self.price == 0 {
            return Err("no oracle price yet");
        }
        let fee = self.fee_of(amount);
        let net = amount - fee;
        // Wiped-out shorts (equity 0) are worth nothing: a new short starts a fresh epoch.
        let shares = if self.short_shares == 0 || l.short_equity == 0 {
            net
        } else {
            mul_div(net, self.short_shares, l.short_equity)
        };
        if shares == 0 {
            return Err("amount too small for one share");
        }
        Ok(TradeQuote {
            amount: U128(amount),
            fee: U128(fee),
            out: U128(shares),
            utilization_after_bps: util_bps(l.c_raw, l.risk_pool + net),
        })
    }

    pub(crate) fn quote_close_short(&self, l: &Live, shares: u128) -> Result<TradeQuote, &'static str> {
        if shares == 0 || shares > self.short_shares {
            return Err("bad shares");
        }
        let value = mul_div(shares, l.short_equity, self.short_shares);
        let util = util_bps(l.c_raw, l.risk_pool - value);
        let fee = self.fee_of(value);
        Ok(TradeQuote { amount: U128(value), fee: U128(fee), out: U128(value - fee), utilization_after_bps: util })
    }

    // ───────────── mutations (caller has already accrued and authorized) ─────────────

    pub(crate) fn internal_open_long(&mut self, who: &AccountId, amount: u128, min_units: u128) -> u128 {
        self.require_fresh_price();
        let l = self.live();
        let q = self.quote_open_long(&l, amount).unwrap_or_else(|e| near_sdk::env::panic_str(e));
        let units = q.out.0;
        require!(units >= min_units, "slippage: fewer units than min_units");
        let mut acc = self.account(who);
        require!(acc.free >= amount, "insufficient free balance");
        acc.free -= amount;
        acc.long_units += units;
        acc.long_cost += amount;
        self.save_account(who, acc);
        self.free_total -= amount;
        self.total_units += units;
        self.risk_pool += amount - q.fee.0;
        self.book_trade(amount, q.fee.0);
        emit(
            "open_long",
            json!({
                "account_id": who, "amount": amount.to_string(), "fee": q.fee.0.to_string(),
                "units": units.to_string(), "price": self.price.to_string(), "nf": self.nf.to_string(),
            }),
        );
        self.finish();
        units
    }

    pub(crate) fn internal_close_long(&mut self, who: &AccountId, units: Option<u128>, min_out: u128) -> u128 {
        self.require_fresh_price();
        let mut acc = self.account(who);
        let units = units.unwrap_or(acc.long_units);
        require!(units > 0 && units <= acc.long_units, "bad units");
        let l = self.live();
        let q = self.quote_close_long(&l, units).unwrap_or_else(|e| near_sdk::env::panic_str(e));
        let out = q.out.0;
        require!(out >= min_out, "slippage: out below min_out");
        let cost = mul_div(acc.long_cost, units, acc.long_units);
        acc.long_units -= units;
        acc.long_cost -= cost;
        acc.free += out;
        acc.realized_pnl += out as i128 - cost as i128;
        self.save_account(who, acc);
        self.total_units -= units;
        self.risk_pool -= q.amount.0;
        self.free_total += out;
        self.book_trade(q.amount.0, q.fee.0);
        emit(
            "close_long",
            json!({
                "account_id": who, "units": units.to_string(), "value": q.amount.0.to_string(),
                "fee": q.fee.0.to_string(), "out": out.to_string(),
                "pnl": (out as i128 - cost as i128).to_string(), "price": self.price.to_string(),
                "nf": self.nf.to_string(),
            }),
        );
        self.finish();
        out
    }

    pub(crate) fn internal_open_short(&mut self, who: &AccountId, amount: u128, min_shares: u128) -> u128 {
        self.require_fresh_price();
        let l = self.live();
        if self.short_shares > 0 && l.short_equity == 0 {
            self.short_epoch += 1;
            emit("shorts_reset", json!({ "epoch": self.short_epoch, "old_shares": self.short_shares.to_string() }));
            self.short_shares = 0;
        }
        let q = self.quote_open_short(&l, amount).unwrap_or_else(|e| near_sdk::env::panic_str(e));
        let shares = q.out.0;
        require!(shares >= min_shares, "slippage: fewer shares than min_shares");
        let mut acc = self.account(who);
        require!(acc.free >= amount, "insufficient free balance");
        acc.free -= amount;
        acc.short_shares += shares;
        acc.short_cost += amount;
        self.save_account(who, acc);
        self.free_total -= amount;
        self.short_shares += shares;
        self.risk_pool += amount - q.fee.0;
        self.book_trade(amount, q.fee.0);
        emit(
            "open_short",
            json!({
                "account_id": who, "amount": amount.to_string(), "fee": q.fee.0.to_string(),
                "shares": shares.to_string(), "price": self.price.to_string(),
            }),
        );
        self.finish();
        shares
    }

    pub(crate) fn internal_close_short(&mut self, who: &AccountId, shares: Option<u128>, min_out: u128) -> u128 {
        self.require_fresh_price();
        let mut acc = self.account(who);
        let shares = shares.unwrap_or(acc.short_shares);
        require!(shares > 0 && shares <= acc.short_shares, "bad shares");
        let l = self.live();
        let q = self.quote_close_short(&l, shares).unwrap_or_else(|e| near_sdk::env::panic_str(e));
        let out = q.out.0;
        require!(out >= min_out, "slippage: out below min_out");
        let cost = mul_div(acc.short_cost, shares, acc.short_shares);
        acc.short_shares -= shares;
        acc.short_cost -= cost;
        acc.free += out;
        acc.realized_pnl += out as i128 - cost as i128;
        self.save_account(who, acc);
        self.short_shares -= shares;
        self.risk_pool -= q.amount.0;
        self.free_total += out;
        self.book_trade(q.amount.0, q.fee.0);
        emit(
            "close_short",
            json!({
                "account_id": who, "shares": shares.to_string(), "value": q.amount.0.to_string(),
                "fee": q.fee.0.to_string(), "out": out.to_string(),
                "pnl": (out as i128 - cost as i128).to_string(), "price": self.price.to_string(),
            }),
        );
        self.finish();
        out
    }

    fn book_trade(&mut self, volume: u128, fee: u128) {
        self.fees += fee;
        self.stats.fees_earned.0 += fee;
        self.stats.volume.0 += volume;
        self.stats.trades += 1;
    }

    fn finish(&mut self) {
        self.assert_invariant();
        self.maybe_snapshot();
    }
}

#[near]
impl Contract {
    /// Buy long units with `amount` of free balance. `account_id` defaults to
    /// the caller. Managers and approved operators may pass it.
    pub fn open_long(&mut self, amount: U128, account_id: Option<AccountId>, min_units: Option<U128>) -> U128 {
        let who = self.resolve_trader(account_id);
        self.accrue();
        U128(self.internal_open_long(&who, amount.0, min_units.map(|v| v.0).unwrap_or(0)))
    }

    /// Sell `units` (all if omitted) back to the pool. Returns USDC credited.
    pub fn close_long(&mut self, units: Option<U128>, account_id: Option<AccountId>, min_out: Option<U128>) -> U128 {
        let who = self.resolve_trader(account_id);
        self.accrue();
        U128(self.internal_close_long(&who, units.map(|v| v.0), min_out.map(|v| v.0).unwrap_or(0)))
    }

    /// Deposit `amount` of free balance into the Curve Short pool. Returns shares.
    pub fn open_short(&mut self, amount: U128, account_id: Option<AccountId>, min_shares: Option<U128>) -> U128 {
        let who = self.resolve_trader(account_id);
        self.accrue();
        U128(self.internal_open_short(&who, amount.0, min_shares.map(|v| v.0).unwrap_or(0)))
    }

    /// Redeem `shares` (all if omitted). Returns USDC credited.
    pub fn close_short(&mut self, shares: Option<U128>, account_id: Option<AccountId>, min_out: Option<U128>) -> U128 {
        let who = self.resolve_trader(account_id);
        self.accrue();
        U128(self.internal_close_short(&who, shares.map(|v| v.0), min_out.map(|v| v.0).unwrap_or(0)))
    }
}
