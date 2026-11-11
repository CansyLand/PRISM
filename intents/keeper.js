// Oracle + funding keeper. Run it in a loop next to the relayer.
//
//   pyth mode   (mainnet): Hermes signed update → pyth.update_price_feeds(data) →
//                          curve.refresh_price()  (the ledger validates age, conf, monotonicity)
//   pusher mode (testnet): Hermes price → curve.push_price(price_6dp)
//   both                 : curve.poke() books funding and snapshots
//
// Env: NEAR_RPC, CURVE_CONTRACT, KEEPER_ACCOUNT_ID, KEEPER_PRIVATE_KEY,
//      ORACLE_MODE=pyth|pusher, PYTH_CONTRACT (pyth-oracle.near), PYTH_PRICE_ID (hex, no 0x),
//      KEEPER_INTERVAL_SEC=30
// Run: node --env-file=.env keeper.js [--once]

const { JsonRpcProvider, Account } = require("near-api-js");

const TGAS = 1_000_000_000_000n;
const HERMES = process.env.HERMES_URL || "https://hermes.pyth.network";
const NEAR_USD = "c415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750";

const cfg = {
  rpc: process.env.NEAR_RPC || "https://test.rpc.fastnear.com",
  curve: process.env.CURVE_CONTRACT,
  keeper: process.env.KEEPER_ACCOUNT_ID,
  key: process.env.KEEPER_PRIVATE_KEY,
  mode: process.env.ORACLE_MODE || "pusher",
  pyth: process.env.PYTH_CONTRACT || "pyth-oracle.near",
  priceId: (process.env.PYTH_PRICE_ID || NEAR_USD).replace(/^0x/, ""),
  every: Number(process.env.KEEPER_INTERVAL_SEC || 30) * 1000,
};

async function hermesLatest(id) {
  const res = await fetch(`${HERMES}/v2/updates/price/latest?ids[]=${id}&encoding=hex&parsed=true`);
  if (!res.ok) throw new Error(`hermes HTTP ${res.status}`);
  const j = await res.json();
  const p = j.parsed[0].price; // { price, conf, expo, publish_time }
  return { data: j.binary.data[0], price: BigInt(p.price), expo: p.expo, publishTime: p.publish_time };
}

function to6dp(price, expo) {
  const shift = 6 + expo;
  return shift >= 0 ? price * 10n ** BigInt(shift) : price / 10n ** BigInt(-shift);
}

async function tick(provider, account) {
  const h = await hermesLatest(cfg.priceId);
  const call = (contractId, methodName, args, gas = 50n * TGAS, deposit = 0n) =>
    account.callFunction({ contractId, methodName, args, gas, deposit });

  if (cfg.mode === "pyth") {
    const fee = await provider.callFunction({ contractId: cfg.pyth, method: "get_update_fee_estimate", args: { data: h.data } });
    await call(cfg.pyth, "update_price_feeds", { data: h.data }, 150n * TGAS, BigInt(fee));
    const ok = await call(cfg.curve, "refresh_price", {}, 60n * TGAS);
    console.log(new Date().toISOString(), "pyth refresh", ok ? "accepted" : "rejected (see price_rejected event)");
  } else {
    const p = to6dp(h.price, h.expo);
    await call(cfg.curve, "push_price", { price: p.toString() });
    console.log(new Date().toISOString(), "pushed", Number(p) / 1e6);
  }
  const m = await call(cfg.curve, "poke", {});
  console.log(`  util ${m.utilization_bps / 100}%  curve ${Number(m.curve_claims) / 1e6}  flat ${Number(m.flat_equity) / 1e6}  nf ${Number(m.nf) / 1e18}`);
}

async function main() {
  for (const k of ["curve", "keeper", "key"]) if (!cfg[k]) throw new Error(`missing env for ${k}`);
  const provider = new JsonRpcProvider({ url: cfg.rpc });
  const account = new Account(cfg.keeper, provider, cfg.key);
  const once = process.argv.includes("--once");
  for (;;) {
    try {
      await tick(provider, account);
    } catch (e) {
      console.error(new Date().toISOString(), "tick failed:", e.message);
      if (once) process.exit(1);
    }
    if (once) return;
    await new Promise((r) => setTimeout(r, cfg.every));
  }
}

main();
