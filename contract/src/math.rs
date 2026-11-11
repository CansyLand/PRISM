//! Fixed-point math. All `*_e18` values are scaled by 1e18.
//! Every operation panics on overflow (U256 ops and `overflow-checks = true`),
//! so a bad input reverts instead of wrapping.

#[allow(deprecated, semicolon_in_expressions_from_macros, clippy::all)]
mod u256 {
    uint::construct_uint! {
        pub struct U256(4);
    }
}
pub use u256::U256;

pub const ONE: u128 = 1_000_000_000_000_000_000; // 1e18
pub const BPS: u128 = 10_000;
pub const YEAR_SECS: u128 = 31_536_000;
/// exp(-0.5) in 1e18.
const EXP_NEG_HALF: u128 = 606_530_659_712_633_423;

/// Largest power index we represent (ratio^p ≤ 1e32). Long claims are capped by the pool long
/// before this, and `Contract::maybe_rebase` re-anchors the index well below it.
pub fn index_cap_e18() -> U256 {
    U256::exp10(50)
}

/// Power index `(price / ref_price)^p`, scaled 1e18, multiplied one factor at a time so p up to 10
/// stays inside U256. Saturates at `index_cap_e18()`.
pub fn power_index_e18(price: u128, ref_price: u128, p: u8) -> U256 {
    let cap = index_cap_e18();
    let mut idx = U256::from(ONE);
    for _ in 0..p {
        idx = idx * U256::from(price) / U256::from(ref_price);
        if idx >= cap {
            return cap;
        }
    }
    idx
}

/// `exp(-x)` for x scaled 1e18. Splits x into 0.5 steps, then a 4th-order
/// Taylor series on the remainder (error < 3e-4 relative at x = 0.5, far
/// smaller at the per-poke x values seen in practice).
pub fn exp_neg_e18(mut x: u128) -> u128 {
    let mut acc = ONE;
    let mut steps = 0;
    while x > ONE / 2 {
        acc = acc * EXP_NEG_HALF / ONE;
        x -= ONE / 2;
        steps += 1;
        if steps > 120 {
            return 0;
        }
    }
    let x2 = x * x / ONE;
    let x3 = x2 * x / ONE;
    let x4 = x3 * x / ONE;
    // 1 - x + x²/2 - x³/6 + x⁴/24, ordered so it never underflows (x <= 0.5).
    let t = ONE + x2 / 2 + x4 / 24 - x - x3 / 6;
    acc * t / ONE
}

/// Annual funding rate (1e18) that a power-p perpetual's longs pay under GBM:
/// `p(p-1)/2 · σ²` plus an optional base rate.
pub fn annual_funding_rate_e18(p: u8, implied_vol_bps: u32, base_bps: u32) -> u128 {
    let sigma = implied_vol_bps as u128 * ONE / BPS;
    let sigma2 = sigma * sigma / ONE;
    let coef = (p as u128) * (p as u128).saturating_sub(1) / 2;
    coef * sigma2 + base_bps as u128 * ONE / BPS
}

pub fn mul_div(a: u128, b: u128, c: u128) -> u128 {
    (U256::from(a) * U256::from(b) / U256::from(c)).as_u128()
}

/// U256 → u128, saturating instead of panicking.
pub fn sat_u128(v: U256) -> u128 {
    if v > U256::from(u128::MAX) {
        u128::MAX
    } else {
        v.as_u128()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_is_one_at_ref_and_squares() {
        assert_eq!(power_index_e18(5_000_000, 5_000_000, 2).as_u128(), ONE);
        // +10% → 1.21
        assert_eq!(power_index_e18(5_500_000, 5_000_000, 2).as_u128(), 1_210_000_000_000_000_000);
        // p = 1 is linear
        assert_eq!(power_index_e18(7_500_000, 5_000_000, 1).as_u128(), 1_500_000_000_000_000_000);
        // p = 10: +10% → 1.1^10 ≈ 2.5937
        let v = power_index_e18(5_500_000, 5_000_000, 10).as_u128();
        assert!(v.abs_diff(2_593_742_460_100_000_000) < 1_000, "{v}");
        // an absurd ratio saturates instead of overflowing
        assert_eq!(power_index_e18(1_000_000_000_000, 1, 10), index_cap_e18());
    }

    #[test]
    fn exp_neg_matches_reference() {
        let cases: [(u128, f64); 5] = [(0, 1.0), (ONE / 1000, 0.999000499833375), (ONE / 4, 0.7788007830714049), (ONE, 0.36787944117144233), (3 * ONE, 0.049787068367863944)];
        for (x, want) in cases {
            let got = exp_neg_e18(x) as f64 / ONE as f64;
            assert!((got - want).abs() / want < 5e-4, "x={x} got={got} want={want}");
        }
    }

    #[test]
    fn funding_rate_p2_vol80() {
        // σ = 80% → σ² = 0.64/yr for p = 2
        assert_eq!(annual_funding_rate_e18(2, 8_000, 0), 640_000_000_000_000_000);
        // p = 1 has no convexity → zero fair funding
        assert_eq!(annual_funding_rate_e18(1, 8_000, 0), 0);
        // p = 3 → 3σ²
        assert_eq!(annual_funding_rate_e18(3, 8_000, 0), 1_920_000_000_000_000_000);
    }
}
