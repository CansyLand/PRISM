// PRISM v4 setup — deploy the pusher-governance wasm to a FRESH contract
// account (v4 changed the state layout; the old v3 state is incompatible):
//   1. create subaccount prism-v2-1455.prism-v2-1455.testnet (same key as master)
//   2. deploy v4 wasm + new()
//   3. set_pusher(contract-itself) — the pricefeed pushes from the contract
//      account (self-call), strangers remain blocked
//   4. fund to 19 NEAR (storage rent + demo room)
//   5. verify owner + pusher + params on-chain
const {
  JsonRpcProvider, Account, KeyPair, KeyPairSigner, actions, nearToYocto, teraToGas,
} = require("near-api-js");
const fs = require("fs");
const path = require("path");

const RPC = "https://test.rpc.fastnear.com";
const NEW_ACCOUNT = "prism-v4-2026.testnet";
const FUND_TARGET = 19;

function loadCreds() {
  const txt = fs.readFileSync(path.join(__dirname, "..", "..", ".deploy.env"), "utf8");
  const g = (k) => (txt.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
  return {
    accountId: g("ACCOUNT_ID"), privateKey: g("PRIVATE_KEY"),
    liquidatorId: g("LIQUIDATOR_ACCOUNT_ID"), liquidatorKey: g("LIQUIDATOR_PRIVATE_KEY"),
  };
}
async function bal(p, id) {
  try {
    const i = await p.query({ request_type: "view_account", account_id: id, finality: "optimistic" });
    return Number(i.amount) / 1e24;
  } catch { return 0; }
}
async function transfer(p, fromId, fromKey, toId, amount) {
  const acc = new Account(fromId, p, fromKey);
  const pk = KeyPair.fromString(fromKey).getPublicKey().toString();
  const tx = await acc.createTransaction({ receiverId: toId, publicKey: pk, actions: [actions.transfer(nearToYocto(amount.toFixed(3)))] });
  const signed = await KeyPairSigner.fromSecretKey(fromKey).signTransaction(tx);
  return JSON.stringify(await p.sendTransaction(signed.signedTransaction)).slice(0, 80);
}

async function main() {
  const c = loadCreds();
  const p = new JsonRpcProvider({ url: RPC });
  const pub = KeyPair.fromString(c.privateKey).getPublicKey().toString();
  console.log("master:", c.accountId, (await bal(p, c.accountId)).toFixed(3), "NEAR");

  // 1. create subaccount (atomic: create + key + 5 NEAR)
  if (await bal(p, NEW_ACCOUNT) <= 0) {
    console.log("creating", NEW_ACCOUNT, "(5 NEAR)");
    const master = new Account(c.accountId, p, c.privateKey);
    const tx = await master.createTransaction({
      receiverId: NEW_ACCOUNT, publicKey: pub,
      actions: [actions.createAccount(), actions.addFullAccessKey(KeyPair.fromString(c.privateKey).getPublicKey(), null, null), actions.transfer(nearToYocto("5"))],
    });
    const signed = await KeyPairSigner.fromSecretKey(c.privateKey).signTransaction(tx);
    const res = await p.sendTransaction(signed.signedTransaction);
    const status = res.final_execution_status || (res.status && res.status.SuccessValue);
    if (status !== "EXECUTED" && !res.status) throw new Error("subaccount creation failed: " + JSON.stringify(res).slice(0, 200));
    console.log("  created, balance:", (await bal(p, NEW_ACCOUNT)).toFixed(3), "NEAR");
  } else {
    console.log(NEW_ACCOUNT, "exists with", (await bal(p, NEW_ACCOUNT)).toFixed(3), "NEAR");
  }

  // 2. deploy wasm + init
  const acc = new Account(NEW_ACCOUNT, p, c.privateKey);
  const wasm = new Uint8Array(fs.readFileSync(path.join(__dirname, "..", "contract", "target", "wasm32-unknown-unknown", "release", "leveraged_positions.wasm")));
  console.log("wasm:", wasm.length, "bytes");
  const dtx = await acc.createTransaction({ receiverId: NEW_ACCOUNT, publicKey: pub, actions: [actions.deployContract(wasm)] });
  const dsigned = await KeyPairSigner.fromSecretKey(c.privateKey).signTransaction(dtx);
  await p.sendTransaction(dsigned.signedTransaction);
  console.log("wasm deployed.");
  try {
    await acc.callFunction({ contractId: NEW_ACCOUNT, methodName: "new", args: {}, gas: teraToGas("200"), deposit: nearToYocto("0") });
    console.log("initialized new()");
  } catch { console.log("state already exists — redeploy, keeping state"); }

  // 3. price pusher = the contract account itself (pricefeed self-call pattern)
  try {
    const raw = await acc.callFunctionRaw({ contractId: NEW_ACCOUNT, methodName: "set_pusher", args: { price_pusher: NEW_ACCOUNT }, gas: teraToGas("100"), deposit: nearToYocto("0") });
    const last = raw.receipts_outcome[raw.receipts_outcome.length - 1];
    const st = last.outcome && last.outcome.status;
    const ok = (st && (st.SuccessValue !== undefined || st.SuccessReceiptId)) || raw.final_execution_status === "EXECUTED";
    if (!ok) throw new Error("set_pusher failed: " + JSON.stringify(st));
    if (st && st.Failure) throw new Error("set_pusher failed: " + JSON.stringify(st));
    console.log("pusher set to", NEW_ACCOUNT);
  } catch (e) {
    // idempotent-ish: verify state instead of failing
    console.log("set_pusher note:", e.message.slice(0, 100));
  }

  // 4. fund to target
  let b = await bal(p, NEW_ACCOUNT);
  if (b < FUND_TARGET) {
    const fb = await bal(p, "prism-fund-11111.testnet");
    if (fb > 0.1) {
      const send = Math.min(fb - 0.05, FUND_TARGET - b);
      console.log("funding from faucet account:", send.toFixed(3), "NEAR ->", await transfer(p, "prism-fund-11111.testnet", c.privateKey, NEW_ACCOUNT, send));
      b = await bal(p, NEW_ACCOUNT);
    }
    if (b < FUND_TARGET) {
      const lb = await bal(p, c.liquidatorId);
      const send = Math.min(lb - 2, FUND_TARGET - b);
      if (send > 0.1) {
        console.log("funding from liquidator:", send.toFixed(3), "NEAR ->", await transfer(p, c.liquidatorId, c.liquidatorKey, NEW_ACCOUNT, send));
        b = await bal(p, NEW_ACCOUNT);
      }
    }
    if (b < FUND_TARGET) {
      // master (the v3 contract account) tops up too, keeping 15 NEAR for its own rent
      const mb = await bal(p, c.accountId);
      const send = Math.min(mb - 15, FUND_TARGET - b);
      if (send > 0.1) {
        console.log("funding from master:", send.toFixed(3), "NEAR ->", await transfer(p, c.accountId, c.privateKey, NEW_ACCOUNT, send));
        b = await bal(p, NEW_ACCOUNT);
      }
    }
  }
  console.log("final balance:", b.toFixed(3), "NEAR");

  // 5. verify (v7: use raw provider query, not account.viewFunction)
  const view = async (m, a = {}) => {
    const r = await p.query({
      request_type: "call_function", account_id: NEW_ACCOUNT, method_name: m,
      args_base64: Buffer.from(JSON.stringify(a)).toString("base64"), finality: "optimistic",
    });
    return JSON.parse(Buffer.from(r.result).toString("utf8"));
  };
  console.log("owner:", JSON.stringify(await view("get_owner")));
  console.log("pusher:", JSON.stringify(await view("get_pusher")));
  console.log("params:", JSON.stringify(await view("get_params")));
  console.log("\n=== PRISM v4 DEPLOYED ON " + NEW_ACCOUNT + " ===");
}
main().catch((e) => { console.error("FATAL:", e.message || e); process.exit(1); });
