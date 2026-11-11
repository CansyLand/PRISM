// Platform relayer: the only off-chain piece between NEAR Intents and the ledger.
// It pays all gas, so users never hold NEAR or sign anything.
//
// Telegram user 42 maps to the virtual ledger account `tg-42.<relayer>`. The owner
// registers the relayer once with `curve.add_manager(<relayer>)`, which lets it act
// for every `*.<relayer>` account. That's custodial; see PLAN.md, security §2.
//
//   deposit        1Click quote → user pays depositAddress on their chain →
//                  SUCCESS → usdc.ft_transfer_call(curve, amountOut, {receiver_id, action?})
//   withdraw       1Click quote (USDC.near → dest chain) → storage_deposit(depositAddress)
//                  → curve.withdraw({account_id, amount, receiver_id: depositAddress})
//                  → REFUNDED? re-credit the user with ft_transfer_call
//   trade          curve.open_curve / close_curve / open_flat / close_flat with account_id
//
// Every deposit and withdrawal is recorded in .relayer-state.json, which keeps
// crediting idempotent (a deposit is never credited twice).
//
// Env: NEAR_RPC, CURVE_CONTRACT, USDC_CONTRACT, RELAYER_ACCOUNT_ID, RELAYER_PRIVATE_KEY
// Run: node --env-file=.env relayer.js <command> ...

const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Account } = require("near-api-js");
const oneclick = require("./oneclick");

const TGAS = 1_000_000_000_000n;
const ONE_YOCTO = 1n;
const STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR (NEP-145 FT registration)
const STATE_FILE = path.join(__dirname, ".relayer-state.json");

const env = (k, d) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { deposits: {}, withdrawals: {} };
  }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE + ".tmp", JSON.stringify(s, null, 2));
  fs.renameSync(STATE_FILE + ".tmp", STATE_FILE);
}

class Relayer {
  constructor(cfg = {}) {
    this.rpc = cfg.rpc || env("NEAR_RPC", "https://test.rpc.fastnear.com");
    this.curve = cfg.curve || env("CURVE_CONTRACT");
    this.usdc = cfg.usdc || env("USDC_CONTRACT");
    this.relayerId = cfg.relayerId || env("RELAYER_ACCOUNT_ID");
    this.provider = new JsonRpcProvider({ url: this.rpc });
    const key = cfg.privateKey || process.env.RELAYER_PRIVATE_KEY;
    this.account = key ? new Account(this.relayerId, this.provider, key) : null;
    this.state = loadState();
  }

  userId(tgId) {
    return `tg-${String(tgId).replace(/[^a-z0-9_-]/gi, "").toLowerCase()}.${this.relayerId}`;
  }

  view(contractId, method, args = {}) {
    return this.provider.callFunction({ contractId, method, args });
  }

  call(contractId, methodName, args, { gas = 100n * TGAS, deposit = 0n } = {}) {
    if (!this.account) throw new Error("RELAYER_PRIVATE_KEY not set");
    return this.account.callFunction({ contractId, methodName, args, gas, deposit });
  }

  // ─────────────── reads (bot / Telegram) ───────────────
  market() {
    return this.view(this.curve, "get_market");
  }
  accountOf(tgId) {
    return this.view(this.curve, "get_account", { account_id: this.userId(tgId) });
  }

  // ─────────────── deposit ───────────────
  async startDeposit({ tgId, originAsset, amount, refundTo, open, dry = false }) {
    const q = await oneclick.depositQuote({ originAsset, amount, refundTo, relayer: this.relayerId, dry });
    if (dry) return q;
    const rec = {
      tgId: String(tgId), account_id: this.userId(tgId), open: open || null,
      originAsset, amount: String(amount), quote: q.quote, status: "PENDING_DEPOSIT", credited: null,
      createdAt: new Date().toISOString(),
    };
    this.state.deposits[q.depositAddress] = rec;
    saveState(this.state);
    return { depositAddress: q.depositAddress, depositMemo: q.depositMemo, quote: q.quote };
  }

  /** Waits for 1Click SUCCESS, then credits the user. `simulate` = testnet: skip 1Click, credit this amount. */
  async settleDeposit(depositAddress, { simulate } = {}) {
    let rec = this.state.deposits[depositAddress];
    if (simulate) {
      rec = rec || { tgId: depositAddress, account_id: this.userId(depositAddress), open: null };
      rec.status = "SUCCESS";
      rec.amountOut = String(simulate);
      this.state.deposits[depositAddress] = rec;
    }
    if (!rec) throw new Error(`unknown deposit ${depositAddress}`);
    if (rec.credited) return rec; // idempotent
    if (!simulate) {
      const s = await oneclick.waitFor(depositAddress, { onTick: (t) => (rec.status = t.status) });
      rec.status = s.status;
      if (s.status !== "SUCCESS") {
        saveState(this.state);
        throw new Error(`deposit ${depositAddress} ended ${s.status} (1Click refunds the user's origin address)`);
      }
      rec.amountOut = s.swapDetails && s.swapDetails.amountOut;
      if (!rec.amountOut) throw new Error("SUCCESS without swapDetails.amountOut, so credit it manually");
    }
    const msg = { receiver_id: rec.account_id };
    if (rec.open === "curve") msg.action = "open_curve";
    if (rec.open === "flat") msg.action = "open_flat";
    rec.credited = "in_flight";
    saveState(this.state);
    const res = await this.call(
      this.usdc, "ft_transfer_call",
      { receiver_id: this.curve, amount: rec.amountOut, msg: JSON.stringify(msg) },
      { gas: 150n * TGAS, deposit: ONE_YOCTO },
    );
    // ft_transfer_call returns the amount used. "0" means the ledger refused it (e.g. stale price on open).
    rec.credited = res === "0" ? null : new Date().toISOString();
    saveState(this.state);
    if (!rec.credited) throw new Error("ledger refused the deposit; USDC is back in the relayer, so retry");
    return rec;
  }

  // ─────────────── withdraw ───────────────
  async ensureFtRegistered(accountId) {
    const bal = await this.view(this.usdc, "storage_balance_of", { account_id: accountId });
    if (!bal) {
      await this.call(this.usdc, "storage_deposit", { account_id: accountId, registration_only: true },
        { gas: 30n * TGAS, deposit: STORAGE_DEPOSIT });
    }
  }

  async withdraw({ tgId, amount, destinationAsset, recipient, dry = false }) {
    const account_id = this.userId(tgId);
    const q = await oneclick.withdrawQuote({ destinationAsset, amount, recipient, refundTo: this.relayerId, dry });
    if (dry) return q;
    const depositAddress = q.depositAddress;
    this.state.withdrawals[depositAddress] = {
      tgId: String(tgId), account_id, amount: String(amount), destinationAsset, recipient,
      quote: q.quote, status: "SENDING", createdAt: new Date().toISOString(),
    };
    saveState(this.state);
    await this.ensureFtRegistered(depositAddress);
    await this.call(this.curve, "withdraw",
      { amount: String(amount), account_id, receiver_id: depositAddress },
      { gas: 100n * TGAS, deposit: ONE_YOCTO });
    this.state.withdrawals[depositAddress].status = "SENT";
    saveState(this.state);
    return { depositAddress, quote: q.quote };
  }

  /** Follows a withdrawal to the end. On REFUNDED (USDC came back to the relayer), re-credits the user. */
  async settleWithdraw(depositAddress) {
    const rec = this.state.withdrawals[depositAddress];
    if (!rec) throw new Error(`unknown withdrawal ${depositAddress}`);
    if (["SUCCESS", "RECREDITED"].includes(rec.status)) return rec;
    const s = await oneclick.waitFor(depositAddress);
    rec.status = s.status;
    if (s.status === "REFUNDED") {
      const refunded = (s.swapDetails && s.swapDetails.refundedAmount) || rec.amount;
      await this.call(this.usdc, "ft_transfer_call",
        { receiver_id: this.curve, amount: String(refunded), msg: JSON.stringify({ receiver_id: rec.account_id }) },
        { gas: 150n * TGAS, deposit: ONE_YOCTO });
      rec.status = "RECREDITED";
    }
    saveState(this.state);
    return rec;
  }

  // ─────────────── trading on behalf of a user ───────────────
  openCurve(tgId, amount, minUnits) {
    return this.call(this.curve, "open_curve", { amount: String(amount), account_id: this.userId(tgId), min_units: minUnits && String(minUnits) });
  }
  closeCurve(tgId, units, minOut) {
    return this.call(this.curve, "close_curve", { units: units && String(units), account_id: this.userId(tgId), min_out: minOut && String(minOut) });
  }
  openFlat(tgId, amount, minShares) {
    return this.call(this.curve, "open_flat", { amount: String(amount), account_id: this.userId(tgId), min_shares: minShares && String(minShares) });
  }
  closeFlat(tgId, shares, minOut) {
    return this.call(this.curve, "close_flat", { shares: shares && String(shares), account_id: this.userId(tgId), min_out: minOut && String(minOut) });
  }
}

module.exports = { Relayer };

// ─────────────── CLI ───────────────
if (require.main === module) {
  const [cmd, ...a] = process.argv.slice(2);
  const flag = (f) => a.includes(f);
  const opt = (f) => (a.includes(f) ? a[a.indexOf(f) + 1] : undefined);
  const out = (x) => console.log(JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  const r = new Relayer();
  const run = {
    market: () => r.market(),
    account: () => r.accountOf(a[0]),
    // deposit <tgId> <originAsset> <amount> <refundTo> [--open curve|flat] [--dry]
    deposit: () => r.startDeposit({ tgId: a[0], originAsset: a[1], amount: a[2], refundTo: a[3], open: opt("--open"), dry: flag("--dry") }),
    // settle-deposit <depositAddress | tgId> [--simulate <usdcRaw>]
    "settle-deposit": () => r.settleDeposit(a[0], { simulate: opt("--simulate") }),
    // withdraw <tgId> <usdcRaw> <destinationAsset> <recipient> [--dry]
    withdraw: () => r.withdraw({ tgId: a[0], amount: a[1], destinationAsset: a[2], recipient: a[3], dry: flag("--dry") }),
    "settle-withdraw": () => r.settleWithdraw(a[0]),
    "open-curve": () => r.openCurve(a[0], a[1]),
    "close-curve": () => r.closeCurve(a[0], a[1]),
    "open-flat": () => r.openFlat(a[0], a[1]),
    "close-flat": () => r.closeFlat(a[0], a[1]),
    tokens: () => oneclick.tokens().then((t) => t.filter((x) => x.symbol === "USDC")),
  }[cmd];
  if (!run) {
    console.log("commands: market | account <tg> | deposit <tg> <originAsset> <amount> <refundTo> [--open curve|flat] [--dry]");
    console.log("          settle-deposit <addr> [--simulate <usdcRaw>] | withdraw <tg> <usdcRaw> <destAsset> <recipient> [--dry]");
    console.log("          settle-withdraw <addr> | open-curve|close-curve|open-flat|close-flat <tg> [amount] | tokens");
    process.exit(1);
  }
  run().then(out).catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
}
