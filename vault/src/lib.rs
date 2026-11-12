//! Uprise hedged vault ("Crab"): the Curve Short side, delta-hedged with BTC.
//!
//! Yield hunters deposit USDC and get vault shares. The vault is an ordinary account in the
//! Uprise ledger: it opens Curve Short with part of its cash and holds `p × long claims` worth of
//! BTC (pro rata to its share of the short pool) so a BTC move barely changes its value. What is
//! left is the funding that Curve Long pays.
//!
//! Pricing: deposits and withdrawals are queued and settle at the next `sync()`, which reads the
//! ledger position, the market and both token balances in one round trip. Nobody can deposit at a
//! stale price. `sync()` is permissionless; a keeper calls it every few seconds.
//!
//! Keeper actions (`allocate`, `deallocate`, `pull`, `hedge_buy`, `hedge_sell`) need a fresh sync
//! and are bounded by it: the hedge can only move toward its target, cash can only move between
//! the vault, the ledger and the swap. The keeper can't send funds anywhere else.

use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::{I128, U128};
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    PromiseOrValue,
};

const BTC_UNIT: u128 = 100_000_000;
const MAX_QUEUE: usize = 40;
const GAS_VIEW: Gas = Gas::from_tgas(10);
const GAS_FT: Gas = Gas::from_tgas(10);
const GAS_FT_CALL: Gas = Gas::from_tgas(60);
const GAS_LEDGER: Gas = Gas::from_tgas(30);
const GAS_ON_SYNC: Gas = Gas::from_tgas(120);
const GAS_ON_PAID: Gas = Gas::from_tgas(5);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Shares,
    Owed,
}

/// Subset of the ledger's `AccountView` we need.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct LedgerAccount {
    free: U128,
    short_shares: U128,
    short_value: U128,
}

/// Subset of the ledger's `MarketView`.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct LedgerMarket {
    price: U128,
    price_fresh: bool,
    power: u8,
    long_claims: U128,
    short_shares: U128,
}

#[ext_contract(ext_ledger)]
#[allow(dead_code)]
trait Ledger {
    fn get_account(&self, account_id: AccountId) -> Option<serde_json::Value>;
    fn get_market(&self) -> serde_json::Value;
    fn close_short(&mut self, shares: Option<U128>, account_id: Option<AccountId>, min_out: Option<U128>) -> U128;
    fn withdraw(
        &mut self,
        amount: U128,
        account_id: Option<AccountId>,
        receiver_id: Option<AccountId>,
        memo: Option<String>,
        msg: Option<String>,
    );
}

#[ext_contract(ext_self)]
#[allow(dead_code)]
trait SelfCallbacks {
    fn on_sync(&mut self);
    fn on_paid(&mut self, account_id: AccountId, amount: U128);
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Default, Debug)]
pub struct Snapshot {
    pub ts: u64,
    /// USDC held by the vault itself (includes queued deposits).
    pub usdc: U128,
    /// BTC held as the hedge (8 dp).
    pub btc: U128,
    /// Ledger oracle price, USDC 6 dp per BTC.
    pub price: U128,
    pub power: u8,
    /// Vault's Curve Short value and its free balance inside the ledger.
    pub short_value: U128,
    pub short_shares: U128,
    pub ledger_free: U128,
    /// Hedge target: p × long claims × our share of the short pool, in USDC.
    pub hedge_target_usd: U128,
    /// Total value after this sync's deposits and withdrawals.
    pub nav: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Pending {
    pub account_id: AccountId,
    pub amount: U128,
}

#[near(serializers = [json])]
pub struct VaultView {
    pub ledger: AccountId,
    pub usdc: AccountId,
    pub btc: AccountId,
    pub swap: AccountId,
    pub keeper: AccountId,
    pub total_shares: U128,
    /// USDC (6 dp) per 1e6 shares, i.e. the share price.
    pub share_price_e6: U128,
    pub snapshot: Snapshot,
    pub snapshot_age_secs: u64,
    pub fresh: bool,
    pub hedge_btc_value: U128,
    /// Hedge value minus target (USDC): positive = over-hedged.
    pub hedge_error_usd: I128,
    pub pending_deposits: Vec<Pending>,
    pub pending_withdrawals: Vec<Pending>,
    pub total_deposited: U128,
    pub total_withdrawn: U128,
    pub syncs: u64,
}

#[near(serializers = [json])]
pub struct PositionView {
    pub account_id: AccountId,
    pub shares: U128,
    pub value: U128,
    pub pending_deposit: U128,
    pub pending_withdraw_shares: U128,
    pub owed: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    keeper: AccountId,
    ledger: AccountId,
    usdc: AccountId,
    btc: AccountId,
    swap: AccountId,
    total_shares: u128,
    shares: LookupMap<AccountId, u128>,
    /// Payouts that failed (receiver not registered on the token); claim with `claim_owed`.
    owed: LookupMap<AccountId, u128>,
    owed_total: u128,
    deposits: Vec<Pending>,
    /// Withdrawal requests, amount in shares (already removed from the holder's balance).
    withdrawals: Vec<Pending>,
    snap: Snapshot,
    /// False after any keeper action until the next sync.
    snap_valid: bool,
    max_snapshot_age_secs: u64,
    min_deposit: u128,
    total_deposited: u128,
    total_withdrawn: u128,
    syncs: u64,
}

fn now() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    // a·b fits in u128 for USDC/BTC amounts used here (≤ 1e30); checked so it reverts otherwise.
    a.checked_mul(b).unwrap_or_else(|| env::panic_str("overflow")) / c
}

fn result_json<T: for<'de> Deserialize<'de>>(i: u64) -> Option<T> {
    match env::promise_result_checked(i, 64 * 1024) {
        Ok(bytes) => serde_json::from_slice(&bytes).ok(),
        Err(_) => None,
    }
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        owner: AccountId,
        keeper: AccountId,
        ledger: AccountId,
        usdc: AccountId,
        btc: AccountId,
        swap: AccountId,
        min_deposit: U128,
    ) -> Self {
        Self {
            owner,
            keeper,
            ledger,
            usdc,
            btc,
            swap,
            total_shares: 0,
            shares: LookupMap::new(Key::Shares),
            owed: LookupMap::new(Key::Owed),
            owed_total: 0,
            deposits: vec![],
            withdrawals: vec![],
            snap: Snapshot::default(),
            snap_valid: false,
            max_snapshot_age_secs: 120,
            min_deposit: min_deposit.0,
            total_deposited: 0,
            total_withdrawn: 0,
            syncs: 0,
        }
    }

    // ── users ──

    /// Queue a withdrawal of `shares` (all if omitted). Paid in USDC at the next sync that has
    /// enough cash; the keeper frees cash from the ledger if needed.
    pub fn request_withdraw(&mut self, shares: Option<U128>) {
        let who = env::predecessor_account_id();
        let have = self.shares.get(&who).copied().unwrap_or(0);
        let amount = shares.map(|s| s.0).unwrap_or(have);
        require!(amount > 0 && amount <= have, "not enough shares");
        require!(self.withdrawals.len() < MAX_QUEUE, "withdrawal queue is full, try again in a minute");
        self.shares.insert(who.clone(), have - amount);
        self.withdrawals.push(Pending { account_id: who.clone(), amount: U128(amount) });
        emit("withdraw_requested", json!({ "account_id": who, "shares": amount.to_string() }));
    }

    /// Pay out a payout that failed earlier.
    pub fn claim_owed(&mut self) {
        let who = env::predecessor_account_id();
        let amount = self.owed.remove(&who).unwrap_or(0);
        require!(amount > 0, "nothing owed");
        self.owed_total -= amount;
        self.pay(who, amount);
    }

    // ── sync: read everything, settle the queues ──

    pub fn sync(&mut self) -> near_sdk::Promise {
        let me = env::current_account_id();
        ext_ledger::ext(self.ledger.clone())
            .with_static_gas(GAS_VIEW)
            .get_account(me.clone())
            .and(ext_ledger::ext(self.ledger.clone()).with_static_gas(GAS_VIEW).get_market())
            .and(ext_ft_core::ext(self.usdc.clone()).with_static_gas(GAS_VIEW).ft_balance_of(me.clone()))
            .and(ext_ft_core::ext(self.btc.clone()).with_static_gas(GAS_VIEW).ft_balance_of(me.clone()))
            .then(ext_self::ext(me).with_static_gas(GAS_ON_SYNC).on_sync())
    }

    #[private]
    pub fn on_sync(&mut self) {
        let acc: Option<Option<LedgerAccount>> = result_json(0);
        let market: Option<LedgerMarket> = result_json(1);
        let usdc: Option<U128> = result_json(2);
        let btc: Option<U128> = result_json(3);
        let (Some(acc), Some(m), Some(usdc), Some(btc)) = (acc, market, usdc, btc) else {
            self.snap_valid = false;
            log!("sync failed: a view call did not return");
            return;
        };
        require!(m.price.0 > 0, "ledger has no price");
        let (free, our_shares, short_value) =
            acc.map(|a| (a.free.0, a.short_shares.0, a.short_value.0)).unwrap_or((0, 0, 0));
        let price = m.price.0;
        // Tokens owed to people (failed payouts) still sit in our USDC balance.
        let mut cash = usdc.0.saturating_sub(self.owed_total);
        let btc_value = mul_div(btc.0, price, BTC_UNIT);
        let queued: u128 = self.deposits.iter().map(|d| d.amount.0).sum();
        let nav_before = (cash + btc_value + short_value + free).saturating_sub(queued);
        // Mint queued deposits at the pre-deposit price.
        let deposits = std::mem::take(&mut self.deposits);
        let mut nav = nav_before;
        for d in deposits {
            let minted = if self.total_shares == 0 || nav == 0 {
                d.amount.0 // first deposit (or a fully wiped vault): 1 share = 1 USDC raw unit
            } else {
                mul_div(d.amount.0, self.total_shares, nav)
            };
            let had = self.shares.get(&d.account_id).copied().unwrap_or(0);
            self.shares.insert(d.account_id.clone(), had + minted);
            self.total_shares += minted;
            nav += d.amount.0;
            self.total_deposited += d.amount.0;
            emit("deposited", json!({ "account_id": d.account_id, "amount": d.amount, "shares": minted.to_string() }));
        }
        // Pay withdrawals in order while there is cash; the rest waits for the keeper.
        let withdrawals = std::mem::take(&mut self.withdrawals);
        let mut waiting = vec![];
        for w in withdrawals {
            let value = if self.total_shares == 0 { 0 } else { mul_div(w.amount.0, nav, self.total_shares) };
            if !waiting.is_empty() || value > cash {
                waiting.push(w);
                continue;
            }
            self.total_shares -= w.amount.0;
            nav -= value;
            cash -= value;
            self.total_withdrawn += value;
            emit("withdrawn", json!({ "account_id": w.account_id, "shares": w.amount, "amount": value.to_string() }));
            if value > 0 {
                self.pay(w.account_id, value);
            }
        }
        self.withdrawals = waiting;
        let hedge_target = if m.short_shares.0 == 0 {
            0
        } else {
            mul_div(mul_div(m.long_claims.0, our_shares, m.short_shares.0), m.power as u128, 1)
        };
        self.snap = Snapshot {
            ts: now(),
            usdc: U128(cash),
            btc: btc,
            price: m.price,
            power: m.power,
            short_value: U128(short_value),
            short_shares: U128(our_shares),
            ledger_free: U128(free),
            hedge_target_usd: U128(hedge_target),
            nav: U128(nav),
        };
        self.snap_valid = m.price_fresh;
        self.syncs += 1;
    }

    #[private]
    pub fn on_paid(&mut self, account_id: AccountId, amount: U128) {
        if !matches!(env::promise_result_checked(0, 0), Ok(_)) {
            let had = self.owed.get(&account_id).copied().unwrap_or(0);
            self.owed.insert(account_id.clone(), had + amount.0);
            self.owed_total += amount.0;
            emit("payout_failed", json!({ "account_id": account_id, "amount": amount }));
        }
    }

    // ── keeper actions, each bounded by the last sync ──

    /// Move `amount` of vault cash into the ledger as Curve Short.
    pub fn allocate(&mut self, amount: U128) -> near_sdk::Promise {
        self.keeper_step();
        let queued: u128 = self.deposits.iter().map(|d| d.amount.0).sum();
        require!(amount.0 > 0 && amount.0 <= self.snap.usdc.0 + queued, "more than the vault's cash");
        ext_ft_core::ext(self.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_CALL)
            .ft_transfer_call(self.ledger.clone(), amount, None, r#"{"action":"open_short"}"#.into())
    }

    /// Close `shares` of the vault's Curve Short (USDC lands in its ledger free balance).
    pub fn deallocate(&mut self, shares: U128) -> near_sdk::Promise {
        self.keeper_step();
        require!(shares.0 > 0 && shares.0 <= self.snap.short_shares.0, "more than the vault's short shares");
        ext_ledger::ext(self.ledger.clone()).with_static_gas(GAS_LEDGER).close_short(Some(shares), None, None)
    }

    /// Bring `amount` of free ledger balance back to the vault.
    pub fn pull(&mut self, amount: U128) -> near_sdk::Promise {
        self.keeper_step();
        require!(amount.0 > 0 && amount.0 <= self.snap.ledger_free.0, "more than the vault's free ledger balance");
        ext_ledger::ext(self.ledger.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_CALL)
            .withdraw(amount, None, None, None, None)
    }

    /// Buy BTC with `usdc_amount`; only allowed while the hedge is below target.
    pub fn hedge_buy(&mut self, usdc_amount: U128) -> near_sdk::Promise {
        self.keeper_step();
        let have = mul_div(self.snap.btc.0, self.snap.price.0, BTC_UNIT);
        let target = self.snap.hedge_target_usd.0;
        require!(have < target, "hedge is already at or above target");
        require!(usdc_amount.0 <= (target - have) * 105 / 100 + 1_000_000, "buy overshoots the hedge target");
        require!(usdc_amount.0 <= self.snap.usdc.0, "more than the vault's cash");
        let min_btc = mul_div(usdc_amount.0, BTC_UNIT, self.snap.price.0) * 98 / 100;
        ext_ft_core::ext(self.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_CALL)
            .ft_transfer_call(self.swap.clone(), usdc_amount, None, json!({ "min_out": U128(min_btc) }).to_string())
    }

    /// Sell `btc_amount` of BTC; only allowed while the hedge is above target.
    pub fn hedge_sell(&mut self, btc_amount: U128) -> near_sdk::Promise {
        self.keeper_step();
        let have = mul_div(self.snap.btc.0, self.snap.price.0, BTC_UNIT);
        let target = self.snap.hedge_target_usd.0;
        require!(have > target, "hedge is already at or below target");
        let value = mul_div(btc_amount.0, self.snap.price.0, BTC_UNIT);
        require!(value <= (have - target) * 105 / 100 + 1_000_000, "sell overshoots the hedge target");
        require!(btc_amount.0 <= self.snap.btc.0, "more BTC than the vault holds");
        let min_usdc = value * 98 / 100;
        ext_ft_core::ext(self.btc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_CALL)
            .ft_transfer_call(self.swap.clone(), btc_amount, None, json!({ "min_out": U128(min_usdc) }).to_string())
    }

    // ── owner ──

    pub fn set_keeper(&mut self, keeper: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "only owner");
        self.keeper = keeper;
    }

    pub fn set_max_snapshot_age(&mut self, secs: u64) {
        require!(env::predecessor_account_id() == self.owner, "only owner");
        require!((10..=3_600).contains(&secs), "10..=3600");
        self.max_snapshot_age_secs = secs;
    }

    // ── views ──

    pub fn get_vault(&self) -> VaultView {
        let s = &self.snap;
        let hedge_value = if s.price.0 == 0 { 0 } else { mul_div(s.btc.0, s.price.0, BTC_UNIT) };
        let age = now().saturating_sub(s.ts);
        VaultView {
            ledger: self.ledger.clone(),
            usdc: self.usdc.clone(),
            btc: self.btc.clone(),
            swap: self.swap.clone(),
            keeper: self.keeper.clone(),
            total_shares: U128(self.total_shares),
            share_price_e6: U128(if self.total_shares == 0 { 1_000_000 } else { mul_div(s.nav.0, 1_000_000, self.total_shares) }),
            snapshot: s.clone(),
            snapshot_age_secs: age,
            fresh: self.snap_valid && age <= self.max_snapshot_age_secs,
            hedge_btc_value: U128(hedge_value),
            hedge_error_usd: I128(hedge_value as i128 - s.hedge_target_usd.0 as i128),
            pending_deposits: self.deposits.clone(),
            pending_withdrawals: self.withdrawals.clone(),
            total_deposited: U128(self.total_deposited),
            total_withdrawn: U128(self.total_withdrawn),
            syncs: self.syncs,
        }
    }

    pub fn get_position(&self, account_id: AccountId) -> PositionView {
        let shares = self.shares.get(&account_id).copied().unwrap_or(0);
        let value = if self.total_shares == 0 { 0 } else { mul_div(shares, self.snap.nav.0, self.total_shares) };
        let pending_deposit = self.deposits.iter().filter(|d| d.account_id == account_id).map(|d| d.amount.0).sum::<u128>();
        let pending_w = self.withdrawals.iter().filter(|d| d.account_id == account_id).map(|d| d.amount.0).sum::<u128>();
        PositionView {
            account_id: account_id.clone(),
            shares: U128(shares),
            value: U128(value),
            pending_deposit: U128(pending_deposit),
            pending_withdraw_shares: U128(pending_w),
            owed: U128(self.owed.get(&account_id).copied().unwrap_or(0)),
        }
    }
}

impl Contract {
    fn keeper_step(&mut self) {
        let caller = env::predecessor_account_id();
        require!(caller == self.keeper || caller == self.owner, "only the keeper");
        require!(self.snap_valid && now().saturating_sub(self.snap.ts) <= self.max_snapshot_age_secs, "sync first");
        // One action per sync, so every bound is checked against fresh numbers.
        self.snap_valid = false;
    }

    fn pay(&self, account_id: AccountId, amount: u128) {
        let _ = ext_ft_core::ext(self.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT)
            .ft_transfer(account_id.clone(), U128(amount), Some("uprise vault".into()))
            .then(ext_self::ext(env::current_account_id()).with_static_gas(GAS_ON_PAID).on_paid(account_id, U128(amount)));
    }
}

#[near]
impl FungibleTokenReceiver for Contract {
    /// USDC with `msg = ""` or `"deposit"` queues a deposit for the sender. Swap proceeds and
    /// everything else arrive by plain `ft_transfer` and are picked up by `sync`.
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.usdc, "only USDC deposits");
        require!(msg.is_empty() || msg == "deposit", "unknown msg");
        require!(amount.0 >= self.min_deposit, "deposit below minimum");
        require!(self.deposits.len() < MAX_QUEUE, "deposit queue is full, try again in a minute");
        self.deposits.push(Pending { account_id: sender_id.clone(), amount });
        emit("deposit_queued", json!({ "account_id": sender_id, "amount": amount }));
        PromiseOrValue::Value(U128(0))
    }
}

fn emit(event: &str, data: serde_json::Value) {
    log!("EVENT_JSON:{}", json!({ "standard": "uprise-vault", "version": "1.0.0", "event": event, "data": [data] }));
}

#[cfg(test)]
mod tests;
