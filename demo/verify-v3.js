// Verify v3 on-chain methods + run the full demo userflows end-to-end.
const { JsonRpcProvider } = require("near-api-js");
const fs = require("fs");
const path = require("path");

const NODE_URL = "https://test.rpc.fastnear.com";
function loadCreds() {
  const txt = fs.readFileSync(path.join(__dirname, "..", ".deploy.env"), "utf8");
  const g = (k) => (txt.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
  return g("ACCOUNT_ID");
}

async function view(provider, acc, method) {
  const r = await provider.query({
    request_type: "call_function",
    account_id: acc,
    method_name: method,
    args_base64: "",
    finality: "optimistic",
  });
  return Buffer.from(r[0], "base64").toString("utf8");
}

(async () => {
  const acc = loadCreds();
  const p = new JsonRpcProvider({ url: NODE_URL });
  console.log("account:", acc);
  const methods = [
    "get_mark",
    "get_stats",
    "get_positions",
    "funding_rate_bps",
    "last_funding_ts",
    "liq_penalty_bps",
  ];
  for (const m of methods) {
    try {
      console.log(m + " ->", (await view(p, acc, m)).slice(0, 220));
    } catch (e) {
      console.log(m + " ERR", e.message.slice(0, 90));
    }
  }
})().catch((e) => console.error("FATAL", e.message));
