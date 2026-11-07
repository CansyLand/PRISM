use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::I128;
use near_sdk::{env, near, require, AccountId, PanicOnDefault};
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

const MIN_MARGIN: u128 = 1_000_000; // 1 USDC minimum collateral
/// Liquidate when margin coverage < 50% of notional (simple margin check).
const LIQ_BPS: u128 = 5_000;

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct LeveragedPositions {
    positions: HashMap<AccountId, Position>,
}

#[near]
impl LeveragedPositions {
    #[init]
    pub fn new() -> Self {
        Self {
            positions: HashMap::new(),
        }
    }

    /// Open (or re-open) a leveraged position.
    /// size: signed base units (+long / -short). price & margin: USDC raw units (6dp).
    pub fn open_position(&mut self, size: i128, price: u128, margin: u128) {
        let caller: AccountId = env::predecessor_account_id();
        require!(size != 0, "size must be non-zero");
        require!(price > 0, "price must be > 0");
        require!(margin >= MIN_MARGIN, "margin below minimum");
        self.positions.insert(
            caller.clone(),
            Position {
                owner: caller,
                size,
                entry_price: price,
                margin,
                is_open: true,
            },
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
            .entry(caller)
            .and_modify(|p| p.entry_price = fill_price);
    }

    /// Close the caller's position at `exit_price` (USDC raw 6dp).
    /// Returns PnL = size * (exit - entry) in USDC raw units.
    pub fn close_position(&mut self, exit_price: u128) -> I128 {
        let caller: AccountId = env::predecessor_account_id();
        let pos = self.positions.get(&caller).expect("no position");
        require!(pos.is_open, "position already closed");
        let pnl = pos.size * (exit_price as i128 - pos.entry_price as i128);
        self.positions
            .entry(caller)
            .and_modify(|p| p.is_open = false);
        I128(pnl)
    }

    /// Anyone may liquidate an underwater position:
    /// margin * 10_000 < |size| * mark_price * LIQ_BPS  (i.e. coverage < 50%).
    /// Returns PnL at mark price in USDC raw units.
    pub fn liquidate(&mut self, account_id: AccountId, mark_price: u128) -> I128 {
        let pos = self.positions.get(&account_id).expect("no position");
        require!(pos.is_open, "not open");
        let notional = pos.size.unsigned_abs() * mark_price;
        require!(
            pos.margin * 10_000 < notional * LIQ_BPS,
            "position healthy, not liquidatable"
        );
        let pnl = pos.size * (mark_price as i128 - pos.entry_price as i128);
        self.positions
            .entry(account_id)
            .and_modify(|p| p.is_open = false);
        I128(pnl)
    }

    pub fn get_position(&self, account_id: AccountId) -> Option<Position> {
        self.positions.get(&account_id).cloned()
    }

    pub fn get_positions(&self) -> Vec<Position> {
        self.positions.values().cloned().collect()
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

    #[test]
    fn open_get_close_loop() {
        ctx("bob.testnet", "bob.testnet");
        let mut c = LeveragedPositions::new();
        c.open_position(1_000, 200_000_000, 100_000_000); // long 1000 @ $20, margin $100
        let p = c
            .get_position("bob.testnet".parse().unwrap())
            .expect("position missing");
        assert!(p.is_open && p.size == 1_000 && p.margin == 100_000_000);
        let pnl = c.close_position(210_000_000).0; // close @ $21 => +10 USDC x 1000 = $10,000
        assert_eq!(pnl, 10_000_000_000); // 10,000 USDC raw
        let p2 = c
            .get_position("bob.testnet".parse().unwrap())
            .expect("position missing");
        assert!(!p2.is_open);
    }

    #[test]
    fn settle_entry_uses_real_fill_price() {
        ctx("bob.testnet", "bob.testnet");
        let mut c = LeveragedPositions::new();
        c.open_position(10, 3_650_000, 3_650_000); // mock entry $3.65
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
        c.open_position(10, 3_650_000, 3_650_000);
        c.close_position(3_650_000);
        c.settle_entry(4_000_000);
    }

    #[test]
    #[should_panic(expected = "margin below minimum")]
    fn rejects_tiny_margin() {
        ctx("bob.testnet", "bob.testnet");
        let mut c = LeveragedPositions::new();
        c.open_position(1_000, 200_000_000, 1);
    }

    #[test]
    fn liquidation_when_underwater() {
        ctx("alice.testnet", "alice.testnet");
        let mut c = LeveragedPositions::new();
        c.open_position(1_000, 200_000_000, 20_000_000); // coverage 10% < 50%
        ctx("carol.testnet", "carol.testnet");
        let pnl = c.liquidate("alice.testnet".parse().unwrap(), 200_000_000).0;
        assert_eq!(pnl, 0);
        let p = c
            .get_position("alice.testnet".parse().unwrap())
            .expect("position missing");
        assert!(!p.is_open);
    }

    #[test]
    #[should_panic(expected = "position healthy")]
    fn no_liquidation_when_healthy() {
        ctx("alice.testnet", "alice.testnet");
        let mut c = LeveragedPositions::new();
        c.open_position(1_000, 200_000_000, 200_000_000_000); // coverage 100% >= 50% (notional $200k)
        ctx("carol.testnet", "carol.testnet");
        let _ = c.liquidate("alice.testnet".parse().unwrap(), 200_000_000);
    }
}
