//! Owner controls, each one bounded. The owner can't touch balances, block
//! closes, or block withdrawals. `open_paused` only stops new opens.
//! Account-level operator approvals live here too.

use crate::events::emit;
use crate::oracle::OracleConfig;
use crate::{Contract, ContractExt, Params, MAX_OPERATORS};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId};

pub fn validate_params(p: &Params) {
    require!((1..=4).contains(&p.power), "power must be 1..=4");
    require!(p.implied_vol_bps <= 50_000, "implied_vol_bps > 500%");
    require!(p.base_funding_bps <= 10_000, "base_funding_bps > 100%/yr");
    require!(p.util_mult_base_bps <= 20_000, "util_mult_base_bps > 2×");
    require!(p.util_mult_slope_bps <= 50_000, "util_mult_slope_bps > 5×");
    require!((1_000..=9_500).contains(&p.util_kink_bps), "util_kink_bps must be 1000..=9500");
    require!(p.util_mult_kink_slope_bps <= 200_000, "util_mult_kink_slope_bps > 20×");
    require!(
        p.util_mult_base_bps > 0 || p.util_mult_slope_bps > 0,
        "funding multiplier can't be zero at every utilization"
    );
    require!(p.funding_fee_bps <= 5_000, "funding_fee_bps > 50%");
    require!(p.trade_fee_bps <= 100, "trade_fee_bps > 1%");
    require!((100..=9_000).contains(&p.max_util_bps), "max_util_bps must be 100..=9000");
    require!((5..=3_600).contains(&p.max_price_age_secs), "max_price_age_secs must be 5..=3600");
    require!(p.max_conf_bps <= 1_000, "max_conf_bps > 10%");
    require!(p.max_jump_bps <= 5_000, "max_jump_bps > 50%");
    require!(p.min_amount.0 >= 1, "min_amount must be > 0");
    require!(p.snapshot_interval_secs >= 1, "snapshot_interval_secs must be > 0");
}

impl Contract {
    pub(crate) fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }
}

#[near]
impl Contract {
    pub fn set_params(&mut self, params: Params) {
        self.assert_owner();
        validate_params(&params);
        require!(
            params.power == self.params.power || self.total_units == 0,
            "power can't change while Curve units exist"
        );
        self.accrue(); // book funding at the old rate first
        self.params = params.clone();
        emit("set_params", json!({ "params": params }));
    }

    pub fn set_oracle(&mut self, oracle: OracleConfig) {
        self.assert_owner();
        self.accrue();
        self.oracle = oracle.clone();
        emit("set_oracle", json!({ "oracle": oracle }));
    }

    pub fn set_open_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.open_paused = paused;
        emit("set_open_paused", json!({ "paused": paused }));
    }

    /// A manager controls every `*.manager` account (custodial, for the
    /// Telegram/relayer namespace), including withdrawals.
    pub fn add_manager(&mut self, manager: AccountId) {
        self.assert_owner();
        self.managers.insert(manager.clone());
        emit("add_manager", json!({ "manager": manager }));
    }

    pub fn remove_manager(&mut self, manager: AccountId) {
        self.assert_owner();
        self.managers.remove(&manager);
        emit("remove_manager", json!({ "manager": manager }));
    }

    pub fn set_owner(&mut self, owner: AccountId) {
        self.assert_owner();
        emit("set_owner", json!({ "old": self.owner, "new": owner }));
        self.owner = owner;
    }

    /// Let a bot trade (never withdraw) for `account_id` (default: caller).
    pub fn approve_operator(&mut self, operator: AccountId, account_id: Option<AccountId>) {
        let who = self.resolve_withdrawer(account_id);
        let mut acc = self.account(&who);
        if !acc.operators.contains(&operator) {
            require!(acc.operators.len() < MAX_OPERATORS, "too many operators");
            acc.operators.push(operator.clone());
        }
        self.save_account(&who, acc);
        emit("approve_operator", json!({ "account_id": who, "operator": operator }));
    }

    pub fn revoke_operator(&mut self, operator: AccountId, account_id: Option<AccountId>) {
        let who = self.resolve_withdrawer(account_id);
        let mut acc = self.account(&who);
        acc.operators.retain(|o| o != &operator);
        self.save_account(&who, acc);
        emit("revoke_operator", json!({ "account_id": who, "operator": operator }));
    }
}
