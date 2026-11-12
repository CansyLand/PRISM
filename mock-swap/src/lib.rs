//! Testnet-only swap between mock USDC (6 dp) and mock BTC (8 dp) at an oracle price.
//! Stands in for a real DEX so the hedged vault's rebalancing can be tested end to end.
//! The keeper pushes the same price here and to the ledger. Reserves are tracked, so a swap
//! larger than the reserve reverts and the input is refunded by the token.
//!
//! Swap: `ft_transfer_call(swap, amount, msg)` on either token; `msg` is `""` or
//! `{"receiver_id": "...", "min_out": "..."}`. Output goes out with `ft_transfer`.
//! Seeding: the owner sends tokens with `msg = "seed"`.

use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{env, log, near, require, AccountId, Gas, NearToken, PanicOnDefault, PromiseOrValue};

const BTC_UNIT: u128 = 100_000_000; // 1 BTC in raw units (8 dp)
const BPS: u128 = 10_000;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    pusher: AccountId,
    usdc: AccountId,
    btc: AccountId,
    /// USDC (6 dp) per 1 BTC.
    price: u128,
    price_ts: u64,
    fee_bps: u16,
    max_price_age_secs: u64,
    usdc_reserve: u128,
    btc_reserve: u128,
    volume_usdc: u128,
}

#[near(serializers = [json])]
#[derive(Default)]
pub struct SwapMsg {
    pub receiver_id: Option<AccountId>,
    pub min_out: Option<U128>,
}

#[near(serializers = [json])]
pub struct SwapView {
    pub usdc: AccountId,
    pub btc: AccountId,
    pub price: U128,
    pub price_ts: u64,
    pub fee_bps: u16,
    pub usdc_reserve: U128,
    pub btc_reserve: U128,
    pub volume_usdc: U128,
}

fn now() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, pusher: AccountId, usdc: AccountId, btc: AccountId, fee_bps: u16) -> Self {
        require!(fee_bps <= 100, "fee too high");
        Self {
            owner,
            pusher,
            usdc,
            btc,
            price: 0,
            price_ts: 0,
            fee_bps,
            max_price_age_secs: 300,
            usdc_reserve: 0,
            btc_reserve: 0,
            volume_usdc: 0,
        }
    }

    pub fn push_price(&mut self, price: U128) {
        require!(env::predecessor_account_id() == self.pusher, "only the pusher");
        require!(price.0 > 0, "bad price");
        self.price = price.0;
        self.price_ts = now();
    }

    /// Quote: output for `amount` of `token_in` (no state change).
    pub fn quote(&self, token_in: AccountId, amount: U128) -> U128 {
        U128(self.out_for(&token_in, amount.0))
    }

    pub fn get_swap(&self) -> SwapView {
        SwapView {
            usdc: self.usdc.clone(),
            btc: self.btc.clone(),
            price: U128(self.price),
            price_ts: self.price_ts,
            fee_bps: self.fee_bps,
            usdc_reserve: U128(self.usdc_reserve),
            btc_reserve: U128(self.btc_reserve),
            volume_usdc: U128(self.volume_usdc),
        }
    }

    /// Owner: take reserves out (testnet housekeeping).
    #[payable]
    pub fn drain(&mut self, token: AccountId, amount: U128) {
        near_sdk::assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "only owner");
        if token == self.usdc {
            self.usdc_reserve -= amount.0;
        } else {
            require!(token == self.btc, "unknown token");
            self.btc_reserve -= amount.0;
        }
        let _ = ext_ft_core::ext(token)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(10))
            .ft_transfer(self.owner.clone(), amount, None);
    }
}

impl Contract {
    fn out_for(&self, token_in: &AccountId, amount: u128) -> u128 {
        require!(self.price > 0, "no price yet");
        let gross = if *token_in == self.usdc {
            amount * BTC_UNIT / self.price
        } else {
            require!(*token_in == self.btc, "unknown token");
            amount * self.price / BTC_UNIT
        };
        gross * (BPS - self.fee_bps as u128) / BPS
    }
}

#[near]
impl FungibleTokenReceiver for Contract {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        require!(token == self.usdc || token == self.btc, "unsupported token");
        if msg == "seed" {
            require!(sender_id == self.owner, "only the owner seeds");
            if token == self.usdc {
                self.usdc_reserve += amount.0;
            } else {
                self.btc_reserve += amount.0;
            }
            return PromiseOrValue::Value(U128(0));
        }
        require!(now().saturating_sub(self.price_ts) <= self.max_price_age_secs, "swap price is stale");
        let m: SwapMsg = if msg.trim().is_empty() {
            SwapMsg::default()
        } else {
            serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("bad swap msg"))
        };
        let out = self.out_for(&token, amount.0);
        require!(out > 0, "amount too small");
        require!(out >= m.min_out.map(|v| v.0).unwrap_or(0), "slippage: below min_out");
        let token_out = if token == self.usdc {
            require!(out <= self.btc_reserve, "not enough BTC in the swap");
            self.usdc_reserve += amount.0;
            self.btc_reserve -= out;
            self.volume_usdc += amount.0;
            self.btc.clone()
        } else {
            require!(out <= self.usdc_reserve, "not enough USDC in the swap");
            self.btc_reserve += amount.0;
            self.usdc_reserve -= out;
            self.volume_usdc += out;
            self.usdc.clone()
        };
        let receiver = m.receiver_id.unwrap_or(sender_id);
        log!("{}", json!({ "swap": { "in": amount.0.to_string(), "out": out.to_string(), "token_out": token_out, "price": self.price.to_string() } }));
        let _ = ext_ft_core::ext(token_out)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(10))
            .ft_transfer(receiver, U128(out), Some("uprise swap".into()));
        PromiseOrValue::Value(U128(0))
    }
}
