// Liquidation demo — the "unstoppable" moment, fully on-chain-priced.
//
// A REALISTIC liquidation under the max-leverage cap:
//   1. price feed pushes a live mark on-chain (2 sources, median)
//   2. OWNER opens a LEGAL 10x long (10% margin) at the mark — healthy
//   3. LIQUIDATOR opens a 1x position on itself (100% margin) — healthy
//   4. GUARD: stranger tries to liquidate the liquidator's healthy position
//      → REJECTED by the contract
//   5. PRICE CRASH: feed pushes a mark 7% lower (within the 20% fresh
//      deviation guard). Owner's equity erodes from 10% → 3.2% of notional,
//      below the 5% maintenance floor.
//   6. RISK ENGINE → LIQUIDATION THROUGH AN INTENT: the off-chain risk
//      engine expresses the liquidation as a 1Click intent (dry-run; the
//      solver hedges the exposure in the market). If the intent route is
//      down, we degrade — the loop does not stop.
//   7. SETTLE ON-CHAIN AT THE MARK: liquidator calls liquidate_on_mark —
//      no price argument, no external feed. The liquidator earns 50% of the
//      remaining equity as reward. If 1Click, CoinGecko and every chain were
//      congested right now, this tx would still work.
const { Account, JsonRpcProvider, teraToGas, nearToYocto } = require("near-api-js");
const fs = require("fs");
const path = require("path");
const { pushMark, updateMark } = require("./pricefeed");
const { quote } = require("./intent");

const NODE_URL = "https://test.rpc.fastnear.com";
const USDC = 1e6;
const CRASH_BPS = 700; // price falls 7% between step 2 and step 7

function loadCreds() {
  const txt = fs.readFileSync(path.join(__dirname, "..", ".deploy.env"), "utf8");
  const g = (k) => (txt.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
  return {
    owner: { accountId: g("ACCOUNT_ID"), privateKey: g("PRIVATE_KEY") },
    liquidator: { accountId: g("LIQUIDATOR_ACCOUNT_ID"), privateKey: g("LIQUIDATOR_PRIVATE_KEY") },
  };
}

function line(t) {
  console.log("\n" + "─".repeat(66) + "\n" + t + "\n" + "─".repeat(66));
}

async function main() {
  const { owner, liquidator } = loadCreds();
  const provider = new JsonRpcProvider({ url: NODE_URL });
  const ownerAcc = new Account(owner.accountId, provider, owner.privateKey);
  const liqAcc = new Account(liquidator.accountId, provider, liquidator.privateKey);

  line("1) PRICE FEED PUSHES THE MARK ON-CHAIN (2 sources, median)");
  const feed = await pushMark();
  const mark = feed.onChain[0];
  console.log(`  pushed $${feed.pushed} -> on-chain mark now ${JSON.stringify(feed.onChain)}`);
  console.log(`  from here on, NOTHING external is consulted for risk.`);

  line("2) OWNER OPENS A LEGAL 10x LONG AT THE MARK (10% margin)");
  const size = 100;
  const notional = size * mark;
  const marginU = Math.round(notional / 10); // 10% — exactly 10x, the cap
  await ownerAcc.callFunction({
    contractId: owner.accountId,
    methodName: "open_position",
    args: { size, price: mark, margin: marginU },
    gas: teraToGas("100"),
    deposit: nearToYocto("0"),
  });
  let posO = await provider.callFunction({
    contractId: owner.accountId, method: "get_position", args: { account_id: owner.accountId },
  });
  console.log(`  open_position(size=${size}, price=${mark}, margin=${marginU})`);
  console.log(`  notional $${(notional / USDC).toFixed(2)} | margin $${(marginU / USDC).toFixed(2)} | 10x leverage`);
  console.log(`  position: ${JSON.stringify(posO)}`);
  console.log("  equity = 10% of notional > 5% maintenance floor → HEALTHY");

  line("3) LIQUIDATOR OPENS A 1x POSITION ON ITSELF (100% margin)");
  const liqSize = 10;
  const liqNotional = liqSize * mark;
  const marginH = liqNotional; // 1x: margin = full notional
  await liqAcc.callFunction({
    contractId: owner.accountId,
    methodName: "open_position",
    args: { size: liqSize, price: mark, margin: marginH },
    gas: teraToGas("100"),
    deposit: nearToYocto("0"),
  });
  let posL = null;
  for (let i = 0; i < 10; i++) {
    posL = await provider.callFunction({
      contractId: owner.accountId, method: "get_position", args: { account_id: liquidator.accountId },
    });
    if (posL && posL.entry_price === mark) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`  open_position(size=${liqSize}, price=${mark}, margin=${marginH})`);
  console.log(`  position: ${JSON.stringify(posL)}`);
  console.log("  equity = 100% of notional >> 5% maintenance floor → healthy");

  line("4) GUARD: liquidating the HEALTHY position is IMPOSSIBLE");
  console.log(`  caller: ${owner.accountId}  (a stranger to the liquidator's position)`);
  try {
    await ownerAcc.callFunction({
      contractId: owner.accountId,
      methodName: "liquidate_on_mark",
      args: { account_id: liquidator.accountId },
      gas: teraToGas("100"),
      deposit: nearToYocto("0"),
    });
    console.log("  UNEXPECTED: healthy liquidation succeeded!");
    process.exit(1);
  } catch (e) {
    const msg = (e.messages && e.messages[0]) || e.message;
    console.log("  liquidate_on_mark(...) REJECTED by the contract:");
    console.log(`  ${JSON.stringify(msg).slice(0, 200)}`);
  }

  line("5) PRICE CRASH: feed pushes a mark 7% lower (one 20%-guard step)");
  const crashed = Math.round(mark * (10_000 - CRASH_BPS) / 10_000);
  await updateMark(crashed);
  const m2 = crashed;
  const equity = marginU + size * (m2 - mark); // USDC raw 6dp
  const notionalNow = size * m2;
  console.log(`  mark: $${(mark / USDC).toFixed(4)} → $${(m2 / USDC).toFixed(4)}  (-${CRASH_BPS / 100}%)`);
  console.log(`  owner equity: $${(marginU / USDC).toFixed(2)} → $${(equity / USDC).toFixed(2)}`);
  console.log(`  equity/notional: ${((equity / notionalNow) * 100).toFixed(2)}%  (floor 5%)`);
  // wait for the mark tx to land before the view (optimistic finality can race)
  let prev = null;
  for (let i = 0; i < 10; i++) {
    prev = await provider.callFunction({
      contractId: owner.accountId, method: "preview_liquidation", args: { account_id: owner.accountId },
    });
    if (prev) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`  preview_liquidation → ${JSON.stringify(prev)}`);

  line("6) RISK ENGINE → LIQUIDATION THROUGH AN INTENT (dry-run)");
  console.log(`  owner      : ${owner.accountId}`);
  console.log(`  liquidator : ${liquidator.accountId}   <-- different key, not an admin`);
  console.log("  the off-chain risk engine reads the on-chain position + on-chain");
  console.log("  mark, sees equity below maintenance, and expresses the liquidation");
  console.log("  as a 1Click intent (the solver hedges the long's exposure in the");
  console.log("  market) while the accounting settles on NEAR:");
  try {
    const liqQ = await quote({ action: "close", amount: (BigInt(size) * 10n ** 24n).toString(), dry: true });
    console.log(`  intent: wNEAR -> USDC  (hedge the long's notional)`);
    console.log(`  quote:  ${liqQ.quote.amountInFormatted} wNEAR => ${liqQ.quote.amountOutFormatted} USDC  (est ${liqQ.quote.timeEstimate}s)`);
    console.log(`  correlation: ${liqQ.correlationId}   [dry-run: no funds moved]`);
  } catch (e) {
    console.log(`  1Click route unavailable (${(e && e.message || e).toString().slice(0, 60)}…)`);
    console.log("  → DEGRADED: hedge off-chain is pending; on-chain settlement below");
    console.log("    does not depend on it — that is the point.");
  }

  line("7) SETTLE ON-CHAIN AT THE MARK — NO PRICE ARGUMENT, NO FEED");
  console.log("  the mark comes from ON-CHAIN STATE. If 1Click, CoinGecko and");
  console.log("  every chain were congested right now, this tx would still work.");
  await liqAcc.callFunction({
    contractId: owner.accountId,
    methodName: "liquidate_on_mark",
    args: { account_id: owner.accountId },
    gas: teraToGas("100"),
    deposit: nearToYocto("0"),
  });
  posO = await provider.callFunction({
    contractId: owner.accountId, method: "get_position", args: { account_id: owner.accountId },
  });
  console.log("  liquidate_on_mark(...) → closed.");
  console.log(`  position: ${JSON.stringify(posO)}`);
  console.log("  liquidator reward (50% of remaining equity) recorded on-chain.");

  line("LIQUIDATION DEMO COMPLETE ✓");
  console.log("  - a LEGAL 10x position, broken by a 7% move, liquidated by a stranger");
  console.log("  - mark price lives in the contract, pushed by a 2-source median feed");
  console.log("  - liquidation is expressed as a 1Click intent (value moves off-chain)");
  console.log("  - settlement reads only NEAR state (congestion-proof)");
  console.log("  - liquidator earns 50% of remaining equity; healthy positions cannot be touched");
}

main().catch((e) => {
  console.error("ERROR:", e && e.message ? e.message : e);
  if (e && e.messages) console.error(JSON.stringify(e.messages).slice(0, 400));
  process.exit(1);
});
