// Find which .deploy.env private key matches which account's on-chain key.
const { JsonRpcProvider, KeyPair } = require("near-api-js");
const fs = require("fs");
const txt = fs.readFileSync("../.deploy.env", "utf8");
const g = (k) => (txt.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
const p = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
(async () => {
  const keys = {
    PRIVATE_KEY: g("PRIVATE_KEY"),
    LIQUIDATOR_PRIVATE_KEY: g("LIQUIDATOR_PRIVATE_KEY"),
  };
  const pks = {};
  for (const [k, v] of Object.entries(keys)) {
    if (!v) { console.log(k, "= missing"); continue; }
    try { pks[k] = KeyPair.fromString(v).getPublicKey().toString(); }
    catch (e) { console.log(k, "= invalid key:", e.message.slice(0, 50)); }
  }
  console.log("\nderived public keys:");
  for (const [k, v] of Object.entries(pks)) console.log("  ", k, "→", v);
  console.log("\non-chain keys:");
  for (const id of [g("LIQUIDATOR_ACCOUNT_ID"), g("ACCOUNT_ID")]) {
    const r = await p.query({ request_type: "view_access_key_list", account_id: id, finality: "optimistic" });
    console.log("  ", id, ":", r.keys.map((k) => k.public_key).join(", "));
  }
})();
