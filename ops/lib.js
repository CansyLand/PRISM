// Shared helpers for Uprise testnet ops: keys, accounts, calls, views.
// Keys live in ops/.keys.json (gitignored). Testnet only.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, teraToGas, nearToYocto } from "near-api-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const RPC = process.env.NEAR_RPC || "https://test.rpc.fastnear.com";
export const provider = new JsonRpcProvider({ url: RPC });
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

export { KeyPair, Account, KeyPairSigner };
