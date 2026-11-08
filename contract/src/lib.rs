use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::{I128, U128};
use near_sdk::{env, log, near, require, AccountId, PanicOnDefault};
use std::collections::HashMap;

/// Amounts/prices are USDC raw units (6 decimals), u128.
/// `size` is signed base units: positive = long, negative = short.
#[derive(
    BorshSerialize, BorshDeserialize, serde::Serialize, serde::Deserialize, Clone, PartialEq,
)]
pub struct Position {
    pub owner: AccountId,
    pub size: i128,
    pub entry_price: u128,
    pub margin: u128,
    pub is_open: bool,
}

/// Result of a liquidation: PnL at mark, remaining owner equity
/// (clamped at zero) and the liquidator's reward share.
#[derive(
    BorshSerialize, BorshDeserialize, serde::Serialize, serde::Deserialize, Clone, PartialEq, Debug,
)]
pub struct LiquidationResult {
    pub pnl: i128,          // size * (mark - entry), USDC raw 6dp
    pub owner_equity: u128, // max(0, margin + pnl) - reward, USDC raw 6dp
    pub liquidator_reward: u128,
}

#[derive(
    BorshSerialize, BorshDeserialize, serde::Serialize, serde::Deserialize, Clone, PartialEq, Debug,
)]
pub struct Stats {
    pub open_positions: u64,
    pub total_notional: u128, // sum |size| * mark, USDC raw 6dp
    pub total_margin: u128,   // sum of open margins, USDC raw 6dp
    pub funding_bps: i128,    // current per-interval funding rate
    pub last_funding_ts: u64, // unix seconds
}

const MIN_MARGIN: u128 = 1_000_000; // 1 USDC minimum collateral
/// Maintenance margin: liquidate when equity (margin + unrealized PnL)
/// falls below LIQ_BPS of notional at the mark price.
/// For a 10x position (10% margin) that means ~5% adverse move before
/// liquidation — the standard perpetual model.
const LIQ_BPS: u128 = 500;
/// Max leverage: margin must be at least 1/10 of notional.
const MAX_LEVERAGE: u128 = 10;
/// Share of the liquidated position's remaining equity paid to the
/// liquidator as an incentive (50%). The rest stays claimable by the owner.
const LIQ_PENALTY_BPS: u128 = 5_000;
/// Mark price may not deviate more than 20% from the last stored mark.
const MAX_MARK_DEVIATION_BPS: u128 = 2_000;
/// A stale mark (no update for 1h) accepts up to 50% deviation, so the
/// feed can re-anchor after a real gap. Fresh marks stay at 20%.
const STALE_MARK_SECONDS: u64 = 3_600;
const STALE_MARK_DEVIATION_BPS: u128 = 5_000;
/// Funding may only be applied at most once per hour.
const MIN_FUNDING_INTERVAL_SECONDS: u64 = 3_600;
/// Funding per interval may not move more than this share of margin
/// away from a position in a single application (10%).
const MAX_FUNDING_MARGIN_BPS: u128 = 1_000;

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct LeveragedPositions {
    positions: HashMap<AccountId, Position>,
    mark_price: u128,  // USDC raw 6dp, 0 = not set
    mark_ts: u64,      // unix seconds
    funding_bps: i128, // per-interval funding rate, bps (positive = longs pay)
    last_funding_ts: u64,
}

#[near]
impl LeveragedPositions {
    #[init]
    pub fn new() -> Self {
        Self {
            positions: HashMap::new(),
            mark_price: 0,
            mark_ts: 0,
            funding_bps: 0,
            last_funding_ts: 0,
        }
    }

    // ─────────────────────────── PRICE FEED ───────────────────────────

    /// Anyone may refresh the mark price (median of external feeds,
    /// e.g. from a price feed service). Guarded: must be within 20%
    /// of the last stored mark (50% if the stored mark is stale),
    /// so a single bad reading can never wreck the risk state.
    /// This is the on-chain source of truth for risk, so
    /// liquidations survive even if the price feed or an external
    /// chain is down — any client can feed a fresh one.
    pub fn update_mark(&mut self, mark: u128) {
        require!(mark > 0, "mark must be > 0");
        let last = self.mark_price;
        if last > 0 {
            let now = env::block_timestamp() / 1_000_000_000;
            let stale = self.mark_ts > 0 && now >= self.mark_ts + STALE_MARK_SECONDS;
            let max_dev_bps = if stale {
                STALE_MARK_DEVIATION_BPS
            } else {
                MAX_MARK_DEVIATION_BPS
            };
            let diff = if mark > last {
                mark - last
            } else {
                last - mark
            };
            require!(
                diff * 10_000 <= last * max_dev_bps,
                "mark deviates too far from last stored mark"
            );
        }
        self.mark_price = mark;
        self.mark_ts = env::block_timestamp() / 1_000_000_000;
        log!(
            "{}",
            format!(
                r#"{{"event":"mark","mark":{},"ts":{}}}"#,
                self.mark_price, self.mark_ts
            )
        );
    }

    pub fn get_mark(&self) -> (u128, u64) {
        (self.mark_price, self.mark_ts)
    }

    // ─────────────────────────── POSITION LIFECYCLE ───────────────────────────

    /// Open (or re-open) a leveraged position.
    /// size: signed base units (+long / -short). price & margin: USDC raw units (6dp).
    /// Enforces MAX_LEVERAGE: margin must cover at least 1/10 of notional.
    pub fn open_position(&mut self, size: i128, price: u128, margin: u128) {
        let caller: AccountId = env::predecessor_account_id();
        require!(size != 0, "size must be non-zero");
        require!(price > 0, "price must be > 0");
        require!(margin >= MIN_MARGIN, "margin below minimum");
        let notional = size.unsigned_abs() * price;
        require!(
            margin * MAX_LEVERAGE >= notional,
            "margin below 1/10 of notional (max leverage 10x)"
        );
        self.positions.insert(
            caller.clone(),
            Position {
                owner: caller.clone(),
                size,
                entry_price: price,
                margin,
                is_open: true,
            },
        );
        log!(
            "{}",
            format!(
                r#"{{"event":"open","account":"{}","size":{},"price":{},"margin":{}}}"#,
                caller, size, price, margin
            )
        );
    }

    /// Record the ACTUAL solver fill price for the caller's position
    /// (e.g. from a 1Click intent quote: USDC-in / wNEAR-out).
    /// Only the position owner, while the position is open.
    /// PnL on close is then computed from this real fill price.
    pub fn settle_entry(&mut self, fill_price: u128) {
        let caller: AccountId = env::predecessor_account_id();
        let pos = self.positions.get(&caller).expect("no position");
        require!(pos.is_open, "position not open");
        require!(fill_price > 0, "fill price must be > 0");
        self.positions
            .entry(caller.clone())
            .and_modify(|p| p.entry_price = fill_price);
        log!(
            "{}",
            format!(
                r#"{{"event":"fill","account":"{}","fill_price":{}}}"#,
                caller, fill_price
            )
        );
    }

    /// Close the caller's position at the ON-CHAIN mark price.
    /// Used by intent-routed liquidation: the solver executes the
    /// hedge swap off-chain (via the 1Click intent) and the accounting
    /// is settled against the on-chain mark — no external feed needed.
    pub fn close_position_at_mark(&mut self) -> I128 {
        require!(self.mark_price > 0, "no mark price set");
        self.close_position(self.mark_price)
    }

    /// Close the caller's position at `exit_price` (USDC raw 6dp).
    /// Returns PnL = size * (exit - entry) in USDC raw units.
    pub fn close_position(&mut self, exit_price: u128) -> I128 {
        let caller: AccountId = env::predecessor_account_id();
        require!(exit_price > 0, "exit price must be > 0");
        let pos = self.positions.get(&caller).expect("no position");
        require!(pos.is_open, "position already closed");
        let pnl = pos.size * (exit_price as i128 - pos.entry_price as i128);
        self.positions
            .entry(caller.clone())
            .and_modify(|p| p.is_open = false);
        log!(
            "{}",
            format!(
                r#"{{"event":"close","account":"{}","exit_price":{},"pnl":{}}}"#,
                caller, exit_price, pnl
            )
        );
        I128(pnl)
    }

    // ─────────────────────────── RISK / LIQUIDATION ───────────────────────────

    /// Liquidate `account_id` at the ON-CHAIN mark price.
    /// This is the congestion-proof path: it only needs NEAR.
    pub fn liquidate_on_mark(&mut self, account_id: AccountId) -> LiquidationResult {
        require!(self.mark_price > 0, "no mark price set");
        self.liquidate(account_id, self.mark_price)
    }

    /// Liquidate `account_id` when its equity (margin + unrealized PnL)
    /// is below LIQ_BPS (5%) of the notional at `mark_price`.
    /// PnL = size * (mark - entry), so longs liquidate on drops,
    /// shorts on rises. Anyone may call.
    /// The liquidator earns LIQ_PENALTY_BPS (50%) of the position's
    /// remaining equity as a reward — the rest stays with the owner.
    pub fn liquidate(&mut self, account_id: AccountId, mark_price: u128) -> LiquidationResult {
        require!(mark_price > 0, "mark price must be > 0");
        let pos = self.positions.get(&account_id).expect("no position");
        require!(pos.is_open, "not open");
        let pnl = pos.size * (mark_price as i128 - pos.entry_price as i128);
        let equity = pos.margin as i128 + pnl;
        // Liquidatable when equity*10_000 < notional*LIQ_BPS (i.e. equity < 5% of notional).
        let threshold = (pos.size.unsigned_abs() * mark_price) as i128 * LIQ_BPS as i128;
        require!(
            equity * 10_000 < threshold,
            "position healthy, not liquidatable"
        );
        // Reward split on the remaining (clamped) equity.
        let remaining = if equity > 0 { equity as u128 } else { 0 };
        let reward = remaining * LIQ_PENALTY_BPS / 10_000;
        self.positions
            .entry(account_id.clone())
            .and_modify(|p| p.is_open = false);
        log!(
            "{}",
            format!(
                r#"{{"event":"liquidate","account":"{}","liquidator":"{}","mark":{},"pnl":{},"reward":{}}}"#,
                account_id,
                env::predecessor_account_id(),
                mark_price,
                pnl,
                reward
            )
        );
        LiquidationResult {
            pnl,
            owner_equity: remaining - reward,
            liquidator_reward: reward,
        }
    }

    // ─────────────────────────── FUNDING ───────────────────────────

    /// Set the per-interval funding rate (bps; positive = longs pay shorts).
    /// Typically an off-chain oracle computes 0.01% × sign(premium) per
    /// interval from mark vs index and pushes it here.
    pub fn set_funding_rate(&mut self, funding_bps: i128) {
        require!(
            funding_bps.abs() <= 1_000,
            "funding rate capped at ±10% per interval"
        );
        self.funding_bps = funding_bps;
        log!(
            "{}",
            format!(
                r#"{{"event":"funding_rate","funding_bps":{}}}"#,
                funding_bps
            )
        );
    }

    /// Apply the current funding rate to ALL open positions (at most
    /// once per hour). delta = size * mark * funding_bps / 10_000 —
    /// longs with positive funding pay, shorts receive (and vice versa).
    /// Delta is clamped to MAX_FUNDING_MARGIN_BPS (10%) of each position's
    /// margin, and margin is floored at zero (a wiped position then
    /// liquidates through the normal mark-based path).
    pub fn apply_funding(&mut self) -> U128 {
        require!(self.mark_price > 0, "no mark price set");
        let now = env::block_timestamp() / 1_000_000_000;
        require!(
            self.last_funding_ts == 0 || now >= self.last_funding_ts + MIN_FUNDING_INTERVAL_SECONDS,
            "funding interval not elapsed"
        );
        let mut total_abs: u128 = 0;
        for (account, pos) in self.positions.iter_mut().filter(|p| p.1.is_open) {
            let delta = position_funding_delta(pos, self.mark_price, self.funding_bps);
            let clamped = clamp_funding_delta(delta, pos.margin);
            pos.margin = adjust_margin(pos.margin, clamped);
            total_abs += clamped.unsigned_abs();
            log!(
                "{}",
                format!(
                    r#"{{"event":"funding","account":"{}","delta":{}}}"#,
                    account, clamped
                )
            );
        }
        self.last_funding_ts = now;
        U128(total_abs)
    }

    // ─────────────────────────── VIEWS ───────────────────────────

    pub fn get_position(&self, account_id: AccountId) -> Option<Position> {
        self.positions.get(&account_id).cloned()
    }

    pub fn get_positions(&self) -> Vec<Position> {
        self.positions.values().cloned().collect()
    }

    /// View: what a liquidation at the current mark would return
    /// (no state change). Useful for UI risk panels.
    pub fn preview_liquidation(&self, account_id: AccountId) -> Option<LiquidationResult> {
        let pos = self.positions.get(&account_id)?;
        if !pos.is_open || self.mark_price == 0 {
            return None;
        }
        let pnl = pos.size * (self.mark_price as i128 - pos.entry_price as i128);
        let equity = pos.margin as i128 + pnl;
        let threshold = (pos.size.unsigned_abs() * self.mark_price) as i128 * LIQ_BPS as i128;
        if equity * 10_000 >= threshold {
            return None; // healthy
        }
        let remaining = if equity > 0 { equity as u128 } else { 0 };
        let reward = remaining * LIQ_PENALTY_BPS / 10_000;
        Some(LiquidationResult {
            pnl,
            owner_equity: remaining - reward,
            liquidator_reward: reward,
        })
    }

    pub fn get_stats(&self) -> Stats {
        let mut open_positions = 0u64;
        let mut total_notional: u128 = 0;
        let mut total_margin: u128 = 0;
        for p in self.positions.values() {
            if p.is_open {
                open_positions += 1;
                total_notional += p.size.unsigned_abs() * self.mark_price;
                total_margin += p.margin;
            }
        }
        Stats {
            open_positions,
            total_notional,
            total_margin,
            funding_bps: self.funding_bps,
            last_funding_ts: self.last_funding_ts,
        }
    }

    /// View: current per-interval funding rate (bps; positive = longs pay).
    pub fn funding_rate_bps(&self) -> I128 {
        I128(self.funding_bps)
    }

    /// View: liquidator's cut of the remaining equity, in bps (5000 = 50%).
    pub fn liquidator_reward_bps(&self) -> U128 {
        U128(LIQ_PENALTY_BPS)
    }

    /// View: params needed by the risk panel in one round-trip.
    pub fn get_params(&self) -> serde_json::Value {
        serde_json::json!({
            "liq_bps": LIQ_BPS,
            "max_leverage": MAX_LEVERAGE,
            "min_margin": MIN_MARGIN,
            "liq_penalty_bps": LIQ_PENALTY_BPS,
            "max_mark_deviation_bps": MAX_MARK_DEVIATION_BPS,
            "stale_mark_seconds": STALE_MARK_SECONDS,
            "stale_mark_deviation_bps": STALE_MARK_DEVIATION_BPS,
            "min_funding_interval_seconds": MIN_FUNDING_INTERVAL_SECONDS,
            "max_funding_margin_bps": MAX_FUNDING_MARGIN_BPS,
        })
    }
}

/// Funding delta for a position at `mark` with rate `funding_bps`.
/// Positive = position PAYS (a long under positive funding), negative = receives.
fn position_funding_delta(pos: &Position, mark: u128, funding_bps: i128) -> i128 {
    let notional = pos.size.unsigned_abs() as i128 * mark as i128;
    // size>0 (long) pays positive funding; size<0 (short) receives it.
    let sign = if pos.size >= 0 { 1 } else { -1 };
    sign * notional * funding_bps as i128 / 10_000
}

fn clamp_funding_delta(delta: i128, margin: u128) -> i128 {
    let max_move = margin as i128 * MAX_FUNDING_MARGIN_BPS as i128 / 10_000;
    delta.clamp(-max_move, max_move)
}

fn adjust_margin(margin: u128, delta: i128) -> u128 {
    let m = margin as i128 - delta; // positive delta (paying) reduces margin
    if m < 0 {
        0
    } else {
        m as u128
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;

    fn ctx(account: &str, predecessor: &str) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(account.parse().unwrap())
            .signer_account_id(account.parse().unwrap())
            .predecessor_account_id(predecessor.parse().unwrap());
        near_sdk::testing_env!(b.build());
    }

    fn ctx_at(account: &str, predecessor: &str, ts_nanos: u64) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(account.parse().unwrap())
            .signer_account_id(account.parse().unwrap())
            .predecessor_account_id(predecessor.parse().unwrap())
            .block_timestamp(ts_nanos);
        near_sdk::testing_env!(b.build());
    }

    // USDC raw: $20 = 20_000_000

    #[test]
    fn open_get_close_loop() {
        ctx("bob.testnet", "bob.testnet");
        let mut c = LeveragedPositions::new();
        // long 1000 @ $20, margin $400k = 2% of notional ($20M) -> 50x? no:
        // notional = 1000 * 20_000_000 = 20_000_000_000 ($20M); margin 100_000_000 = $100k -> 200x
        // That now violates MAX_LEVERAGE. Use margin = 2_000_000_000 ($2M = 10% = exactly 10x).
        c.open_position(1_000, 20_000_000, 2_000_000_000);
        let p = c
            .get_position("bob.testnet".parse().unwrap())
            .expect("position missing");
        assert!(p.is_open && p.size == 1_000 && p.margin == 2_000_000_000);
        let pnl = c.close_position(21_000_000).0; // close @ $21 => +$1 x 1000 = $1,000
        assert_eq!(pnl, 1_000_000_000); // 1,000 USDC raw
        let p2 = c
            .get_position("bob.testnet".parse().unwrap())
            .expect("position missing");
        assert!(!p2.is_open);
    }

    #[test]
    #[should_panic(expected = "max leverage")]
    fn max_leverage_enforced() {
        ctx("bob.testnet", "bob.testnet");
        let mut c = LeveragedPositions::new();
        // notional = 1000 * 20_000_000 = 20B; margin 1B = 5% = 20x -> rejected
        c.open_position(1_000, 20_000_000, 1_000_000_000);
    }

    #[test]
    fn exactly_ten_x_allowed() {
        ctx("bob.testnet", "bob.testnet");
        let mut c = LeveragedPositions::new();
        // exactly 10x (10% margin) is allowed
        c.open_position(1_000, 20_000_000, 2_000_000_000);
        assert!(
            c.get_position("bob.testnet".parse().unwrap())
                .unwrap()
                .is_open
        );
    }

    #[test]
    fn settle_entry_uses_real_fill_price() {
        ctx("bob.testnet", "bob.testnet");
        let mut c = LeveragedPositions::new();
        c.open_position(10, 3_650_000, 36_500_000); // 10x: notional 36.5M, margin 36.5M*0.1
        c.settle_entry(3_660_000); // actual solver fill was $3.66
        let p = c.get_position("bob.testnet".parse().unwrap()).unwrap();
        assert_eq!(p.entry_price, 3_660_000);
        let pnl = c.close_position(3_831_000).0; // close @ $3.831
        assert_eq!(pnl, 10 * (3_831_000 - 3_660_000)); // based on REAL fill
    }

    #[test]
    #[should_panic(expected = "position not open")]
    fn settle_entry_rejected_when_closed() {
        ctx("bob.testnet", "bob.testnet");
        let mut c = LeveragedPositions::new();
        c.open_position(10, 3_650_000, 36_500_000);
        c.close_position(3_650_000);
        c.settle_entry(4_000_000);
    }

    #[test]
    fn mark_price_updates_and_guards() {
        ctx("alice.testnet", "alice.testnet");
        let mut c = LeveragedPositions::new();
        c.update_mark(3_600_000); // first mark always accepted
        assert_eq!(c.get_mark().0, 3_600_000);
        c.update_mark(3_670_000); // +2%: fine
        assert_eq!(c.get_mark().0, 3_670_000);
        c.update_mark(4_000_000); // +9%: fine
        assert_eq!(c.get_mark().0, 4_000_000);
    }

    #[test]
    #[should_panic(expected = "mark deviates too far")]
    fn mark_price_deviation_guard() {
        ctx("alice.testnet", "alice.testnet");
        let mut c = LeveragedPositions::new();
        c.update_mark(3_600_000);
        c.update_mark(5_000_000); // +39% on a FRESH mark: rejected
    }

    #[test]
    fn liquidation_uses_onchain_mark() {
        // Congestion-proof path: liquidation reads the ON-CHAIN mark,
        // so it works even if every external price feed is down.
        ctx("alice.testnet", "alice.testnet");
        let mut c = LeveragedPositions::new();
        // 10x long: notional $200k, margin $20k (10%)
        c.open_position(1_000, 200_000_000, 20_000_000_000);
        c.update_mark(180_000_000); // price fell 10% (within 20% feed guard)
        assert_eq!(c.get_mark().0, 180_000_000);
        ctx("carol.testnet", "carol.testnet");
        // liquidate_on_mark reads mark from state, not from args
        let r = c.liquidate_on_mark("alice.testnet".parse().unwrap());
        assert_eq!(r.pnl, 1_000 * (180_000_000 - 200_000_000)); // PnL at on-chain mark
        assert!(
            !c.get_position("alice.testnet".parse().unwrap())
                .unwrap()
                .is_open
        );
    }

    #[test]
    #[should_panic(expected = "no mark price set")]
    fn liquidate_on_mark_requires_mark() {
        ctx("alice.testnet", "alice.testnet");
        let mut c = LeveragedPositions::new();
        c.open_position(1_000, 200_000_000, 20_000_000_000);
        c.liquidate_on_mark("alice.testnet".parse().unwrap());
    }

    #[test]
    #[should_panic(expected = "margin below minimum")]
    fn rejects_tiny_margin() {
        ctx("bob.testnet", "bob.testnet");
        let mut c = LeveragedPositions::new();
        c.open_position(1_000, 20_000_000, 1);
    }

    #[test]
    fn liquidation_when_underwater() {
        ctx("alice.testnet", "alice.testnet");
        let mut c = LeveragedPositions::new();
        // 10x long: notional $200k, margin $20k
        c.open_position(1_000, 200_000_000, 20_000_000_000);
        ctx("carol.testnet", "carol.testnet");
        let r = c.liquidate("alice.testnet".parse().unwrap(), 182_000_000);
        // price fell 8.9%: equity = $20k - $17.8k = $2.2k < 5% of $182k notional
        assert_eq!(r.pnl, 1_000 * (182_000_000 - 200_000_000));
        let p = c
            .get_position("alice.testnet".parse().unwrap())
            .expect("position missing");
        assert!(!p.is_open);
    }

    #[test]
    fn liquidation_reward_split() {
        ctx("alice.testnet", "alice.testnet");
        let mut c = LeveragedPositions::new();
        // 10x long: notional $200k, margin $20k
        c.open_position(1_000, 200_000_000, 20_000_000_000);
        ctx("carol.testnet", "carol.testnet");
        let r = c.liquidate("alice.testnet".parse().unwrap(), 182_000_000);
        // equity = 20_000_000_000 - 18_000_000_000 = 2_000_000_000 ($2k)
        // reward = 50% = 1_000_000_000; owner keeps the rest
        assert_eq!(r.liquidator_reward, 1_000_000_000);
        assert_eq!(r.owner_equity, 1_000_000_000);
    }

    #[test]
    fn liquidation_reward_zero_when_bust() {
        ctx("alice.testnet", "alice.testnet");
        let mut c = LeveragedPositions::new();
        // 10x long, 2% margin (20x? no — 2% margin = 50x > MAX_LEVERAGE)
        // Use a position that is allowed: 10x, then mark crashes to wipe equity.
        c.open_position(1_000, 200_000_000, 20_000_000_000);
        c.update_mark(160_000_000); // -20%: pnl = -40k, equity = -20k -> bust
        ctx("carol.testnet", "carol.testnet");
        let r = c.liquidate_on_mark("alice.testnet".parse().unwrap());
        assert_eq!(r.liquidator_reward, 0);
        assert_eq!(r.owner_equity, 0);
        assert!(r.pnl < 0);
    }

    #[test]
    fn preview_liquidation_healthy_returns_none() {
        ctx("alice.testnet", "alice.testnet");
        let mut c = LeveragedPositions::new();
        c.open_position(1_000, 200_000_000, 20_000_000_000);
        c.update_mark(199_000_000); // tiny drop: still healthy
        assert!(c
            .preview_liquidation("alice.testnet".parse().unwrap())
            .is_none());
    }

    #[test]
    fn preview_liquidation_underwater_matches_liquidate() {
        ctx("alice.testnet", "alice.testnet");
        let mut c = LeveragedPositions::new();
        c.open_position(1_000, 200_000_000, 20_000_000_000);
        c.update_mark(182_000_000);
        let prev = c
            .preview_liquidation("alice.testnet".parse().unwrap())
            .expect("should be liquidatable");
        assert_eq!(prev.pnl, 1_000 * (182_000_000 - 200_000_000));
        // preview does NOT mutate state
        assert!(
            c.get_position("alice.testnet".parse().unwrap())
                .unwrap()
                .is_open
        );
        ctx("carol.testnet", "carol.testnet");
        let real = c.liquidate_on_mark("alice.testnet".parse().unwrap());
        assert_eq!(real, prev);
    }

    #[test]
    #[should_panic(expected = "position healthy")]
    fn ten_x_position_healthy_at_entry() {
        // A 10x position (10% margin) must NOT be liquidatable at the entry
        // price — with a 5% maintenance floor it survives ~5% adverse move.
        ctx("alice.testnet", "alice.testnet");
        let mut c = LeveragedPositions::new();
        c.open_position(1_000, 200_000_000, 20_000_000_000); // 10x long
        ctx("carol.testnet", "carol.testnet");
        let _ = c.liquidate("alice.testnet".parse().unwrap(), 200_000_000);
    }

    #[test]
    #[should_panic(expected = "position healthy")]
    fn no_liquidation_when_healthy() {
        ctx("alice.testnet", "alice.testnet");
        let mut c = LeveragedPositions::new();
        c.open_position(1_000, 200_000_000, 100_000_000_000); // 50% margin >= 5% floor
        ctx("carol.testnet", "carol.testnet");
        let _ = c.liquidate("alice.testnet".parse().unwrap(), 200_000_000);
    }

    #[test]
    fn funding_long_pays_on_rise() {
        // Long position, positive funding: long pays, margin decreases.
        ctx_at("alice.testnet", "alice.testnet", 2_000_000_000_000_000_000);
        let mut c = LeveragedPositions::new();
        c.open_position(1_000, 200_000_000, 20_000_000_000); // 10x long, notional $200k at mark
        c.update_mark(200_000_000);
        c.set_funding_rate(1); // 0.01% per interval
        ctx_at(
            "keeper.testnet",
            "keeper.testnet",
            2_000_000_000_000_000_000 + 3_600_000_000_000,
        ); // +1h
        let total = c.apply_funding().0;
        // delta = 1000 * 200_000_000 * 1 / 10_000 = 20_000_000 ($20 of $200k... check: 200M*1000=200B; *1/10_000 = 20M raw = $20)
        assert_eq!(total, 20_000_000);
        let p = c.get_position("alice.testnet".parse().unwrap()).unwrap();
        assert_eq!(p.margin, 20_000_000_000 - 20_000_000); // margin reduced by $20
    }

    #[test]
    fn funding_short_receives_on_positive_rate() {
        // Short position, positive funding: short receives, margin increases.
        ctx_at("alice.testnet", "alice.testnet", 2_000_000_000_000_000_000);
        let mut c = LeveragedPositions::new();
        c.open_position(-1_000, 200_000_000, 20_000_000_000); // 10x short
        c.update_mark(200_000_000);
        c.set_funding_rate(1);
        ctx_at(
            "keeper.testnet",
            "keeper.testnet",
            2_000_000_000_000_000_000 + 3_600_000_000_000,
        );
        c.apply_funding();
        let p = c.get_position("alice.testnet".parse().unwrap()).unwrap();
        assert_eq!(p.margin, 20_000_000_000 + 20_000_000);
    }

    #[test]
    fn funding_negative_rate_inverts_flow() {
        // Positive funding on a long = long pays. Negative funding = long receives.
        ctx_at("alice.testnet", "alice.testnet", 2_000_000_000_000_000_000);
        let mut c = LeveragedPositions::new();
        c.open_position(1_000, 200_000_000, 20_000_000_000);
        c.update_mark(200_000_000);
        c.set_funding_rate(-1);
        ctx_at(
            "keeper.testnet",
            "keeper.testnet",
            2_000_000_000_000_000_000 + 3_600_000_000_000,
        );
        c.apply_funding();
        let p = c.get_position("alice.testnet".parse().unwrap()).unwrap();
        assert_eq!(p.margin, 20_000_000_000 + 20_000_000); // long received
    }

    #[test]
    #[should_panic(expected = "funding interval not elapsed")]
    fn funding_rate_limits_interval() {
        ctx_at("alice.testnet", "alice.testnet", 2_000_000_000_000_000_000);
        let mut c = LeveragedPositions::new();
        c.open_position(1_000, 200_000_000, 20_000_000_000);
        c.update_mark(200_000_000);
        c.set_funding_rate(1);
        ctx_at(
            "keeper.testnet",
            "keeper.testnet",
            2_000_000_000_000_000_000 + 100_000_000_000,
        ); // +100s
        c.apply_funding();
        c.apply_funding(); // same "hour": rejected
    }

    #[test]
    #[should_panic(expected = "funding rate capped")]
    fn funding_rate_cap() {
        ctx("alice.testnet", "alice.testnet");
        let mut c = LeveragedPositions::new();
        c.set_funding_rate(1_001);
    }

    #[test]
    fn funding_clamped_to_margin_and_floored_at_zero() {
        // A rate large enough to wipe all margin: delta clamped to 10% of margin,
        // and margin can never go negative.
        ctx_at("alice.testnet", "alice.testnet", 2_000_000_000_000_000_000);
        let mut c = LeveragedPositions::new();
        // 10x long, notional $200k, margin $20k (10%)
        c.open_position(1_000, 200_000_000, 20_000_000_000);
        c.update_mark(200_000_000);
        c.set_funding_rate(1_000); // max: 10% of notional per interval = $20k delta
        ctx_at(
            "keeper.testnet",
            "keeper.testnet",
            2_000_000_000_000_000_000 + 3_600_000_000_000,
        );
        c.apply_funding();
        // raw delta = 1000*200_000_000*1000/10_000 = 20_000_000_000 ($20k = 100% of margin)
        // clamp = 10% of $20k margin = 2_000_000_000 ($2k)
        let p = c.get_position("alice.testnet".parse().unwrap()).unwrap();
        assert_eq!(p.margin, 20_000_000_000 - 2_000_000_000);
    }

    #[test]
    fn funding_never_wipes_margin_below_zero() {
        // Repeated applications over many hours can never push margin below zero.
        ctx_at("alice.testnet", "alice.testnet", 2_000_000_000_000_000_000);
        let mut c = LeveragedPositions::new();
        c.open_position(1_000, 200_000_000, 20_000_000_000);
        c.update_mark(200_000_000);
        c.set_funding_rate(1_000);
        for h in 1..=5u64 {
            ctx_at(
                "keeper.testnet",
                "keeper.testnet",
                2_000_000_000_000_000_000 + h * 3_600_000_000_000,
            );
            c.apply_funding();
        }
        // clamp is 10% of CURRENT margin, which shrinks each hour:
        // after 5 hours: 20k * 0.9^5 = 11_809_800_000, never negative
        let p = c.get_position("alice.testnet".parse().unwrap()).unwrap();
        assert_eq!(p.margin, 11_809_800_000);
    }

    #[test]
    fn stats_aggregate_open_positions() {
        ctx("alice.testnet", "alice.testnet");
        let mut c = LeveragedPositions::new();
        c.open_position(1_000, 200_000_000, 20_000_000_000);
        ctx("bob.testnet", "bob.testnet");
        c.open_position(-500, 200_000_000, 10_000_000_000);
        c.update_mark(200_000_000);
        let s = c.get_stats();
        assert_eq!(s.open_positions, 2);
        assert_eq!(s.total_notional, 1_500 * 200_000_000);
        assert_eq!(s.total_margin, 30_000_000_000);
        c.close_position(200_000_000); // alice closes
        let s2 = c.get_stats();
        assert_eq!(s2.open_positions, 1);
    }
}
