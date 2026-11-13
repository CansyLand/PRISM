use crate::math::{BPS, ONE};
use crate::oracle::{OracleConfig, PythPrice};
use crate::{Contract, Params, BUCKETS, DEFAULT_CAP_BPS, DEFAULT_FUNDING_MULT_BPS, UV_HI, UV_LO};
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::{I64, U128, U64};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId, NearToken, PromiseResult};

const T0: u64 = 1_700_000_000;
const P5: u128 = 5_000_000; // $5.00
const DAY: u64 = 86_400;

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

/// Zero fees, a flat 1× multiplier, no surcharge, no base fee, no caps, plain (not delta-weighted)
/// utilization, so per-bucket math is exact. 50% jump guard so we can move the price fast.
fn params() -> Params {
    Params {
        trade_fee_bps: 0,
        funding_fee_bps: 0,
        max_jump_bps: 5_000,
        max_open_bps: 10_000,
        util_mult_base_bps: 10_000,
        util_mult_slope_bps: 0,
        util_mult_kink_slope_bps: 0,
        rv_halflife_secs: 0,
        base_funding_bps: 0,
        bucket_funding_mult_bps: vec![10_000; BUCKETS],
        bucket_cap_bps: vec![10_000; BUCKETS],
        util_delta_weight_bps: 0,
        ..Params::default()
    }
}

/// The default utilization multiplier (1× at u = 0, 1.4× at the 40% kink, 12× at 100%), plain
/// utilization, no caps / surcharge / base fee / trade fees. Realized vol off.
fn util_params() -> Params {
    Params {
        util_mult_base_bps: Params::default().util_mult_base_bps,
        util_mult_slope_bps: Params::default().util_mult_slope_bps,
        util_mult_kink_slope_bps: Params::default().util_mult_kink_slope_bps,
        ..params()
    }
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
/// Move the price to `target` in steps the jump guard accepts (±40%), all at time `ts`.
fn walk(c: &mut Contract, target: u128, ts: u64) {
    let mut p = c.get_market().price.0;
    while p != target {
        p = if target > p { (p * 14 / 10).min(target) } else { (p * 6 / 10).max(target) };
        push(c, p, ts);
    }
}
fn deposit(c: &mut Contract, who: &str, amount: u128, ts: u64, msg: &str) {
    ctx("usdc.near", ts, 0);
    let _ = c.ft_on_transfer(acc(who), U128(amount), msg.to_string());
}
fn short(c: &mut Contract, who: &str, amount: u128, ts: u64) {
    deposit(c, who, amount, ts, "");
    ctx(who, ts, 0);
    c.open_short(U128(amount), None, None);
}
fn long(c: &mut Contract, who: &str, power: u8, amount: u128, ts: u64) -> u128 {
    deposit(c, who, amount, ts, "");
    ctx(who, ts, 0);
    c.open_long(power, U128(amount), None, None).0
}
fn close(c: &mut Contract, who: &str, power: u8, ts: u64) -> u128 {
    ctx(who, ts, 0);
    c.close_long(power, None, None, None).0
}
fn view(c: &Contract, who: &str) -> crate::views::AccountView {
    c.get_account(acc(who)).unwrap()
}
fn long_value(c: &Contract, who: &str, power: u8) -> u128 {
    view(c, who).longs.iter().find(|l| l.power == power).map(|l| l.value.0).unwrap_or(0)
}
fn bucket(c: &Contract, power: u8) -> crate::views::BucketView {
    c.get_buckets().into_iter().find(|b| b.power == power).unwrap()
}
fn approx(a: u128, b: u128, tol: u128) -> bool {
    a.abs_diff(b) <= tol
}
fn rel(a: u128, b: u128, ppm: u128) -> bool {
    a.abs_diff(b) * 1_000_000 <= b.max(1) * ppm
}
/// Solvency view, the stored invariant, and "the views add up": per-bucket claims sum to the total,
/// and every account's long values sum to (at most) the total claims.
fn solvent(c: &Contract) {
    let s = c.get_solvency();
    assert!(s.ok, "claims {} != treasury {}", s.claims_total.0, s.treasury.0);
    c.assert_invariant();
    let m = c.get_market();
    let sum_raw: u128 = m.buckets.iter().map(|b| b.claims_raw.0).sum();
    assert_eq!(sum_raw, m.long_claims_raw.0, "bucket claims add up");
    assert!(m.long_claims.0 <= m.risk_pool.0, "claims within the pool");
    let held: u128 = c.get_accounts(None, Some(200)).iter().map(|a| a.long_value.0).sum();
    assert!(held <= m.long_claims.0 + 10, "holders {} > claims {}", held, m.long_claims.0);
}
fn shorts_seeded(p: Params, amount: u128) -> Contract {
    let mut c = setup(p);
    short(&mut c, "alice.near", amount, T0);
    c
}

/// Alice seeds 10k Curve Short, Bob buys 1k of x².
fn seeded() -> Contract {
    let mut c = shorts_seeded(params(), usd(10_000));
    long(&mut c, "bob.near", 2, usd(1_000), T0);
    c
}

// ───────────────────────── basics (ported from the single-power ledger) ─────────────────────────

#[test]
fn ten_buckets_are_listed() {
    let c = setup(Params::default());
    let b = c.get_buckets();
    assert_eq!(b.len(), 10);
    for (i, v) in b.iter().enumerate() {
        assert_eq!(v.power as usize, i + 1);
        assert_eq!(v.nf.0, ONE);
        assert_eq!(v.ref_price.0, P5);
        assert_eq!(v.total_units.0, 0);
        assert_eq!(v.cap_bps, DEFAULT_CAP_BPS[i]);
        assert_eq!(v.funding_mult_bps, DEFAULT_FUNDING_MULT_BPS[i]);
    }
    assert_eq!(c.get_market().buckets.len(), 10);
    assert_eq!(DEFAULT_FUNDING_MULT_BPS[9], 20_000, "x¹⁰ pays 2× its convexity");
    assert_eq!(DEFAULT_FUNDING_MULT_BPS[0], 10_000);
}

#[test]
#[should_panic(expected = "open too large")]
fn one_long_open_is_limited_to_20pct_of_the_pool() {
    let mut c = shorts_seeded(Params { trade_fee_bps: 0, ..Params::default() }, usd(100));
    long(&mut c, "bob.near", 1, usd(5_000), T0);
}

#[test]
fn repeated_long_opens_are_allowed_and_get_expensive() {
    let p = Params { trade_fee_bps: 0, bucket_cap_bps: vec![10_000; BUCKETS], util_delta_weight_bps: 0, ..Params::default() };
    let mut c = shorts_seeded(p, usd(100));
    deposit(&mut c, "bob.near", usd(5_000), T0, "");
    assert_eq!(bucket(&c, 2).max_open.0, usd(20));
    for _ in 0..8 {
        let max = bucket(&c, 2).max_open.0;
        ctx("bob.near", T0, 0);
        c.open_long(2, U128(max), None, None);
    }
    let m = c.get_market();
    // 8 opens of 20% each: pool 100 → 430, longs hold 330 of it.
    assert!(approx(m.risk_pool.0, 429_981_696, 10), "pool {}", m.risk_pool.0);
    assert!(m.utilization_bps > 7_600, "util {}", m.utilization_bps);
    assert!(m.funding_multiplier_bps > 70_000, "multiplier {}", m.funding_multiplier_bps);
    solvent(&c);
}

#[test]
fn multiplier_matches_spec() {
    let c = setup(util_params());
    assert_eq!(c.util_multiplier_bps(0), 10_000);
    assert_eq!(c.util_multiplier_bps(2_500), 12_500);
    assert_eq!(c.util_multiplier_bps(4_000), 14_000);
    assert_eq!(c.util_multiplier_bps(7_000), 17_000 + 50_000);
    assert_eq!(c.util_multiplier_bps(10_000), 20_000 + 100_000);
}

fn funding_after_one_day(flat: u128, curve: u128, price_after_open: u128) -> (u128, u32) {
    let mut c = shorts_seeded(util_params(), usd(flat));
    long(&mut c, "bob.near", 2, usd(curve), T0);
    walk(&mut c, price_after_open, T0);
    let mult = c.get_market().funding_multiplier_bps;
    let before = view(&c, "bob.near").long_value.0;
    push(&mut c, price_after_open, T0 + DAY);
    (before - view(&c, "bob.near").long_value.0, mult)
}

#[test]
fn scarce_shorts_get_paid_more() {
    let (deep, m_deep) = funding_after_one_day(20_000, 1_000, P5); // u ≈ 4.8%
    let (thin, m_thin) = funding_after_one_day(2_500, 1_000, P5); // u ≈ 28.6%
    assert!(m_thin > m_deep, "multiplier {m_thin} should exceed {m_deep}");
    assert!(thin > deep, "funding {thin} should exceed {deep}");
}

#[test]
fn rally_past_the_kink_makes_funding_steep() {
    // Open at 33% utilization, then a rally pushes long claims to ~65% of the pool.
    let (_, m_open) = funding_after_one_day(2_000, 1_000, P5);
    let (paid, m_rally) = funding_after_one_day(2_000, 1_000, 7_000_000);
    assert!(m_open < 14_000 && m_rally > 50_000, "open {m_open} rally {m_rally}");
    assert!(paid > 5_000_000, "paid {paid}");
}

#[test]
#[should_panic(expected = "never below fair funding")]
fn multiplier_floor_below_fair_is_rejected() {
    setup(Params { util_mult_base_bps: 5_000, ..params() });
}

/// Hourly prices for `days` days, alternating ±move_bps, starting at `t0`. Returns the last timestamp.
fn wiggle(c: &mut Contract, t0: u64, days: u64, move_bps: u128) -> u64 {
    let mut t = t0;
    for h in 0..days * 24 {
        t += 3_600;
        let px = if h % 2 == 0 { P5 * (BPS + move_bps) / BPS } else { P5 };
        push(c, px, t);
    }
    t
}

#[test]
fn realized_vol_tracks_the_oracle_and_lifts_funding() {
    let p = Params { rv_halflife_secs: 1_814_400, ..params() };
    let mut c = setup(p.clone());
    wiggle(&mut c, T0, 60, 20);
    let m = c.get_market();
    assert!((1_500..=2_300).contains(&m.realized_vol_bps), "calm rv {}", m.realized_vol_bps);
    assert_eq!(m.funding_vol_bps, 8_000);
    let mut c = setup(p.clone());
    wiggle(&mut c, T0, 60, 200);
    let m = c.get_market();
    assert!((15_500..=19_500).contains(&m.realized_vol_bps), "wild rv {}", m.realized_vol_bps);
    assert_eq!(m.funding_vol_bps, m.realized_vol_bps);
    // x²: convexity = σ², about (1.7)² ≈ 290%/yr instead of 64%. x¹⁰: 45σ².
    assert!(bucket(&c, 2).funding_convexity_annual_bps > 25_000);
    assert_eq!(bucket(&c, 1).funding_convexity_annual_bps, 0);
    assert!(bucket(&c, 10).funding_convexity_annual_bps > 45 * 25_000);
    let mut c = setup(Params { rv_cap_bps: 12_000, max_jump_bps: 5_000, ..p });
    push(&mut c, P5 * 14 / 10, T0 + 60);
    assert!(c.get_market().realized_vol_bps <= 12_000);
}

#[test]
fn curve_value_follows_price_squared() {
    let mut c = seeded();
    assert_eq!(long_value(&c, "bob.near", 2), usd(1_000));
    push(&mut c, 5_500_000, T0); // +10% → ×1.21
    let bob = view(&c, "bob.near");
    assert_eq!(bob.long_value.0, usd(1_210));
    assert_eq!(bob.long_pnl.0, usd(210) as i128);
    assert_eq!(view(&c, "alice.near").short_value.0, usd(10_000) - usd(210));
    push(&mut c, 4_500_000, T0); // −10% → ×0.81
    assert_eq!(long_value(&c, "bob.near", 2), usd(810));
    assert_eq!(view(&c, "alice.near").short_value.0, usd(10_190));
    solvent(&c);
}

#[test]
fn funding_shrinks_longs_and_pays_shorts() {
    let mut c = seeded();
    push(&mut c, P5, T0 + DAY);
    // σ = 80%, p = 2 → 0.64/yr → exp(−0.64/365) ≈ 0.998248
    let bob = long_value(&c, "bob.near", 2);
    assert!(approx(bob, 998_248_000, 2_000), "curve after 1 day = {bob}");
    let alice = view(&c, "alice.near").short_value.0;
    assert_eq!(alice + bob, usd(11_000), "funding is a pure transfer Curve Long → Curve Short");
    assert!(c.get_stats().funding_paid.0 > 0);
    solvent(&c);
}

#[test]
fn views_include_pending_funding_without_a_poke() {
    let mut c = seeded();
    ctx("anyone.near", T0 + DAY, 0);
    let pending = long_value(&c, "bob.near", 2);
    let m = c.get_market();
    c.poke();
    assert_eq!(long_value(&c, "bob.near", 2), pending);
    assert_eq!(c.get_market().long_claims.0, m.long_claims.0);
}

#[test]
fn round_trip_close_both_sides_and_withdraw() {
    let mut c = seeded();
    push(&mut c, 5_500_000, T0);
    assert_eq!(close(&mut c, "bob.near", 2, T0), usd(1_210));
    assert_eq!(view(&c, "bob.near").realized_pnl.0, usd(210) as i128);
    assert!(view(&c, "bob.near").longs.is_empty(), "closed position is removed");
    ctx("alice.near", T0, 0);
    assert_eq!(c.close_short(None, None, None).0, usd(9_790));
    let m = c.get_market();
    assert_eq!(m.risk_pool.0, 0);
    assert_eq!(m.free_total.0, usd(11_000));
    ctx("bob.near", T0, 1);
    let _ = c.withdraw(U128(usd(1_210)), None, Some(acc("intents.near")), None, Some("bob.near".into()));
    assert_eq!(c.get_market().treasury.0, usd(9_790));
    solvent(&c);
}

#[test]
#[should_panic(expected = "no Curve Short liquidity yet")]
fn longs_need_short_liquidity() {
    let mut c = setup(params());
    long(&mut c, "bob.near", 3, usd(100), T0);
}

#[test]
fn shorts_can_exit_any_time_and_funding_turns_extreme() {
    let mut c = shorts_seeded(params(), usd(1_000));
    long(&mut c, "bob.near", 2, usd(400), T0);
    ctx("alice.near", T0, 0);
    c.close_short(Some(U128(usd(900))), None, None); // leaves $100 of short equity: u = 80%
    ctx("owner.near", T0, 0);
    c.set_params(util_params());
    let m = c.get_market();
    assert_eq!(m.utilization_bps, 8_000);
    assert_eq!(m.funding_multiplier_bps, 10_000 + 8_000 + 100_000 * 4_000 / 6_000);
    solvent(&c);
}

#[test]
fn rally_past_the_pool_writes_longs_down_and_new_shorts_can_join() {
    let mut c = shorts_seeded(params(), usd(1_000));
    long(&mut c, "bob.near", 2, usd(500), T0);
    push(&mut c, 7_500_000, T0);
    push(&mut c, 10_000_000, T0); // 2× → claim would be 2000 > pool 1500: written down to 1500
    let m = c.get_market();
    assert!(approx(m.long_claims_raw.0, usd(1_500), 1), "claims {}", m.long_claims_raw.0);
    assert_eq!(m.short_equity.0, 0);
    assert_eq!(c.get_stats().write_downs, 1);
    short(&mut c, "carol.near", usd(1_000), T0);
    assert_eq!(c.get_market().short_epoch, 1);
    assert_eq!(view(&c, "carol.near").short_value.0, usd(1_000));
    let alice = view(&c, "alice.near");
    assert_eq!((alice.short_shares.0, alice.short_value.0), (0, 0));
    push(&mut c, 7_500_000, T0);
    assert!(view(&c, "carol.near").short_value.0 > usd(1_600));
    assert_eq!(view(&c, "alice.near").realized_pnl.0, -(usd(1_000) as i128));
    close(&mut c, "bob.near", 2, T0);
    solvent(&c);
}

#[test]
fn equity_with_no_shorts_goes_to_fees() {
    let mut c = shorts_seeded(params(), usd(1_000));
    long(&mut c, "bob.near", 2, usd(500), T0);
    ctx("alice.near", T0, 0);
    c.close_short(None, None, None);
    push(&mut c, 4_000_000, T0); // longs lose 36%, nobody is short to receive it
    let m = c.get_market();
    assert_eq!(m.short_equity.0, 0);
    assert_eq!(m.fees.0, usd(180));
    solvent(&c);
}

#[test]
fn fees_go_to_protocol_and_owner_can_claim() {
    let mut c = shorts_seeded(Params { trade_fee_bps: 10, funding_fee_bps: 1_000, max_jump_bps: 5_000, ..Params::default() }, usd(10_000));
    long(&mut c, "bob.near", 2, usd(1_000), T0);
    assert_eq!(c.get_market().fees.0, usd(10) + usd(1));
    push(&mut c, P5, T0 + DAY);
    assert!(c.get_market().fees.0 > usd(11), "funding fee booked");
    solvent(&c);
    ctx("owner.near", T0 + DAY, 1);
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
    c.close_long(2, Some(U128(usd(100))), Some(acc("bob.near")), None);
    assert_eq!(view(&c, "bob.near").longs[0].units.0, usd(900));
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
    c.close_long(2, None, Some(acc("bob.near")), None);
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
    c.close_long(2, None, None, None);
}

#[test]
fn deposit_and_open_in_one_transfer() {
    let mut c = setup(params());
    deposit(&mut c, "alice.near", usd(1_000), T0, r#"{"action":"open_short"}"#);
    deposit(&mut c, "relayer.near", usd(100), T0, r#"{"receiver_id":"tg-7.relayer.near","action":"open_long","power":7}"#);
    let a = view(&c, "tg-7.relayer.near");
    assert_eq!(a.free.0, 0);
    assert_eq!(a.longs.len(), 1);
    assert_eq!(a.longs[0].power, 7);
    assert_eq!(a.long_value.0, usd(100));
    assert_eq!(view(&c, "alice.near").short_shares.0, usd(1_000));
    solvent(&c);
}

#[test]
#[should_panic(expected = "open_long needs power")]
fn deposit_open_long_without_power_is_refunded() {
    let mut c = setup(params());
    deposit(&mut c, "alice.near", usd(1_000), T0, r#"{"action":"open_short"}"#);
    deposit(&mut c, "bob.near", usd(100), T0, r#"{"action":"open_long"}"#);
}

#[test]
fn previews_match_execution() {
    let mut c = seeded();
    for power in [1u8, 5, 10] {
        let p = c.preview_open_long(power, U128(usd(500)));
        assert!(p.ok, "{:?}", p.error);
        let units = long(&mut c, "carol.near", power, usd(500), T0);
        assert_eq!(units, p.quote.unwrap().out.0);
        let units_held = view(&c, "carol.near").longs.iter().find(|l| l.power == power).unwrap().units;
        let q = c.preview_close_long(power, units_held).quote.unwrap();
        assert_eq!(close(&mut c, "carol.near", power, T0), q.out.0);
    }
    let p = c.preview_open_long(2, U128(usd(100_000)));
    assert!(!p.ok && p.error.unwrap().contains("open too large"));
    let p = c.preview_open_long(0, U128(usd(10)));
    assert!(!p.ok && p.error.unwrap().contains("power must be 1..=10"));
    let p = c.preview_open_long(11, U128(usd(10)));
    assert!(!p.ok);
    let p = c.preview_open_long(2, bucket(&c, 2).max_open);
    assert!(p.ok && p.quote.unwrap().utilization_after_bps > 5_000);
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
    assert!(!c.on_pyth_price(Ok(Some(px(560_000_000, 28_000_000, (T0 + 9) as i64)))));
    assert!(!c.on_pyth_price(Ok(Some(px(560_000_000, 100_000, (T0 + 8) as i64)))));
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
    assert_eq!(s.last().unwrap().delta_claims.0, c.get_market().delta_claims.0);
}

// ───────────────────────── buckets: payoff and the shared pool ─────────────────────────

/// Bob holds $100 in every bucket against a $1M pool.
fn every_bucket(p: Params) -> Contract {
    let mut c = shorts_seeded(p, usd(1_000_000));
    for power in 1..=10u8 {
        long(&mut c, "bob.near", power, usd(100), T0);
    }
    c
}

#[test]
fn each_bucket_follows_its_own_power() {
    let mut c = every_bucket(params());
    assert_eq!(view(&c, "bob.near").longs.len(), 10);
    push(&mut c, 5_500_000, T0); // +10%
    for power in 1..=10u8 {
        let want = 100.0 * 1.1f64.powi(power as i32);
        let got = long_value(&c, "bob.near", power) as f64 / 1e6;
        assert!((got - want).abs() < 1e-5, "x{power}: {got} vs {want}");
    }
    push(&mut c, 4_500_000, T0); // −10% from $5
    for power in 1..=10u8 {
        let want = 100.0 * 0.9f64.powi(power as i32);
        let got = long_value(&c, "bob.near", power) as f64 / 1e6;
        assert!((got - want).abs() < 1e-5, "x{power}: {got} vs {want}");
    }
    let total: u128 = view(&c, "bob.near").longs.iter().map(|l| l.value.0).sum();
    assert_eq!(view(&c, "bob.near").long_value.0, total);
    solvent(&c);
}

#[test]
fn delta_claims_sum_power_times_claims() {
    let mut c = every_bucket(params());
    push(&mut c, 6_000_000, T0);
    let m = c.get_market();
    let want: u128 = m.buckets.iter().map(|b| b.power as u128 * b.claims.0).sum();
    assert!(approx(m.delta_claims.0, want, 10), "{} vs {}", m.delta_claims.0, want);
    // at $5, $100 each: Σ p · 100 = 5,500
    let c = every_bucket(params());
    assert_eq!(c.get_market().delta_claims.0, usd(5_500));
    assert_eq!(c.get_market().long_claims.0, usd(1_000));
}

#[test]
fn cross_bucket_invariant_through_a_noisy_month() {
    let p = Params { trade_fee_bps: 10, funding_fee_bps: 1_000, max_jump_bps: 5_000, ..Params::default() };
    let mut c = shorts_seeded(p, usd(200_000));
    let traders = ["t1.near", "t2.near", "t3.near", "t4.near", "t5.near", "t6.near"];
    // A deterministic path with jumps and wicks, hourly; trades in every bucket along the way.
    let mut seed = 7u64;
    let mut rnd = || {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 33) as u128
    };
    let mut t = T0;
    let mut price = P5;
    for step in 0..720u64 {
        t += 3_600;
        let r = rnd() % 1000;
        price = match r {
            0..=9 => price * 13 / 10,  // jump up
            10..=19 => price * 7 / 10, // jump down
            _ => price * (9_900 + (rnd() % 201)) / 10_000,
        }
        .clamp(500_000, 50_000_000);
        push(&mut c, price, t);
        let who = traders[(rnd() % 6) as usize];
        let power = (rnd() % 10) as u8 + 1;
        if rnd() % 3 == 0 {
            if view_opt(&c, who).map(|a| a.longs.iter().any(|l| l.power == power)).unwrap_or(false) {
                close(&mut c, who, power, t);
            }
        } else {
            let amount = usd(1 + rnd() % 500);
            let max = bucket(&c, power).max_open.0;
            if amount <= max && c.preview_open_long(power, U128(amount)).ok {
                long(&mut c, who, power, amount, t);
            }
        }
        if step % 24 == 0 {
            solvent(&c);
        }
    }
    solvent(&c);
    // Everybody leaves: the pool ends up holding exactly the short equity.
    for who in traders {
        for power in 1..=10u8 {
            if view_opt(&c, who).map(|a| a.longs.iter().any(|l| l.power == power)).unwrap_or(false) {
                close(&mut c, who, power, t);
            }
        }
    }
    let m = c.get_market();
    assert!(m.long_claims_raw.0 <= 10, "dust only: {}", m.long_claims_raw.0);
    assert!(m.trades_ok());
    solvent(&c);
}

fn view_opt(c: &Contract, who: &str) -> Option<crate::views::AccountView> {
    c.get_account(acc(who))
}

trait TradesOk {
    fn trades_ok(&self) -> bool;
}
impl TradesOk for crate::views::MarketView {
    fn trades_ok(&self) -> bool {
        self.short_equity.0 + self.long_claims.0 == self.risk_pool.0
    }
}

#[test]
fn write_down_is_pro_rata_across_buckets() {
    // A rally that only an x¹⁰ bucket can push past the pool also writes down the x¹ holder.
    let mut c = shorts_seeded(params(), usd(1_000));
    long(&mut c, "steady.near", 1, usd(500), T0);
    long(&mut c, "degen.near", 10, usd(20), T0);
    let before_x1 = long_value(&c, "steady.near", 1);
    push(&mut c, 7_000_000, T0); // +40%: x¹ 700, x¹⁰ 20 × 28.9 = 578 → 1,278 < 1,520
    assert_eq!(c.get_stats().write_downs, 0);
    let x1_mid = long_value(&c, "steady.near", 1);
    assert_eq!(x1_mid, before_x1 * 14 / 10);
    push(&mut c, 8_000_000, T0); // x¹ 800, x¹⁰ 20 × 109.95 = 2,199 → 2,999 > 1,520: written down
    let m = c.get_market();
    assert_eq!(c.get_stats().write_downs, 1);
    assert_eq!(m.short_equity.0, 0);
    assert!(approx(m.long_claims_raw.0, usd(1_520), 2));
    let x1 = long_value(&c, "steady.near", 1) as f64;
    let x10 = long_value(&c, "degen.near", 10) as f64;
    let f1 = x1 / 800e6;
    let f10 = x10 / (20e6 * 1.6f64.powi(10));
    assert!((f1 - f10).abs() < 1e-6, "same haircut factor: {f1} vs {f10}");
    assert!(f1 < 0.51 && f1 > 0.50, "x¹ lost about half: {f1}");
    solvent(&c);
}

#[test]
fn caps_contain_the_contagion() {
    // Same rally, default caps: x¹⁰ can't grow big enough to write anyone down.
    let p = Params { bucket_cap_bps: DEFAULT_CAP_BPS.to_vec(), ..params() };
    let mut c = shorts_seeded(p, usd(1_000));
    long(&mut c, "steady.near", 1, usd(200), T0);
    let max10 = bucket(&c, 10).max_open.0;
    assert!(max10 < usd(31) && max10 > usd(29), "x¹⁰ cap 2.5% of a $1,200 pool: {max10}");
    long(&mut c, "degen.near", 10, max10, T0);
    push(&mut c, 7_000_000, T0);
    assert_eq!(c.get_stats().write_downs, 0);
    assert_eq!(long_value(&c, "steady.near", 1), usd(280));
    solvent(&c);
}

#[test]
#[should_panic(expected = "bucket cap reached")]
fn bucket_cap_blocks_an_open() {
    let p = Params { bucket_cap_bps: DEFAULT_CAP_BPS.to_vec(), ..params() };
    let mut c = shorts_seeded(p, usd(10_000));
    let max = bucket(&c, 10).max_open.0;
    long(&mut c, "degen.near", 10, max + usd(1), T0);
}

#[test]
fn bucket_cap_max_open_is_exactly_fillable_and_other_buckets_stay_open() {
    let p = Params { bucket_cap_bps: DEFAULT_CAP_BPS.to_vec(), trade_fee_bps: 10, ..params() };
    let mut c = shorts_seeded(p, usd(10_000));
    for power in [10u8, 7, 3] {
        let max = bucket(&c, power).max_open.0;
        long(&mut c, "degen.near", power, max, T0);
        let b = bucket(&c, power);
        assert!(b.share_of_pool_bps as u16 <= b.cap_bps && b.share_of_pool_bps as u16 + 1 >= b.cap_bps, "x{power} at its cap: {}", b.share_of_pool_bps);
        assert!(bucket(&c, power).max_open.0 <= usd(1) / 1000, "x{power} is full");
        assert!(!c.preview_open_long(power, U128(usd(1))).ok);
    }
    assert!(c.preview_open_long(1, U128(usd(100))).ok, "x¹ still open");
    solvent(&c);
}

#[test]
fn a_bucket_pushed_past_its_cap_by_price_can_still_close() {
    let p = Params { bucket_cap_bps: DEFAULT_CAP_BPS.to_vec(), ..params() };
    let mut c = shorts_seeded(p, usd(10_000));
    let max = bucket(&c, 5).max_open.0;
    long(&mut c, "bob.near", 5, max, T0);
    push(&mut c, 6_000_000, T0); // ×2.49 for x⁵
    let b = bucket(&c, 5);
    assert!(b.share_of_pool_bps as u16 > b.cap_bps);
    assert_eq!(b.max_open.0, 0);
    assert!(c.preview_open_long(5, U128(usd(1))).error.unwrap().contains("bucket cap"));
    assert!(c.preview_open_long(4, U128(usd(10))).ok);
    let out = close(&mut c, "bob.near", 5, T0);
    assert!(rel(out, max * 248_832 / 100_000, 10));
    solvent(&c);
}

// ───────────────────────── funding per bucket ─────────────────────────

/// Flat multiplier, default surcharge curve, 10% base fee, no trade/funding fees, realized vol off.
fn funding_params(base: u32) -> Params {
    Params { base_funding_bps: base, bucket_funding_mult_bps: DEFAULT_FUNDING_MULT_BPS.to_vec(), ..params() }
}

#[test]
fn every_bucket_pays_its_own_rate() {
    let mut c = every_bucket(funding_params(1_000));
    push(&mut c, P5, T0 + DAY);
    for power in 1..=10u8 {
        let conv = (power as f64) * (power as f64 - 1.0) / 2.0 * 0.64;
        let mult = DEFAULT_FUNDING_MULT_BPS[power as usize - 1] as f64 / 1e4;
        let rate = conv * mult + 0.10;
        let want = 100e6 * (-rate / 365.0).exp();
        let got = long_value(&c, "bob.near", power) as f64;
        assert!((got - want).abs() / want < 2e-6, "x{power}: {got} vs {want}");
        let b = bucket(&c, power);
        assert!(((b.funding_rate_annual_bps as f64) - rate * 1e4).abs() <= 1.0, "x{power} rate {}", b.funding_rate_annual_bps);
    }
    solvent(&c);
}

#[test]
fn x1_pays_only_the_base_fee() {
    let mut c = every_bucket(funding_params(1_000));
    push(&mut c, P5, T0 + 365 * DAY / 10); // 36.5 days at 10%/yr ≈ 1%
    let x1 = long_value(&c, "bob.near", 1);
    assert!(rel(x1, (100e6 * (-0.01f64).exp()) as u128, 50), "x¹ {x1}");
    assert_eq!(bucket(&c, 1).funding_convexity_annual_bps, 0);
    // Without a base fee x¹ pays nothing at all.
    let mut c = every_bucket(funding_params(0));
    push(&mut c, P5, T0 + 30 * DAY);
    assert_eq!(long_value(&c, "bob.near", 1), usd(100));
    assert!(long_value(&c, "bob.near", 2) < usd(100));
}

#[test]
fn x10_pays_double_its_convexity() {
    let c = every_bucket(funding_params(0));
    let b10 = bucket(&c, 10);
    assert_eq!(b10.funding_convexity_annual_bps, 288_000); // 45 × 0.64
    assert_eq!(b10.funding_rate_annual_bps, 576_000);
    let b2 = bucket(&c, 2);
    assert!(b2.funding_rate_annual_bps <= b2.funding_convexity_annual_bps * 102 / 100);
    // steeper buckets pay proportionally more, never less
    let ratios: Vec<f64> = (2..=10u8).map(|p| { let b = bucket(&c, p); b.funding_rate_annual_bps as f64 / b.funding_convexity_annual_bps as f64 }).collect();
    assert!(ratios.windows(2).all(|w| w[0] <= w[1] + 1e-9), "{ratios:?}");
}

#[test]
fn funding_is_a_transfer_across_all_buckets() {
    let mut c = every_bucket(Params { util_delta_weight_bps: 5_000, ..funding_params(1_000) });
    let total_before = c.get_market().risk_pool.0;
    push(&mut c, P5, T0 + DAY);
    let m = c.get_market();
    assert_eq!(m.risk_pool.0, total_before, "no fee: the pool keeps every dollar");
    assert_eq!(m.long_claims.0 + m.short_equity.0, m.risk_pool.0);
    let paid: u128 = (1..=10u8).map(|p| usd(100) - long_value(&c, "bob.near", p)).sum();
    assert!(approx(view(&c, "alice.near").short_value.0, usd(1_000_000) + paid, 10));
    assert!(approx(c.get_stats().funding_paid.0, paid, 10));
}

#[test]
fn delta_weighted_utilization_counts_steep_buckets_more() {
    let p = Params { util_delta_weight_bps: 5_000, ..params() };
    let mut c = shorts_seeded(p.clone(), usd(9_900));
    long(&mut c, "bob.near", 1, usd(100), T0);
    assert_eq!(c.get_market().utilization_bps, 100); // 100 / 10,000
    let mut c = shorts_seeded(p, usd(9_900));
    long(&mut c, "bob.near", 10, usd(100), T0);
    assert_eq!(c.get_market().utilization_bps, 550); // 5.5 × 100 / 10,000
    assert_eq!(c.get_market().claims_to_pool_bps, 100);
    // full delta weight: w_p = p
    let mut c = shorts_seeded(Params { util_delta_weight_bps: 10_000, ..params() }, usd(9_900));
    long(&mut c, "bob.near", 10, usd(100), T0);
    assert_eq!(c.get_market().utilization_bps, 1_000);
}

#[test]
fn steep_bucket_flow_raises_funding_for_everyone() {
    let p = Params { util_delta_weight_bps: 5_000, ..util_params() };
    let mut c = shorts_seeded(p, usd(1_000));
    long(&mut c, "bob.near", 2, usd(100), T0);
    let r_before = bucket(&c, 2).funding_rate_annual_bps;
    long(&mut c, "degen.near", 10, usd(100), T0);
    let r_after = bucket(&c, 2).funding_rate_annual_bps;
    assert!(r_after > r_before * 15 / 10, "x² rate {r_before} → {r_after}");
}

// ───────────────────────── rebasing, re-scaling, extremes ─────────────────────────

#[test]
fn x10_rebases_and_rescales_on_a_moonshot_without_changing_values() {
    // 1 raw unit of USDC in x¹⁰ so a 10.4× rally ($14,800) stays far inside a $1M pool.
    let p = Params { min_amount: U128(1), ..params() };
    let mut c = shorts_seeded(p, usd(1_000_000));
    long(&mut c, "bob.near", 10, 1, T0); // $0.000001
    walk(&mut c, 52_000_000, T0); // 10.4×: the unit value leaves [1e12, 1e20] on the way → rebase + re-scale
    let b = bucket(&c, 10);
    assert!(b.ref_price.0 > P5 * 7, "re-anchored near the top: {}", b.ref_price.0);
    assert!(b.scale < 0, "units were multiplied: scale {}", b.scale);
    assert!(b.nf.0 >= UV_LO && b.nf.0 <= UV_HI, "nf {}", b.nf.0);
    let want = 10.4f64.powi(10);
    let got = long_value(&c, "bob.near", 10) as f64;
    assert!((got - want).abs() / want < 1e-9, "{got} vs {want}");
    assert_eq!(view(&c, "bob.near").longs[0].units.0, b.total_units.0);
    // A new $100 open at the new scale is priced exactly.
    long(&mut c, "carol.near", 10, usd(100), T0);
    assert!(approx(long_value(&c, "carol.near", 10), usd(100), 1));
    // Back down to $5: both values return.
    walk(&mut c, P5, T0);
    assert!(approx(long_value(&c, "bob.near", 10), 1, 1));
    assert_eq!(c.get_stats().write_downs, 0);
    let carol = long_value(&c, "carol.near", 10) as f64;
    let want = 100e6 / 10.4f64.powi(10);
    assert!((carol - want).abs() <= 2.0, "{carol} vs {want}");
    // Positions that rounded down to dust on the way back are gone; the rest close normally.
    for who in ["bob.near", "carol.near"] {
        if view(&c, who).longs.iter().any(|l| l.power == 10) {
            close(&mut c, who, 10, T0);
        }
    }
    assert!(bucket(&c, 10).claims_raw.0 <= 1);
    solvent(&c);
}

#[test]
fn x10_melting_for_months_rescales_units_and_stays_tradable() {
    let mut c = shorts_seeded(funding_params(1_000), usd(1_000_000));
    long(&mut c, "bob.near", 10, usd(100), T0);
    let mut t = T0;
    for _ in 0..120 {
        t += DAY;
        push(&mut c, P5, t);
    }
    // 57.7/yr for 120 days ≈ e^−19: $100 → about $0.0000005
    let b = bucket(&c, 10);
    assert!(b.scale >= 1, "melted units were re-scaled: {}", b.scale);
    assert!(b.nf.0 >= UV_LO, "nf {}", b.nf.0);
    let bob = long_value(&c, "bob.near", 10);
    assert!(bob <= 10, "melted: {bob}");
    // New money in the same bucket gets fine-grained units and full value.
    long(&mut c, "carol.near", 10, usd(1), T0 + 120 * DAY);
    assert!(approx(long_value(&c, "carol.near", 10), usd(1), 1));
    long(&mut c, "dave.near", 10, usd(250), t);
    assert!(approx(long_value(&c, "dave.near", 10), usd(250), 1));
    close(&mut c, "bob.near", 10, t);
    solvent(&c);
    let out = close(&mut c, "dave.near", 10, t);
    assert!(approx(out, usd(250), 1));
    solvent(&c);
}

#[test]
fn worthless_bucket_resets_and_old_holders_read_zero() {
    let p = Params { max_jump_bps: 5_000, ..params() };
    let mut c = shorts_seeded(p, usd(100_000));
    long(&mut c, "bob.near", 10, usd(100), T0);
    long(&mut c, "steady.near", 1, usd(100), T0);
    walk(&mut c, 1, T0); // $5 → $0.000001: x¹⁰ index 1e-67, a unit is worth < 1e-18 raw
    let b = bucket(&c, 10);
    assert_eq!(b.total_units.0, 0);
    assert_eq!(b.nf.0, ONE);
    let bob = view(&c, "bob.near");
    assert!(bob.longs.iter().all(|l| l.power != 10), "x¹⁰ dust cleared on read");
    assert_eq!(bob.realized_pnl.0, -(usd(100) as i128), "the view already shows the loss");
    assert!(long_value(&c, "steady.near", 1) <= 20);
    // trading at the bottom still works
    long(&mut c, "carol.near", 10, usd(10), T0);
    assert!(approx(long_value(&c, "carol.near", 10), usd(10), 1));
    // bob's next trade books the loss, once
    long(&mut c, "bob.near", 3, usd(10), T0);
    assert_eq!(view(&c, "bob.near").realized_pnl.0, -(usd(100) as i128));
    assert_eq!(c.accounts.get(&acc("bob.near")).unwrap().realized_pnl, -(usd(100) as i128));
    solvent(&c);
}

#[test]
fn spike_and_crash_across_all_buckets() {
    let p = Params { bucket_cap_bps: DEFAULT_CAP_BPS.to_vec(), util_delta_weight_bps: 5_000, max_jump_bps: 5_000, ..params() };
    let mut c = shorts_seeded(p, usd(100_000));
    for power in 1..=10u8 {
        let amt = bucket(&c, power).max_open.0.min(usd(2_000));
        long(&mut c, "bob.near", power, amt, T0);
    }
    walk(&mut c, 100_000_000, T0); // 20×
    assert!(c.get_stats().write_downs > 0);
    let m = c.get_market();
    assert_eq!(m.short_equity.0, 0);
    assert!(approx(m.long_claims.0, m.risk_pool.0, 1));
    solvent(&c);
    walk(&mut c, 50_000, T0); // to $0.05: −99.95%
    let m = c.get_market();
    assert!(m.short_equity.0 > m.risk_pool.0 * 99 / 100);
    solvent(&c);
    for power in 1..=10u8 {
        if view(&c, "bob.near").longs.iter().any(|l| l.power == power) {
            close(&mut c, "bob.near", power, T0);
        }
    }
    walk(&mut c, P5, T0);
    solvent(&c);
}

#[test]
fn pyth_gap_up_writes_down_in_one_print() {
    let mut c = every_bucket(params());
    ctx("owner.near", T0, 0);
    c.set_oracle(OracleConfig::Pyth { contract: acc("pyth-oracle.near"), price_id: "c415".into() });
    let px = |price: i64, t: i64| PythPrice { price: I64(price), conf: U64(1_000), expo: -8, publish_time: t };
    ctx("curve.near", T0 + 2, 0);
    assert!(c.on_pyth_price(Ok(Some(px(1_500_000_000, (T0 + 1) as i64))))); // $5 → $15 in one print
    // x¹⁰ would be worth 100 × 3^10 = $5.9M against a $1M pool
    let m = c.get_market();
    assert_eq!(c.get_stats().write_downs, 1);
    assert_eq!(m.short_equity.0, 0);
    let f = long_value(&c, "bob.near", 1) as f64 / 300e6;
    let f10 = long_value(&c, "bob.near", 10) as f64 / (100e6 * 3f64.powi(10));
    assert!((f - f10).abs() < 1e-5);
    solvent(&c);
    ctx("curve.near", T0 + 4, 0);
    assert!(c.on_pyth_price(Ok(Some(px(500_000_000, (T0 + 3) as i64)))));
    assert!(c.get_market().short_equity.0 > 0);
    solvent(&c);
}

#[test]
fn huge_and_tiny_positions() {
    let mut c = shorts_seeded(params(), usd(1_000_000_000)); // $1B of shorts
    for power in 1..=10u8 {
        long(&mut c, "whale.near", power, usd(50_000_000), T0); // $50M per bucket
        long(&mut c, "minnow.near", power, usd(1), T0); // the $1 minimum
        assert_eq!(long_value(&c, "whale.near", power), usd(50_000_000));
        assert_eq!(long_value(&c, "minnow.near", power), usd(1));
    }
    push(&mut c, 5_500_000, T0);
    for power in 1..=10u8 {
        let want = 1.1f64.powi(power as i32);
        assert!((long_value(&c, "minnow.near", power) as f64 / 1e6 - want).abs() < 2e-6);
        assert!((long_value(&c, "whale.near", power) as f64 / 5e13 - want).abs() < 1e-9);
    }
    solvent(&c);
    for power in 1..=10u8 {
        close(&mut c, "minnow.near", power, T0);
        close(&mut c, "whale.near", power, T0);
    }
    assert!(c.get_market().long_claims_raw.0 <= 10);
    solvent(&c);
}

#[test]
#[should_panic(expected = "amount below minimum")]
fn below_minimum_rejected() {
    let mut c = shorts_seeded(params(), usd(1_000));
    deposit(&mut c, "bob.near", usd(1), T0, "");
    ctx("bob.near", T0, 0);
    c.open_long(4, U128(999_999), None, None);
}

#[test]
#[should_panic(expected = "power must be 1..=10")]
fn power_zero_rejected() {
    let mut c = shorts_seeded(params(), usd(1_000));
    long(&mut c, "bob.near", 0, usd(10), T0);
}

#[test]
#[should_panic(expected = "power must be 1..=10")]
fn power_eleven_rejected() {
    let mut c = shorts_seeded(params(), usd(1_000));
    long(&mut c, "bob.near", 11, usd(10), T0);
}

#[test]
#[should_panic(expected = "bad units")]
fn closing_a_bucket_you_dont_hold_fails() {
    let mut c = seeded();
    close(&mut c, "bob.near", 3, T0);
}

#[test]
fn rounding_never_pays_out_more_than_paid_in() {
    // 200 round trips of odd sizes in every bucket, at a few prices: the pool never loses.
    let p = Params { min_amount: U128(1), ..params() };
    let mut c = shorts_seeded(p, usd(100_000));
    let mut paid = 0u128;
    let mut got = 0u128;
    for i in 0..200u128 {
        let power = (i % 10) as u8 + 1;
        let amount = 1 + i * 7_919 % 3_333_333;
        let price = [P5, 5_000_001, 4_999_999, 7_777_777][(i % 4) as usize];
        walk(&mut c, price, T0);
        long(&mut c, "dust.near", power, amount, T0);
        paid += amount;
        got += close(&mut c, "dust.near", power, T0);
    }
    assert!(got <= paid, "got {got} > paid {paid}");
    assert!(paid - got < 2_000, "rounding loss stays tiny: {}", paid - got);
    walk(&mut c, P5, T0);
    let alice = view(&c, "alice.near").short_value.0;
    assert!(alice >= usd(100_000), "shorts never pay for rounding: {alice}");
    solvent(&c);
}

#[test]
fn partial_closes_split_cost_basis() {
    let mut c = every_bucket(params());
    let units = view(&c, "bob.near").longs.iter().find(|l| l.power == 6).unwrap().units.0;
    ctx("bob.near", T0, 0);
    c.close_long(6, Some(U128(units / 4)), None, None);
    let pos = view(&c, "bob.near").longs.into_iter().find(|l| l.power == 6).unwrap();
    assert!(approx(pos.cost.0, usd(75), 1));
    assert!(approx(pos.value.0, usd(75), 1));
    solvent(&c);
}

#[test]
#[should_panic(expected = "slippage")]
fn slippage_guard_on_close() {
    let mut c = every_bucket(params());
    ctx("bob.near", T0, 0);
    c.close_long(3, None, None, Some(U128(usd(101))));
}

#[test]
fn many_accounts_in_every_bucket() {
    let mut c = shorts_seeded(Params { trade_fee_bps: 10, ..params() }, usd(1_000_000));
    for i in 0..60u32 {
        let who = format!("u{i}.near");
        long(&mut c, &who, (i % 10) as u8 + 1, usd(10 + i as u128), T0);
    }
    assert_eq!(c.get_num_accounts(), 61);
    assert_eq!(c.get_accounts(Some(0), Some(200)).len(), 61);
    push(&mut c, 5_300_000, T0 + 600);
    solvent(&c);
    let held: u128 = c.get_accounts(None, Some(200)).iter().map(|a| a.long_value.0).sum();
    assert!(approx(held, c.get_market().long_claims.0, 60), "{held} vs {}", c.get_market().long_claims.0);
    for i in 0..60u32 {
        close(&mut c, &format!("u{i}.near"), (i % 10) as u8 + 1, T0 + 600);
    }
    assert!(c.get_market().long_claims_raw.0 <= 60);
    solvent(&c);
}

// ───────────────────────── admin and emergency ─────────────────────────

#[test]
#[should_panic(expected = "bucket_funding_mult_bps needs 10 entries")]
fn params_need_ten_multipliers() {
    setup(Params { bucket_funding_mult_bps: vec![10_000; 9], ..params() });
}

#[test]
#[should_panic(expected = "must not decrease with power")]
fn surcharge_cannot_favour_steep_buckets() {
    let mut m = DEFAULT_FUNDING_MULT_BPS.to_vec();
    m[9] = 15_000;
    setup(Params { bucket_funding_mult_bps: m, ..params() });
}

#[test]
#[should_panic(expected = "bucket_cap_bps must be 1..=10000")]
fn zero_cap_rejected() {
    let mut caps = DEFAULT_CAP_BPS.to_vec();
    caps[4] = 0;
    setup(Params { bucket_cap_bps: caps, ..params() });
}

#[test]
fn owner_can_retune_buckets_with_positions_open() {
    let mut c = every_bucket(params());
    push(&mut c, P5, T0 + DAY);
    let fees_before = c.get_market().fees.0;
    ctx("owner.near", T0 + DAY, 0);
    c.set_params(funding_params(2_000));
    assert_eq!(bucket(&c, 10).funding_mult_bps, 20_000);
    assert_eq!(c.get_market().fees.0, fees_before);
    push(&mut c, P5, T0 + 2 * DAY);
    solvent(&c);
}

#[test]
#[should_panic(expected = "owner only")]
fn strangers_cannot_set_params() {
    let mut c = setup(params());
    ctx("mallory.near", T0, 0);
    c.set_params(params());
}

#[test]
#[should_panic(expected = "emergency shutdown")]
fn emergency_withdraw_stops_the_market() {
    let mut c = every_bucket(params());
    ctx("owner.near", T0, 1);
    let _ = c.emergency_withdraw(U128(usd(1_000)), acc("owner.near"));
    assert!(c.get_market().emergency);
    short(&mut c, "carol.near", usd(100), T0);
}

#[test]
#[should_panic(expected = "emergency shutdown")]
fn emergency_blocks_long_closes() {
    let mut c = every_bucket(params());
    ctx("owner.near", T0, 1);
    let _ = c.emergency_withdraw(U128(usd(1_000)), acc("owner.near"));
    close(&mut c, "bob.near", 4, T0);
}

#[test]
#[should_panic(expected = "emergency shutdown")]
fn emergency_blocks_prices() {
    let mut c = every_bucket(params());
    ctx("owner.near", T0, 1);
    let _ = c.emergency_withdraw(U128(usd(1_000)), acc("owner.near"));
    push(&mut c, P5, T0 + 10);
}

#[test]
#[should_panic(expected = "emergency shutdown")]
fn emergency_blocks_withdrawals() {
    let mut c = every_bucket(params());
    deposit(&mut c, "bob.near", usd(10), T0, "");
    ctx("owner.near", T0, 1);
    let _ = c.emergency_withdraw(U128(usd(1_000)), acc("owner.near"));
    ctx("bob.near", T0, 1);
    let _ = c.withdraw(U128(usd(10)), None, None, None, None);
}

#[test]
fn views_still_work_after_an_emergency() {
    let mut c = every_bucket(params());
    ctx("owner.near", T0, 1);
    let _ = c.emergency_withdraw(U128(usd(1_000)), acc("owner.near"));
    ctx("anyone.near", T0 + DAY, 0);
    let m = c.get_market();
    assert!(m.emergency && m.open_paused);
    assert_eq!(m.buckets.len(), 10);
    assert_eq!(view(&c, "bob.near").longs.len(), 10);
    assert!(!c.preview_open_long(3, U128(usd(10))).ok);
}

#[test]
#[should_panic(expected = "owner only")]
fn only_owner_can_emergency_withdraw() {
    let mut c = setup(params());
    ctx("alice.near", T0, 1);
    let _ = c.emergency_withdraw(U128(1), acc("alice.near"));
}

#[test]
#[should_panic(expected = "opens are paused")]
fn paused_market_blocks_opens_but_closes_work() {
    let mut c = every_bucket(params());
    ctx("owner.near", T0, 0);
    c.set_open_paused(true);
    close(&mut c, "bob.near", 9, T0);
    solvent(&c);
    long(&mut c, "bob.near", 9, usd(10), T0);
}
