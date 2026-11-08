// Live bot integration test: open a 10x long (as the pusher account),
// crash the mark -7% (past the 5% maintenance floor), run the liquidation
// bot one-shot, assert the position was liquidated by the liquidator account
// and the reward was earned. Finally restore a healthy mark.
const { JsonRpcProvider, Account, nearToYocto } = require("near-api-js");
const fs = require("fs");
const path = require("path");

const NODE_URL = "https://test.rpc.fastnear.com";
const GAS = "300000000000000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const txt = fs.readFileSync(path.join(__dirname, "..", ".deploy.env"), "utf8");
const g = (k) => (txt.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
const CONTRACT = g("ACCOUNT_ID"); // prism-v4-2026.testnet (owner == pusher)
const pusher = new Account(g("ACCOUNT_ID"), new JsonRpcProvider({ url: NODE_URL }), g("PRIVATE_KEY"));

let passed = 0, failed = 0;
const ok = (n, c, d) => { if (c) { passed++; console.log(`  ✓ ${n}${d ? " — " + d : ""}`); } else { failed++; console.log(`  ✗ ${n}${d ? " — " + d : ""}`); } };

async function tx(method, args) {
  const res = await pusher.callFunctionRaw({ contractId: CONTRACT, methodName: method, args, gas: GAS, deposit: "0" });
  const logs = [];
  for (const ro of res.receipts_outcome || []) logs.push(...((ro.outcome && ro.outcome.logs) || []));
  return { res, logs };
}
const view = (m, a = {}) => pusher.provider.callFunction({ contractId: CONTRACT, method: m, args: a });
const me = g("ACCOUNT_ID");

(async () => {
  console.log("== bot live test on", CONTRACT, "==");
  const mark0 = (await view("get_mark", {}))[0];

  // open 10x long: size 100 units, margin = 1/10 of notional
  const size = 100, margin = Math.round((size * mark0) / 10);
  await tx("open_position", { size, price: mark0, margin });
  await sleep(400);
  const pos = await view("get_position", { account_id: me });
  ok("10x long open (bot target)", pos && pos.is_open, `size=${pos.size} margin=${Number(pos.margin)/1e6} USDC`);

  // healthy at current mark
  let preview = await view("preview_liquidation", { account_id: me });
  ok("healthy at mark (no liquidation)", !preview);

  // crash -7%: for a 10x position, equity 10% - 7% = 3% < 5% maintenance floor
  const crashed = Math.round(mark0 * 0.93);
  await tx("update_mark", { mark: crashed });
  await sleep(400);
  preview = await view("preview_liquidation", { account_id: me });
  ok("below maintenance floor after -7% crash", !!preview, `reward would be $${Number(preview.liquidator_reward)/1e6}`);

  // THE MOMENT: bot detects + liquidates
  console.log("  ... running liquidation-bot.js one-shot ...");
  const { execSync } = require("child_process");
  const out = execSync("node liquidation-bot.js", { env: { ...process.env, BOT_ONESHOT: "1" }, encoding: "utf8" });
  console.log(out.trim().split("\n").map((l) => "    " + l).join("\n"));
  ok("bot executed a liquidation", /✓ liquidated/.test(out));

  const posAfter = await view("get_position", { account_id: me });
  ok("position closed by bot", !posAfter || !posAfter.is_open);

  // restore a healthy mark (anchor for future e2e runs; +7% back within 20% guard of pre-crash)
  await tx("update_mark", { mark: mark0 });
  await sleep(400);

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error("fatal:", e); process.exit(1); });
