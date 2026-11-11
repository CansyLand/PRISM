// probe: which step of the deploy path throws
const t = require("near-api-js");
const fs = require("fs");
const path = require("path");
console.log("near-api-js version:", JSON.parse(fs.readFileSync(path.join(__dirname, "node_modules", "near-api-js", "package.json"), "utf8")).version);
console.log("exports:", Object.keys(t).filter((x) => /Account|Signer|Provider|KeyPair/.test(x)).join(", "));
const txt = fs.readFileSync(path.join(__dirname, "..", ".deploy.env"), "utf8");
const g = (k) => (txt.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
const { Account, JsonRpcProvider, KeyPair, KeyPairSigner } = t;
const provider = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const id = g("ACCOUNT_ID"), pk = g("PRIVATE_KEY");
try {
  const acc = new Account(id, provider, pk);
  console.log("Account constructed:", acc.accountId);
} catch (e) {
  console.log("Account ctor ERROR:", e.message);
}
try {
  const kps = KeyPairSigner.fromSecretKey(pk);
  console.log("KeyPairSigner ok, pubkey:", kps.getPublicKey().toString().slice(0, 12));
} catch (e) {
  console.log("KeyPairSigner ERROR:", e.message);
}
(async () => {
  try {
    const acc = new Account(id, provider, pk);
    const tx = await acc.createTransaction({
      receiverId: id,
      publicKey: KeyPair.fromString(pk).getPublicKey().toString(),
      actions: [t.actions.functionCall("noop", id, "10", 0)],
    });
    console.log("createTransaction ok, block hash:", tx.blockHash ? "yes" : "no");
    const signer = KeyPairSigner.fromSecretKey(pk);
    const signed = await signer.signTransaction(tx);
    console.log("signTransaction ok");
  } catch (e) {
    console.log("tx path ERROR:", e.message);
    console.log(e.stack && e.stack.split("\n").slice(1, 4).join("\n"));
  }
  process.exit(0);
})();
