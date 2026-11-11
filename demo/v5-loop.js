// V5 FULL LOOP — Position Ledger + Intent Settlement Adapter (original design)
// Proven near-api-js v7 patterns (see e2e-test.js):
//   actions: acc.callFunctionRaw({contractId, methodName, args, gas, deposit})
//   views:   provider.callFunction({contractId, method, args})
//
//   [0] DEPLOY  : ledger wasm -> owner account; adapter wasm -> adapter account
//   [1] FEED    : 2 sources -> median -> ON-CHAIN mark (reused pricefeed.js)
//   [2] OPEN    : margin funded via 1Click intent (DRY-RUN quote, real fill px)
//   [3] LEDGER  : user -> adapter.request_open -> pending intent on the ledger;
//                 solver -> adapter.settle(real 1Click fill) -> POSITION ON NEAR
//   [4] RISK    : ledger.health + on-chain mark -> HEALTHY / LIQUIDATE (basic)
//   [5] CLOSE   : 1Click intent (DRY-RUN) -> adapter.request_close -> settle
//                 with the real exit fill -> PnL moves between pools ON-CHAIN
//
// Single source of truth: the on-chain Position Ledger. The adapter only
// tracks intents and relays them; no external sequencer owns any state.
// No funds move: all 1Click quotes are dry-run; position state is on NEAR testnet.
const { Account, JsonRpcProvider, actions, KeyPair, nearToYocto } = require("near-api-js");
const fs = require("fs");
const path = require("path");
const { markPrice } = require("./pricefeed");
const { quote } = require("./intent");

const NODE_URL = "https://test.rpc.fastnear.com";
const USDC = 1e6;
const WNEAR = 10n ** 24n;
const GAS_DEPLOY = "300000000000000000"; // 300 TGas (unused: v7 signAndSendTransaction)
const GAS_INIT = "300000000000000"; // 0.3 TGas — node per-action cap is 1 TGas
const GAS_PLAIN = "300000000000000"; // 0.3 TGas
const GAS_ADAPTER = "900000000000000"; // 0.9 TGas (adapter fn + 0.3 TGas ledger cross-call + callback)

function loadCreds() {
  const txt = fs.readFileSync(path.join(__dirname, "..", ".deploy.env"), "utf8");
  const g = (k) => (txt.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
  return {
    owner: { accountId: g("ACCOUNT_ID"), privateKey: g("PRIVATE_KEY") },
    adapter: { accountId: g("LIQUIDATOR_ACCOUNT_ID"), privateKey: g("LIQUIDATOR_PRIVATE_KEY") },
  };
}
function line(t) {
  console.log("\n" + "─".repeat(66) + "\n" + t + "\n" + "─".repeat(66));
}
const raw = (v) => (v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : v);

async function deploy(account, wasmPath, initArgs, initName) {
  const wasm = new Uint8Array(fs.readFileSync(wasmPath));
  await account.signAndSendTransaction({
    receiverId: account.accountId,
    actions: [actions.deployContract(wasm)],
  });
  console.log(`  wasm deployed (${(wasm.length / 1024).toFixed(0)} KB)`);
  try {
    await account.callFunctionRaw({
      contractId: account.accountId, methodName: initName, args: initArgs,
      gas: GAS_INIT, deposit: "0",
    });
    console.log(`  ${initName}() initialized`);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/state|exists|already|immutable/i.test(msg)) {
      console.log(`  ${initName}() — state already exists (redeploy, kept)`);
    } else {
      throw new Error(`${initName}() failed: ${msg}`);
    }
  }
}
const tx = (acc, contractId, method, args, gas = GAS_PLAIN) =>
  acc.callFunctionRaw({ contractId, methodName: method, args, gas, deposit: "0" });

async function main() {
  const { owner, adapter } = loadCreds();
  const provider = new JsonRpcProvider({ url: NODE_URL });
  const ownerAcc = new Account(owner.accountId, provider, owner.privateKey);
  const adapterAcc = new Account(adapter.accountId, provider, adapter.privateKey);
  const view = (contractId, method, args = {}) =>
    provider.callFunction({ contractId, method, args });

  // ── [0] DEPLOY ─────────────────────────────────────────────────
  line("[0] DEPLOY: Position Ledger (ledger host) + Intent Settlement Adapter");
  const bal = async (id) => {
    const i = await provider.query({ request_type: "view_account", account_id: id, finality: "optimistic" });
    return Number(i.amount) / 1e24;
  };
  // The adapter host needs ~2 NEAR storage for the wasm; top it up if low.
  const aBal = await bal(adapter.accountId).catch(() => 0);
  if (aBal < 3) {
    console.log(`  funding adapter host: 8 NEAR (has ${aBal.toFixed(3)})`);
    await ownerAcc.signAndSendTransaction({
      receiverId: adapter.accountId,
      actions: [actions.transfer(nearToYocto("8"))],
    });
  }
  // The ledger lives on a FRESH sub-account: the main account still holds the
  // v4 contract whose state layout differs from v5's.
  const ledgerId = `ledger.${owner.accountId}`;
  let lBal = await bal(ledgerId).catch(() => 0);
  if (lBal <= 0) {
    console.log(`  creating ledger host ${ledgerId} (3 NEAR seed)`);
    await ownerAcc.createAccount({
      newAccountId: ledgerId,
      publicKey: KeyPair.fromString(owner.privateKey).getPublicKey().toString(),
      nearToTransfer: nearToYocto("3"),
    });
  }
  if ((await bal(ledgerId).catch(() => 0)) < 2.5) {
    console.log("  topping up ledger host: 3 NEAR");
    await ownerAcc.signAndSendTransaction({
      receiverId: ledgerId,
      actions: [actions.transfer(nearToYocto("3"))],
    });
  }
  const ledgerAcc = new Account(ledgerId, provider, owner.privateKey);
  const ledgerWasm = path.join(__dirname, "..", "contract", "target", "wasm32-unknown-unknown", "release", "leveraged_positions.wasm");
  const adapterWasm = path.join(__dirname, "..", "adapter", "target", "wasm32-unknown-unknown", "release", "prism_adapter.wasm");
  await deploy(ledgerAcc, ledgerWasm, {}, "new");
  await deploy(adapterAcc, adapterWasm, { ledger: ledgerId }, "new");
  // solver registrations: the adapter may settle intents on the ledger;
  // the demo account (standing in for the 1Click solver) may drive the adapter.
  await tx(ledgerAcc, ledgerId, "add_solver", { solver: adapter.accountId });
  await tx(adapterAcc, adapter.accountId, "add_solver", { solver: owner.accountId });
  console.log(`  ledger  : ${ledgerId}  solvers: ${raw(await view(ledgerId, "list_solvers"))}`);
  console.log(`  adapter : ${adapter.accountId}  ledger: ${raw(await view(adapter.accountId, "get_ledger"))}`);

  // ── [1] PRICE FEED → ON-CHAIN MARK ─────────────────────────────
  line("[1] PRICE FEED: 2 sources → median → on-chain mark");
  const { agg, readings } = await markPrice();
  if (!agg.healthy) throw new Error("price sources disagree: " + agg.sources.join(", "));
  console.log(`  sources: ${readings.map((r) => `${r.source} $${r.price || "fail"}`).join(" | ")} → median $${agg.median}`);
  const markRaw = Math.round(agg.median * USDC);
  await tx(ledgerAcc, ledgerId, "update_mark", { mark: String(markRaw) });
  const m = await view(ledgerId, "get_mark");
  console.log(`  on-chain mark: $${(Number(m[0]) / USDC).toFixed(4)}  (raw ${m[0]})`);

  // ── [2] OPEN INTENT (1Click, dry-run) ──────────────────────────
  line("[2] OPEN INTENT: fund the margin  USDC → wNEAR  (1Click dry-run)");
  const size = 10;
  const markUsd = markRaw / USDC;
  const margin = Math.round((size * markUsd) / 10 * USDC); // 10x leverage
  const openQ = await quote({ action: "open", amount: String(margin), dry: true });
  const fillPrice = Number((BigInt(openQ.quote.amountIn) * WNEAR) / BigInt(openQ.quote.amountOut));
  console.log(`  quote: ${openQ.quote.amountInFormatted} USDC => ${openQ.quote.amountOutFormatted} wNEAR (est ${openQ.quote.timeEstimate}s)`);
  console.log(`  real fill: $${(fillPrice / USDC).toFixed(4)}  correlation: ${openQ.correlationId}  [dry-run: no funds moved]`);

  // ── [3] POSITION LEDGER: user intent → solver settlement ───────
  line("[3] POSITION LEDGER: user intent + solver settlement (on-chain)");
  await tx(ownerAcc, adapter.accountId, "request_open", {
    size: String(size), ref_price: String(markRaw), margin: String(margin),
  }, GAS_ADAPTER);
  const seq1 = await view(adapter.accountId, "count_intents");
  console.log(`  user → adapter.request_open: tracked intent seq=${raw(seq1)}`);
  const tracked1 = await view(adapter.accountId, "get_intent", { seq: seq1 });
  console.log(`  adapter state: ${raw(tracked1)}`);
  const ledgerId1 = tracked1 && tracked1.ledger_intent;
  if (ledgerId1) console.log(`  ledger intent #${ledgerId1}: ${raw(await view(ledgerId, "get_intent", { id: String(ledgerId1) }))}`);
  // solver (the demo account, standing in for the 1Click solver) applies the REAL fill
  await tx(ownerAcc, adapter.accountId, "settle", { seq: String(seq1), fill_price: String(fillPrice) }, GAS_ADAPTER);
  const pos = await view(ledgerId, "get_position", { account_id: owner.accountId });
  console.log(`  position ON-CHAIN: ${raw(pos)}`);
  console.log(`  pools: ${raw(await view(ledgerId, "get_pools"))}`);
  if (!pos || !pos.is_open) throw new Error("position not open after settlement");

  // ── [4] RISK ENGINE: ledger + on-chain mark → decision ─────────
  line("[4] RISK ENGINE: health from ledger + ON-CHAIN mark (basic check)");
  const h = await view(ledgerId, "health", { account_id: owner.accountId });
  if (!h) throw new Error("no health info");
  const verdict = h.is_liquidatable ? "LIQUIDATE" : "HEALTHY → hold / close at will";
  console.log(`  health: ${raw(h)}`);
  console.log(`  equity $${(Number(h.equity) / USDC).toFixed(2)} | notional $${(Number(h.notional) / USDC).toFixed(2)} | equity/notional ${(Number(h.equity_bps) / 100).toFixed(1)}% (floor 5%)`);
  console.log(`  DECISION: ${verdict}`);

  // ── [5] CLOSE via intent + on-chain settlement ─────────────────
  line("[5] CLOSE: 1Click intent (dry-run) → adapter settles with real exit fill");
  const closeQ = await quote({ action: "close", amount: (BigInt(size) * WNEAR).toString(), dry: true });
  const exitPrice = Number((BigInt(closeQ.quote.amountOut) * WNEAR) / BigInt(closeQ.quote.amountIn));
  console.log(`  quote: ${closeQ.quote.amountOutFormatted} USDC <= ${closeQ.quote.amountInFormatted} wNEAR (est ${closeQ.quote.timeEstimate}s)`);
  console.log(`  real exit: $${(exitPrice / USDC).toFixed(4)}  correlation: ${closeQ.correlationId}`);
  await tx(ownerAcc, adapter.accountId, "request_close", {
    fraction_bps: "10000", ref_price: String(markRaw),
  }, GAS_ADAPTER);
  const seq2 = await view(adapter.accountId, "count_intents");
  console.log(`  user → adapter.request_close(100%): tracked intent seq=${raw(seq2)}`);
  await tx(ownerAcc, adapter.accountId, "settle", { seq: String(seq2), fill_price: String(exitPrice) }, GAS_ADAPTER);
  const posAfter = await view(ledgerId, "get_position", { account_id: owner.accountId });
  const poolsAfter = await view(ledgerId, "get_pools");
  const stats = await view(ledgerId, "get_stats");
  const pnlUsd = size * (exitPrice - Number(pos.entry_price)) / USDC;
  console.log(`  position after close: ${raw(posAfter)}`);
  console.log(`  pools after: ${raw(poolsAfter)}`);
  console.log(`  stats: ${raw(stats)}`);
  console.log(`  PnL = $${pnlUsd.toFixed(2)} (honest 1Click spread — no mock prices)`);

  line("V5 FULL LOOP COMPLETE ✓");
  console.log("  user opened a position → recorded on the NEAR Position Ledger");
  console.log("  → closed via 1Click intents settled on-chain (state never left NEAR)");
}
main().catch((e) => {
  console.error("ERROR:", e && e.message ? e.message : e);
  if (e && e.messages) console.error(JSON.stringify(e.messages).slice(0, 400));
  process.exit(1);
});