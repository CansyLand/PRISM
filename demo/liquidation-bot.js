// PRISM liquidation bot — 24/7 watcher.
// Polls get_positions on the live contract; for every position where
// preview_liquidation returns a result (equity below the maintenance floor at
// the on-chain mark), it calls liquidate_on_mark and earns 50% of the
// position's remaining equity.
//
// Usage:
//   node liquidation-bot.js                 # runs forever (5 s poll)
//   BOT_CONTRACT=x.testnet BOT_POLL_MS=3000 node liquidation-bot.js
//   BOT_ONESHOT=1 node liquidation-bot.js   # single pass, then exit (cron-friendly)
//
// The bot needs NO price feed of its own: liquidation is entirely
// on-chain (mark is in the contract; preview_liquidation is a pure view).
// It stays correct even when every off-chain source is down — the point of
// the design.
const { JsonRpcProvider, Account } = require("near-api-js");
const fs = require("fs");
const path = require("path");

const NODE_URL = process.env.BOT_NODE_URL || "https://test.rpc.fastnear.com";
const POLL_MS = parseInt(process.env.BOT_POLL_MS || "5000", 10);
const ONESHOT = process.env.BOT_ONESHOT === "1";
const GAS = "300000000000000"; // 0.3 TGas

function loadCreds() {
  const txt = fs.readFileSync(path.join(__dirname, "..", ".deploy.env"), "utf8");
  const g = (k) => (txt.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
  return {
    contract: process.env.BOT_CONTRACT || g("ACCOUNT_ID"),
    liquidator: {
      accountId: g("LIQUIDATOR_ACCOUNT_ID"),
      privateKey: g("LIQUIDATOR_PRIVATE_KEY"),
    },
  };
}

const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);

async function main() {
  const c = loadCreds();
  const provider = new JsonRpcProvider({ url: NODE_URL });
  const bot = new Account(c.liquidator.accountId, provider, c.liquidator.privateKey);

  const view = (m, a = {}) => provider.callFunction({ contractId: c.contract, method: m, args: a });

  console.log(`[bot] ${ts()} watching ${c.contract} as ${c.liquidator.accountId} (poll ${POLL_MS} ms${ONESHOT ? ", one-shot" : ""})`);
  let liquidations = 0;

  const pass = async () => {
    let positions, mark;
    try {
      [positions, mark] = await Promise.all([view("get_positions", {}), view("get_mark", {})]);
    } catch (e) {
      console.log(`[bot] ${ts()} view error (retrying next poll): ${e.message.split("\n")[0]}`);
      return;
    }
    const markUsd = (mark[0] / 1e6).toFixed(4);
    const open = Array.isArray(positions) ? positions.filter((p) => p.is_open) : [];
    const openCount = open.length;

    if (openCount === 0) {
      if (ONESHOT) console.log(`[bot] ${ts()} mark $${markUsd} — no open positions; nothing to do`);
      return;
    }

    for (const pos of open) {
      let preview = null;
      try {
        preview = await view("preview_liquidation", { account_id: pos.owner });
      } catch {
        continue;
      }
      if (!preview) continue; // healthy

      const reward = Number(preview.liquidator_reward) / 1e6;
      console.log(`[bot] ${ts()} LIQUIDATION TARGET ${pos.owner} — equity below floor at mark $${markUsd}; reward $${reward.toFixed(6)} (50% of remaining equity)`);
      try {
        const res = await bot.callFunctionRaw({
          contractId: c.contract, methodName: "liquidate_on_mark",
          args: { account_id: pos.owner }, gas: GAS, deposit: "0",
        });
        // source of truth: is the position now closed on-chain?
        const after = await view("get_position", { account_id: pos.owner });
        const closed = !after || !after.is_open;
        if (closed) {
          liquidations++;
          console.log(`[bot] ${ts()} ✓ liquidated ${pos.owner} — reward $${reward.toFixed(6)} to ${c.liquidator.accountId}`);
        } else {
          console.log(`[bot] ${ts()} ✗ liquidation of ${pos.owner} still open after call (status ${res.final_execution_status})`);
        }
      } catch (e) {
        console.log(`[bot] ${ts()} ✗ liquidation call failed for ${pos.owner}: ${e.message.split("\n")[0]}`);
      }
    }
    if (ONESHOT && liquidations === 0) {
      console.log(`[bot] ${ts()} mark $${markUsd} — ${openCount} open position(s), all healthy`);
    }
  };

  if (ONESHOT) {
    await pass();
    console.log(`[bot] one-shot pass complete: ${liquidations} liquidation(s)`);
    return;
  }
  for (;;) {
    await pass();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => { console.error("[bot] fatal:", e); process.exit(1); });
