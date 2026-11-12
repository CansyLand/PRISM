// Uprise keeper: price feed + vault rebalancing.
//   node keeper.js                 # live price of the deployment's asset (NEAR or BTC), Coinbase with Binance fallback
//   PRICE_MODE=random VOL=3 node keeper.js   # synthetic random walk, VOL = yearly vol (3 = 300%) for fast tests
//   node keeper.js once            # one price push + one vault cycle, then exit
//
// Every PRICE_SECS: push the price to the ledger and the swap.
// Every VAULT_SECS: sync the vault, then take up to MAX_STEPS bounded actions:
//   1. pay queued withdrawals (pull free ledger cash, else close part of the short)
//   2. bring free ledger cash home
//   3. hedge toward p × long claims (buy or sell the asset on the swap)
//   4. keep about SHORT_SHARE of the vault in Curve Short (needed before anyone can open a long)
import { account, view, call, loadDeployment, sleep, ONE_YOCTO, fmtUsd, ASSETS, spotPrice } from "./lib.js";

const d = loadDeployment();
if (!d) throw new Error("run setup.js first");
const keeper = account(d.keeper);
const ASSET = ASSETS[d.assetSymbol || "BTC"], SYM = ASSET.symbol, UNIT = 10n ** BigInt(d.assetDecimals ?? 8);
const PRICE_SECS = Number(process.env.PRICE_SECS || 15);
const VAULT_SECS = Number(process.env.VAULT_SECS || 45);
const MODE = process.env.PRICE_MODE || "live";
const VOL = Number(process.env.VOL || 3);
const SHORT_SHARE = Number(process.env.SHORT_SHARE || 0.5);
const MAX_STEPS = 6;
const once = process.argv[2] === "once";
const ts = () => new Date().toISOString().slice(11, 19);
const say = (...a) => console.log(ts(), ...a);

let last = null;
const livePrice = () => spotPrice(ASSET);
async function nextPrice() {
  if (MODE !== "random") return livePrice();
  if (last == null) last = await livePrice();
  // VOL is per year; each step is PRICE_SECS of *simulated day* time so tests move fast:
  // one step = one simulated hour.
  const dt = 1 / (365 * 24);
  last *= Math.exp(-VOL * VOL / 2 * dt + VOL * Math.sqrt(dt) * gauss());
  return last;
}
function gauss() { return Math.sqrt(-2 * Math.log(Math.max(Math.random(), 1e-12))) * Math.cos(2 * Math.PI * Math.random()); }

async function pushPrice() {
  const p = await nextPrice();
  const raw = String(Math.round(p * 1e6));
  await Promise.all([
    call(keeper, d.ledger, "push_price", { price: raw }, { tgas: 80 }),
    call(keeper, d.swap, "push_price", { price: raw }, { tgas: 10 }),
  ]);
  return p;
}

const big = (x) => BigInt(x);
async function sync() {
  const before = (await view(d.vault, "get_vault")).syncs;
  await call(keeper, d.vault, "sync", {}, { tgas: 300 });
  // RPC nodes can lag a block behind: wait until the view shows this sync.
  for (let i = 0; i < 10; i++) {
    const v = await view(d.vault, "get_vault");
    if (v.syncs > before) return v;
    await sleep(700);
  }
  return view(d.vault, "get_vault");
}

/** Decide one action from a fresh snapshot, or null when the vault is where it should be. */
function decide(v) {
  const s = v.snapshot, price = big(s.price);
  const nav = big(s.nav), cash = big(s.usdc), held = big(s.asset), free = big(s.ledger_free);
  const shortVal = big(s.short_value), shortShares = big(s.short_shares);
  const hedgeVal = held * price / UNIT, target = big(s.hedge_target_usd);
  const sharePx = big(v.share_price_e6);
  const owedW = v.pending_withdrawals.reduce((a, w) => a + big(w.amount) * sharePx / 1_000_000n, 0n);
  const tol = nav / 100n > 5_000_000n ? nav / 100n : 5_000_000n; // 1% of NAV, at least $5
  // 1. withdrawals waiting for cash
  if (owedW > cash) {
    const need = owedW - cash + 1_000_000n;
    if (free > 0n) return ["pull", { amount: String(free < need ? free : need) }, `pull ${fmtUsd(free < need ? free : need)} for withdrawals`];
    if (shortShares > 0n && shortVal > 0n) {
      let sh = shortShares * need / shortVal + 1n; if (sh > shortShares) sh = shortShares;
      return ["deallocate", { shares: String(sh) }, `close short worth ~${fmtUsd(need)} for withdrawals`];
    }
  }
  // 2. free ledger cash home
  if (free > 1_000_000n) return ["pull", { amount: String(free) }, `pull ${fmtUsd(free)} from the ledger`];
  // 3. hedge
  const err = hedgeVal - target;
  if (err < -tol && cash - owedW > 1_000_000n) {
    let buy = -err; const room = cash - owedW; if (buy > room) buy = room;
    return ["hedge_buy", { usdc_amount: String(buy) }, `buy ${SYM} for ${fmtUsd(buy)} (hedge ${fmtUsd(hedgeVal)} → ${fmtUsd(target)})`];
  }
  if (err > tol) {
    const sell = err * UNIT / price;
    if (sell > 0n) return ["hedge_sell", { asset_amount: String(sell) }, `sell ${(Number(sell * 100000n / UNIT) / 1e5).toFixed(4)} ${SYM} (hedge ${fmtUsd(hedgeVal)} → ${fmtUsd(target)})`];
  }
  // 4. short allocation
  const wantShort = BigInt(Math.floor(Number(nav) * SHORT_SHARE));
  const spare = cash - owedW - (target > hedgeVal ? target - hedgeVal : 0n) - nav / 20n; // keep 5% cash
  if (shortVal + tol < wantShort && spare > 1_000_000n) {
    let amt = wantShort - shortVal; if (amt > spare) amt = spare;
    return ["allocate", { amount: String(amt) }, `put ${fmtUsd(amt)} into Curve Short`];
  }
  // Short far above target and the hedge needs cash: close some.
  if (target > hedgeVal + tol && cash < target - hedgeVal && shortVal > wantShort && shortShares > 0n) {
    const need = target - hedgeVal - cash;
    let sh = shortShares * need / shortVal + 1n; if (sh > shortShares) sh = shortShares;
    return ["deallocate", { shares: String(sh) }, `close short worth ~${fmtUsd(need)} to fund the hedge`];
  }
  return null;
}

async function vaultCycle() {
  let v = await sync();
  for (let i = 0; i < MAX_STEPS; i++) {
    if (!v.fresh) { say("vault snapshot not fresh (ledger price stale?)"); return v; }
    const step = decide(v);
    if (!step) break;
    const [method, args, text] = step;
    try {
      await call(keeper, d.vault, method, args, { tgas: 300 });
      say("vault:", text);
    } catch (e) {
      say("vault:", method, "failed:", String(e.message || e).slice(0, 200));
    }
    v = await sync();
  }
  const s = v.snapshot;
  say(`vault NAV ${fmtUsd(s.nav)} · share ${(Number(v.share_price_e6) / 1e6).toFixed(5)} · cash ${fmtUsd(s.usdc)} · short ${fmtUsd(s.short_value)} · ${SYM} ${fmtUsd(v.hedge_value)} / target ${fmtUsd(s.hedge_target_usd)} · queue ${v.pending_deposits.length}D ${v.pending_withdrawals.length}W`);
  return v;
}

async function main() {
  say(`keeper ${d.keeper} · price ${MODE}${MODE === "random" ? ` (vol ${VOL * 100}%/yr, 1 step = 1 sim hour)` : ""} · push every ${PRICE_SECS}s · vault every ${VAULT_SECS}s`);
  let nextVault = 0;
  for (;;) {
    try {
      const p = await pushPrice();
      const m = await view(d.ledger, "get_market");
      say(`${SYM} $${p.toFixed(SYM === "NEAR" ? 4 : 2)} · util ${(m.utilization_bps / 100).toFixed(1)}% · funding ${(m.funding_rate_annual_bps / 100).toFixed(1)}%/yr (σ ${(m.funding_vol_bps / 100).toFixed(0)}%) · claims ${fmtUsd(m.long_claims)} · pool ${fmtUsd(m.risk_pool)}`);
    } catch (e) { say("price push failed:", String(e.message || e).slice(0, 200)); }
    if (once || Date.now() >= nextVault) {
      try { await vaultCycle(); } catch (e) { say("vault cycle failed:", String(e.message || e).slice(0, 200)); }
      nextVault = Date.now() + VAULT_SECS * 1000;
    }
    if (once) break;
    await sleep(PRICE_SECS * 1000);
  }
}
main();
