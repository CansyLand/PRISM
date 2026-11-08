// Transfer NEAR from the v2 master to the contract account (state storage).
const {
  JsonRpcProvider, Account, KeyPair, KeyPairSigner, actions, nearToYocto,
} = require("near-api-js");
const fs = require("fs");
const path = require("path");

function loadCreds() {
  const txt = fs.readFileSync(path.join(__dirname, "..", ".deploy.env"), "utf8");
  const g = (k) => (txt.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
  return g("PRIVATE_KEY");
}

async function main() {
  const privateKey = loadCreds();
  const provider = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
  const master = new Account("prism-v2-1455.testnet", provider, privateKey);
  const info = await provider.query({
    request_type: "view_account", account_id: "prism-v2-1455.testnet", finality: "optimistic",
  });
  console.log("master balance:", (Number(info.amount) / 1e24).toFixed(3), "NEAR");
  const tx = await master.createTransaction({
    receiverId: "contract.prism-v2-1455.testnet",
    publicKey: KeyPair.fromString(privateKey).getPublicKey().toString(),
    actions: [actions.transfer(nearToYocto("5"))],
  });
  const signed = await KeyPairSigner.fromSecretKey(privateKey).signTransaction(tx);
  const res = await provider.sendTransaction(signed.signedTransaction);
  console.log("transfer status:", JSON.stringify(res.status).slice(0, 120));
  const i2 = await provider.query({
    request_type: "view_account", account_id: "contract.prism-v2-1455.testnet", finality: "optimistic",
  });
  console.log("contract balance now:", (Number(i2.amount) / 1e24).toFixed(3), "NEAR");
}

main().catch((e) => {
  console.error("ERROR:", e && e.message ? e.message : e);
  process.exit(1);
});
