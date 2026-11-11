//! NEP-297 events. Every state change emits exactly one line:
//! `EVENT_JSON:{"standard":"curve-ledger","version":"1.0.0","event":<name>,"data":[{...}]}`
//! Amounts are decimal strings (USDC raw, 6dp); timestamps are unix seconds.
//! Indexers can rebuild the full ledger history from these lines alone.

use near_sdk::env;
use near_sdk::serde_json::{json, Value};

pub const STANDARD: &str = "curve-ledger";
pub const VERSION: &str = "1.0.0";

pub fn emit(event: &str, data: Value) {
    let line = json!({
        "standard": STANDARD,
        "version": VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{}", line));
}
