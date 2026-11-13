// Uprise app server: static app + live-network helpers.
//   node app/server.js        # http://localhost:8787 · live = the network in ops/deployment.json
//
// Demo mode runs entirely in the browser (mock market). This server only backs live mode:
//   GET  /api/config                 contract ids, network, asset
//   POST /api/rpc                    JSON-RPC proxy with failover between public RPCs
//   POST /api/relay {signed_delegate}  gas sponsoring: we submit the user's signed meta-transaction (NEP-366)
//   POST /api/onboard {account_id}   creates the device wallet on chain (tiny NEAR for the key's storage);
//                                    on testnet also 1,000 test USDC
//   POST /api/faucet {account_id}    testnet: 1,000 test USDC (device wallets and existing .testnet accounts; every 10 min)
//   POST /api/backup {account_id, email, secret}   store the device key encrypted, for email recovery
//   POST /api/recover/start {email}  sends a 6-digit code (SMTP, or the server log until SMTP is set up)
//   POST /api/recover/finish {email, code}   returns the stored key(s)
//   GET  /api/history?range=5m|1h|1d|1w candles for the asset (Coinbase)
//   GET  /api/vault-history          vault share price samples
//   POST /api/deposit-address {account_id, asset, amount}  mainnet: 1Click deposit address → USDC to this account
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { account, view, call, loadDeployment, usd, near, balanceNear, faucetAccount, sleep, RPCS, ASSETS, decodeSignedDelegate, provider } from "../ops/lib.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(DIR, "public");
const PORT = Number(process.env.PORT || 8787);
const d = loadDeployment();
if (!d) throw new Error("ops/deployment.json missing: run ops/setup.js");
const TESTNET = d.network === "testnet";
const ASSET = ASSETS[d.assetSymbol || "BTC"];
const STATE = path.join(DIR, ".server-state.json");
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
for (const k of ["onboarded", "faucet", "gas", "backups", "codes"]) state[k] ||= {};
state.vault ||= [];
const save = () => fs.writeFileSync(STATE, JSON.stringify(state), { mode: 0o600 });
// The relayer pays gas for meta-transactions and creates new wallets. On testnet it's the faucet account.
const relayer = account(d.relayer || d.faucet);
const ipHits = new Map();

const isImplicit = (id) => /^[0-9a-f]{64}$/.test(id);
const json = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
const body = async (req, max = 50_000) => { let s = ""; for await (const c of req) { s += c; if (s.length > max) break; } try { return JSON.parse(s || "{}"); } catch { return {}; } };
function limited(req, key, max, windowMs) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
  const k = key + ip, now = Date.now(), hits = (ipHits.get(k) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) return true;
  hits.push(now); ipHits.set(k, hits); return false;
}

// ── key backups: AES-256-GCM at rest. Key from BACKUP_KEY (hex) or a generated file next to the state. ──
const KEYFILE = path.join(DIR, ".backup-key");
const BACKUP_KEY = Buffer.from(process.env.BACKUP_KEY || (fs.existsSync(KEYFILE) ? fs.readFileSync(KEYFILE, "utf8") : (() => { const k = crypto.randomBytes(32).toString("hex"); fs.writeFileSync(KEYFILE, k, { mode: 0o600 }); return k; })()), "hex");
const seal = (text) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", BACKUP_KEY, iv); const out = Buffer.concat([c.update(text, "utf8"), c.final()]); return [iv, c.getAuthTag(), out].map((b) => b.toString("base64")).join("."); };
const open = (blob) => { const [iv, tag, out] = blob.split(".").map((s) => Buffer.from(s, "base64")); const dc = crypto.createDecipheriv("aes-256-gcm", BACKUP_KEY, iv); dc.setAuthTag(tag); return Buffer.concat([dc.update(out), dc.final()]).toString("utf8"); };
const normEmail = (e) => String(e || "").trim().toLowerCase();
async function sendCode(email, code) {
  // SMTP is wired later on the real server. Until then the code goes to the server log.
  console.log(`[recovery] code for ${email}: ${code}`);
}

// ── JSON-RPC proxy with failover ──
let rpcCur = 0;
async function rpcProxy(req, res) {
  let raw = ""; for await (const c of req) { raw += c; if (raw.length > 200_000) { res.writeHead(413); return res.end(); } }
  for (let k = 0; k < RPCS.length * 2; k++) {
    const i = (rpcCur + k) % RPCS.length;
    try {
      const r = await fetch(RPCS[i], { method: "POST", headers: { "Content-Type": "application/json" }, body: raw, signal: AbortSignal.timeout(15_000) });
      const text = await r.text();
      if (r.status === 429 || r.status >= 500 || /"code":\s*-429|DEPRECATED|discontinued/.test(text)) continue;
      rpcCur = i;
      res.writeHead(r.status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(text);
    } catch {}
  }
  json(res, 503, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "all NEAR RPC endpoints are busy, try again" } });
}

// ── gas sponsoring (NEP-366): only calls into our own contracts, small deposits only ──
const ALLOWED = new Set([d.usdc, d.ledger, d.vault].filter(Boolean));
async function relay(b64) {
  const sd = decodeSignedDelegate(Buffer.from(b64, "base64"));
  const da = sd.delegateAction;
  if (!ALLOWED.has(da.receiverId)) throw new Error(`we only sponsor calls to Uprise contracts, not ${da.receiverId}`);
  for (const a of da.actions) {
    const fc = a.functionCall;
    if (!fc) throw new Error("only function calls are sponsored");
    if (BigInt(fc.deposit) > 1n) throw new Error("sponsored calls can attach at most 1 yoctoNEAR");
    if (BigInt(fc.gas) > 300_000_000_000_000n) throw new Error("too much gas");
  }
  return relayer.relayMetaTransaction(sd);
}

// ── price history ──
const cache = new Map();
async function history(range) {
  const g = { "5m": 60, "1h": 60, "1d": 300, "1w": 3600 }[range] || 300; // 5m: seeded with 1-minute candles, then 5-second live candles in the app
  const hit = cache.get(g);
  if (hit && Date.now() - hit.t < 30_000) return hit.v;
  const r = await fetch(`https://api.exchange.coinbase.com/products/${ASSET.coinbase}/candles?granularity=${g}`, { headers: { "User-Agent": "uprise" } });
  const rows = await r.json();
  const v = rows.map(([t, lo, hi, o, c]) => [t, o, hi, lo, c]).sort((a, b) => a[0] - b[0]);
  cache.set(g, { t: Date.now(), v });
  return v;
}

async function sampleVault() {
  try {
    const v = await view(d.vault, "get_vault");
    state.vault.push([Math.floor(Date.now() / 1000), Number(v.share_price_e6) / 1e6, Number(v.snapshot.nav) / 1e6]);
    if (state.vault.length > 20_000) state.vault.splice(0, state.vault.length - 20_000);
    save();
  } catch {}
}
setInterval(sampleVault, 60_000); sampleVault();

async function refillRelayer() {
  // Testnet only: when the relayer runs low, pull 10 NEAR from the public testnet faucet.
  if (!TESTNET || (await balanceNear(relayer.accountId)) > 3) return;
  const tmp = `uprise-tmp-${Math.random().toString(36).slice(2, 8)}.testnet`;
  await faucetAccount(tmp); await sleep(2500);
  await account(tmp).deleteAccount(relayer.accountId);
}

async function onboard(id) {
  if (state.onboarded[id]) return { ok: true, already: true };
  await refillRelayer().catch((e) => console.warn("refill failed", e.message));
  // Creates the implicit account. 0.02 NEAR covers the key's storage; gas is sponsored by /api/relay.
  await relayer.transfer({ receiverId: id, amount: near(0.02) });
  await call(relayer, d.usdc, TESTNET ? "mint" : "storage_deposit", TESTNET ? { account_id: id, amount: String(usd(1_000)) } : { account_id: id, registration_only: true }, { tgas: 30, deposit: TESTNET ? 0n : near(0.00125) });
  state.onboarded[id] = Date.now(); if (TESTNET) state.faucet[id] = Date.now(); save();
  return { ok: true, usdc: TESTNET ? 1000 : 0 };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/config") {
      return json(res, 200, { network: d.network, testnet: TESTNET, power: d.power, asset: ASSET.symbol, assetDecimals: d.assetDecimals, usdc: d.usdc, assetToken: d.asset, ledger: d.ledger, vault: d.vault, swap: d.swap, relayer: relayer.accountId });
    }
    if (url.pathname === "/api/rpc" && req.method === "POST") return rpcProxy(req, res);
    if (url.pathname === "/api/history") return json(res, 200, await history(url.searchParams.get("range") || "1d"));
    if (url.pathname === "/api/vault-history") return json(res, 200, state.vault.slice(-2_000));
    if (url.pathname === "/api/relay" && req.method === "POST") {
      if (limited(req, "relay", 60, 600_000)) return json(res, 429, { error: "too many transactions, slow down" });
      const { signed_delegate } = await body(req, 20_000);
      const r = await relay(signed_delegate);
      const fail = r.status?.Failure; if (fail) return json(res, 400, { error: JSON.stringify(fail).slice(0, 300) });
      const v = r.status?.SuccessValue; let value = null;
      try { value = v ? JSON.parse(Buffer.from(v, "base64").toString()) : null; } catch {}
      return json(res, 200, { ok: true, hash: r.transaction?.hash, value, receipts: r.receipts_outcome?.map((o) => o.outcome.status) });
    }
    if (url.pathname === "/api/onboard" && req.method === "POST") {
      const { account_id } = await body(req);
      if (!isImplicit(account_id)) return json(res, 400, { error: "expects a 64-hex implicit account" });
      if (!state.onboarded[account_id] && limited(req, "onboard", 5, 3_600_000)) return json(res, 429, { error: "too many new wallets from this network, try later" });
      return json(res, 200, await onboard(account_id));
    }
    if (url.pathname === "/api/faucet" && req.method === "POST") {
      if (!TESTNET) return json(res, 400, { error: "test USDC exists on testnet only" });
      const { account_id } = await body(req);
      // device wallets made here, or any existing testnet account (e.g. a Meteor wallet); limited per account and IP
      const known = isImplicit(account_id) && state.onboarded[account_id];
      const named = /^[a-z0-9_.-]{2,64}\.testnet$/.test(String(account_id || "")) && (await provider.viewAccount({ accountId: account_id }).then(() => true).catch(() => false));
      if (!known && !named) return json(res, 400, { error: "unknown wallet" });
      if (limited(req, "faucet", 6, 3_600_000)) return json(res, 429, { error: "too many requests, try later" });
      const wait = 600_000 - (Date.now() - (state.faucet[account_id] || 0));
      if (wait > 0) return json(res, 429, { error: `next test USDC in ${Math.ceil(wait / 60_000)} min` });
      await call(relayer, d.usdc, "mint", { account_id, amount: String(usd(1_000)) }, { tgas: 30 });
      state.faucet[account_id] = Date.now(); save();
      return json(res, 200, { ok: true, usdc: 1000 });
    }
    if (url.pathname === "/api/backup" && req.method === "POST") {
      const { account_id, email, secret } = await body(req);
      const e = normEmail(email);
      if (!isImplicit(account_id) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(secret || "")) return json(res, 400, { error: "need a wallet, a valid email and the key" });
      if (limited(req, "backup", 10, 3_600_000)) return json(res, 429, { error: "too many backups, try later" });
      (state.backups[e] ||= {})[account_id] = { key: seal(secret), at: Date.now() }; save();
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/recover/start" && req.method === "POST") {
      const e = normEmail((await body(req)).email);
      if (limited(req, "recover", 5, 3_600_000)) return json(res, 429, { error: "too many attempts, try later" });
      if (state.backups[e]) { const code = String(crypto.randomInt(100000, 1000000)); state.codes[e] = { code, at: Date.now(), tries: 0 }; save(); await sendCode(e, code); }
      return json(res, 200, { ok: true }); // same answer whether or not the email exists
    }
    if (url.pathname === "/api/recover/finish" && req.method === "POST") {
      const { email, code } = await body(req); const e = normEmail(email), c = state.codes[e];
      if (!c || Date.now() - c.at > 15 * 60_000 || c.tries >= 5) return json(res, 400, { error: "code expired, ask for a new one" });
      if (String(code).trim() !== c.code) { c.tries++; save(); return json(res, 400, { error: "wrong code" }); }
      delete state.codes[e]; save();
      return json(res, 200, { ok: true, wallets: Object.entries(state.backups[e] || {}).map(([id, b]) => ({ account_id: id, secret: open(b.key) })) });
    }
    if (url.pathname === "/api/deposit-address" && req.method === "POST") {
      if (TESTNET) return json(res, 400, { error: "cross-chain deposits through NEAR Intents run on mainnet" });
      const { account_id, asset, amount, refund_to } = await body(req);
      const oneclick = createRequire(import.meta.url)("../intents/oneclick.js");
      return json(res, 200, await oneclick.depositQuote({ originAsset: asset, amount, refundTo: refund_to, relayer: account_id }));
    }
    // static
    const p = path.normalize(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = path.join(PUB, p);
    if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
    const type = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" }[path.extname(file)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    json(res, 500, { error: String(e.message || e).slice(0, 300) });
  }
});
server.listen(PORT, () => console.log(`Uprise on http://localhost:${PORT} · live = ${d.network} · ${ASSET.symbol} · ledger ${d.ledger}`));
