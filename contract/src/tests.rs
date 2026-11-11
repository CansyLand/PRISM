use crate::oracle::{OracleConfig, PythPrice};
use crate::{Contract, Params};
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::{I64, U128, U64};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId, NearToken, PromiseResult};

const T0: u64 = 1_700_000_000;
const P5: u128 = 5_000_000; // $5.00

fn usd(x: u128) -> u128 {
    x * 1_000_000
}
fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn ctx(who: &str, ts: u64, yocto: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("curve.near"))
        .predecessor_account_id(acc(who))
        .block_timestamp(ts * 1_000_000_000)
        .attached_deposit(NearToken::from_yoctonear(yocto))
        .prepaid_gas(near_sdk::Gas::from_tgas(300))
        .build());
}
fn ctx_with_result(who: &str, ts: u64, r: PromiseResult) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(acc("curve.near"))
            .predecessor_account_id(acc(who))
            .block_timestamp(ts * 1_000_000_000)
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![r]
    );
}

/// Zero fees and a flat 1× funding multiplier so the math is exact. 50% jump guard so we can move the price fast.
fn params() -> Params {
    Params {
        trade_fee_bps: 0,
        funding_fee_bps: 0,
        max_jump_bps: 5_000,
        util_mult_base_bps: 10_000,
        util_mult_slope_bps: 0,
        util_mult_kink_slope_bps: 0,
        ..Params::default()
    }
}

/// Default multiplier: 0.5× at u = 0, 1× at the 50% kink, 4.5× at 100%.
fn util_params() -> Params {
    Params { trade_fee_bps: 0, funding_fee_bps: 0, max_jump_bps: 5_000, ..Params::default() }
}

fn funding_after_one_day(flat: u128, curve: u128, price_after_open: u128) -> (u128, u32) {
    let mut c = setup(util_params());
    deposit(&mut c, "alice.near", usd(flat), T0, "");
    ctx("alice.near", T0, 0);
    c.open_flat(U128(usd(flat)), None, None);
    deposit(&mut c, "bob.near", usd(curve), T0, "");
    ctx("bob.near", T0, 0);
    c.open_curve(U128(usd(curve)), None, None);
    let mut p = P5;
    while p < price_after_open {
        p = (p * 14 / 10).min(price_after_open); // stay inside the 50% jump guard
        push(&mut c, p, T0);
    }
    let mult = c.get_market().funding_multiplier_bps;
    let before = view(&c, "bob.near").curve_value.0;
    push(&mut c, price_after_open, T0 + 86_400);
    (before - view(&c, "bob.near").curve_value.0, mult)
}

#[test]
fn multiplier_curve_matches_spec() {
    let c = setup(util_params());
    assert_eq!(c.util_multiplier_bps(0), 5_000);
    assert_eq!(c.util_multiplier_bps(2_500), 7_500);
    assert_eq!(c.util_multiplier_bps(5_000), 10_000);
    assert_eq!(c.util_multiplier_bps(7_500), 12_500 + 15_000);
    assert_eq!(c.util_multiplier_bps(10_000), 15_000 + 30_000);
}

#[test]
fn scarce_shorts_get_paid_more() {
    // Same $1k long, same price, but less short liquidity → higher utilization → more funding.
    let (deep, m_deep) = funding_after_one_day(20_000, 1_000, P5); // u ≈ 4.8%
    let (thin, m_thin) = funding_after_one_day(2_500, 1_000, P5); // u ≈ 28.6%
    assert!(m_thin > m_deep, "multiplier {m_thin} should exceed {m_deep}");
    assert!(thin > deep, "funding {thin} should exceed {deep}");
}

#[test]
fn rally_past_the_kink_makes_funding_steep() {
    // Open at 33% utilization, then a rally pushes Curve claims to ~65% of the pool.
    let (_, m_open) = funding_after_one_day(2_000, 1_000, P5);
    let (paid, m_rally) = funding_after_one_day(2_000, 1_000, 7_000_000);
    assert!(m_open < 10_000 && m_rally > 15_000, "open {m_open} rally {m_rally}");
    // Fair rate is 0.64/yr; at m > 1.5× one day costs > 0.26% of the (now ~$1,960) claim.
    assert!(paid > 5_000_000, "paid {paid}");
}

fn setup(p: Params) -> Contract {
    ctx("owner.near", T0, 0);
    let mut c = Contract::new(
        acc("owner.near"),
        acc("usdc.near"),
        OracleConfig::Pusher { pusher: acc("pusher.near") },
        U128(P5),
        Some(p),
    );
    push(&mut c, P5, T0);
    c
}
fn push(c: &mut Contract, price: u128, ts: u64) {
    ctx("pusher.near", ts, 0);
    c.push_price(U128(price));
}
fn deposit(c: &mut Contract, who: &str, amount: u128, ts: u64, msg: &str) {
    ctx("usdc.near", ts, 0);
    let _ = c.ft_on_transfer(acc(who), U128(amount), msg.to_string());
}
fn view(c: &Contract, who: &str) -> crate::views::AccountView {
    c.get_account(acc(who)).unwrap()
}
fn approx(a: u128, b: u128, tol: u128) -> bool {
    a.abs_diff(b) <= tol
}
fn solvent(c: &Contract) {
    let s = c.get_solvency();
    assert!(s.ok, "claims {} != treasury {}", s.claims_total.0, s.treasury.0);
}

/// Alice seeds 10k Flat, Bob buys 1k Curve.
fn seeded() -> Contract {
    let mut c = setup(params());
    deposit(&mut c, "alice.near", usd(10_000), T0, "");
    ctx("alice.near", T0, 0);
    c.open_flat(U128(usd(10_000)), None, None);
    deposit(&mut c, "bob.near", usd(1_000), T0, "");
    ctx("bob.near", T0, 0);
    c.open_curve(U128(usd(1_000)), None, None);
    c
}

#[test]
fn curve_value_follows_price_squared() {
    let mut c = seeded();
    assert_eq!(view(&c, "bob.near").curve_value.0, usd(1_000));
    push(&mut c, 5_500_000, T0); // +10% → ×1.21 (same block: no funding)
    let bob = view(&c, "bob.near");
    assert_eq!(bob.curve_value.0, usd(1_210));
    assert_eq!(bob.curve_pnl.0, usd(210) as i128);
    // Flat paid for it, one for one.
    assert_eq!(view(&c, "alice.near").flat_value.0, usd(10_000) - usd(210));
    push(&mut c, 4_500_000, T0); // −10% → ×0.81
    assert_eq!(view(&c, "bob.near").curve_value.0, usd(810));
    assert_eq!(view(&c, "alice.near").flat_value.0, usd(10_190));
    solvent(&c);
}

#[test]
fn funding_shrinks_curve_and_pays_flat() {
    let mut c = seeded();
    let day = T0 + 86_400;
    push(&mut c, P5, day); // a quiet day: same price
    // σ = 80%, p = 2 → 0.64/yr → exp(−0.64/365) ≈ 0.998248
    let bob = view(&c, "bob.near").curve_value.0;
    assert!(approx(bob, 998_248_000, 2_000), "curve after 1 day = {bob}");
    let alice = view(&c, "alice.near").flat_value.0;
    assert_eq!(alice + bob, usd(11_000), "funding is a pure transfer Curve → Flat");
    assert!(c.get_stats().funding_paid.0 > 0);
    solvent(&c);
}

#[test]
fn views_include_pending_funding_without_a_poke() {
    let mut c = seeded();
    ctx("anyone.near", T0 + 86_400, 0);
    let pending = view(&c, "bob.near").curve_value.0;
    c.poke();
    assert_eq!(view(&c, "bob.near").curve_value.0, pending);
}

#[test]
fn round_trip_close_both_sides_and_withdraw() {
    let mut c = seeded();
    push(&mut c, 5_500_000, T0);
    ctx("bob.near", T0, 0);
    let out = c.close_curve(None, None, None);
    assert_eq!(out.0, usd(1_210));
    assert_eq!(view(&c, "bob.near").realized_pnl.0, usd(210) as i128);
    ctx("alice.near", T0, 0);
    let out = c.close_flat(None, None, None);
    assert_eq!(out.0, usd(9_790));
    let m = c.get_market();
    assert_eq!(m.risk_pool.0, 0);
    assert_eq!(m.free_total.0, usd(11_000));
    ctx("bob.near", T0, 1);
    let _ = c.withdraw(U128(usd(1_210)), None, Some(acc("intents.near")), None, Some("bob.near".into()));
    assert_eq!(c.get_market().treasury.0, usd(9_790));
    solvent(&c);
}

#[test]
#[should_panic(expected = "utilization cap: not enough Flat liquidity")]
fn curve_needs_flat_liquidity() {
    let mut c = setup(params());
    deposit(&mut c, "bob.near", usd(100), T0, "");
    ctx("bob.near", T0, 0);
    c.open_curve(U128(usd(100)), None, None);
}

#[test]
#[should_panic(expected = "Flat is locked")]
fn flat_cannot_exit_when_curve_exposure_is_high() {
    let mut c = setup(params());
    deposit(&mut c, "alice.near", usd(1_000), T0, "");
    ctx("alice.near", T0, 0);
    c.open_flat(U128(usd(1_000)), None, None);
    deposit(&mut c, "bob.near", usd(400), T0, "");
    ctx("bob.near", T0, 0);
    c.open_curve(U128(usd(400)), None, None);
    ctx("alice.near", T0, 0);
    c.close_flat(None, None, None);
}

#[test]
fn curve_is_haircut_pro_rata_when_flat_is_wiped() {
    let mut c = setup(params());
    deposit(&mut c, "alice.near", usd(1_000), T0, "");
    ctx("alice.near", T0, 0);
    c.open_flat(U128(usd(1_000)), None, None);
    deposit(&mut c, "bob.near", usd(500), T0, "");
    ctx("bob.near", T0, 0);
    c.open_curve(U128(usd(500)), None, None);
    push(&mut c, 7_500_000, T0);
    push(&mut c, 10_000_000, T0); // 2× → raw claim 2000 > pool 1500
    let m = c.get_market();
    assert_eq!(m.curve_claims_raw.0, usd(2_000));
    assert_eq!(m.curve_claims.0, usd(1_500));
    assert_eq!(m.flat_equity.0, 0);
    ctx("bob.near", T0, 0);
    assert_eq!(c.close_curve(None, None, None).0, usd(1_500));
    solvent(&c);
}

#[test]
fn fees_go_to_protocol_and_owner_can_claim() {
    let mut c = setup(Params { trade_fee_bps: 10, funding_fee_bps: 1_000, max_jump_bps: 5_000, ..Params::default() });
    deposit(&mut c, "alice.near", usd(10_000), T0, "");
    ctx("alice.near", T0, 0);
    c.open_flat(U128(usd(10_000)), None, None);
    deposit(&mut c, "bob.near", usd(1_000), T0, "");
    ctx("bob.near", T0, 0);
    c.open_curve(U128(usd(1_000)), None, None);
    assert_eq!(c.get_market().fees.0, usd(10) + usd(1)); // 10 bps on 10k + 1k
    push(&mut c, P5, T0 + 86_400);
    let m = c.get_market();
    assert!(m.fees.0 > usd(11), "funding fee booked");
    solvent(&c);
    ctx("owner.near", T0 + 86_400, 1);
    let _ = c.claim_fees(U128(usd(11)), acc("treasury.near"));
    solvent(&c);
}

#[test]
fn failed_withdraw_is_refunded() {
    let mut c = setup(params());
    deposit(&mut c, "alice.near", usd(100), T0, "");
    ctx("alice.near", T0, 1);
    let _ = c.withdraw(U128(usd(40)), None, Some(acc("0xdeposit.near")), None, None);
    assert_eq!(view(&c, "alice.near").free.0, usd(60));
    ctx_with_result("curve.near", T0, PromiseResult::Failed);
    let used = c.on_transfer_out(crate::treasury::Payee::Account(acc("alice.near")), U128(usd(40)), false);
    assert_eq!(used.0, 0);
    let a = view(&c, "alice.near");
    assert_eq!(a.free.0, usd(100));
    assert_eq!(a.withdrawn.0, 0);
    solvent(&c);
}

#[test]
fn partial_ft_transfer_call_refund() {
    let mut c = setup(params());
    deposit(&mut c, "alice.near", usd(100), T0, "");
    ctx("alice.near", T0, 1);
    let _ = c.withdraw(U128(usd(40)), None, Some(acc("intents.near")), None, Some("alice.near".into()));
    ctx_with_result("curve.near", T0, PromiseResult::Successful(b"\"30000000\"".to_vec()));
    let used = c.on_transfer_out(crate::treasury::Payee::Account(acc("alice.near")), U128(usd(40)), true);
    assert_eq!(used.0, usd(30));
    assert_eq!(view(&c, "alice.near").free.0, usd(70));
    solvent(&c);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn withdraw_requires_full_access_key() {
    let mut c = setup(params());
    deposit(&mut c, "alice.near", usd(100), T0, "");
    ctx("alice.near", T0, 0);
    let _ = c.withdraw(U128(usd(10)), None, None, None, None);
}

#[test]
fn operator_trades_but_cannot_withdraw_manager_can() {
    let mut c = seeded();
    ctx("bob.near", T0, 0);
    c.approve_operator(acc("bot.near"), None);
    assert_eq!(c.can_act(acc("bot.near"), acc("bob.near")), (true, false));
    ctx("bot.near", T0, 0);
    c.close_curve(Some(U128(usd(100))), Some(acc("bob.near")), None);
    assert_eq!(view(&c, "bob.near").curve_units.0, usd(900));

    // Managed (Telegram) namespace: relayer.near controls *.relayer.near.
    ctx("owner.near", T0, 0);
    c.add_manager(acc("relayer.near"));
    deposit(&mut c, "relayer.near", usd(50), T0, r#"{"receiver_id":"tg-42.relayer.near"}"#);
    ctx("relayer.near", T0, 1);
    let _ = c.withdraw(U128(usd(50)), Some(acc("tg-42.relayer.near")), Some(acc("1click-addr.near")), None, None);
    assert_eq!(view(&c, "tg-42.relayer.near").free.0, 0);
    assert_eq!(c.can_act(acc("relayer.near"), acc("bob.near")), (false, false));
}

#[test]
#[should_panic(expected = "not authorized to withdraw")]
fn operator_withdraw_rejected() {
    let mut c = seeded();
    ctx("bob.near", T0, 0);
    c.approve_operator(acc("bot.near"), None);
    ctx("bot.near", T0, 1);
    let _ = c.withdraw(U128(1), Some(acc("bob.near")), Some(acc("bot.near")), None, None);
}

#[test]
#[should_panic(expected = "not authorized to trade")]
fn stranger_cannot_trade() {
    let mut c = seeded();
    ctx("mallory.near", T0, 0);
    c.close_curve(None, Some(acc("bob.near")), None);
}

#[test]
#[should_panic(expected = "only the configured collateral token")]
fn rejects_foreign_tokens() {
    let mut c = setup(params());
    ctx("fake-usdc.near", T0, 0);
    let _ = c.ft_on_transfer(acc("alice.near"), U128(usd(100)), String::new());
}

#[test]
#[should_panic(expected = "oracle price is stale")]
fn stale_price_blocks_trades() {
    let mut c = seeded();
    ctx("bob.near", T0 + 3_600, 0);
    c.close_curve(None, None, None);
}

#[test]
fn deposit_and_open_in_one_transfer() {
    let mut c = setup(params());
    deposit(&mut c, "alice.near", usd(1_000), T0, r#"{"action":"open_flat"}"#);
    deposit(&mut c, "relayer.near", usd(100), T0, r#"{"receiver_id":"tg-7.relayer.near","action":"open_curve"}"#);
    let a = view(&c, "tg-7.relayer.near");
    assert_eq!(a.free.0, 0);
    assert_eq!(a.curve_value.0, usd(100));
    assert_eq!(view(&c, "alice.near").flat_shares.0, usd(1_000));
    solvent(&c);
}

#[test]
fn previews_match_execution() {
    let mut c = seeded();
    let p = c.preview_open_curve(U128(usd(500)));
    assert!(p.ok);
    deposit(&mut c, "carol.near", usd(500), T0, "");
    ctx("carol.near", T0, 0);
    let units = c.open_curve(U128(usd(500)), None, None);
    assert_eq!(units.0, p.quote.unwrap().out.0);
    let p = c.preview_open_curve(U128(usd(100_000)));
    assert!(!p.ok && p.error.unwrap().contains("utilization"));
}

#[test]
fn pyth_callback_sets_price_and_rejects_bad_data() {
    let mut c = seeded();
    ctx("owner.near", T0, 0);
    c.set_oracle(OracleConfig::Pyth { contract: acc("pyth-oracle.near"), price_id: "c415".into() });
    let px = |price: i64, conf: u64, t: i64| PythPrice { price: I64(price), conf: U64(conf), expo: -8, publish_time: t };
    ctx("curve.near", T0 + 10, 0);
    assert!(c.on_pyth_price(Ok(Some(px(550_000_000, 100_000, (T0 + 8) as i64)))));
    assert_eq!(c.get_market().price.0, 5_500_000);
    // wide confidence (5%) rejected
    assert!(!c.on_pyth_price(Ok(Some(px(560_000_000, 28_000_000, (T0 + 9) as i64)))));
    // not newer
    assert!(!c.on_pyth_price(Ok(Some(px(560_000_000, 100_000, (T0 + 8) as i64)))));
    // stale
    ctx("curve.near", T0 + 1_000, 0);
    assert!(!c.on_pyth_price(Ok(Some(px(560_000_000, 100_000, (T0 + 100) as i64)))));
    assert!(!c.on_pyth_price(Ok(None)));
    assert_eq!(c.get_market().price.0, 5_500_000);
}

#[test]
#[should_panic(expected = "price jump exceeds max_jump_bps")]
fn pusher_jump_guard() {
    let mut c = setup(Params::default());
    push(&mut c, 7_000_000, T0 + 1); // +40% > 20%
}

#[test]
fn snapshots_are_recorded_and_paginated() {
    let mut c = seeded();
    for i in 1..=5u64 {
        push(&mut c, P5, T0 + i * 300);
    }
    let s = c.get_snapshots(None, None);
    assert_eq!(s.len() as u64, c.get_snapshot_count());
    assert!(s.len() >= 5);
    assert!(s.windows(2).all(|w| w[0].ts < w[1].ts));
}
