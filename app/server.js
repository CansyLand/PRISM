// Uprise app server: static app + a few helper endpoints.
//   node app/server.js                     # demo mode on http://localhost:8787 (testnet)
//   MODE=live ONECLICK_JWT=… node app/server.js   # live mode (mainnet deployment + 1Click deposits)
//
// Endpoints
//   GET  /api/config              contract ids, network, mode
//   POST /api/onboard {account_id}   demo: gives a new device wallet gas + 1,000 test USDC (once)
//   POST /api/faucet  {account_id}   demo: 1,000 more test USDC (once per 10 minutes)
//   GET  /api/history?range=1h|1d|1w  BTC/USD candles (Coinbase), cached
//   GET  /api/vault-history        vault share price samples recorded by this server
//   POST /api/deposit-address {account_id, asset, amount}  live: 1Click deposit address → USDC to this account
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { account, view, call, loadDeployment, usd, near, balanceNear, faucetAccount, sleep } from "../ops/lib.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(DIR, "public");
const PORT = Number(process.env.PORT || 8787);
const MODE = process.env.MODE || "demo";
const d = loadDeployment();
if (!d) throw new Error("ops/deployment.json missing: run ops/setup.js");
const STATE = path.join(DIR, ".server-state.json");
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { onboarded: {}, faucet: {}, vault: [] };
const save = () => fs.writeFileSync(STATE, JSON.stringify(state));
const faucetAcct = MODE === "demo" ? account(d.faucet) : null;
const minter = faucetAcct; // test USDC mints stay under the token's per-call faucet limit, so no master key on the server
const ipHits = new Map();

const isImplicit = (id) => /^[0-9a-f]{64}$/.test(id);
const json = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
const body = (req) => new Promise((ok) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch { ok({}); } }); });
function limited(req, max, windowMs) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
  const now = Date.now(), hits = (ipHits.get(ip) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) return true;
  hits.push(now); ipHits.set(ip, hits); return false;
}

// ── price history (Coinbase), cached ──
const cache = new Map();
async function history(range) {
  const g = { "1h": 60, "1d": 300, "1w": 3600 }[range] || 300;
  const hit = cache.get(g);
  if (hit && Date.now() - hit.t < 30_000) return hit.v;
  const r = await fetch(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${g}`, { headers: { "User-Agent": "uprise-demo" } });
  const rows = await r.json();
  const v = rows.map(([t, lo, hi, o, c]) => [t, c]).sort((a, b) => a[0] - b[0]);
  cache.set(g, { t: Date.now(), v });
  return v;
}

// ── vault share price samples (for the yield chart) ──
async function sampleVault() {
  try {
    const v = await view(d.vault, "get_vault");
    state.vault.push([Math.floor(Date.now() / 1000), Number(v.share_price_e6) / 1e6, Number(v.snapshot.nav) / 1e6]);
    if (state.vault.length > 20_000) state.vault.splice(0, state.vault.length - 20_000);
    save();
  } catch {}
}
setInterval(sampleVault, 60_000); sampleVault();

// ── demo onboarding ──
const GAS_GIFT = 0.5; // NEAR; a trade reserves ~0.15 NEAR of gas up front and refunds most of it
async function refillFaucet() {
  // Testnet only: when the gas faucet runs low, pull 10 NEAR from the public testnet faucet.
  if ((await balanceNear(d.faucet)) > 3) return;
  const tmp = `uprise-tmp-${Math.random().toString(36).slice(2, 8)}.testnet`;
  await faucetAccount(tmp); await sleep(2500);
  await account(tmp).deleteAccount(d.faucet);
  console.log("faucet refilled:", await balanceNear(d.faucet), "NEAR");
}
async function onboard(id) {
  if (state.onboarded[id]) return { ok: true, already: true };
  await refillFaucet().catch((e) => console.warn("refill failed", e.message));
  await faucetAcct.transfer({ receiverId: id, amount: near(GAS_GIFT) }); // creates the implicit account, pays its gas
  await call(minter, d.usdc, "mint", { account_id: id, amount: String(usd(1_000)) }, { tgas: 30 });
  state.onboarded[id] = Date.now(); state.faucet[id] = Date.now(); save();
  return { ok: true, near: "0.1", usdc: 1000 };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/config") {
      return json(res, 200, { mode: MODE, network: d.network, rpc: d.rpc, power: d.power, usdc: d.usdc, btc: d.btc, ledger: d.ledger, vault: d.vault, swap: d.swap });
    }
    if (url.pathname === "/api/history") return json(res, 200, await history(url.searchParams.get("range") || "1d"));
    if (url.pathname === "/api/vault-history") return json(res, 200, state.vault.slice(-2_000));
    if (url.pathname === "/api/onboard" && req.method === "POST") {
      if (MODE !== "demo") return json(res, 400, { error: "onboarding gifts are demo-only" });
      const { account_id } = await body(req);
      if (!isImplicit(account_id)) return json(res, 400, { error: "expects a 64-hex implicit account" });
      if (!state.onboarded[account_id] && limited(req, 5, 3_600_000)) return json(res, 429, { error: "too many new wallets from this network, try later" });
      return json(res, 200, await onboard(account_id));
    }
    if (url.pathname === "/api/faucet" && req.method === "POST") {
      if (MODE !== "demo") return json(res, 400, { error: "faucet is demo-only" });
      const { account_id } = await body(req);
      if (!isImplicit(account_id) || !state.onboarded[account_id]) return json(res, 400, { error: "unknown wallet" });
      const wait = 600_000 - (Date.now() - (state.faucet[account_id] || 0));
      if (wait > 0) return json(res, 429, { error: `next test USDC in ${Math.ceil(wait / 60_000)} min` });
      await call(minter, d.usdc, "mint", { account_id, amount: String(usd(1_000)) }, { tgas: 30 });
      state.faucet[account_id] = Date.now(); save();
      return json(res, 200, { ok: true, usdc: 1000 });
    }
    if (url.pathname === "/api/gas" && req.method === "POST") {
      if (MODE !== "demo") return json(res, 400, { error: "gas top-ups are demo-only" });
      const { account_id } = await body(req);
      if (!isImplicit(account_id) || !state.onboarded[account_id]) return json(res, 400, { error: "unknown wallet" });
      if ((await balanceNear(account_id)) >= 0.25) return json(res, 200, { ok: true, skipped: true });
      if (Date.now() - (state.gas?.[account_id] || 0) < 600_000) return json(res, 429, { error: "gas was topped up recently" });
      await refillFaucet().catch(() => {});
      await faucetAcct.transfer({ receiverId: account_id, amount: near(GAS_GIFT) });
      (state.gas ||= {})[account_id] = Date.now(); save();
      return json(res, 200, { ok: true, near: GAS_GIFT });
    }
    if (url.pathname === "/api/deposit-address" && req.method === "POST") {
      if (MODE !== "live") return json(res, 400, { error: "cross-chain deposits run on mainnet only (live mode)" });
      const { account_id, asset, amount, refund_to } = await body(req);
      const oneclick = createRequire(import.meta.url)("../intents/oneclick.js");
      const q = await oneclick.depositQuote({ originAsset: asset, amount, refundTo: refund_to, relayer: account_id });
      return json(res, 200, q);
    }
    // static
    let p = path.normalize(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.join(PUB, p);
    if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
    const type = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" }[path.extname(file)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    json(res, 500, { error: String(e.message || e).slice(0, 300) });
  }
});
server.listen(PORT, () => console.log(`Uprise ${MODE} on http://localhost:${PORT} · ledger ${d.ledger}`));
