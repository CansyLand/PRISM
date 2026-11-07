// Full-loop demo: open -> position visible -> close, using the 1Click intent
// API (dry-run) for live prices + funding/settlement quotes and the NEAR
// testnet contract for position state. No funds move.
const { Account, KeyPair, JsonRpcProvider, teraToGas, nearToYocto } = require("near-api-js");
const fs = require("fs");
const path = require("path");
const { tokenPrice, quote } = require("./intent");

const NODE_URL = "https://rpc.testnet.near.org";
const USDC = 1e6; // 6 decimals
const WNEAR = 1e24; // 24 decimals

function loadCreds() {
  const txt = fs.readFileSync(path.join(__dirname, "..", ".deploy.env"), "utf8");
  const g = (k) => (txt.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
  return { privateKey: g("PRIVATE_KEY"), accountId: g("ACCOUNT_ID") };
}

function line(t) { console.log("\n" + "─".repeat(66) + "\n" + t + "\n" + "─".repeat(66)); }

async function main() {
  const { accountId } = loadCreds();
  const provider = new JsonRpcProvider({ url: NODE_URL });
  const account = new Account(accountId, provider, loadCreds().privateKey);

  line("1) LIVE MARKET PRICE (from 1Click tokens endpoint)");
  const wNearPrice = await tokenPrice("wNEAR"); // USD per wNEAR
  const priceUsd = wNearPrice;
  const entryPrice = Math.round(priceUsd * USDC); // USDC 6dp per 1 base unit
  console.log(`  wNEAR price = $${wNearPrice}`);
  console.log(`  position entry_price = ${entryPrice} (USDC 6dp) => $${(entryPrice / USDC).toFixed(2)}/unit`);

  // Position params: long 10 units, margin 2 units of notional (10x leverage)
  const size = 10;
  const notionalUsd = size * priceUsd;
  const marginUsd = notionalUsd / 10;
  const margin = Math.round(marginUsd * USDC);
  line("2) OPEN INTENT (dry-run): fund margin  USDC -> wNEAR");
  const openQ = await quote({ action: "open", amount: margin, dry: true });
  console.log(`  intent: USDC -> wNEAR, EXACT_INPUT, slippage 1%`);
  console.log(`  quote:  ${openQ.quote.amountInFormatted} USDC => ${openQ.quote.amountOutFormatted} wNEAR  (est ${openQ.quote.timeEstimate}s)`);
  console.log(`  recipient: ${openQ.intent.recipient}   [dry-run: no funds moved]`);

  line("3) OPEN POSITION ON-CHAIN (testnet contract)");
  await account.callFunction({
    contractId: accountId,
    methodName: "open_position",
    args: { size, price: entryPrice, margin },
    gas: teraToGas("100"),
    deposit: nearToYocto("0"),
  });
  let pos = await provider.callFunction({ contractId: accountId, method: "get_position", args: { account_id: accountId } });
  console.log(`  open_position(size=${size}, price=${entryPrice}, margin=${margin})`);
  console.log(`  position: ${JSON.stringify(pos)}`);
  console.log(`  notional $${notionalUsd.toFixed(2)}  margin $${marginUsd.toFixed(2)}  (10x leverage)`);

  line("4) SHOW CURRENT POSITION (view call)");
  console.log(`  get_position => ${JSON.stringify(pos)}`);

  // Simulate a price move: exit at +5% (long wins)
  const exitPrice = Math.round(entryPrice * 1.05);
  const pnlUsd = (size * (exitPrice - entryPrice)) / USDC;
  line("5) CLOSE INTENT (dry-run): settle  wNEAR -> USDC");
  // Realize: swap the wNEAR position value back to USDC
  const wNearToSettle = BigInt(Math.round(size)); // 1 wNEAR per unit
  const closeQ = await quote({ action: "close", amount: (wNearToSettle * (10n ** 24n)).toString(), dry: true });
  console.log(`  intent: wNEAR -> USDC, EXACT_INPUT, slippage 1%`);
  console.log(`  quote:  ${closeQ.quote.amountInFormatted} wNEAR => ${closeQ.quote.amountOutFormatted} USDC  (est ${closeQ.quote.timeEstimate}s)`);

  line("6) CLOSE POSITION ON-CHAIN");
  await account.callFunction({
    contractId: accountId,
    methodName: "close_position",
    args: { exit_price: exitPrice },
    gas: teraToGas("100"),
    deposit: nearToYocto("0"),
  });
  pos = await provider.callFunction({ contractId: accountId, method: "get_position", args: { account_id: accountId } });
  console.log(`  close_position(exit_price=${exitPrice})  [simulated +5% price move]`);
  console.log(`  position: ${JSON.stringify(pos)}`);
  console.log(`  PnL = ${size} * ($${(exitPrice / USDC).toFixed(2)} - $${(entryPrice / USDC).toFixed(2)}) = $${pnlUsd.toFixed(2)}`);

  line("LOOP COMPLETE  ✓");
  console.log("  open -> position visible via view call -> close, on NEAR testnet.");
  console.log("  Funding/settlement expressed as valid 1Click intents (dry-run quotes).");
  console.log(`  Position account: ${accountId}`);
}

main().catch((e) => { console.error("ERROR:", e && e.message ? e.message : e); if (e && e.messages) console.error(JSON.stringify(e.messages)); process.exit(1); });
