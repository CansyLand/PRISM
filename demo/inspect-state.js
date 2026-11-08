// Inspect contract account: balance, state size, and how much is held in storage.
const { JsonRpcProvider } = require("near-api-js");

async function main() {
  const p = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
  for (const acc of ["contract.prism-v2-1455.testnet", "prism-v2-1455.testnet"]) {
    const i = await p.query({ request_type: "view_account", account_id: acc, finality: "optimistic" });
    console.log(acc);
    console.log("  balance:", (Number(i.amount) / 1e24).toFixed(4), "NEAR");
    console.log("  locked:", (Number(i.locked) / 1e24).toFixed(4), "NEAR");
    console.log("  storage_usage:", i.storage_usage, "bytes");
    console.log("  storage_paid:", (Number(i.storage_paid_at ? 0 : 0)), "(field n/a)");
  }
  // raw state size of the contract
  const st = await p.query({
    request_type: "view_state",
    account_id: "contract.prism-v2-1455.testnet",
    prefix: new Uint8Array(),
    finality: "optimistic",
  });
  const bytes = st.values.reduce((n, v) => n + v.value.length, 0);
  console.log("contract state values:", st.values.length, "total base64 bytes:", bytes, "≈", Math.ceil(bytes * 3 / 4), "raw bytes");
}

main().catch((e) => console.error("ERR", e.message));
