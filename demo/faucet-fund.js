// Top up the contract account to cover testnet storage rent (~18 NEAR).
// Sources: 1) faucet-created prism-fund-11111.testnet (holds the contract keypair),
//          2) liquidator-8842.testnet (keeps 2 NEAR for gas).
const {
  JsonRpcProvider, Account, KeyPair, KeyPairSigner, actions, nearToYocto,
} = require("near-api-js");
const fs = require("fs");
const path = require("path");

const RPC = "https://test.rpc.fastnear.com";
const TARGET = 19; // NEAR the contract should end up with

function loadCreds() {
  const txt = fs.readFileSync(path.join(__dirname, "..", ".deploy.env"), "utf8");
  const g = (k) => (txt.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
  return {
    accountId: g("ACCOUNT_ID"),
    publicKey: g("PUBLIC_KEY"),
    privateKey: g("PRIVATE_KEY"),
    liquidatorId: g("LIQUIDATOR_ACCOUNT_ID"),
    liquidatorKey: g("LIQUIDATOR_PRIVATE_KEY"),
  };
}

async function bal(p, id) {
  const i = await p.query({ request_type: "view_account", account_id: id, finality: "optimistic" });
  return Number(i.amount) / 1e24;
}

async function transfer(p, fromId, fromKey, toId, amount) {
  const acc = new Account(fromId, p, fromKey);
  const signerPk = KeyPair.fromString(fromKey).getPublicKey().toString();
  const tx = await acc.createTransaction({
    receiverId: toId,
    publicKey: signerPk,
    actions: [actions.transfer(nearToYocto(amount.toFixed(3)))],
  });
  const signed = await KeyPairSigner.fromSecretKey(fromKey).signTransaction(tx);
  const res = await p.sendTransaction(signed.signedTransaction);
  return JSON.stringify(res.status).slice(0, 60);
}

async function main() {
  const c = loadCreds();
  const p = new JsonRpcProvider({ url: RPC });
  let balNow = await bal(p, c.accountId);
  console.log("contract starts at", balNow.toFixed(3), "NEAR");

  // source 1: faucet throwaway
  const tb = await bal(p, "prism-fund-11111.testnet").catch(() => 0);
  if (tb > 0.1 && balNow < TARGET) {
    const send = Math.min(tb - 0.05, TARGET - balNow);
    console.log(`  prism-fund-11111.testnet holds ${tb.toFixed(3)}; sending ${send.toFixed(3)}`);
    console.log("  status:", await transfer(p, "prism-fund-11111.testnet", c.privateKey, c.accountId, send));
    balNow = await bal(p, c.accountId);
    console.log("  contract now:", balNow.toFixed(3), "NEAR");
  }

  // source 2: liquidator (keep 2 NEAR for gas)
  if (balNow < TARGET) {
    const lb = await bal(p, c.liquidatorId);
    const send = Math.min(lb - 2, TARGET - balNow);
    console.log(`  liquidator holds ${lb.toFixed(3)}; sending ${send.toFixed(3)}`);
    console.log("  status:", await transfer(p, c.liquidatorId, c.liquidatorKey, c.accountId, send));
    balNow = await bal(p, c.accountId);
    console.log("  contract now:", balNow.toFixed(3), "NEAR");
  }
  console.log("FINAL contract balance:", balNow.toFixed(3), "NEAR");
}

main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
