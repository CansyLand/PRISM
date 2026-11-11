//! Treasury: NEP-141 deposits (`ft_on_transfer`), withdrawals with refund
//! callbacks, protocol fee claims, and an on-chain balance audit.
//!
//! Intents wiring:
//! * **Deposit**: the platform relayer, the `intents.near` verifier (an
//!   `ft_withdraw` intent with `msg`), or 1Click calls
//!   `usdc.ft_transfer_call(curve, amount, msg)`, where msg is
//!   `{"receiver_id": "...", "action": "open_curve" | "open_flat", "min_out": "..."}`
//!   (all fields optional; empty msg credits the sender).
//! * **Withdraw**: `withdraw(amount, receiver_id = 1Click deposit address)` does a
//!   plain `ft_transfer`. Alternatively `receiver_id = "intents.near"` with
//!   `msg = "<intents account>"` uses `ft_transfer_call` and credits the
//!   user's balance inside NEAR Intents, from where 1Click routes it to any chain.

use crate::events::emit;
use crate::{Contract, ContractExt};
use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::{I128, U128};
use near_sdk::serde_json::{self, json};
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, Gas, NearToken, PromiseOrValue,
};

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_FT_TRANSFER_CALL: Gas = Gas::from_tgas(80);
const GAS_WITHDRAW_CALLBACK: Gas = Gas::from_tgas(15);
const GAS_BALANCE: Gas = Gas::from_tgas(10);

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DepositAction {
    OpenCurve,
    OpenFlat,
}

#[near(serializers = [json])]
#[derive(Default)]
pub struct DepositMsg {
    pub receiver_id: Option<AccountId>,
    pub action: Option<DepositAction>,
    /// Slippage guard for `action` (min units / min shares).
    pub min_out: Option<U128>,
}

/// Who gets refunded if an outgoing transfer fails.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub enum Payee {
    Account(AccountId),
    Fees,
}

#[near(serializers = [json])]
pub struct AuditResult {
    pub token_balance: U128,
    pub treasury: U128,
    /// token_balance − treasury. Must be ≥ 0 (in-flight withdrawals show as surplus).
    pub surplus: I128,
}

#[near]
impl FungibleTokenReceiver for Contract {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.token, "only the configured collateral token is accepted");
        let m: DepositMsg = if msg.trim().is_empty() {
            DepositMsg::default()
        } else {
            serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("bad deposit msg"))
        };
        // Crediting someone else is safe: the sender can only gift its own tokens.
        let receiver = m.receiver_id.unwrap_or_else(|| sender_id.clone());
        self.accrue();
        self.internal_deposit(&sender_id, &receiver, amount.0);
        // A panic below makes the token refund the whole transfer, so deposit + open is atomic.
        let min = m.min_out.map(|v| v.0).unwrap_or(0);
        match m.action {
            Some(DepositAction::OpenCurve) => {
                self.internal_open_curve(&receiver, amount.0, min);
            }
            Some(DepositAction::OpenFlat) => {
                self.internal_open_flat(&receiver, amount.0, min);
            }
            None => {}
        }
        PromiseOrValue::Value(U128(0))
    }
}

impl Contract {
    pub(crate) fn internal_deposit(&mut self, sender: &AccountId, receiver: &AccountId, amount: u128) {
        require!(amount >= self.params.min_amount.0, "deposit below minimum");
        let mut acc = self.accounts.get(receiver).cloned().unwrap_or_default();
        self.normalize(&mut acc);
        acc.free += amount;
        acc.deposited += amount;
        self.save_account(receiver, acc);
        self.free_total += amount;
        self.treasury += amount;
        emit(
            "deposit",
            json!({ "sender_id": sender, "account_id": receiver, "amount": amount.to_string() }),
        );
        self.assert_invariant();
    }

    fn send(
        &self,
        payee: Payee,
        receiver: AccountId,
        amount: u128,
        memo: Option<String>,
        msg: Option<String>,
    ) -> near_sdk::Promise {
        let is_call = msg.is_some();
        let ft = ext_ft_core::ext(self.token.clone()).with_attached_deposit(NearToken::from_yoctonear(1));
        let p = match msg {
            Some(msg) => ft.with_static_gas(GAS_FT_TRANSFER_CALL).ft_transfer_call(receiver, U128(amount), memo, msg),
            None => ft.with_static_gas(GAS_FT_TRANSFER).ft_transfer(receiver, U128(amount), memo),
        };
        p.then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_WITHDRAW_CALLBACK)
                .on_transfer_out(payee, U128(amount), is_call),
        )
    }
}

#[near]
impl Contract {
    /// Withdraw free balance. Requires 1 yoctoNEAR (a full-access key), so a
    /// leaked bot key can't move funds out. `receiver_id` defaults to the
    /// account. With `msg`, uses `ft_transfer_call` (e.g. into `intents.near`).
    #[payable]
    pub fn withdraw(
        &mut self,
        amount: U128,
        account_id: Option<AccountId>,
        receiver_id: Option<AccountId>,
        memo: Option<String>,
        msg: Option<String>,
    ) -> near_sdk::Promise {
        assert_one_yocto();
        let who = self.resolve_withdrawer(account_id);
        let amount = amount.0;
        require!(amount > 0, "zero amount");
        let mut acc = self.account(&who);
        require!(acc.free >= amount, "insufficient free balance");
        acc.free -= amount;
        acc.withdrawn += amount;
        self.save_account(&who, acc);
        self.free_total -= amount;
        self.treasury -= amount;
        self.assert_invariant();
        let receiver = receiver_id.unwrap_or_else(|| who.clone());
        emit(
            "withdraw",
            json!({
                "account_id": who, "receiver_id": receiver, "amount": amount.to_string(),
                "via": if msg.is_some() { "ft_transfer_call" } else { "ft_transfer" },
            }),
        );
        self.send(Payee::Account(who), receiver, amount, memo, msg)
    }

    /// Owner: send accumulated protocol fees out.
    #[payable]
    pub fn claim_fees(&mut self, amount: U128, receiver_id: AccountId) -> near_sdk::Promise {
        assert_one_yocto();
        self.assert_owner();
        require!(amount.0 > 0 && amount.0 <= self.fees, "bad amount");
        self.fees -= amount.0;
        self.treasury -= amount.0;
        self.assert_invariant();
        emit("claim_fees", json!({ "receiver_id": receiver_id, "amount": amount.0.to_string() }));
        self.send(Payee::Fees, receiver_id, amount.0, None, None)
    }

    /// Restores whatever didn't leave: everything on failure, or the unused
    /// part an `ft_transfer_call` receiver handed back. Returns the amount sent.
    #[private]
    pub fn on_transfer_out(&mut self, payee: Payee, amount: U128, is_call: bool) -> U128 {
        // ft_transfer returns nothing, ft_transfer_call returns a short U128 string.
        let used = match env::promise_result_checked(0, 64) {
            Ok(bytes) if is_call => {
                serde_json::from_slice::<U128>(&bytes).map(|u| u.0.min(amount.0)).unwrap_or(amount.0)
            }
            Ok(_) => amount.0,
            Err(_) => 0,
        };
        let refund = amount.0 - used;
        if refund > 0 {
            match &payee {
                Payee::Account(id) => {
                    let mut acc = self.account(id);
                    acc.free += refund;
                    acc.withdrawn -= refund;
                    self.save_account(id, acc);
                    self.free_total += refund;
                }
                Payee::Fees => self.fees += refund,
            }
            self.treasury += refund;
            emit("transfer_refund", json!({ "payee": payee, "refund": refund.to_string() }));
        }
        U128(used)
    }

    /// Anyone: compares our tracked treasury with the real token balance.
    pub fn audit_treasury(&self) -> near_sdk::Promise {
        ext_ft_core::ext(self.token.clone())
            .with_static_gas(GAS_BALANCE)
            .ft_balance_of(env::current_account_id())
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_BALANCE).on_audit())
    }

    #[private]
    pub fn on_audit(&self, #[callback_unwrap] balance: U128) -> AuditResult {
        let surplus = balance.0 as i128 - self.treasury as i128;
        emit(
            "audit",
            json!({ "token_balance": balance.0.to_string(), "treasury": self.treasury.to_string(), "surplus": surplus.to_string() }),
        );
        AuditResult { token_balance: balance, treasury: U128(self.treasury), surplus: I128(surplus) }
    }
}
