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
        acc("asset.near"),
        8,
        acc("swap.near"),
        Venue::Mock,
        U128(usd(1)),
    )
}

fn ok(v: serde_json::Value) -> PromiseResult {
    PromiseResult::Successful(serde_json::to_vec(&v).unwrap())
}

/// Simulate a sync that sees these balances. `delta` is the ledger's Σ p · C_eff,p over all buckets.
fn sync(c: &mut Contract, ts: u64, usdc: u128, asset: u128, free: u128, short_shares: u128, short_value: u128, delta: u128, pool_shares: u128) {
    let account = if short_shares == 0 && free == 0 {
        serde_json::Value::Null
    } else {
        json!({ "free": free.to_string(), "short_shares": short_shares.to_string(), "short_value": short_value.to_string() })
    };
    let market = json!({ "price": PX.to_string(), "price_fresh": true, "long_claims": "0", "delta_claims": delta.to_string(), "short_shares": pool_shares.to_string() });
    ctx("vault.near", ts, vec![ok(account), ok(market), ok(json!(usdc.to_string())), ok(json!(asset.to_string()))]);
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
    sync(&mut c, T0 + 2, usd(4_000), 2_000_000, usd(1_000), usd(3_000), usd(3_000), usd(600), usd(3_000));
    let v = c.get_vault();
    assert_eq!(v.snapshot.nav.0, usd(10_000));
    // Hedge target = delta_claims × our share = 600 × 100%; we hold 2,000 → over-hedged.
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
    sync(&mut c, T0, usd(10_000), 0, 0, usd(5_000), usd(5_000), usd(1_500), usd(5_000));
    // Target = delta 1,500 × 100%; buying 3,000 is too much.
    ctx("keeper.near", T0 + 1, vec![]);
    let _ = c.hedge_buy(U128(usd(3_000)));
}

#[test]
fn hedge_buy_within_target_is_allowed() {
    let mut c = setup();
    deposit(&mut c, "alice.near", usd(10_000));
    sync(&mut c, T0, usd(10_000), 0, 0, usd(5_000), usd(5_000), usd(1_500), usd(5_000));
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
    ctx("asset.near", T0, vec![]);
    let _ = c.ft_on_transfer(acc("alice.near"), U128(1_000), "deposit".into());
}

#[test]
fn failed_sync_marks_snapshot_stale() {
    let mut c = setup();
    ctx("vault.near", T0, vec![PromiseResult::Failed, PromiseResult::Failed, PromiseResult::Failed, PromiseResult::Failed]);
    c.on_sync();
    assert!(!c.get_vault().fresh);
}

#[test]
fn ref_dcl_swap_message_names_pool_and_min_out() {
    let mut c = setup();
    c.venue = Venue::RefDcl { pool_id: "usdc.near|wrap.near|100".into() };
    let m = c.swap_msg(&acc("usdc.near"), 1234);
    assert_eq!(m, r#"{"Swap":{"pool_ids":["usdc.near|wrap.near|100"],"output_token":"usdc.near","min_output_amount":"1234"}}"#);
}

#[test]
fn wnear_decimals_do_not_overflow() {
    // 1,000,000 wNEAR (24 dp) at $3.60: value = 3.6M USDC.
    assert_eq!(mul_div(1_000_000 * 10u128.pow(24), 3_600_000, 10u128.pow(24)), 3_600_000_000_000);
}

// ── bucketed ledger: the hedge follows delta_claims, not one power ──

/// Ledger with x¹ $1,000, x³ $200 and x¹⁰ $50 of claims: delta = 1,000 + 600 + 500 = 2,100.
const MIXED_DELTA: u128 = 2_100_000_000;

#[test]
fn hedge_target_is_delta_claims_times_our_share() {
    let mut c = setup();
    deposit(&mut c, "alice.near", usd(10_000));
    sync(&mut c, T0, usd(10_000), 0, 0, 0, 0, 0, 0);
    // We own 3,000 of 4,000 pool shares (75%).
    sync(&mut c, T0 + 1, usd(7_000), 0, 0, usd(3_000), usd(3_000), MIXED_DELTA, usd(4_000));
    let v = c.get_vault();
    assert_eq!(v.snapshot.hedge_target_usd.0, usd(1_575));
    assert_eq!(v.snapshot.delta_claims.0, MIXED_DELTA);
    assert_eq!(v.hedge_error_usd.0, -(usd(1_575) as i128));
}

#[test]
fn no_short_shares_means_no_hedge() {
    let mut c = setup();
    deposit(&mut c, "alice.near", usd(1_000));
    sync(&mut c, T0, usd(1_000), 0, 0, 0, 0, MIXED_DELTA, 0);
    assert_eq!(c.get_vault().snapshot.hedge_target_usd.0, 0);
}

#[test]
fn hedge_sell_when_delta_shrinks() {
    // Longs closed (or melted): delta fell to 100 while we still hold $1,000 of the asset.
    let mut c = setup();
    deposit(&mut c, "alice.near", usd(10_000));
    sync(&mut c, T0, usd(9_000), 1_000_000, 0, usd(5_000), usd(5_000), usd(100), usd(5_000));
    ctx("keeper.near", T0 + 1, vec![]);
    let _ = c.hedge_sell(U128(900_000)); // 0.009 BTC = $900 → back to target
}

#[test]
#[should_panic(expected = "sell overshoots the hedge target")]
fn hedge_sell_cannot_overshoot() {
    let mut c = setup();
    deposit(&mut c, "alice.near", usd(10_000));
    sync(&mut c, T0, usd(9_000), 1_000_000, 0, usd(5_000), usd(5_000), usd(900), usd(5_000));
    ctx("keeper.near", T0 + 1, vec![]);
    let _ = c.hedge_sell(U128(1_000_000)); // selling all $1,000 when only $100 is excess
}

#[test]
#[should_panic(expected = "hedge is already at or above target")]
fn no_buys_when_at_target() {
    let mut c = setup();
    deposit(&mut c, "alice.near", usd(10_000));
    // $2,100 of BTC held, target 2,100.
    sync(&mut c, T0, usd(7_900), 2_100_000, 0, usd(5_000), usd(5_000), MIXED_DELTA, usd(5_000));
    ctx("keeper.near", T0 + 1, vec![]);
    let _ = c.hedge_buy(U128(usd(10)));
}

#[test]
fn huge_delta_does_not_overflow() {
    // x¹⁰ claims of $1B → delta $10B, our share 1 of 3 shares.
    let mut c = setup();
    deposit(&mut c, "alice.near", usd(1_000));
    sync(&mut c, T0, usd(1_000), 0, 0, 1, 1, usd(10_000_000_000), 3);
    assert_eq!(c.get_vault().snapshot.hedge_target_usd.0, usd(10_000_000_000) / 3);
}

#[test]
fn ledger_market_view_parses_with_extra_bucket_fields() {
    // The real get_market carries buckets and many other fields; the vault reads only what it needs.
    let mut c = setup();
    deposit(&mut c, "alice.near", usd(1_000));
    sync(&mut c, T0, usd(1_000), 0, 0, 0, 0, 0, 0);
    let market = json!({
        "price": PX.to_string(), "price_fresh": true, "long_claims": "5", "delta_claims": usd(300).to_string(),
        "short_shares": usd(1_000).to_string(), "utilization_bps": 1234,
        "buckets": [{ "power": 1, "claims": "5" }, { "power": 10, "claims": "0" }],
    });
    let account = json!({ "free": "0", "short_shares": usd(500).to_string(), "short_value": usd(500).to_string(), "longs": [] });
    ctx("vault.near", T0 + 1, vec![ok(account), ok(market), ok(json!(usd(500).to_string())), ok(json!("0"))]);
    c.on_sync();
    let v = c.get_vault();
    assert!(v.fresh);
    assert_eq!(v.snapshot.hedge_target_usd.0, usd(150));
}
