// PRISM Intent Settlement Adapter
//
// Turns Position Ledger actions into on-chain settlement flows and tracks
// each intent to completion. In the 1Click flow a solver settles the intent
// on the solvers' chain; this adapter is the on-NEAR side:
//
//   user -> adapter.request_open / request_close
//              1) records a TrackedIntent (status Pending)
//              2) calls ledger.request_open / request_close (creates the
//                 pending intent in the Position Ledger)
//              3) a callback stores the ledger intent id
//   solver -> adapter.settle(seq, fill_price)   (after 1Click completion)
//              1) calls ledger.settle_intent(ledger_id, fill_price)
//              2) a callback marks the tracked intent Settled (or keeps it
//                 Pending on failure so it can be retried)
//   anyone -> adapter.audit(seq)  (verifies ledger state via cross-call)
//   solver -> adapter.liquidate(user)  (risk engine path -> ledger.liquidate)
//
// The adapter holds no funds and no positions — all state of record lives
// in the Position Ledger. It only tracks intent status.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::{I128, U128, U64};
use near_sdk::{env, log, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise};
use std::collections::HashMap;

const GAS_REQUEST: u64 = 300; // 300 TGas (call + callback)
const GAS_SETTLE: u64 = 300;
const GAS_AUDIT: u64 = 300;
const GAS_CALLBACK: u64 = 30;

// Mirrors the Position Ledger's pending-intent shape (borsh layout must match).
#[derive(BorshSerialize, BorshDeserialize, serde::Serialize, serde::Deserialize, Clone, PartialEq, Debug)]
pub enum IntentKind {
    Open { size: i128, ref_price: u128, margin: u128 },
    Close { fraction_bps: u128, ref_price: u128 },
}

#[derive(BorshSerialize, BorshDeserialize, serde::Serialize, serde::Deserialize, Clone, PartialEq, Debug)]
pub struct LedgerIntent {
    pub id: u64,
    pub owner: AccountId,
    pub kind: IntentKind,
    pub created_ts: u64,
    pub deadline_ts: u64,
}

#[derive(
    BorshSerialize, BorshDeserialize, serde::Serialize, serde::Deserialize, Clone, PartialEq, Debug,
)]
pub enum IntentStatus {
    Pending,
    Settled,
    Failed,
}

#[derive(
    BorshSerialize, BorshDeserialize, serde::Serialize, serde::Deserialize, Clone, PartialEq, Debug,
)]
pub struct TrackedIntent {
    pub seq: u64,
    pub user: AccountId,
    pub kind: IntentKind,
    pub ledger_intent: Option<u64>,
    pub status: IntentStatus,
    pub fill_price: Option<u128>,
    pub created_ts: u64,
    pub updated_ts: u64,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct IntentSettlementAdapter {
    pub ledger: AccountId,
    pub owner: AccountId,
    solvers: HashMap<AccountId, ()>,
    intents: HashMap<u64, TrackedIntent>,
    seq: u64,
}

#[near]
impl IntentSettlementAdapter {
    #[init]
    pub fn new(ledger: AccountId) -> Self {
        require!(
            ledger != env::current_account_id(),
            "ledger must be a different account"
        );
        Self {
            ledger,
            owner: env::predecessor_account_id(),
            solvers: HashMap::new(),
            intents: HashMap::new(),
            seq: 0,
        }
    }

    pub fn add_solver(&mut self, solver: AccountId) {
        let caller: AccountId = env::predecessor_account_id();
        require!(caller == self.owner, "not the adapter owner");
        self.solvers.insert(solver.clone(), ());
        log!("{}", format!(r#"{{"event":"add_solver","solver":"{}"}}"#, solver));
    }

    pub fn remove_solver(&mut self, solver: AccountId) {
        let caller: AccountId = env::predecessor_account_id();
        require!(caller == self.owner, "not the adapter owner");
        self.solvers.remove(&solver);
        log!("{}", format!(r#"{{"event":"remove_solver","solver":"{}"}}"#, solver));
    }

    fn require_solver(&self, method: &str) {
        let caller: AccountId = env::predecessor_account_id();
        require!(
            self.solvers.contains_key(&caller),
            format!("{}: caller is not a registered solver", method)
        );
    }
    // ─────────────── REQUEST FLOWS ───────────────

    fn now_s() -> u64 {
        env::block_timestamp() / 1_000_000_000
    }

    /// User requests an open. Records the tracked intent, then cross-calls
    /// `ledger.request_open` and stores the returned ledger intent id in a
    /// callback. The actual margin movement happens when a solver settles
    /// the 1Click intent.
    pub fn request_open(&mut self, size: I128, ref_price: U128, margin: U128) -> U64 {
        let user: AccountId = env::predecessor_account_id();
        self.seq += 1;
        let s = self.seq;
        let now = Self::now_s();
        let kind = IntentKind::Open {
            size: size.0,
            ref_price: ref_price.0,
            margin: margin.0,
        };
        self.intents.insert(
            s,
            TrackedIntent {
                seq: s,
                user: user.clone(),
                kind: kind.clone(),
                ledger_intent: None,
                status: IntentStatus::Pending,
                fill_price: None,
                created_ts: now,
                updated_ts: now,
            },
        );
        // The user (predecessor) owns the position; this adapter acts for
        // them, so the owner is passed explicitly to the ledger.
        let user = env::predecessor_account_id();
        let mut args: Vec<u8> = Vec::new();
        args.extend(borsh::to_vec(&user).unwrap());
        // borsh layout of the ledger's I128/U128 wrappers == raw LE bytes
        args.extend(size.0.to_le_bytes());
        args.extend(ref_price.0.to_le_bytes());
        args.extend(margin.0.to_le_bytes());
        Promise::new(self.ledger.clone())
            .function_call("request_open".to_string(), args, NearToken::from_yoctonear(0), Gas::from_tgas(GAS_REQUEST))
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_request_created".to_string(),
                    s.to_le_bytes().to_vec(),
                    NearToken::from_yoctonear(0), Gas::from_tgas(GAS_CALLBACK),
                ),
            );
        log!(
            "{}",
            format!(
                r#"{{"event":"tracked","seq":{},"user":"{}","kind":"open","size":{},"ref_price":{},"margin":{}}}"#,
                s, user, size.0, ref_price.0, margin.0
            )
        );
        U64(s)
    }

    /// User requests a close of `fraction_bps` of their open position.
    pub fn request_close(&mut self, fraction_bps: U128, ref_price: U128) -> U64 {
        let user: AccountId = env::predecessor_account_id();
        self.seq += 1;
        let s = self.seq;
        let now = Self::now_s();
        let kind = IntentKind::Close {
            fraction_bps: fraction_bps.0,
            ref_price: ref_price.0,
        };
        self.intents.insert(
            s,
            TrackedIntent {
                seq: s,
                user: user.clone(),
                kind: kind.clone(),
                ledger_intent: None,
                status: IntentStatus::Pending,
                fill_price: None,
                created_ts: now,
                updated_ts: now,
            },
        );
        let user = env::predecessor_account_id();
        let mut args: Vec<u8> = Vec::new();
        args.extend(borsh::to_vec(&user).unwrap());
        args.extend(fraction_bps.0.to_le_bytes());
        args.extend(ref_price.0.to_le_bytes());
        Promise::new(self.ledger.clone())
            .function_call("request_close".to_string(), args, NearToken::from_yoctonear(0), Gas::from_tgas(GAS_REQUEST))
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_request_created".to_string(),
                    s.to_le_bytes().to_vec(),
                    NearToken::from_yoctonear(0), Gas::from_tgas(GAS_CALLBACK),
                ),
            );
        log!(
            "{}",
            format!(
                r#"{{"event":"tracked","seq":{},"user":"{}","kind":"close","fraction_bps":{},"ref_price":{}}}"#,
                s, user, fraction_bps.0, ref_price.0
            )
        );
        U64(s)
    }

    /// Risk engine path: a registered solver liquidates an unhealthy
    /// position. The ledger evaluates at its stored mark.
    pub fn liquidate(&mut self, user: AccountId) -> U64 {
        self.require_solver("liquidate");
        self.seq += 1;
        let s = self.seq;
        let now = Self::now_s();
        let kind = IntentKind::Close {
            fraction_bps: 10_000,
            ref_price: 0,
        };
        self.intents.insert(
            s,
            TrackedIntent {
                seq: s,
                user: user.clone(),
                kind,
                ledger_intent: None,
                status: IntentStatus::Pending,
                fill_price: None,
                created_ts: now,
                updated_ts: now,
            },
        );
        let args = borsh::to_vec(&user).unwrap();
        Promise::new(self.ledger.clone())
            .function_call("liquidate".to_string(), args, NearToken::from_yoctonear(0), Gas::from_tgas(GAS_REQUEST))
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_liquidate_done".to_string(),
                    s.to_le_bytes().to_vec(),
                    NearToken::from_yoctonear(0), Gas::from_tgas(GAS_CALLBACK),
                ),
            );
        log!("{}", format!(r#"{{"event":"tracked","seq":{},"user":"{}","kind":"liquidate"}}"#, s, user));
        U64(s)
    }

    /// A registered solver settles a tracked open/close intent with the
    /// 1Click fill price. Cross-calls `ledger.settle_intent`.
    pub fn settle(&mut self, seq: U64, fill_price: U128) -> () {
        self.require_solver("settle");
        let rec = self.intents.get_mut(&seq.0).expect("intent not found");
        require!(
            rec.status == IntentStatus::Pending,
            "intent not pending"
        );
        require!(
            matches!(rec.kind, IntentKind::Open { .. } | IntentKind::Close { .. }),
            "liquidations settle themselves"
        );
        let ledger_id = rec
            .ledger_intent
            .expect("no ledger intent yet (creation failed or still in flight)");
        rec.fill_price = Some(fill_price.0);
        rec.updated_ts = Self::now_s();
        let mut args: Vec<u8> = Vec::new();
        args.extend(ledger_id.to_le_bytes());
        args.extend(fill_price.0.to_le_bytes());
        Promise::new(self.ledger.clone())
            .function_call("settle_intent".to_string(), args, NearToken::from_yoctonear(0), Gas::from_tgas(GAS_SETTLE))
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_settle_done".to_string(),
                    seq.0.to_le_bytes().to_vec(),
                    NearToken::from_yoctonear(0), Gas::from_tgas(GAS_CALLBACK),
                ),
            );
        log!(
            "{}",
            format!(
                r#"{{"event":"settle_requested","seq":{},"ledger_intent":{},"fill_price":{}}}"#,
                seq.0, ledger_id, fill_price.0
            )
        );
    }

    /// Anyone may verify a tracked intent against the ledger: if the ledger
    /// no longer holds the pending intent, a still-Pending tracked intent
    /// is marked Failed (a Settled one is left alone).
    pub fn audit(&mut self, seq: U64) -> () {
        let rec = self.intents.get(&seq.0).expect("intent not found");
        require!(
            matches!(rec.kind, IntentKind::Open { .. } | IntentKind::Close { .. }),
            "liquidations cannot be audited this way"
        );
        let ledger_id = rec
            .ledger_intent
            .expect("no ledger intent yet");
        let args = ledger_id.to_le_bytes().to_vec();
        Promise::new(self.ledger.clone())
            .function_call("get_intent".to_string(), args, NearToken::from_yoctonear(0), Gas::from_tgas(GAS_AUDIT))
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_audit".to_string(),
                    seq.0.to_le_bytes().to_vec(),
                    NearToken::from_yoctonear(0), Gas::from_tgas(GAS_CALLBACK),
                ),
            );
    }
    // ─────────────── CALLBACKS ───────────────

    /// After ledger.request_open / request_close: store the ledger intent
    /// id, or mark the tracked intent Failed if the ledger call panicked
    /// (e.g. leverage limit, no position to close).
    #[private]
    pub fn on_request_created(&mut self, seq: U64) {
        let idx = env::promise_results_count() - 1;
        match env::promise_result(idx) {
            near_sdk::PromiseResult::Successful(data) if data.len() >= 8 => {
                let id = u64::from_le_bytes(data[0..8].try_into().unwrap());
                if let Some(rec) = self.intents.get_mut(&seq.0) {
                    rec.ledger_intent = Some(id);
                    rec.updated_ts = Self::now_s();
                    log!(
                        "{}",
                        format!(
                            r#"{{"event":"intent_created","seq":{},"ledger_intent":{}}}"#,
                            seq.0, id
                        )
                    );
                }
            }
            _ => {
                if let Some(rec) = self.intents.get_mut(&seq.0) {
                    rec.status = IntentStatus::Failed;
                    rec.updated_ts = Self::now_s();
                    log!("{}", format!(r#"{{"event":"request_failed","seq":{}}}"#, seq.0));
                }
            }
        }
    }

    /// After ledger.settle_intent: Settled on success; stays Pending on
    /// failure (e.g. fill outside band, intent expired) so a solver can
    /// retry with a corrected fill.
    #[private]
    pub fn on_settle_done(&mut self, seq: U64) {
        let idx = env::promise_results_count() - 1;
        match env::promise_result(idx) {
            near_sdk::PromiseResult::Successful(_) => {
                if let Some(rec) = self.intents.get_mut(&seq.0) {
                    rec.status = IntentStatus::Settled;
                    rec.updated_ts = Self::now_s();
                    log!(
                        "{}",
                        format!(
                            r#"{{"event":"settled","seq":{},"fill_price":{}}}"#,
                            seq.0,
                            rec.fill_price.unwrap_or(0)
                        )
                    );
                }
            }
            near_sdk::PromiseResult::Failed => {
                log!("{}", format!(r#"{{"event":"settle_failed_retryable","seq":{}}}"#, seq.0));
            }
        }
    }

    /// After ledger.liquidate: Settled on success, Failed otherwise
    /// (position was healthy at the mark).
    #[private]
    pub fn on_liquidate_done(&mut self, seq: U64) {
        let idx = env::promise_results_count() - 1;
        match env::promise_result(idx) {
            near_sdk::PromiseResult::Successful(_) => {
                if let Some(rec) = self.intents.get_mut(&seq.0) {
                    rec.status = IntentStatus::Settled;
                    rec.updated_ts = Self::now_s();
                    log!("{}", format!(r#"{{"event":"liquidated","seq":{}}}"#, seq.0));
                }
            }
            near_sdk::PromiseResult::Failed => {
                if let Some(rec) = self.intents.get_mut(&seq.0) {
                    rec.status = IntentStatus::Failed;
                    rec.updated_ts = Self::now_s();
                    log!("{}", format!(r#"{{"event":"liquidate_rejected","seq":{}}}"#, seq.0));
                }
            }
        }
    }

    /// After the get_intent audit cross-call: borsh Option<T> — first byte
    /// 0 = None (intent gone), 1 = Some (still open in the ledger).
    #[private]
    pub fn on_audit(&mut self, seq: U64) {
        let idx = env::promise_results_count() - 1;
        match env::promise_result(idx) {
            near_sdk::PromiseResult::Successful(data) => {
                let still_open = data.first() == Some(&1);
                if !still_open {
                    if let Some(rec) = self.intents.get_mut(&seq.0) {
                        if rec.status == IntentStatus::Pending {
                            rec.status = IntentStatus::Failed;
                            rec.updated_ts = Self::now_s();
                            log!("{}", format!(r#"{{"event":"audit_failed","seq":{}}}"#, seq.0));
                        }
                    }
                }
            }
            near_sdk::PromiseResult::Failed => {}
        }
    }

    // ─────────────── VIEWS ───────────────

    pub fn get_intent(&self, seq: U64) -> Option<TrackedIntent> {
        self.intents.get(&seq.0).cloned()
    }

    pub fn list_intents(&self, user: Option<AccountId>) -> Vec<TrackedIntent> {
        let mut out: Vec<TrackedIntent> = self
            .intents
            .values()
            .filter(|i| user.as_ref().map(|u| i.user == *u).unwrap_or(true))
            .cloned()
            .collect();
        out.sort_by_key(|i| i.seq);
        out
    }

    pub fn count_intents(&self) -> U64 {
        U64(self.intents.len() as u64)
    }

    pub fn get_ledger(&self) -> AccountId {
        self.ledger.clone()
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn list_solvers(&self) -> Vec<AccountId> {
        self.solvers.keys().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;

    const LEDGER: &str = "prism-ledger.testnet";
    const SOLVER: &str = "solver.testnet";

    fn ctx(account: &str, predecessor: &str) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(account.parse().unwrap())
            .signer_account_id(account.parse().unwrap())
            .predecessor_account_id(predecessor.parse().unwrap());
        near_sdk::testing_env!(b.build());
    }

    fn adapter_with_solver() -> IntentSettlementAdapter {
        ctx("adapter.testnet", "ops.testnet");
        let mut a = IntentSettlementAdapter::new(LEDGER.parse().unwrap());
        a.add_solver(SOLVER.parse().unwrap());
        a
    }

    #[test]
    fn setup_and_governance() {
        let a = adapter_with_solver();
        assert_eq!(a.get_ledger(), LEDGER.parse::<AccountId>().unwrap());
        assert_eq!(a.get_owner(), "ops.testnet".parse::<AccountId>().unwrap());
        assert_eq!(a.list_solvers(), vec![SOLVER.parse::<AccountId>().unwrap()]);
    }

    #[test]
    #[should_panic(expected = "not the adapter owner")]
    fn only_owner_adds_solvers() {
        ctx("adapter.testnet", "adapter.testnet");
        let mut a = IntentSettlementAdapter::new(LEDGER.parse().unwrap());
        ctx("adapter.testnet", "mallory.testnet");
        a.add_solver(SOLVER.parse().unwrap());
    }

    #[test]
    fn request_open_tracks_intent() {
        let mut a = adapter_with_solver();
        ctx("adapter.testnet", "bob.testnet");
        let s = a.request_open(I128(10), U128(3_600_000), U128(3_600_000));
        let rec = a.get_intent(s).unwrap();
        assert_eq!(rec.seq, 1);
        assert_eq!(rec.user, "bob.testnet".parse::<AccountId>().unwrap());
        assert!(matches!(rec.kind, IntentKind::Open { size: 10, .. }));
        assert_eq!(rec.status, IntentStatus::Pending);
        assert_eq!(rec.ledger_intent, None);
        assert_eq!(a.count_intents().0, 1);
        assert_eq!(a.list_intents(Some("bob.testnet".parse().unwrap())).len(), 1);
        assert_eq!(a.list_intents(Some("carol.testnet".parse().unwrap())).len(), 0);
    }

    #[test]
    fn request_close_tracks_intent() {
        let mut a = adapter_with_solver();
        ctx("adapter.testnet", "bob.testnet");
        a.request_open(I128(10), U128(3_600_000), U128(3_600_000));
        let s = a.request_close(U128(5_000), U128(3_700_000));
        let rec = a.get_intent(s).unwrap();
        assert_eq!(rec.seq, 2);
        assert!(matches!(rec.kind, IntentKind::Close { fraction_bps: 5_000, .. }));
        assert_eq!(rec.status, IntentStatus::Pending);
    }

    #[test]
    #[should_panic(expected = "not a registered solver")]
    fn settle_requires_solver() {
        let mut a = adapter_with_solver();
        ctx("adapter.testnet", "bob.testnet");
        a.request_open(I128(10), U128(3_600_000), U128(3_600_000));
        ctx("adapter.testnet", "mallory.testnet");
        a.settle(U64(1), U128(3_600_000));
    }

    #[test]
    #[should_panic(expected = "no ledger intent yet")]
    fn settle_before_creation_fails() {
        let mut a = adapter_with_solver();
        ctx("adapter.testnet", "bob.testnet");
        a.request_open(I128(10), U128(3_600_000), U128(3_600_000));
        // ledger_intent never set (no callback ran in unit tests)
        ctx("adapter.testnet", SOLVER);
        a.settle(U64(1), U128(3_600_000));
    }

    #[test]
    #[should_panic(expected = "not a registered solver")]
    fn liquidate_requires_solver() {
        let mut a = adapter_with_solver();
        ctx("adapter.testnet", "bob.testnet");
        a.liquidate("victim.testnet".parse().unwrap());
    }
}
