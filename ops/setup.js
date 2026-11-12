// One-shot testnet deployment of the whole Uprise stack.
//   node setup.js            # create accounts, deploy, init, seed, fund test players
// Safe to re-run: every step checks whether it's already done.
import fs from "node:fs";
import path from "node:path";
import {
  DIR, account, view, call, faucetAccount, balanceNear, loadKeys, saveKey, loadDeployment, saveDeployment,
  KeyPair, near, usd, ONE_YOCTO, sleep, provider, ASSETS, spotPrice,
} from "./lib.js";

const WASM = path.join(DIR, "..", "target", "wasm32-unknown-unknown", "release");
const RETAIL = 6, HUNTERS = 3, POWER = Number(process.env.POWER || 3);
const d = loadDeployment() || {};
const ASSET = ASSETS[d.assetSymbol || process.env.ASSET || "NEAR"];
const UNIT = 10n ** BigInt(ASSET.decimals);

async function exists(id) { return !!(await provider.viewAccount({ accountId: id }).catch(() => null)); }
async function hasCode(id) { const s = await provider.viewAccount({ accountId: id }).catch(() => null); return s && s.code_hash !== "11111111111111111111111111111111"; }
const log = (...a) => console.log("·", ...a);

// ── 1. master account, topped up from extra faucet accounts ──
if (!d.master) {
  d.master = `uprise-${Math.random().toString(36).slice(2, 7)}.testnet`;
  await faucetAccount(d.master); saveDeployment(d); log("master", d.master); await sleep(2500);
}
const master = account(d.master);
// Contract accounts are named per asset (ledger-near, vault-near, …) so several markets can share one master.
const SYM = ASSET.symbol.toLowerCase();
const NAMES = { usdc: "usdc", asset: SYM === "near" ? "wnear" : SYM, swap: `swap-${SYM}`, ledger: `ledger-${SYM}`, vault: `vault-${SYM}` };
const sub = (name) => `${NAMES[name] || name}.${d.master}`;
const plan = {
  usdc: 3, asset: 3, swap: 2.4, ledger: 5, vault: 3, keeper: 3, faucet: 6,
  ...Object.fromEntries(Array.from({ length: RETAIL }, (_, i) => [`r${i + 1}`, 0.6])),
  ...Object.fromEntries(Array.from({ length: HUNTERS }, (_, i) => [`h${i + 1}`, 0.6])),
};
let NEED = 2;
for (const [name, amt] of Object.entries(plan)) if (!(await exists(sub(name)))) NEED += amt;
while ((await balanceNear(d.master)) < NEED) {
  const extra = `uprise-tmp-${Math.random().toString(36).slice(2, 8)}.testnet`;
  await faucetAccount(extra); await sleep(2500);
  await account(extra).deleteAccount(d.master); // sends its whole balance to master
  log("topped up master:", await balanceNear(d.master), "NEAR");
}

// ── 2. subaccounts ──
for (const [name, amt] of Object.entries(plan)) {
  const id = sub(name);
  if (await exists(id)) continue;
  const kp = KeyPair.fromRandom("ed25519");
  await master.createAccount({ newAccountId: id, publicKey: kp.getPublicKey().toString(), nearToTransfer: near(amt) });
  saveKey(id, kp.toString());
  log("created", id, amt, "NEAR");
}
Object.assign(d, {
  network: "testnet", rpc: "https://test.rpc.fastnear.com", power: POWER,
  assetSymbol: ASSET.symbol, assetDecimals: ASSET.decimals,
  usdc: sub("usdc"), asset: sub("asset"), swap: sub("swap"), ledger: sub("ledger"), vault: sub("vault"),
  keeper: sub("keeper"), faucet: sub("faucet"),
  retail: Array.from({ length: RETAIL }, (_, i) => sub(`r${i + 1}`)),
  hunters: Array.from({ length: HUNTERS }, (_, i) => sub(`h${i + 1}`)),
});
saveDeployment(d);

// ── 3. deploy + init ──
async function deploy(id, file, init, probe) {
  const ready = await view(id, probe).then(() => true).catch(() => false);
  if (ready) return false;
  if (!(await hasCode(id))) await account(id).deployContract(fs.readFileSync(path.join(WASM, file)));
  await call(account(id), id, "new", init, { tgas: 100 });
  log("deployed", file, "→", id);
  return true;
}
const price = BigInt(Math.round((await spotPrice(ASSET)) * 1e6));
await deploy(d.usdc, "uprise_mock_ft.wasm", { owner: d.master, name: "Mock USDC (Uprise testnet)", symbol: "USDC", decimals: 6, mint_limit: String(usd(10_000)) }, "ft_metadata");
await deploy(d.asset, "uprise_mock_ft.wasm", { owner: d.master, name: `Mock ${ASSET.symbol === "NEAR" ? "wNEAR" : ASSET.symbol} (Uprise testnet)`, symbol: ASSET.symbol === "NEAR" ? "wNEAR" : ASSET.symbol, decimals: ASSET.decimals, mint_limit: String(UNIT) }, "ft_metadata");
await deploy(d.swap, "uprise_mock_swap.wasm", { owner: d.master, pusher: d.keeper, usdc: d.usdc, btc: d.asset, asset_decimals: ASSET.decimals, fee_bps: 5 }, "get_swap");
await deploy(d.ledger, "uprise_ledger.wasm", {
  owner: d.master, token: d.usdc, oracle: { Pusher: { pusher: d.keeper } }, ref_price: String(price),
  params: {
    power: POWER, implied_vol_bps: ASSET.volFloorBps, base_funding_bps: 0,
    util_mult_base_bps: 12_500, util_mult_slope_bps: 10_000, util_kink_bps: 5_000, util_mult_kink_slope_bps: 200_000,
    rv_halflife_secs: 1_814_400, rv_cap_bps: 30_000, max_open_bps: 2_000, funding_fee_bps: 1_000, trade_fee_bps: 30,
    max_price_age_secs: 300, max_conf_bps: 200, max_jump_bps: 2_000, min_amount: String(usd(1)), snapshot_interval_secs: 60,
  },
}, "get_market");
await deploy(d.vault, "uprise_vault.wasm", { owner: d.master, keeper: d.keeper, ledger: d.ledger, usdc: d.usdc, asset: d.asset, asset_decimals: ASSET.decimals, swap: d.swap, venue: "Mock", min_deposit: String(usd(1)) }, "get_vault");
saveDeployment(d);

// ── 4. token registrations, swap liquidity, first prices ──
const everyone = [d.master, d.swap, d.ledger, d.vault, d.keeper, d.faucet, ...d.retail, ...d.hunters];
for (const t of [d.usdc, d.asset]) for (const id of everyone) {
  const bal = await view(t, "storage_balance_of", { account_id: id });
  if (!bal) { await call(master, t, "register", { account_id: id }, { tgas: 10 }); }
}
log("registered everyone on both tokens");
const sw = await view(d.swap, "get_swap");
if (BigInt(sw.usdc_reserve) === 0n) {
  await call(master, d.usdc, "mint", { account_id: d.master, amount: String(usd(5_000_000)) });
  await call(master, d.asset, "mint", { account_id: d.master, amount: String(ASSET.seedUnits * UNIT) });
  await call(master, d.usdc, "ft_transfer_call", { receiver_id: d.swap, amount: String(usd(5_000_000)), msg: "seed" }, { deposit: ONE_YOCTO, tgas: 100 });
  await call(master, d.asset, "ft_transfer_call", { receiver_id: d.swap, amount: String(ASSET.seedUnits * UNIT), msg: "seed" }, { deposit: ONE_YOCTO, tgas: 100 });
  log(`seeded swap: $5M USDC + ${ASSET.seedUnits} ${ASSET.symbol}`);
}
const keeper = account(d.keeper);
await call(keeper, d.ledger, "push_price", { price: String(price) }, { tgas: 50 });
await call(keeper, d.swap, "push_price", { price: String(price) }, { tgas: 10 });
log("first price", Number(price) / 1e6);

// ── 5. test players get test USDC ──
for (const id of d.retail) if (BigInt(await view(d.usdc, "ft_balance_of", { account_id: id })) < usd(500)) await call(master, d.usdc, "mint", { account_id: id, amount: String(usd(2_000)) });
for (const id of d.hunters) if (BigInt(await view(d.usdc, "ft_balance_of", { account_id: id })) < usd(5_000)) await call(master, d.usdc, "mint", { account_id: id, amount: String(usd(25_000)) });
log("funded", d.retail.length, "retail ($2k each) and", d.hunters.length, "hunters ($25k each)");
saveDeployment(d);
console.log(JSON.stringify(d, null, 2));
