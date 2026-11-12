// Shared helpers for Uprise testnet ops: keys, accounts, calls, views.
// Keys live in ops/.keys.json (gitignored). Testnet only.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, teraToGas, nearToYocto, decodeSignedDelegate } from "near-api-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DIR = path.dirname(fileURLToPath(import.meta.url));
// Free public testnet RPCs rate-limit per IP, so fail over between several.
// NEAR_RPC (comma-separated, e.g. a FastNEAR URL with an API key) goes first.
export const RPCS = [...(process.env.NEAR_RPC ? process.env.NEAR_RPC.split(",") : []),
  "https://test.rpc.fastnear.com", "https://near-testnet.drpc.org", "https://rpc.testnet.near.org"];
export const RPC = RPCS[0];
/** Wrap several RPC providers: on a rate limit or network error, try the next one. */
export function failover(providers) {
  let cur = 0;
  const retryable = (e) => /429|rate limit|fetch failed|ECONN|ETIMEDOUT|socket|50[234]|DEPRECATED|discontinued|internal server error|server error|timeout|timed out/i.test(String(e?.message || e) + String(e?.cause || ""));
  return new Proxy(providers[0], {
    get(_, prop) {
      const v = providers[cur][prop];
      if (typeof v !== "function") return v;
      return async (...args) => {
        let err;
        for (let k = 0; k < providers.length * 2; k++) {
          const i = (cur + k) % providers.length;
          try { const r = await providers[i][prop](...args); cur = i; return r; }
          catch (e) { err = e; if (!retryable(e)) throw e; if (k >= providers.length - 1) await new Promise((r) => setTimeout(r, 800)); }
        }
        throw err;
      };
    },
  });
}
export const provider = failover(RPCS.map((url) => new JsonRpcProvider({ url }, { retries: 2, wait: 300 })));
const KEYS = path.join(DIR, ".keys.json");
const DEPLOY = path.join(DIR, "deployment.json");

export const loadKeys = () => (fs.existsSync(KEYS) ? JSON.parse(fs.readFileSync(KEYS, "utf8")) : {});
export const saveKey = (id, secret) => { const k = loadKeys(); k[id] = secret; fs.writeFileSync(KEYS, JSON.stringify(k, null, 2), { mode: 0o600 }); };
export const loadDeployment = () => (fs.existsSync(DEPLOY) ? JSON.parse(fs.readFileSync(DEPLOY, "utf8")) : null);
export const saveDeployment = (d) => fs.writeFileSync(DEPLOY, JSON.stringify(d, null, 2));

export function account(id) {
  const secret = loadKeys()[id];
  if (!secret) throw new Error(`no key for ${id}`);
  return new Account(id, provider, new KeyPairSigner(KeyPair.fromString(secret)));
}

export const view = (contractId, method, args = {}) => provider.callFunction({ contractId, method, args });

/** Call a method; returns the decoded return value. deposit in yocto (string/bigint), gas in Tgas. */
export async function call(acct, contractId, method, args = {}, { deposit = 0n, tgas = 100 } = {}) {
  return acct.callFunction({ contractId, methodName: method, args, deposit: BigInt(deposit), gas: teraToGas(tgas) });
}

export const ONE_YOCTO = 1n;
export const near = (n) => BigInt(nearToYocto(String(n)));
export const usd = (n) => BigInt(Math.round(n * 1e6));
export const fmtUsd = (raw) => "$" + (Number(raw) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ask the public testnet faucet to create a top-level account (it funds it). */
export async function faucetAccount(accountId) {
  const kp = KeyPair.fromRandom("ed25519");
  const r = await fetch("https://helper.testnet.near.org/account", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: kp.getPublicKey().toString() }),
  });
  if (!r.ok) throw new Error(`faucet ${r.status}: ${await r.text()}`);
  saveKey(accountId, kp.toString());
  return accountId;
}

export async function balanceNear(id) {
  const s = await provider.viewAccount({ accountId: id }).catch(() => null);
  return s ? Number(BigInt(s.amount) / 10n ** 21n) / 1000 : 0;
}

/** Underlying assets the stack can run on. Mainnet target: NEAR. */
export const ASSETS = {
  NEAR: { symbol: "NEAR", decimals: 24, coinbase: "NEAR-USD", binance: "NEARUSDT", volFloorBps: 8_000, seedUnits: 1_400_000n },
  BTC: { symbol: "BTC", decimals: 8, coinbase: "BTC-USD", binance: "BTCUSDT", volFloorBps: 6_000, seedUnits: 70n },
};
export async function spotPrice(a) {
  try { const r = await fetch(`https://api.coinbase.com/v2/prices/${a.coinbase}/spot`).then((r) => r.json()); return Number(r.data.amount); }
  catch { const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${a.binance}`).then((r) => r.json()); return Number(r.price); }
}

export { KeyPair, Account, KeyPairSigner, decodeSignedDelegate };
