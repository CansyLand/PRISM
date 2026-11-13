//! Oracle adapter. Swappable source:
//!
//! * `Pyth`: pulls from the Pyth receiver on NEAR (`pyth-oracle.near`).
//!   A keeper first posts a Wormhole-signed Hermes update with
//!   `pyth.update_price_feeds(data)`, then calls `refresh_price()` here. We read
//!   `get_price_unsafe` and apply our own staleness, confidence and
//!   monotonicity checks, so we don't depend on Pyth's stale threshold setting.
//! * `Pusher`: a trusted key with a jump guard. Testnet and demo only.

use crate::events::emit;
use crate::math::BPS;
use crate::{now_secs, Contract, ContractExt, MAX_PRICE};
use near_sdk::json_types::{I64, U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, PromiseError};

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum OracleConfig {
    /// `price_id`: 64-char hex Pyth feed id, no 0x (NEAR/USD = c415de8d…6750).
    Pyth { contract: AccountId, price_id: String },
    Pusher { pusher: AccountId },
}

/// Pyth receiver price struct (JSON).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PythPrice {
    pub price: I64,
    pub conf: U64,
    pub expo: i32,
    pub publish_time: i64,
}

#[ext_contract(ext_pyth)]
#[allow(dead_code)]
pub trait PythReceiver {
    fn get_price_unsafe(&self, price_identifier: String) -> Option<PythPrice>;
}

/// Scale a Pyth `price × 10^expo` value to USDC 6dp.
pub fn pyth_to_6dp(price: i64, expo: i32) -> Option<u128> {
    if price <= 0 || !(-30..=30).contains(&expo) {
        return None;
    }
    let shift = 6 + expo;
    let p = price as u128;
    if shift >= 0 {
        p.checked_mul(10u128.checked_pow(shift as u32)?)
    } else {
        Some(p / 10u128.pow((-shift) as u32))
    }
}

impl Contract {
    /// Accrues funding at the old price, then switches to the new one.
    pub(crate) fn internal_set_price(&mut self, price: u128, ts: u64, source: &str) {
        require!(price > 0 && price <= MAX_PRICE, "price out of range");
        self.accrue(); // funding up to now is priced at the volatility known before this print
        self.update_realized_var(price, ts);
        self.price = price;
        self.price_ts = ts;
        self.write_down_if_capped();
        self.sweep_orphan_equity();
        self.maintain_buckets();
        emit("price", json!({ "price": price.to_string(), "ts": ts, "source": source }));
        self.maybe_snapshot();
    }

    fn reject_price(&self, reason: &str) -> bool {
        emit("price_rejected", json!({ "reason": reason }));
        false
    }
}

#[near]
impl Contract {
    /// Anyone (keeper): pull the latest Pyth price. Returns via `on_pyth_price`.
    pub fn refresh_price(&mut self) -> near_sdk::Promise {
        match &self.oracle {
            OracleConfig::Pyth { contract, price_id } => ext_pyth::ext(contract.clone())
                .with_static_gas(Gas::from_tgas(10))
                .get_price_unsafe(price_id.clone())
                .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(30)).on_pyth_price()),
            OracleConfig::Pusher { .. } => env::panic_str("oracle is in pusher mode"),
        }
    }

    #[private]
    pub fn on_pyth_price(&mut self, #[callback_result] r: Result<Option<PythPrice>, PromiseError>) -> bool {
        let p = match r {
            Ok(Some(p)) => p,
            Ok(None) => return self.reject_price("feed not found"),
            Err(_) => return self.reject_price("pyth call failed"),
        };
        let now = now_secs() as i64;
        if p.publish_time <= 0 || p.publish_time > now + 60 {
            return self.reject_price("bad publish_time");
        }
        let ts = p.publish_time as u64;
        if ts <= self.price_ts {
            return self.reject_price("not newer than stored price");
        }
        if (now - p.publish_time) as u64 > self.params.max_price_age_secs {
            return self.reject_price("stale");
        }
        if p.price.0 <= 0 || (p.conf.0 as u128) * BPS > (p.price.0 as u128) * self.params.max_conf_bps as u128 {
            return self.reject_price("confidence too wide");
        }
        let Some(price) = pyth_to_6dp(p.price.0, p.expo).filter(|v| *v > 0 && *v <= MAX_PRICE) else {
            return self.reject_price("unscalable price");
        };
        self.internal_set_price(price, ts, "pyth");
        true
    }

    /// Pusher mode only (testnet/demo): trusted key, bounded jump vs. a fresh price.
    pub fn push_price(&mut self, price: U128) {
        let OracleConfig::Pusher { pusher } = &self.oracle else {
            env::panic_str("oracle is in pyth mode");
        };
        require!(&env::predecessor_account_id() == pusher, "only the pusher");
        let now = now_secs();
        let fresh = self.price > 0 && now.saturating_sub(self.price_ts) <= self.params.max_price_age_secs;
        if fresh {
            let diff = self.price.abs_diff(price.0);
            require!(diff * BPS <= self.price * self.params.max_jump_bps as u128, "price jump exceeds max_jump_bps");
        }
        self.internal_set_price(price.0, now, "pusher");
    }
}

#[cfg(test)]
mod tests {
    use super::pyth_to_6dp;

    #[test]
    fn scales_pyth_prices() {
        // NEAR at $2.53 with expo -8
        assert_eq!(pyth_to_6dp(253_000_000, -8), Some(2_530_000));
        assert_eq!(pyth_to_6dp(25, -1), Some(2_500_000));
        assert_eq!(pyth_to_6dp(0, -8), None);
        assert_eq!(pyth_to_6dp(-5, -8), None);
    }
}
