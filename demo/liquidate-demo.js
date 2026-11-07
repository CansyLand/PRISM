// Liquidation demo — the "unstoppable" moment.
//
// A STRANGER (second testnet account, different key) force-closes an
// underwater position ON NEAR. No external sequencer, order book, or
// operator is involved: the risk rule and the state live in the contract.
//
// Flow:
//   owner  : open_position(size, live price, SMALL margin)  -> underwater
//   anyone : liquidate(owner, live mark price)              -> closed
const { Account, JsonRpcProvider, teraToGas, nearToYocto } = require("near-api-js");
const fs = require("fs");
const path = require("path");
const { tokenPrice } = require("./intent");

const NODE_URL = "https://rpc.testnet.near.org";
const USDC = 1e6;

function loadCreds() {
  const txt = fs.readFileSync(path.join(__dirname, "..", ".deploy.env"), "utf8");
  const g = (k) => (txt.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
  return {
    owner: { accountId: g("ACCOUNT_ID"), privateKey: g("PRIVATE_KEY") },
    liquidator: { accountId: g("LIQUIDATOR_ACCOUNT_ID"), privateKey: g("LIQUIDATOR_PRIVATE_KEY") },
  };
}

function line(t) { console.log("\n" + "─".repeat(66) + "\n" + t + "\n" + "─".repeat(66)); }

async function main() {
  const { owner, liquidator } = loadCreds();
  const provider = new JsonRpcProvider({ url: NODE_URL });
  const ownerAcc = new Account(owner.accountId, provider, owner.privateKey);
  const liqAcc = new Account(liquidator.accountId, provider, liquidator.privateKey);

  line("1) LIVE MARK PRICE (1Click tokens endpoint)");
  const markUsd = await tokenPrice("wNEAR");
  const mark = Math.round(markUsd * USDC);
  console.log(`  mark price = $${markUsd} => ${mark} (USDC 6dp)`);

  line("2) OWNER OPENS AN UNDERWATER POSITION (10x long, tiny margin)");
  const size = 10;
  const notionalUsd = size * markUsd;
  const marginUsd = notionalUsd / 5; // 20% coverage < 50% threshold
  const margin = Math.round(marginUsd * USDC);
  await ownerAcc.callFunction({
    contractId: owner.accountId,
    methodName: "open_position",
    args: { size, price: mark, margin },
    gas: teraToGas("100"),
    deposit: nearToYocto("0"),
  });
  let pos = await provider.callFunction({
    contractId: owner.accountId, method: "get_position", args: { account_id: owner.accountId },
  });
  console.log(`  open_position(size=${size}, price=${mark}, margin=${margin})`);
  console.log(`  position: ${JSON.stringify(pos)}`);
  const coverage = (margin * 10000) / (size * mark);
  console.log(`  margin coverage = ${margin}/${size * mark} = ${(coverage / 100).toFixed(1)}%  (threshold 50%)`);

  line("3) HEALTHY-POSITION GUARD: liquidating a healthy position is IMPOSSIBLE");
  // Try to liquidate with a price that makes coverage look fine:
  // we need margin*10000 >= |size|*p*5000  => p <= 2*margin/size
  const safePrice = Math.floor((2 * margin) / size);
  try {
    await liqAcc.callFunction({
      contractId: owner.accountId,
      methodName: "liquidate",
      args: { account_id: owner.accountId, mark_price: safePrice },
      gas: teraToGas("100"),
      deposit: nearToYocto("0"),
    });
    console.log("  UNEXPECTED: healthy liquidation succeeded!");
    process.exit(1);
  } catch (e) {
    const msg = (e.messages && e.messages[0]) || e.message;
    console.log(`  liquidate(mark=$${(safePrice / USDC).toFixed(2)}) rejected by contract:`);
    console.log(`  ${JSON.stringify(msg).slice(0, 200)}`);
  }

  line("4) STRANGER LIQUIDATES THE UNDERWATER POSITION (different key!)");
  console.log(`  owner      : ${owner.accountId}`);
  console.log(`  liquidator : ${liquidator.accountId}   <-- not the owner, not an admin`);
  await liqAcc.callFunction({
    contractId: owner.accountId,
    methodName: "liquidate",
    args: { account_id: owner.accountId, mark_price: mark },
    gas: teraToGas("100"),
    deposit: nearToYocto("0"),
  });
  pos = await provider.callFunction({
    contractId: owner.accountId, method: "get_position", args: { account_id: owner.accountId },
  });
  console.log(`  liquidate(${owner.accountId}, mark_price=${mark})`);
  console.log(`  position: ${JSON.stringify(pos)}`);

  line("LIQUIDATION DEMO COMPLETE ✓");
  console.log("  An underwater position was force-closed by a stranger, purely on NEAR.");
  console.log("  A healthy position cannot be liquidated. No operator, no order book,");
  console.log("  no external sequencer — the rule and the state live in the contract.");
}

main().catch((e) => {
  console.error("ERROR:", e && e.message ? e.message : e);
  if (e && e.messages) console.error(JSON.stringify(e.messages).slice(0, 400));
  process.exit(1);
});
