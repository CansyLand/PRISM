// PRISM end-to-end userflow test suite — runs against the LIVE testnet contract.
// Every flow performs real transactions and asserts real on-chain results
// (parsed from on-chain logs and view methods — no mocked data).
//   F1  trading loop     : push mark → open 10x long → close at mark → pnl=0
//   F2  short position   : open short → close at mark → pnl=0 (symmetry)
//   F3  leverage guard   : over-leveraged open rejected (max leverage cap)
//   F4  min-margin guard : sub-$1 margin rejected
//   F5  liquidation      : crash mark → healthy not liquidatable → below floor
//                          → stranger liquidates → reward per model, position closed
//   F6  funding engine   : rate set on-chain, hourly gate, exact margin movement
//   F7  views & stats    : get_mark / get_params / get_stats / get_positions reconcile
//   F8  cleanup          : all positions closed
const {
  JsonRpcProvider, Account, nearToYocto,
} = require("near-api-js");
const fs = require("fs");
const path = require("path");

const NODE_URL = "https://test.rpc.fastnear.com";
const USDC = 1e6;
const GAS = "300000000000000"; // 0.3 TGas
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadCreds() {
  const txt = fs.readFileSync(path.join(__dirname, "..", ".deploy.env"), "utf8");
  const g = (k) => (txt.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
  return {
    owner: { accountId: g("ACCOUNT_ID"), privateKey: g("PRIVATE_KEY") },
    liquidator: { accountId: g("LIQUIDATOR_ACCOUNT_ID"), privateKey: g("LIQUIDATOR_PRIVATE_KEY") },
  };
}

let provider, owner, liquidator, passed = 0, failed = 0;

function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? " — " + detail : ""}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
async function tx(acc, method, args) {
  // v7: callFunctionRaw returns the full RPC response (logs under receipts_outcome[].outcome.logs)
  const res = await acc.callFunctionRaw({
    contractId: owner.accountId, methodName: method, args, gas: GAS, deposit: nearToYocto("0"),
  });
  const logs = [];
  for (const ro of res.receipts_outcome || []) {
    const l = (ro.outcome && ro.outcome.logs) || (ro.receipt && ro.receipt.receipt_logs && ro.receipt.receipt_logs.logs) || [];
    logs.push(...l);
  }
  res.logs = logs;
  return res;
}
async function view(method, args) {
  return provider.callFunction({ contractId: owner.accountId, method, args });
}
// parse the last JSON log line of a transaction
function lastLog(res) {
  const logs = (res && res.logs) || [];
  for (let i = logs.length - 1; i >= 0; i--) {
    try { return JSON.parse(logs[i]); } catch { /* keep looking */ }
  }
  return null;
}
async function expectReject(acc, method, args) {
  try { await tx(acc, method, args); return false; }
  catch { return true; }
}
async function pushMark(markRaw) {
  await tx(owner, "update_mark", { mark: markRaw });
  await sleep(400);
}
async function readMark() {
  const m = await view("get_mark", {});
  return { price: Number(m[0]), ts: Number(m[1]) };
}
async function positionOf(id) {
  return view("get_position", { account_id: id });
}
// close + wait for the position to be gone; returns the logged pnl (raw USDC)
async function closeAndWait(acc, id) {
  const res = await tx(acc, "close_position_at_mark", {});
  const ev = lastLog(res);
  let pos = await positionOf(id);
  for (let i = 0; i < 10 && pos && pos.is_open; i++) { await sleep(1500); pos = await positionOf(id); }
  return { pnl: ev ? Number(ev.pnl) : null, pos };
}
function section(t) { console.log("\n" + "─".repeat(66) + "\n" + t + "\n" + "─".repeat(66)); }

async function main() {
  const c = loadCreds();
  provider = new JsonRpcProvider({ url: NODE_URL });
  owner = new Account(c.owner.accountId, provider, c.owner.privateKey);
  liquidator = new Account(c.liquidator.accountId, provider, c.liquidator.privateKey);
  console.log("contract:", owner.accountId, "| liquidator:", liquidator.accountId);

  // ── pre-state ───────────────────────────────────────────────────────────
  section("PRE-STATE");
  for (const [acc, id] of [[owner, c.owner.accountId], [liquidator, c.liquidator.accountId]]) {
    const pos = await positionOf(id);
    if (pos && pos.is_open) {
      console.log(`  closing leftover ${id}`);
      await closeAndWait(acc, id);
    }
  }
  let mark = await readMark();
  console.log(`  baseline mark $${(mark.price / USDC).toFixed(4)} (age ${Math.floor((Date.now() / 1000 - mark.ts) / 60)}m)`);

  // ── F1: trading loop ────────────────────────────────────────────────────
  section("F1  TRADING LOOP  (open 10x long → close at mark)");
  const openMark = Math.round(mark.price * 98 / 100); // -2%, inside fresh guard
  await pushMark(openMark);
  const size = 100, margin = Math.round((size * openMark) / 10);
  await tx(owner, "open_position", { size, price: openMark, margin });
  await sleep(600);
  let pos = await positionOf(c.owner.accountId);
  ok("position opened", pos && pos.is_open, `size ${pos.size} @ $${(Number(pos.entry_price) / USDC).toFixed(4)}`);
  ok("entry pinned to mark", Number(pos.entry_price) === openMark);
  ok("margin recorded", Number(pos.margin) === margin, `$${(margin / USDC).toFixed(2)}`);
  const { pnl: pnl1, pos: pos1 } = await closeAndWait(owner, c.owner.accountId);
  ok("closed at same mark → pnl = 0", pnl1 === 0, `pnl ${pnl1 === null ? "unknown" : (pnl1 / USDC).toFixed(4)}`);
  ok("position gone", !(pos1 && pos1.is_open));

  // ── F2: short position ──────────────────────────────────────────────────
  section("F2  SHORT POSITION  (symmetry)");
  const shortMark = Math.round(openMark * 101 / 100); // +1%
  await pushMark(shortMark);
  const sSize = -50, sMargin = Math.round((50 * shortMark) / 10);
  await tx(owner, "open_position", { size: sSize, price: shortMark, margin: sMargin });
  await sleep(600);
  pos = await positionOf(c.owner.accountId);
  ok("short opened", pos && pos.is_open && Number(pos.size) < 0, `size ${pos.size}`);
  const { pnl: pnl2 } = await closeAndWait(owner, c.owner.accountId);
  ok("short closed at same mark → pnl = 0", pnl2 === 0, `pnl ${pnl2 === null ? "unknown" : (pnl2 / USDC).toFixed(4)}`);

  // ── F3: leverage guard ──────────────────────────────────────────────────
  section("F3  LEVERAGE GUARD  (max leverage cap)");
  const overLevMargin = Math.round((size * openMark) / 11); // ~11x > cap
  const rejLev = await expectReject(owner, "open_position", { size, price: openMark, margin: overLevMargin });
  ok("over-leveraged open rejected", rejLev, "margin < 1/max_leverage of notional");
  const rej1x = await expectReject(owner, "open_position", { size, price: openMark, margin: size * openMark });
  ok("1x (under-leveraged) still allowed", !rej1x, "low leverage is legal");
  await closeAndWait(owner, c.owner.accountId); // clean the 1x we just opened

  // ── F4: min margin guard ────────────────────────────────────────────────
  section("F4  MIN-MARGIN GUARD  (sub-$1 collateral)");
  const rejMin = await expectReject(owner, "open_position", { size, price: openMark, margin: 100_000 });
  ok("sub-minimum margin rejected", rejMin, "margin $0.10 < $1.00 floor");

  // ── F5: liquidation through stranger ───────────────────────────────────
  section("F5  LIQUIDATION  (crash → stranger liquidates on mark)");
  await pushMark(openMark);
  const lSize = 100, lMargin = Math.round((lSize * openMark) / 10); // 10x
  await tx(owner, "open_position", { size: lSize, price: openMark, margin: lMargin });
  await sleep(600);
  let preview = await view("preview_liquidation", { account_id: c.owner.accountId });
  ok("healthy 10x not liquidatable at entry", !preview, "equity above 5% floor");
  const crashMark = Math.round(openMark * 93 / 100); // -7%: equity ~3% < 5%
  await pushMark(crashMark);
  preview = await view("preview_liquidation", { account_id: c.owner.accountId });
  ok("below maintenance floor after -7% crash", !!preview, preview ? `liquidator_reward $${(Number(preview.liquidator_reward) / USDC).toFixed(2)}` : "");
  if (preview) {
    const expEquity = Number(preview.owner_equity) + Number(preview.liquidator_reward);
    const res = await tx(liquidator, "liquidate_on_mark", { account_id: c.owner.accountId });
    await sleep(600);
    const ev = lastLog(res);
    ok("stranger liquidation executed", !!ev && ev.event === "liquidate", ev ? `reward $${(Number(ev.reward) / USDC).toFixed(2)}` : "no log");
    if (ev) {
      ok("reward matches preview", Number(ev.reward) === Number(preview.liquidator_reward), `$${(Number(preview.liquidator_reward) / USDC).toFixed(2)}`);
      ok("reward = 50% of remaining equity", 2 * Number(ev.reward) === expEquity, `equity $${(expEquity / USDC).toFixed(2)}`);
      ok("owner keeps the rest", Number(preview.owner_equity) === expEquity - Number(ev.reward));
    }
    const posAfter = await positionOf(c.owner.accountId);
    ok("victim position closed", !(posAfter && posAfter.is_open));
  }

  // ── F6: funding engine ──────────────────────────────────────────────────
  section("F6  FUNDING ENGINE  (hourly gate + exact margin movement)");
  const fMark = await readMark();
  await tx(owner, "open_position", { size: 100, price: fMark.price, margin: Math.round((100 * fMark.price) / 10) });
  await tx(liquidator, "open_position", { size: 10, price: fMark.price, margin: Math.round((10 * fMark.price) / 10) });
  await sleep(600);
  const posA0 = await positionOf(c.owner.accountId);
  const posB0 = await positionOf(c.liquidator.accountId);
  await tx(owner, "set_funding_rate", { funding_bps: 100 }); // +1%/interval, longs pay
  const rate = Number(await view("funding_rate_bps", {}));
  ok("funding rate set on-chain", rate === 100, `funding_rate_bps=${rate}`);
  const stats0 = await view("get_stats", {});
  const sinceFunding = Math.floor(Date.now() / 1000) - Number(stats0.last_funding_ts);
  if (sinceFunding < 3600) {
    const gated = await expectReject(owner, "apply_funding", {});
    ok("hourly gate enforced (< 1h since last funding)", gated, `${sinceFunding}s since last apply`);
  } else {
    const RATE = 100, CLAMP = 1000; // clamp = 10% of margin
    const expA = Math.min(Math.round((100 * fMark.price * RATE) / 10_000), Math.round(Number(posA0.margin) * CLAMP / 10_000));
    const expB = Math.min(Math.round((10 * fMark.price * RATE) / 10_000), Math.round(Number(posB0.margin) * CLAMP / 10_000));
    await tx(owner, "apply_funding", {});
    await sleep(600);
    const posA1 = await positionOf(c.owner.accountId);
    const posB1 = await positionOf(c.liquidator.accountId);
    ok("user A margin moved exactly per model", Number(posA0.margin) - Number(posA1.margin) === expA,
      `$${((Number(posA0.margin) - Number(posA1.margin)) / USDC).toFixed(2)} (expected $${(expA / USDC).toFixed(2)})`);
    ok("user B margin moved exactly per model", Number(posB0.margin) - Number(posB1.margin) === expB,
      `$${((Number(posB0.margin) - Number(posB1.margin)) / USDC).toFixed(2)} (expected $${(expB / USDC).toFixed(2)})`);
  }
  await closeAndWait(owner, c.owner.accountId);
  await closeAndWait(liquidator, c.liquidator.accountId);
  await tx(owner, "set_funding_rate", { funding_bps: 0 });

  // ── F7: views & stats reconcile ────────────────────────────────────────
  section("F7  VIEWS & STATS");
  const params = await view("get_params", {});
  ok("get_params sane", Number(params.liq_bps) === 500 && Number(params.min_margin) === USDC && Number(params.max_leverage) >= 2,
    `liq_bps=${params.liq_bps} max_lev=${params.max_leverage} min_margin=${params.min_margin}`);
  const mk2 = await readMark();
  ok("get_mark returns price + timestamp", Number(mk2.price) > 0 && Number(mk2.ts) > 1_600_000_000, `mark $${(mk2.price / USDC).toFixed(4)}`);
  const stats = await view("get_stats", {});
  const all = await view("get_positions", {});
  const open = all.filter((p) => p.is_open);
  ok("stats.open_positions = count(open)", Number(stats.open_positions) === open.length, `${stats.open_positions} vs ${open.length}`);
  const notionalSum = open.reduce((s, p) => s + Math.abs(Number(p.size)) * Number(mk2.price), 0);
  ok("stats.total_notional reconciles", Number(stats.total_notional) === notionalSum, `$${(Number(stats.total_notional) / USDC).toFixed(2)}`);

  // ── F8: cleanup ─────────────────────────────────────────────────────────
  section("F8  CLEANUP");
  for (const [acc, id] of [[owner, c.liquidator.accountId], [liquidator, c.liquidator.accountId]]) {
    const p = await positionOf(id);
    if (p && p.is_open) await closeAndWait(acc, id);
  }
  const finalStats = await view("get_stats", {});
  ok("no open positions remain", Number(finalStats.open_positions) === 0, `open=${finalStats.open_positions} notional=$${(Number(finalStats.total_notional) / USDC).toFixed(2)}`);

  // ── summary ─────────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(66));
  console.log(`RESULT: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log("═".repeat(66));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e && e.messages ? JSON.stringify(e.messages).slice(0, 400) : (e && e.message ? e.message : e));
  process.exit(1);
});
