// PRISM Position Ledger — v5 (original-design architecture)
//
// The on-chain Position Ledger is the SINGLE SOURCE OF TRUTH for all positions.
// There is no vault, no matching engine and no operator state:
//
//   * Positions are matched against OPPOSING EXPOSURE. Two logical pools —
//     long margin pool and short margin pool — hold the posted margin and only
//     transfer value between each other. Nothing is created.
//   * PnL on close: the winner is paid OUT OF THE LOSER'S margin, capped by the
//     margin that actually sits in the losing pool. If the opposing pool is
//     empty (the other side was fully liquidated), the close returns margin
//     only — the remaining side stops earning PnL from capital that is gone.
//   * Opens/closes are expressed as INTENTS: `request_open` / `request_close`
//     create a pending intent, an Intent Settlement Adapter (or any registered
//     solver) calls `settle_intent` with the real 1Click fill price, and only
//     then does the ledger move and the pool move.
//   * The Risk & Liquidation Engine reads this ledger + the on-chain mark.
//     `liquidate` is evaluated at the STORED mark (never a caller-supplied
//     price), callable by registered solvers only. Works even when every
//     external chain/feed is congested: the decision lives on NEAR.
//
// Funding payments are intentionally NOT in v5 (added later).
//
// Units: prices & amounts are USDC raw units (6 decimals), u128.
// `size` is signed base units (integer wNEAR): positive = long, negative = short.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::{I128, U128, U64};
use near_sdk::{env, log, near, require, AccountId, PanicOnDefault};
use std::collections::HashMap;

// ─────────────────────────── CONSTANTS ───────────────────────────

const MIN_MARGIN: u128 = 1_000_000; // 1 USDC minimum collateral
/// Maintenance margin: liquidate when equity (margin + unrealized PnL)
/// falls below LIQ_BPS of notional at the mark price. For a 10x position
/// (10% margin) that is ~5% adverse move — the standard perpetual model.
const LIQ_BPS: u128 = 500;
/// Max leverage: margin must be at least 1/10 of notional.
const MAX_LEVERAGE: u128 = 10;
/// A settle fill must be within this band of the intent's reference price
/// (10%), so a solver cannot report a fake fill.
const FILL_BAND_BPS: u128 = 1_000;
/// Intents expire after 15 minutes.
const INTENT_TTL_SECONDS: u64 = 900;
/// Mark price may not deviate more than 20% from the last stored mark.
const MAX_MARK_DEVIATION_BPS: u128 = 2_000;
/// A stale mark (no update for 1h) accepts up to 50% deviation, so the
/// feed can re-anchor after a real gap. Fresh marks stay at 20%.
const STALE_MARK_SECONDS: u64 = 3_600;
const STALE_MARK_DEVIATION_BPS: u128 = 5_000;

// ─────────────────────────── TYPES ───────────────────────────

#[derive(
    BorshSerialize, BorshDeserialize, serde::Serialize, serde::Deserialize, Clone, PartialEq,
)]
pub struct Position {
    pub owner: AccountId,
    pub size: i128,      // +long / -short, base units
    pub entry_price: u128, // USDC raw 6dp (the settled solver fill)
    pub margin: u128,      // USDC raw 6dp, sitting in the side's pool
    pub is_open: bool,
}

#[derive(
    BorshSerialize, BorshDeserialize, serde::Serialize, serde::Deserialize, Clone, PartialEq,
)]
pub enum IntentKind {
    Open { size: i128, ref_price: u128, margin: u128 },
    Close { fraction_bps: u128, ref_price: u128 },
}

#[derive(
    BorshSerialize, BorshDeserialize, serde::Serialize, serde::Deserialize, Clone, PartialEq,
)]
pub struct PendingIntent {
    pub id: u64,
    pub owner: AccountId,
    pub kind: IntentKind,
    pub created_ts: u64,
    pub deadline_ts: u64,
}

#[derive(
    BorshSerialize, BorshDeserialize, serde::Serialize, serde::Deserialize, Clone, PartialEq, Debug,
)]
pub struct CloseOutcome {
    pub pnl: i128,            // realized, USDC raw 6dp
    pub margin_out: u128,     // owner's margin released
    pub flow: u128,           // pnl paid between pools (0 if no opposing capital)
    pub flow_to: String, // "long_pool" | "short_pool"
}

#[derive(
    BorshSerialize, BorshDeserialize, serde::Serialize, serde::Deserialize, Clone, PartialEq, Debug,
)]
pub struct LiquidationOutcome {
    pub account: AccountId,
    pub pnl: i128,        // at the stored mark
    pub remaining: u128,  // owner's leftover equity -> claimable
    pub to_pool: u128,    // loser's lost margin -> the opposing pool
    pub mark: u128,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct HealthInfo {
    pub equity: i128,
    pub notional: u128,
    pub margin: u128,
    pub equity_bps: i128, // equity / notional * 10_000 (can be negative)
    pub is_liquidatable: bool,
}

#[derive(
    BorshSerialize, BorshDeserialize, serde::Serialize, serde::Deserialize, Clone, PartialEq, Debug,
)]
pub struct Stats {
    pub open_positions: u64,
    pub total_notional: u128,
    pub total_margin: u128,
    pub long_pool: u128,
    pub short_pool: u128,
    pub open_intents: u64,
    pub total_pnl_transferred: u128,
    pub liquidations: u64,
    pub fills: u64,
}

// ─────────────────────────── CONTRACT ───────────────────────────

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct PositionLedger {
    positions: HashMap<AccountId, Position>,
    mark_price: u128, // USDC raw 6dp, 0 = not set
    mark_ts: u64,     // unix seconds
    /// Long/short margin pools — the only capital in the system.
    long_pool: u128,
    short_pool: u128,
    /// Pending intents awaiting a solver settle (1Click).
    intents: HashMap<u64, PendingIntent>,
    intent_seq: u64,
    /// Registered solvers (Intent Settlement Adapters). Only solvers may
    /// call `settle_intent` and `liquidate`; trading requests are open.
    solvers: HashMap<AccountId, ()>,
    /// Owner's equity left over after a liquidation, claimable via `claim`.
    claimable: HashMap<AccountId, u128>,
    total_pnl_transferred: u128,
    liquidations: u64,
    fills: u64,
    owner: AccountId,
    price_pusher: Option<AccountId>,
}
#[near]
impl PositionLedger {
    #[init]
    pub fn new() -> Self {
        Self {
            positions: HashMap::new(),
            mark_price: 0,
            mark_ts: 0,
            long_pool: 0,
            short_pool: 0,
            intents: HashMap::new(),
            intent_seq: 0,
            solvers: HashMap::new(),
            claimable: HashMap::new(),
            total_pnl_transferred: 0,
            liquidations: 0,
            fills: 0,
            owner: env::predecessor_account_id(),
            price_pusher: None,
        }
    }

    // ─────────────── GOVERNANCE (owner) ───────────────

    /// Set (or clear) the authorized mark pusher. Owner only. `None`
    /// re-opens mark updates to anyone (testing).
    pub fn set_pusher(&mut self, price_pusher: Option<AccountId>) {
        let caller: AccountId = env::predecessor_account_id();
        require!(caller == self.owner, "not the contract owner");
        self.price_pusher = price_pusher.clone();
        log!(
            "{}",
            format!(
                r#"{{"event":"pusher","pusher":"{}"}}"#,
                price_pusher.map(|p| p.to_string()).unwrap_or_default()
            )
        );
    }

    /// Register an Intent Settlement Adapter (or any solver) that may
    /// settle intents and execute liquidations. Owner only.
    pub fn add_solver(&mut self, solver: AccountId) {
        let caller: AccountId = env::predecessor_account_id();
        require!(caller == self.owner, "not the contract owner");
        self.solvers.insert(solver.clone(), ());
        log!("{}", format!(r#"{{"event":"add_solver","solver":"{}"}}"#, solver));
    }

    pub fn remove_solver(&mut self, solver: AccountId) {
        let caller: AccountId = env::predecessor_account_id();
        require!(caller == self.owner, "not the contract owner");
        self.solvers.remove(&solver);
        log!("{}", format!(r#"{{"event":"remove_solver","solver":"{}"}}"#, solver));
    }

    fn require_pusher(&self, method: &str) {
        if let Some(ref pusher) = self.price_pusher {
            let caller: AccountId = env::predecessor_account_id();
            require!(
                caller == *pusher,
                format!("{}: caller is not the authorized price pusher", method)
            );
        }
    }

    fn require_solver(&self, method: &str) {
        let caller: AccountId = env::predecessor_account_id();
        require!(
            self.solvers.contains_key(&caller),
            format!("{}: caller is not a registered solver", method)
        );
    }

    // ─────────────── PRICE FEED ───────────────

    /// Refresh the on-chain mark (the only price input the risk engine
    /// needs). Guarded to 20% of the last mark (50% if stale), so a single
    /// bad reading can never wreck the risk state.
    pub fn update_mark(&mut self, mark: U128) {
        self.require_pusher("update_mark");
        let mark = mark.0;
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
            let diff = if mark > last { mark - last } else { last - mark };
            require!(
                diff * 10_000 <= last * max_dev_bps,
                "mark deviates too far from last stored mark"
            );
        }
        self.mark_price = mark;
        self.mark_ts = env::block_timestamp() / 1_000_000_000;
        log!("{}", format!(r#"{{"event":"mark","mark":{}}}"#, mark));
    }

    pub fn get_mark(&self) -> (u128, u64) {
        (self.mark_price, self.mark_ts)
    }

    // ─────────────── INTENT LIFECYCLE ───────────────

    /// Request an open. Creates a pending intent; the margin is NOT touched
    /// yet — it lands in the side's pool when a solver settles the intent
    /// with the real 1Click fill. Enforces MAX_LEVERAGE against ref_price.
    pub fn request_open(&mut self, owner: AccountId, size: I128, ref_price: U128, margin: U128) -> U64 {
        let size = size.0;
        let ref_price = ref_price.0;
        let margin = margin.0;
        log!("{}", format!(r#"{{"event":"dbg_request_open","owner":"{}","size":{},"ref_price":{},"margin":{}}}"#, owner, size, ref_price, margin));
        require!(size != 0, "size must be non-zero");
        require!(ref_price > 0, "ref price must be > 0");
        require!(margin >= MIN_MARGIN, "margin below minimum");
        let notional = size.unsigned_abs() * ref_price;
        require!(
            margin * MAX_LEVERAGE >= notional,
            "margin below 1/10 of notional (max leverage 10x)"
        );
        let now = env::block_timestamp() / 1_000_000_000;
        self.intent_seq += 1;
        let id = self.intent_seq;
        self.intents.insert(
            id,
            PendingIntent {
                id,
                owner: owner.clone(),
                kind: IntentKind::Open {
                    size,
                    ref_price,
                    margin,
                },
                created_ts: now,
                deadline_ts: now + INTENT_TTL_SECONDS,
            },
        );
        log!(
            "{}",
            format!(
                r#"{{"event":"intent_open","id":{},"account":"{}","size":{},"ref_price":{},"margin":{}}}"#,
                id, owner, size, ref_price, margin
            )
        );
        U64(id)
    }

    /// Request a close of `fraction_bps` (1..=10000) of the caller's open
    /// position. Partial fills are allowed. Creates a pending intent.
    pub fn request_close(&mut self, owner: AccountId, fraction_bps: U128, ref_price: U128) -> U64 {
        let fraction_bps = fraction_bps.0;
        let ref_price = ref_price.0;
        require!(ref_price > 0, "ref price must be > 0");
        require!(
            (1..=10_000).contains(&fraction_bps),
            "fraction_bps must be 1..=10000"
        );
        let pos = self.positions.get(&owner).expect("no position");
        require!(pos.is_open, "position not open");
        let close_size = pos.size * fraction_bps as i128 / 10_000;
        require!(close_size != 0, "close size rounds to zero");
        let now = env::block_timestamp() / 1_000_000_000;
        self.intent_seq += 1;
        let id = self.intent_seq;
        self.intents.insert(
            id,
            PendingIntent {
                id,
                owner: owner.clone(),
                kind: IntentKind::Close {
                    fraction_bps,
                    ref_price,
                },
                created_ts: now,
                deadline_ts: now + INTENT_TTL_SECONDS,
            },
        );
        log!(
            "{}",
            format!(
                r#"{{"event":"intent_close","id":{},"account":"{}","fraction_bps":{},"ref_price":{}}}"#,
                id, owner, fraction_bps, ref_price
            )
        );
        U64(id)
    }

    /// Owner cancels their own still-open intent.
    pub fn cancel_intent(&mut self, id: U64) {
        let caller: AccountId = env::predecessor_account_id();
        let it = self.intents.get(&id.0).expect("intent not found");
        require!(it.owner == caller, "not your intent");
        self.intents.remove(&id.0);
        log!("{}", format!(r#"{{"event":"intent_cancel","id":{}}}"#, id.0));
    }
    // ─────────────── POOL ACCOUNTING CORE ───────────────

    fn pool_of(&self, size: i128) -> &'static str {
        if size >= 0 { "long_pool" } else { "short_pool" }
    }

    /// Apply the close of `close_size` (signed, same sign as the position)
    /// at `fill_price`, moving value between the two pools only:
    ///   * winner: margin released + min(pnl, opposing pool) paid out of
    ///     the LOSER's pool — capped, so nothing is created;
    ///   * loser:  margin released minus min(loss, margin) — the loss flows
    ///     into the opposing pool (the other side's profit).
    fn apply_close(&mut self, owner: &AccountId, close_size: i128, fill_price: u128) -> CloseOutcome {
        let pos = self.positions.get(owner).expect("no position");
        require!(pos.is_open, "position not open");
        require!(
            (close_size > 0) == (pos.size > 0) && close_size.unsigned_abs() <= pos.size.unsigned_abs(),
            "close size must match position direction"
        );
        let close_size = close_size.unsigned_abs();
        // Margin released is proportional to the closed share of size.
        let margin_out = pos.margin * close_size / pos.size.unsigned_abs();
        let pnl = close_size as i128 * (fill_price as i128 - pos.entry_price as i128)
            * if pos.size > 0 { 1 } else { -1 };
        let (own_pool, opp_pool) = if pos.size > 0 {
            (&mut self.long_pool, &mut self.short_pool)
        } else {
            (&mut self.short_pool, &mut self.long_pool)
        };
        let (flow, flow_to) = if pnl > 0 {
            // Winner: paid out of the opposing pool, capped at what's there.
            let payout = (pnl as u128).min(*opp_pool);
            *own_pool = own_pool.saturating_sub(margin_out);
            *opp_pool = opp_pool.saturating_sub(payout);
            self.total_pnl_transferred += payout;
            (payout, (if pos.size > 0 { "short_pool" } else { "long_pool" }).to_string())
        } else {
            // Loser: loss capped at own released margin, flows to the
            // opposing pool.
            let loss = ((-pnl) as u128).min(margin_out);
            *own_pool = own_pool.saturating_sub(margin_out);
            *opp_pool += loss;
            self.total_pnl_transferred += loss;
            (loss, (if pos.size > 0 { "short_pool" } else { "long_pool" }).to_string())
        };
        self.positions
            .entry(owner.clone())
            .and_modify(|p| {
                p.size -= (if p.size > 0 { 1 } else { -1 }) as i128 * close_size as i128;
                p.margin = p.margin.saturating_sub(margin_out);
                if p.size == 0 {
                    p.is_open = false;
                }
            });
        log!(
            "{}",
            format!(
                r#"{{"event":"close","account":"{}","close_size":{},"fill":{},"pnl":{},"margin_out":{},"flow":{},"flow_to":"{}","long_pool":{},"short_pool":{}}}"#,
                owner, close_size, fill_price, pnl, margin_out, flow, flow_to,
                self.long_pool, self.short_pool
            )
        );
        CloseOutcome {
            pnl,
            margin_out,
            flow,
            flow_to,
        }
    }

    // ─────────────── SETTLEMENT (solvers only) ───────────────

    /// A registered solver (the Intent Settlement Adapter after the 1Click
    /// intent completed) applies the REAL fill to a pending intent.
    /// The fill must be within FILL_BAND_BPS of the intent's reference
    /// price — a solver cannot report a phantom fill.
    pub fn settle_intent(&mut self, id: U64, fill_price: U128) -> serde_json::Value {
        self.require_solver("settle_intent");
        let fill_price = fill_price.0;
        require!(fill_price > 0, "fill price must be > 0");
        let it = self.intents.remove(&id.0).expect("intent not found");
        let now = env::block_timestamp() / 1_000_000_000;
        require!(now <= it.deadline_ts, "intent expired");
        let ref_price = match &it.kind {
            IntentKind::Open { ref_price, .. } | IntentKind::Close { ref_price, .. } => *ref_price,
        };
        let diff = if fill_price > ref_price {
            fill_price - ref_price
        } else {
            ref_price - fill_price
        };
        require!(
            diff * 10_000 <= ref_price * FILL_BAND_BPS,
            "fill price outside solver band vs reference"
        );
        let outcome = match it.kind {
            IntentKind::Open { size, margin, .. } => {
                // Margin lands in the side's pool; position created/averaged
                // at the REAL fill price.
                if size > 0 {
                    self.long_pool += margin;
                } else {
                    self.short_pool += margin;
                }
                match self.positions.get(&it.owner) {
                    Some(p) if p.is_open => {
                        require!(
                            (p.size > 0) == (size > 0),
                            "close the open position first (no netting on open)"
                        );
                        let new_size = p.size + size;
                        let new_entry = (p.size * p.entry_price as i128 + size * fill_price as i128)
                            / new_size;
                        self.positions.entry(it.owner.clone()).and_modify(|p| {
                            p.size = new_size;
                            p.entry_price = new_entry as u128;
                            p.margin += margin;
                        });
                    }
                    _ => {
                        self.positions.insert(
                            it.owner.clone(),
                            Position {
                                owner: it.owner.clone(),
                                size,
                                entry_price: fill_price,
                                margin,
                                is_open: true,
                            },
                        );
                    }
                }
                self.fills += 1;
                log!(
                    "{}",
                    format!(
                        r#"{{"event":"fill_open","intent":{},"account":"{}","size":{},"fill":{},"margin":{},"long_pool":{},"short_pool":{}}}"#,
                        id.0, it.owner, size, fill_price, margin,
                        self.long_pool, self.short_pool
                    )
                );
                serde_json::json!({
                    "event": "fill_open", "intent": id.0, "account": it.owner,
                    "size": size, "fill": fill_price, "margin": margin,
                    "long_pool": self.long_pool, "short_pool": self.short_pool
                })
            }
            IntentKind::Close { fraction_bps, .. } => {
                let pos = self.positions.get(&it.owner).expect("no position to close");
                let close_size = pos.size * fraction_bps as i128 / 10_000;
                require!(close_size != 0, "close size rounds to zero");
                let o = self.apply_close(&it.owner, close_size, fill_price);
                self.fills += 1;
                serde_json::json!({
                    "event": "fill_close", "intent": id.0, "account": it.owner,
                    "close_size": close_size.unsigned_abs(), "fill": fill_price,
                    "pnl": o.pnl, "margin_out": o.margin_out, "flow": o.flow,
                    "flow_to": o.flow_to, "long_pool": self.long_pool,
                    "short_pool": self.short_pool
                })
            }
        };
        outcome
    }

    /// Direct close (no intent) of `fraction_bps` at `exit_price` —
    /// used by the risk engine and tests; same pool accounting.
    pub fn close_position(&mut self, fraction_bps: U128, exit_price: U128) -> serde_json::Value {
        let caller: AccountId = env::predecessor_account_id();
        let fraction_bps = fraction_bps.0;
        let exit_price = exit_price.0;
        require!(exit_price > 0, "exit price must be > 0");
        require!(
            (1..=10_000).contains(&fraction_bps),
            "fraction_bps must be 1..=10000"
        );
        if self.mark_price > 0 {
            let diff = if exit_price > self.mark_price {
                exit_price - self.mark_price
            } else {
                self.mark_price - exit_price
            };
            require!(
                diff * 10_000 <= self.mark_price * FILL_BAND_BPS,
                "exit price too far from on-chain mark"
            );
        }
        let pos = self.positions.get(&caller).expect("no position");
        let close_size = pos.size * fraction_bps as i128 / 10_000;
        require!(close_size != 0, "close size rounds to zero");
        let o = self.apply_close(&caller, close_size, exit_price);
        self.fills += 1;
        serde_json::json!({
            "event": "close", "account": caller, "pnl": o.pnl,
            "margin_out": o.margin_out, "flow": o.flow, "flow_to": o.flow_to,
            "long_pool": self.long_pool, "short_pool": self.short_pool
        })
    }

    // ─────────────── RISK / LIQUIDATION (solvers only) ───────────────

    /// Liquidate `account_id`, evaluated at the STORED on-chain mark —
    /// never a caller-supplied price (the v4 gap, closed). The loser's
    /// margin flows to the opposing pool; any leftover owner equity is
    /// stored claimable. Callable by registered solvers (the risk engine /
    /// adapter). Congestion-proof: only needs NEAR.
    pub fn liquidate(&mut self, account_id: AccountId) -> LiquidationOutcome {
        self.require_solver("liquidate");
        require!(self.mark_price > 0, "no mark price set");
        let pos = self.positions.get(&account_id).expect("no position");
        require!(pos.is_open, "not open");
        let mark = self.mark_price;
        let pnl = pos.size * (mark as i128 - pos.entry_price as i128);
        let equity = pos.margin as i128 + pnl;
        let notional = pos.size.unsigned_abs() * mark;
        require!(
            equity * 10_000 < notional as i128 * LIQ_BPS as i128,
            "position healthy, not liquidatable"
        );
        let remaining = if equity > 0 { equity as u128 } else { 0 };
        let to_pool = pos.margin.saturating_sub(remaining);
        if pos.size > 0 {
            // loser is long -> the short side profits
            self.short_pool += to_pool;
        } else {
            self.long_pool += to_pool;
        }
        if remaining > 0 {
            *self.claimable.entry(account_id.clone()).or_insert(0) += remaining;
        }
        self.positions
            .entry(account_id.clone())
            .and_modify(|p| {
                p.size = 0;
                p.margin = 0;
                p.is_open = false;
            });
        self.liquidations += 1;
        self.total_pnl_transferred += to_pool;
        log!(
            "{}",
            format!(
                r#"{{"event":"liquidate","account":"{}","engine":"{}","mark":{},"pnl":{},"to_pool":{},"remaining":{},"long_pool":{},"short_pool":{}}}"#,
                account_id, env::predecessor_account_id(), mark, pnl, to_pool, remaining,
                self.long_pool, self.short_pool
            )
        );
        LiquidationOutcome {
            account: account_id.clone(),
            pnl,
            remaining,
            to_pool,
            mark,
        }
    }

    /// Owner withdraws equity left over after liquidation(s). The token
    /// movement is settled by a solver intent; the ledger just clears it.
    pub fn claim(&mut self) -> U128 {
        let caller: AccountId = env::predecessor_account_id();
        let amt = self.claimable.get(&caller).copied().unwrap_or(0);
        if amt > 0 {
            self.claimable.remove(&caller);
            log!("{}", format!(r#"{{"event":"claim","account":"{}","amount":{}}}"#, caller, amt));
        }
        U128(amt)
    }
    // ─────────────── VIEWS ───────────────

    /// Health of a position at the on-chain mark: equity, notional,
    /// equity/notional in bps, and whether it is liquidatable. This is the
    /// view the Risk & Liquidation Engine reads.
    pub fn health(&self, account_id: AccountId) -> Option<HealthInfo> {
        let pos = self.positions.get(&account_id)?;
        if !pos.is_open {
            return None;
        }
        require!(self.mark_price > 0, "no mark price set");
        let mark = self.mark_price;
        let pnl = pos.size * (mark as i128 - pos.entry_price as i128);
        let equity = pos.margin as i128 + pnl;
        let notional = pos.size.unsigned_abs() * mark;
        let is_liquidatable = equity * 10_000 < notional as i128 * LIQ_BPS as i128;
        let equity_bps = if notional > 0 {
            equity * 10_000 / notional as i128
        } else {
            0
        };
        Some(HealthInfo {
            equity,
            notional,
            margin: pos.margin,
            equity_bps,
            is_liquidatable,
        })
    }

    pub fn get_position(&self, account_id: AccountId) -> Option<Position> {
        self.positions.get(&account_id).cloned()
    }

    pub fn get_positions(&self) -> Vec<Position> {
        self.positions.values().cloned().collect()
    }

    pub fn get_intent(&self, id: U64) -> Option<PendingIntent> {
        self.intents.get(&id.0).cloned()
    }

    pub fn list_open_intents(&self) -> Vec<PendingIntent> {
        self.intents.values().cloned().collect()
    }

    pub fn get_pools(&self) -> serde_json::Value {
        let (long_notional, short_notional) = self.positions.values().fold((0u128, 0u128), |acc, p| {
            if !p.is_open {
                return acc;
            }
            let n = p.size.unsigned_abs() * self.mark_price;
            if p.size > 0 {
                (acc.0 + n, acc.1)
            } else {
                (acc.0, acc.1 + n)
            }
        });
        serde_json::json!({
            "long_pool": self.long_pool,
            "short_pool": self.short_pool,
            "long_notional": long_notional,
            "short_notional": short_notional,
            "net_delta": long_notional as i128 - short_notional as i128,
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
            long_pool: self.long_pool,
            short_pool: self.short_pool,
            open_intents: self.intents.len() as u64,
            total_pnl_transferred: self.total_pnl_transferred,
            liquidations: self.liquidations,
            fills: self.fills,
        }
    }

    pub fn get_claimable(&self, account_id: AccountId) -> U128 {
        U128(self.claimable.get(&account_id).copied().unwrap_or(0))
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn get_pusher(&self) -> Option<AccountId> {
        self.price_pusher.clone()
    }

    pub fn list_solvers(&self) -> Vec<AccountId> {
        self.solvers.keys().cloned().collect()
    }

    pub fn get_params(&self) -> serde_json::Value {
        serde_json::json!({
            "liq_bps": LIQ_BPS,
            "max_leverage": MAX_LEVERAGE,
            "min_margin": MIN_MARGIN,
            "fill_band_bps": FILL_BAND_BPS,
            "intent_ttl_seconds": INTENT_TTL_SECONDS,
            "max_mark_deviation_bps": MAX_MARK_DEVIATION_BPS,
            "stale_mark_seconds": STALE_MARK_SECONDS,
            "stale_mark_deviation_bps": STALE_MARK_DEVIATION_BPS,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;

    const ENGINE: &str = "engine.testnet";

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

    /// Ledger owned by alice with `engine.testnet` registered as solver.
    fn ledger() -> PositionLedger {
        ctx("alice.testnet", "alice.testnet");
        let mut c = PositionLedger::new();
        c.add_solver(ENGINE.parse().unwrap());
        c
    }

    /// Open a position through the full intent flow: request (user) +
    /// solver settle at `fill`. Returns the ledger mutated.
    fn open_via_intent(c: &mut PositionLedger, user: &str, size: i128, ref_price: u128, margin: u128, fill: u128) {
        ctx("alice.testnet", user);
        c.request_open(a(user), I128(size), U128(ref_price), U128(margin));
        ctx("alice.testnet", ENGINE);
        c.settle_intent(U64(1), U128(fill));
    }

    fn a(id: &str) -> AccountId {
        id.parse().unwrap()
    }

    #[test]
    fn open_settle_close_loop() {
        let mut c = ledger();
        c.update_mark(U128(3_600_000));
        // long 10 @ $3.60, margin $3.60 (10x)
        open_via_intent(&mut c, "bob.testnet", 10, 3_600_000, 3_600_000, 3_600_000);
        let p = c.get_position(a("bob.testnet")).expect("position");
        assert!(p.is_open && p.size == 10 && p.entry_price == 3_600_000);
        assert_eq!(c.long_pool, 3_600_000);
        // close 100% at mark (no opposing pool -> margin only, no flow)
        ctx("alice.testnet", "bob.testnet");
        let out = c.close_position(U128(10_000), U128(3_600_000));
        assert_eq!(out["pnl"], 0);
        assert_eq!(out["flow"], 0);
        assert_eq!(c.get_pools()["long_pool"], 0);
        assert!(!c.get_position(a("bob.testnet")).unwrap().is_open);
    }

    #[test]
    fn pnl_flows_between_pools_capped() {
        let mut c = ledger();
        c.update_mark(U128(3_600_000));
        // bob long 10, carol short 5 (margin $3.6 / $1.8)
        open_via_intent(&mut c, "bob.testnet", 10, 3_600_000, 3_600_000, 3_600_000);
        ctx("alice.testnet", "carol.testnet");
        c.request_open(a("carol.testnet"), I128(-5), U128(3_600_000), U128(1_800_000));
        ctx("alice.testnet", ENGINE);
        c.settle_intent(U64(2), U128(3_600_000));
        assert_eq!(c.long_pool, 3_600_000);
        assert_eq!(c.short_pool, 1_800_000);
        // mark +10%: bob's full pnl $3.60 > short pool $1.80 -> CAPPED
        c.update_mark(U128(3_960_000));
        ctx("alice.testnet", "bob.testnet");
        let out = c.close_position(U128(10_000), U128(3_960_000));
        assert_eq!(out["pnl"], 3_600_000);
        assert_eq!(out["flow"], 1_800_000); // capped at opposing pool
        assert_eq!(out["flow_to"], "short_pool");
        assert_eq!(c.get_pools()["short_pool"], 0);
        assert_eq!(c.get_pools()["long_pool"], 0);
    }

    #[test]
    fn loser_loss_flows_to_opposing_pool() {
        let mut c = ledger();
        c.update_mark(U128(3_600_000));
        open_via_intent(&mut c, "bob.testnet", 10, 3_600_000, 3_600_000, 3_600_000);
        ctx("alice.testnet", "carol.testnet");
        c.request_open(a("carol.testnet"), I128(-5), U128(3_600_000), U128(1_800_000));
        ctx("alice.testnet", ENGINE);
        c.settle_intent(U64(2), U128(3_600_000));
        // mark -2%: bob loses $0.72, still healthy
        c.update_mark(U128(3_528_000));
        ctx("alice.testnet", "bob.testnet");
        let out = c.close_position(U128(10_000), U128(3_528_000));
        assert_eq!(out["pnl"], -720_000);
        assert_eq!(out["flow"], 720_000);
        assert_eq!(out["flow_to"], "short_pool");
        assert_eq!(c.get_pools()["short_pool"], 2_520_000);
        assert_eq!(c.get_pools()["long_pool"], 0);
    }

    #[test]
    fn partial_close_is_proportional() {
        let mut c = ledger();
        c.update_mark(U128(3_600_000));
        open_via_intent(&mut c, "bob.testnet", 10, 3_600_000, 3_600_000, 3_600_000);
        ctx("alice.testnet", "carol.testnet");
        c.request_open(a("carol.testnet"), I128(-10), U128(3_600_000), U128(3_600_000));
        ctx("alice.testnet", ENGINE);
        c.settle_intent(U64(2), U128(3_600_000));
        // mark +5%, bob closes 50%
        c.update_mark(U128(3_780_000));
        ctx("alice.testnet", "bob.testnet");
        let out = c.close_position(U128(5_000), U128(3_780_000));
        assert_eq!(out["pnl"], 900_000);
        assert_eq!(out["margin_out"], 1_800_000);
        let p = c.get_position(a("bob.testnet")).unwrap();
        assert_eq!(p.size, 5);
        assert_eq!(p.margin, 1_800_000);
        assert_eq!(c.get_pools()["long_pool"], 1_800_000);
        assert_eq!(c.get_pools()["short_pool"], 2_700_000);
    }

    #[test]
    #[should_panic(expected = "not a registered solver")]
    fn settle_requires_solver() {
        let mut c = ledger();
        c.update_mark(U128(3_600_000));
        ctx("alice.testnet", "bob.testnet");
        c.request_open(a("bob.testnet"), I128(10), U128(3_600_000), U128(3_600_000));
        ctx("alice.testnet", "mallory.testnet"); // not a solver
        c.settle_intent(U64(1), U128(3_600_000));
    }

    #[test]
    #[should_panic(expected = "fill price outside solver band")]
    fn phantom_fill_rejected() {
        let mut c = ledger();
        c.update_mark(U128(3_600_000));
        ctx("alice.testnet", "bob.testnet");
        c.request_open(a("bob.testnet"), I128(10), U128(3_600_000), U128(3_600_000));
        ctx("alice.testnet", ENGINE);
        c.settle_intent(U64(1), U128(4_000_000)); // +11% vs ref: phantom
    }

    #[test]
    #[should_panic(expected = "intent expired")]
    fn intent_expiry() {
        let mut c = ledger();
        c.update_mark(U128(3_600_000));
        ctx("alice.testnet", "bob.testnet"); // ts = 0
        c.request_open(a("bob.testnet"), I128(10), U128(3_600_000), U128(3_600_000));
        ctx_at("alice.testnet", ENGINE, (INTENT_TTL_SECONDS as u64 + 1) * 1_000_000_000);
        c.settle_intent(U64(1), U128(3_600_000));
    }

    #[test]
    fn cancel_own_intent() {
        let mut c = ledger();
        ctx("alice.testnet", "bob.testnet");
        let id = c.request_open(a("bob.testnet"), I128(10), U128(3_600_000), U128(3_600_000));
        c.cancel_intent(id);
        assert!(c.get_intent(id).is_none());
    }

    #[test]
    #[should_panic(expected = "not your intent")]
    fn cannot_cancel_foreign_intent() {
        let mut c = ledger();
        ctx("alice.testnet", "bob.testnet");
        let id = c.request_open(a("bob.testnet"), I128(10), U128(3_600_000), U128(3_600_000));
        ctx("alice.testnet", "carol.testnet");
        c.cancel_intent(id);
    }

    #[test]
    #[should_panic(expected = "close the open position first")]
    fn opposing_open_rejected() {
        let mut c = ledger();
        c.update_mark(U128(3_600_000));
        open_via_intent(&mut c, "bob.testnet", 10, 3_600_000, 3_600_000, 3_600_000);
        ctx("alice.testnet", "bob.testnet");
        c.request_open(a("bob.testnet"), I128(-5), U128(3_600_000), U128(1_800_000));
        ctx("alice.testnet", ENGINE);
        c.settle_intent(U64(2), U128(3_600_000));
    }
    #[test]
    fn liquidation_uses_stored_mark_and_claimable_leftover() {
        let mut c = ledger();
        c.update_mark(U128(3_600_000));
        // bob long 10 (10x), carol short 5 — opposing capital present
        open_via_intent(&mut c, "bob.testnet", 10, 3_600_000, 3_600_000, 3_600_000);
        ctx("alice.testnet", "carol.testnet");
        c.request_open(a("carol.testnet"), I128(-5), U128(3_600_000), U128(1_800_000));
        ctx("alice.testnet", ENGINE);
        c.settle_intent(U64(2), U128(3_600_000));
        // mark -8%: bob equity = $0.72 < 5% of notional ($1.656) -> liq
        c.update_mark(U128(3_312_000));
        let h = c.health(a("bob.testnet")).unwrap();
        assert!(h.is_liquidatable);
        ctx("alice.testnet", ENGINE);
        let out = c.liquidate(a("bob.testnet"));
        assert_eq!(out.pnl, -2_880_000);
        assert_eq!(out.remaining, 720_000);
        assert_eq!(out.to_pool, 2_880_000);
        assert_eq!(out.mark, 3_312_000);
        assert!(!c.get_position(a("bob.testnet")).unwrap().is_open);
        assert_eq!(c.get_pools()["short_pool"], 1_800_000 + 2_880_000);
        assert_eq!(c.liquidations, 1);
        // leftover equity is claimable, and cleared on claim
        assert_eq!(c.get_claimable(a("bob.testnet")).0, 720_000);
        ctx("alice.testnet", "bob.testnet");
        assert_eq!(c.claim().0, 720_000);
        assert_eq!(c.claim().0, 0);
    }

    #[test]
    fn insolvent_position_full_margin_to_pool() {
        let mut c = ledger();
        c.update_mark(U128(3_600_000));
        open_via_intent(&mut c, "bob.testnet", 10, 3_600_000, 3_600_000, 3_600_000);
        // mark -12%: equity negative -> entire margin to the short pool
        c.update_mark(U128(3_168_000));
        ctx("alice.testnet", ENGINE);
        let out = c.liquidate(a("bob.testnet"));
        assert!(out.pnl < 0);
        assert_eq!(out.remaining, 0);
        assert_eq!(out.to_pool, 3_600_000);
        assert_eq!(c.get_pools()["short_pool"], 3_600_000);
        assert_eq!(c.get_claimable(a("bob.testnet")).0, 0);
    }

    #[test]
    #[should_panic(expected = "position healthy")]
    fn healthy_position_not_liquidatable() {
        let mut c = ledger();
        c.update_mark(U128(3_600_000));
        open_via_intent(&mut c, "bob.testnet", 10, 3_600_000, 3_600_000, 3_600_000);
        c.update_mark(U128(3_528_000)); // -2%: still above 5% maintenance
        ctx("alice.testnet", ENGINE);
        c.liquidate(a("bob.testnet"));
    }

    #[test]
    #[should_panic(expected = "not a registered solver")]
    fn liquidate_requires_solver() {
        let mut c = ledger();
        c.update_mark(U128(3_600_000));
        open_via_intent(&mut c, "bob.testnet", 10, 3_600_000, 3_600_000, 3_600_000);
        c.update_mark(U128(3_312_000));
        ctx("alice.testnet", "bob.testnet"); // victim cannot self-liquidate
        c.liquidate(a("bob.testnet"));
    }

    #[test]
    fn health_view_values() {
        let mut c = ledger();
        c.update_mark(U128(3_600_000));
        open_via_intent(&mut c, "bob.testnet", 10, 3_600_000, 3_600_000, 3_600_000);
        c.update_mark(U128(3_528_000));
        let h = c.health(a("bob.testnet")).unwrap();
        assert_eq!(h.equity, 2_880_000);
        assert_eq!(h.notional, 35_280_000);
        assert_eq!(h.equity_bps, 816);
        assert!(!h.is_liquidatable);
    }

    #[test]
    #[should_panic(expected = "not the authorized price pusher")]
    fn pusher_governance() {
        let mut c = ledger();
        ctx("alice.testnet", "alice.testnet");
        c.set_pusher(Some(a("oracle.testnet")));
        assert_eq!(c.get_pusher(), Some(a("oracle.testnet")));
        ctx("alice.testnet", "mallory.testnet");
        c.update_mark(U128(3_600_000)); // must panic
    }

    #[test]
    #[should_panic(expected = "not the contract owner")]
    fn only_owner_sets_pusher() {
        let mut c = ledger();
        ctx("alice.testnet", "bob.testnet");
        c.set_pusher(None);
    }

    #[test]
    fn stale_mark_allows_reanchor() {
        let mut c = ledger();
        ctx_at("alice.testnet", "alice.testnet", 10 * 1_000_000_000);
        c.update_mark(U128(3_600_000));
        // +40% would fail the fresh 20% band...
        ctx_at("alice.testnet", "alice.testnet", 11 * 1_000_000_000);
        c.update_mark(U128(4_320_000)); // +20% exactly: passes fresh band
        // ...but passes after the mark goes stale (1h) under the 50% band.
        ctx_at("alice.testnet", "alice.testnet", (10 + STALE_MARK_SECONDS as u64 + 1) * 1_000_000_000);
        c.update_mark(U128(6_120_000)); // +41.7% vs 4.32M: ok stale
        assert_eq!(c.get_mark().0, 6_120_000);
    }

    #[test]
    fn pools_view_net_delta() {
        let mut c = ledger();
        c.update_mark(U128(3_600_000));
        open_via_intent(&mut c, "bob.testnet", 10, 3_600_000, 3_600_000, 3_600_000);
        ctx("alice.testnet", "carol.testnet");
        c.request_open(a("carol.testnet"), I128(-5), U128(3_600_000), U128(1_800_000));
        ctx("alice.testnet", ENGINE);
        c.settle_intent(U64(2), U128(3_600_000));
        let pools = c.get_pools();
        assert_eq!(pools["long_notional"], 36_000_000);
        assert_eq!(pools["short_notional"], 18_000_000);
        assert_eq!(pools["net_delta"], 18_000_000);
    }

    #[test]
    fn stats_track_state() {
        let mut c = ledger();
        c.update_mark(U128(3_600_000));
        open_via_intent(&mut c, "bob.testnet", 10, 3_600_000, 3_600_000, 3_600_000);
        let s = c.get_stats();
        assert_eq!(s.open_positions, 1);
        assert_eq!(s.long_pool, 3_600_000);
        assert_eq!(s.fills, 1);
        assert_eq!(s.open_intents, 0);
    }
}
#[cfg(test)]
mod borsh_repro {
    use near_sdk::json_types::U128;

    #[derive(near_sdk::borsh::BorshDeserialize, near_sdk::borsh::BorshSerialize)]
    #[borsh(crate = "near_sdk::borsh")]
    struct Input { mark: U128 }

    #[test]
    fn repro_single_u128_direct() {
        let bytes = near_sdk::borsh::to_vec(&U128(3_630_000)).unwrap();
        assert_eq!(bytes.len(), 16);
        let v: U128 = near_sdk::borsh::from_slice(&bytes).unwrap();
        assert_eq!(v.0, 3_630_000);
        println!("direct U128 deser OK: {}", v.0);
    }

    #[test]
    fn repro_input_struct() {
        // Exact shape the macro generates for update_mark(U128)
        let bytes = near_sdk::borsh::to_vec(&U128(3_630_000)).unwrap();
        let parsed: Input = near_sdk::borsh::from_slice(&bytes).unwrap();
        assert_eq!(parsed.mark.0, 3_630_000);
        println!("Input-struct deser OK: {}", parsed.mark.0);
    }

    #[test]
    fn json_deser_of_borsh_bytes() {
        // What the ADAPTER sends to a JSON method: borsh bytes of
        // (AccountId, I128, U128, U128) for request_open
        let user = near_sdk::AccountId::new_unvalidated("prism-v4-2026.testnet".to_string());
        let mut args: Vec<u8> = Vec::new();
        args.extend(near_sdk::borsh::to_vec(&user).unwrap());
        args.extend((-10i128).to_le_bytes());
        args.extend(3_600_000u128.to_le_bytes());
        args.extend(1_800_000u128.to_le_bytes());
        println!("adapter borsh args[0..8]: {:02x?}", &args[0..8]);
        // 1) what the generated JSON code does: serde_json::from_slice::<Input>
        #[derive(serde::Deserialize)]
        #[serde(crate = "near_sdk::serde")]
        struct Input {
            owner: near_sdk::AccountId,
            size: near_sdk::json_types::I128,
            ref_price: near_sdk::json_types::U128,
            margin: near_sdk::json_types::U128,
        }
        let res: std::result::Result<Input, _> = near_sdk::serde_json::from_slice(&args);
        match res {
            Ok(_) => println!("serde_json parsed borsh args?! (unexpected)"),
            Err(e) => println!("serde_json clean error: {}", e),
        }
        // 2) raw 16-byte borsh u128 (update_mark probe)
        let raw16: Vec<u8> = 3_640_000u128.to_le_bytes().to_vec();
        #[derive(serde::Deserialize)]
        #[serde(crate = "near_sdk::serde")]
        struct InputM { mark: near_sdk::json_types::U128 }
        let res2: std::result::Result<InputM, _> = near_sdk::serde_json::from_slice(&raw16);
        match res2 {
            Ok(_) => println!("serde_json parsed raw16?! (unexpected)"),
            Err(e) => println!("raw16 clean error: {}", e),
        }
    }

}
