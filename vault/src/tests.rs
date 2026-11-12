use super::*;
use near_sdk::PromiseResult;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const T0: u64 = 1_800_000_000;
const PX: u128 = 100_000_000_000; // $100,000 per BTC, 6 dp

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn usd(v: u128) -> u128 {
    v * 1_000_000
}

fn ctx(who: &str, ts: u64, results: Vec<PromiseResult>) {
    let c = VMContextBuilder::new()
        .current_account_id(acc("vault.near"))
        .predecessor_account_id(acc(who))
        .block_timestamp(ts * 1_000_000_000)
        .build();
    testing_env!(c, near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), results);
}

fn setup() -> Contract {
    ctx("owner.near", T0, vec![]);
    Contract::new(
        acc("owner.near"),
        acc("keeper.near"),
        acc("ledger.near"),
        acc("usdc.near"),
        acc("btc.near"),
        acc("swap.near"),
        U128(usd(1)),
    )
}

fn ok(v: serde_json::Value) -> PromiseResult {
    PromiseResult::Successful(serde_json::to_vec(&v).unwrap())
}

/// Simulate a sync that sees these balances.
fn sync(c: &mut Contract, ts: u64, usdc: u128, btc: u128, free: u128, short_shares: u128, short_value: u128, claims: u128, pool_shares: u128) {
    let account = if short_shares == 0 && free == 0 {
        serde_json::Value::Null
    } else {
        json!({ "free": free.to_string(), "short_shares": short_shares.to_string(), "short_value": short_value.to_string() })
    };
    let market = json!({ "price": PX.to_string(), "price_fresh": true, "power": 3, "long_claims": claims.to_string(), "short_shares": pool_shares.to_string() });
    ctx("vault.near", ts, vec![ok(account), ok(market), ok(json!(usdc.to_string())), ok(json!(btc.to_string()))]);
    c.on_sync();
}

fn deposit(c: &mut Contract, who: &str, amount: u128) {
    ctx("usdc.near", T0, vec![]);
    let _ = c.ft_on_transfer(acc(who), U128(amount), "deposit".into());
}

#[test]
fn deposits_settle_at_the_next_sync_and_later_ones_pay_the_new_price() {
    let mut c = setup();
    deposit(&mut c, "alice.near", usd(1_000));
    assert_eq!(c.get_position(acc("alice.near")).shares.0, 0, "not minted before sync");
    sync(&mut c, T0 + 1, usd(1_000), 0, 0, 0, 0, 0, 0);
    assert_eq!(c.get_position(acc("alice.near")).shares.0, usd(1_000));
    // Vault earns 10%: NAV 1,100. Bob deposits 1,100 → gets 1,000 shares.
    deposit(&mut c, "bob.near", usd(1_100));
    sync(&mut c, T0 + 2, usd(2_200), 0, 0, 0, 0, 0, 0);
    assert_eq!(c.get_position(acc("bob.near")).shares.0, usd(1_000));
    assert_eq!(c.get_position(acc("alice.near")).value.0, usd(1_100));
    assert_eq!(c.get_vault().share_price_e6.0, 1_100_000);
}

#[test]
fn nav_counts_cash_btc_short_and_ledger_free() {
    let mut c = setup();
    deposit(&mut c, "alice.near", usd(10_000));
    sync(&mut c, T0 + 1, usd(10_000), 0, 0, 0, 0, 0, 0);
    // 4,000 cash, 0.02 BTC ($2,000), 3,000 short, 1,000 free in the ledger = 10,000.
    sync(&mut c, T0 + 2, usd(4_000), 2_000_000, usd(1_000), usd(3_000), usd(3_000), usd(200), usd(3_000));
    let v = c.get_vault();
    assert_eq!(v.snapshot.nav.0, usd(10_000));
    // Hedge target = p × claims × our share = 3 × 200 × 100% = 600; we hold 2,000 → over-hedged.
    assert_eq!(v.snapshot.hedge_target_usd.0, usd(600));
    assert_eq!(v.hedge_error_usd.0, (usd(1_400)) as i128);
}

#[test]
fn withdrawals_wait_for_cash_and_keep_their_order() {
    let mut c = setup();
    deposit(&mut c, "alice.near", usd(1_000));
    deposit(&mut c, "bob.near", usd(1_000));
    sync(&mut c, T0 + 1, usd(2_000), 0, 0, 0, 0, 0, 0);
    ctx("alice.near", T0 + 2, vec![]);
    c.request_withdraw(None);
    ctx("bob.near", T0 + 2, vec![]);
    c.request_withdraw(Some(U128(usd(500))));
    // Only 1,200 cash: alice (1,000) is paid, bob (500) waits.
    sync(&mut c, T0 + 3, usd(1_200), 0, 0, usd(800), usd(800), 0, usd(800));
    let v = c.get_vault();
    assert_eq!(v.pending_withdrawals.len(), 1);
    assert_eq!(v.total_withdrawn.0, usd(1_000));
    assert_eq!(c.get_position(acc("alice.near")).shares.0, 0);
    // Next sync with cash: bob is paid.
    sync(&mut c, T0 + 4, usd(1_000), 0, 0, 0, 0, 0, 0);
    assert!(c.get_vault().pending_withdrawals.is_empty());
    assert_eq!(c.get_vault().total_withdrawn.0, usd(1_500));
}

#[test]
#[should_panic(expected = "sync first")]
fn keeper_needs_a_fresh_sync() {
    let mut c = setup();
    deposit(&mut c, "alice.near", usd(1_000));
    sync(&mut c, T0, usd(1_000), 0, 0, 0, 0, 0, 0);
    ctx("keeper.near", T0 + 500, vec![]);
    let _ = c.allocate(U128(usd(100)));
}

#[test]
#[should_panic(expected = "sync first")]
fn one_keeper_action_per_sync() {
    let mut c = setup();
    deposit(&mut c, "alice.near", usd(1_000));
    sync(&mut c, T0, usd(1_000), 0, 0, 0, 0, 0, 0);
    ctx("keeper.near", T0 + 1, vec![]);
    let _ = c.allocate(U128(usd(100)));
    let _ = c.allocate(U128(usd(100)));
}

#[test]
#[should_panic(expected = "buy overshoots the hedge target")]
fn hedge_buys_cannot_overshoot() {
    let mut c = setup();
    deposit(&mut c, "alice.near", usd(10_000));
    sync(&mut c, T0, usd(10_000), 0, 0, usd(5_000), usd(5_000), usd(500), usd(5_000));
    // Target = 3 × 500 = 1,500; buying 3,000 is too much.
    ctx("keeper.near", T0 + 1, vec![]);
    let _ = c.hedge_buy(U128(usd(3_000)));
}

#[test]
fn hedge_buy_within_target_is_allowed() {
    let mut c = setup();
    deposit(&mut c, "alice.near", usd(10_000));
    sync(&mut c, T0, usd(10_000), 0, 0, usd(5_000), usd(5_000), usd(500), usd(5_000));
    ctx("keeper.near", T0 + 1, vec![]);
    let _ = c.hedge_buy(U128(usd(1_500)));
}

#[test]
#[should_panic(expected = "only the keeper")]
fn strangers_cannot_move_funds() {
    let mut c = setup();
    sync(&mut c, T0, usd(1_000), 0, 0, 0, 0, 0, 0);
    ctx("mallory.near", T0 + 1, vec![]);
    let _ = c.allocate(U128(usd(100)));
}

#[test]
#[should_panic(expected = "only USDC deposits")]
fn rejects_other_tokens() {
    let mut c = setup();
    ctx("btc.near", T0, vec![]);
    let _ = c.ft_on_transfer(acc("alice.near"), U128(1_000), "deposit".into());
}

#[test]
fn failed_sync_marks_snapshot_stale() {
    let mut c = setup();
    ctx("vault.near", T0, vec![PromiseResult::Failed, PromiseResult::Failed, PromiseResult::Failed, PromiseResult::Failed]);
    c.on_sync();
    assert!(!c.get_vault().fresh);
}
