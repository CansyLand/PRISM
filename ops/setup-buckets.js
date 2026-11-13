// Deploy the bucketed (x¹–x¹⁰) market next to an existing testnet stack.
//   node setup-buckets.js        # creates ledger-b, vault-b, swap-b, keeper-b, relayer-b under the master
// Reuses the deployment's USDC and wNEAR tokens (so wallets keep their balances) and its test players.
// The old deployment.json is kept as deployment-x3.json; the new one points at the bucketed contracts.
// Safe to re-run: every step checks whether it's already done.
import fs from "node:fs";
import path from "node:path";
import {
  DIR, account, view, call, faucetAccount, balanceNear, saveKey, loadDeployment, saveDeployment,
  KeyPair, near, usd, ONE_YOCTO, sleep, provider, ASSETS, spotPrice,
} from "./lib.js";

const WASM = path.join(DIR, "..", "target", "wasm32-unknown-unknown", "release");
const SEED_VAULT = Number(process.env.SEED_VAULT || 200_000); // USDC the master puts into the new vault
const old = loadDeployment();
if (!old) throw new Error("no deployment.json");
const backup = path.join(DIR, "deployment-x3.json");
if (!old.buckets && !fs.existsSync(backup)) fs.writeFileSync(backup, JSON.stringify(old, null, 2));
const base = old.buckets ? JSON.parse(fs.readFileSync(backup, "utf8")) : old;
const ASSET = ASSETS[base.assetSymbol || "NEAR"], UNIT = 10n ** BigInt(ASSET.decimals);
const sub = (n) => `${n}.${base.master}`;
const d = {
  ...base,
  buckets: true, powers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  ledger: sub("ledger-b"), vault: sub("vault-b"), swap: sub("swap-b"), keeper: sub("keeper-b"), relayer: sub("relayer-b"),
  // Own test players, so the old x³ crowd (which signs with r1…h3) never shares a key with this one.
  retail: Array.from({ length: 6 }, (_, i) => sub(`rb${i + 1}`)),
  hunters: Array.from({ length: 3 }, (_, i) => sub(`hb${i + 1}`)),
  previous: { ledger: base.ledger, vault: base.vault, swap: base.swap, keeper: base.keeper, power: base.power, retail: base.retail, hunters: base.hunters },
};
delete d.power;
const log = (...a) => console.log("·", ...a);
const master = account(base.master);
const exists = async (id) => !!(await provider.viewAccount({ accountId: id }).catch(() => null));
const hasCode = async (id) => { const s = await provider.viewAccount({ accountId: id }).catch(() => null); return s && s.code_hash !== "11111111111111111111111111111111"; };

// ── 1. accounts (top up the master from the faucet if needed) ──
const plan = { [d.ledger]: 5, [d.vault]: 3, [d.swap]: 2.4, [d.keeper]: 3, [d.relayer]: 3,
  ...Object.fromEntries([...d.retail, ...d.hunters].map((id) => [id, 0.3])) };
let need = 2;
for (const [id, amt] of Object.entries(plan)) if (!(await exists(id))) need += amt;
while ((await balanceNear(base.master)) < need) {
  const extra = `uprise-tmp-${Math.random().toString(36).slice(2, 8)}.testnet`;
  await faucetAccount(extra); await sleep(2500);
  await account(extra).deleteAccount(base.master);
  log("topped up master:", await balanceNear(base.master), "NEAR");
}
for (const [id, amt] of Object.entries(plan)) {
  if (await exists(id)) continue;
  const kp = KeyPair.fromRandom("ed25519");
  await master.createAccount({ newAccountId: id, publicKey: kp.getPublicKey().toString(), nearToTransfer: near(amt) });
  saveKey(id, kp.toString());
  log("created", id, amt, "NEAR");
}

// ── 2. deploy + init ──
async function deploy(id, file, init, probe) {
  if (await view(id, probe).then(() => true).catch(() => false)) return;
  if (!(await hasCode(id))) await account(id).deployContract(fs.readFileSync(path.join(WASM, file)));
  await call(account(id), id, "new", init, { tgas: 100 });
  log("deployed", file, "→", id);
}
const price = BigInt(Math.round((await spotPrice(ASSET)) * 1e6));
await deploy(d.swap, "uprise_mock_swap.wasm", { owner: base.master, pusher: d.keeper, usdc: d.usdc, btc: d.asset, asset_decimals: ASSET.decimals, fee_bps: 5 }, "get_swap");
// Bucket parameters are the contract defaults from sim/buckets (surcharge to 2× at x¹⁰, caps 0.25/p, delta weight 0.5,
// 10% base fee, m(u) 1× → 12×). Deployment-specific settings on top.
const defaults = {
  base_funding_bps: 1_000,
  bucket_funding_mult_bps: [10_000, 10_123, 10_494, 11_111, 11_975, 13_086, 14_444, 16_049, 17_901, 20_000],
  bucket_cap_bps: [2_500, 1_250, 833, 625, 500, 416, 357, 312, 277, 250],
  util_delta_weight_bps: 5_000, util_mult_base_bps: 10_000, util_mult_slope_bps: 10_000, util_kink_bps: 4_000, util_mult_kink_slope_bps: 100_000,
};
await deploy(d.ledger, "uprise_ledger.wasm", {
  owner: base.master, token: d.usdc, oracle: { Pusher: { pusher: d.keeper } }, ref_price: String(price),
  params: {
    implied_vol_bps: ASSET.volFloorBps, ...defaults,
    rv_halflife_secs: 1_814_400, rv_cap_bps: 30_000, max_open_bps: 2_000, funding_fee_bps: 1_000, trade_fee_bps: 30,
    max_price_age_secs: 300, max_conf_bps: 200, max_jump_bps: 2_000, min_amount: String(usd(1)), snapshot_interval_secs: 60,
  },
}, "get_market");
await deploy(d.vault, "uprise_vault.wasm", { owner: base.master, keeper: d.keeper, ledger: d.ledger, usdc: d.usdc, asset: d.asset, asset_decimals: ASSET.decimals, swap: d.swap, venue: "Mock", min_deposit: String(usd(1)) }, "get_vault");
saveDeployment(d);

// ── 3. token registrations, swap liquidity, first price ──
for (const t of [d.usdc, d.asset]) for (const id of [d.swap, d.ledger, d.vault, d.keeper, d.relayer]) {
  if (!(await view(t, "storage_balance_of", { account_id: id }))) await call(master, t, "register", { account_id: id }, { tgas: 10 });
}
log("registered the new contracts on both tokens");
const sw = await view(d.swap, "get_swap");
if (BigInt(sw.usdc_reserve) === 0n) {
  await call(master, d.usdc, "mint", { account_id: base.master, amount: String(usd(5_000_000)) });
  await call(master, d.asset, "mint", { account_id: base.master, amount: String(ASSET.seedUnits * UNIT) });
  await call(master, d.usdc, "ft_transfer_call", { receiver_id: d.swap, amount: String(usd(5_000_000)), msg: "seed" }, { deposit: ONE_YOCTO, tgas: 100 });
  await call(master, d.asset, "ft_transfer_call", { receiver_id: d.swap, amount: String(ASSET.seedUnits * UNIT), msg: "seed" }, { deposit: ONE_YOCTO, tgas: 100 });
  log(`seeded swap: $5M USDC + ${ASSET.seedUnits} ${ASSET.symbol}`);
}
const keeper = account(d.keeper);
await call(keeper, d.ledger, "push_price", { price: String(price) }, { tgas: 80 });
await call(keeper, d.swap, "push_price", { price: String(price) }, { tgas: 10 });
log("first price", Number(price) / 1e6);

// ── 4. seed the vault so Curve Short has liquidity (the keeper allocates part of it) ──
const v = await view(d.vault, "get_vault");
if (BigInt(v.total_shares) === 0n && v.pending_deposits.length === 0) {
  await call(master, d.usdc, "mint", { account_id: base.master, amount: String(usd(SEED_VAULT)) });
  await call(master, d.usdc, "ft_transfer_call", { receiver_id: d.vault, amount: String(usd(SEED_VAULT)), msg: "deposit" }, { deposit: ONE_YOCTO, tgas: 100 });
  log(`master queued a $${SEED_VAULT.toLocaleString()} vault deposit`);
}
// ── 5. test players get test USDC ──
for (const id of d.retail) if (BigInt(await view(d.usdc, "ft_balance_of", { account_id: id })) < usd(500)) await call(master, d.usdc, "mint", { account_id: id, amount: String(usd(2_000)) });
for (const id of d.hunters) if (BigInt(await view(d.usdc, "ft_balance_of", { account_id: id })) < usd(5_000)) await call(master, d.usdc, "mint", { account_id: id, amount: String(usd(25_000)) });
log("funded", d.retail.length, "retail ($2k each) and", d.hunters.length, "hunters ($25k each)");
saveDeployment(d);
console.log(JSON.stringify(d, null, 2));
