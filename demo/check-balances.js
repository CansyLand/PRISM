// One-shot: check testnet balances of the accounts the liquidation demo uses.
const { JsonRpcProvider } = require("near-api-js");
const fs = require("fs");
const path = require("path");
const txt = fs.readFileSync(path.join(__dirname, "..", ".deploy.env"), "utf8");
const g = (k) => (txt.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
(async () => {
  const p = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
  for (const a of [g("ACCOUNT_ID"), g("LIQUIDATOR_ACCOUNT_ID")]) {
    try {
      const i = await p.query({ request_type: "view_account", account_id: a, finality: "optimistic" });
      console.log(a, "balance:", (Number(i.amount) / 1e24).toFixed(3), "NEAR");
    } catch (e) {
      console.log(a, "ERR", e.message.slice(0, 80));
    }
  }
})().catch((e) => console.error("FATAL", e.message));
