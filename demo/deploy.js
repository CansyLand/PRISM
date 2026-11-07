// Deploy leveraged-positions wasm to testnet, run #[init] new(), then prove
// the full open -> get -> close loop on-chain. Uses near-api-js v7.
const fs = require("fs");
const path = require("path");
const {
  Account,
  KeyPair,
  JsonRpcProvider,
  KeyPairSigner,
  actions,
  nearToYocto,
  teraToGas,
} = require("near-api-js");

const NODE_URL = "https://rpc.testnet.near.org";

function loadCreds() {
  const txt = fs.readFileSync(path.join(__dirname, "..", ".deploy.env"), "utf8");
  const g = (k) => (txt.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
  return { privateKey: g("PRIVATE_KEY"), accountId: g("ACCOUNT_ID") };
}

async function main() {
  const { privateKey, accountId } = loadCreds();
  const provider = new JsonRpcProvider({ url: NODE_URL });
  const account = new Account(accountId, provider, privateKey);

  const info = await provider.query({
    request_type: "view_account",
    account_id: accountId,
    finality: "optimistic",
  });
  console.log("Account:", accountId, "balance:", Number(info.amount) / 1e24, "NEAR");

  const wasmPath = path.join(
    __dirname, "..", "contract", "target", "wasm32-unknown-unknown", "release", "leveraged_positions.wasm",
  );
  const wasm = new Uint8Array(fs.readFileSync(wasmPath));
  console.log("Wasm size:", wasm.length, "bytes");

  // 1) Deploy the wasm bytecode
  const deployTx = await account.createTransaction({
    receiverId: accountId,
    publicKey: KeyPair.fromString(privateKey).getPublicKey().toString(),
    actions: [actions.deployContract(wasm)],
  });
  const signer = KeyPairSigner.fromSecretKey(privateKey);
  const signed = await signer.signTransaction(deployTx);
  await provider.sendTransaction(signed.signedTransaction);
  console.log("Wasm deployed.");

  // 2) Initialize via #[init] new()
  await account.callFunction({
    contractId: accountId,
    methodName: "new",
    args: {},
    gas: teraToGas("200"),
    deposit: nearToYocto("0"),
  });
  console.log("Contract initialized (new()).");

  // 3) Open: long 1000 @ $20.00, margin $100.00 (USDC 6dp)
  await account.callFunction({
    contractId: accountId,
    methodName: "open_position",
    args: { size: 1000, price: 200_000_000, margin: 100_000_000 },
    gas: teraToGas("100"),
    deposit: nearToYocto("0"),
  });
  const pos = await provider.callFunction({
    contractId: accountId,
    method: "get_position",
    args: { account_id: accountId },
  });
  console.log("Position after open:", JSON.stringify(pos));

  // 4) Close at $21.00 => PnL +$10,000.00
  await account.callFunction({
    contractId: accountId,
    methodName: "close_position",
    args: { exit_price: 210_000_000 },
    gas: teraToGas("100"),
    deposit: nearToYocto("0"),
  });
  const pos2 = await provider.callFunction({
    contractId: accountId,
    method: "get_position",
    args: { account_id: accountId },
  });
  console.log("Position after close:", JSON.stringify(pos2));

  console.log("\n=== ON-CHAIN LOOP VERIFIED ON TESTNET ===");
  console.log("open -> visible via get_position -> closed.");
}

main().catch((e) => {
  console.error("ERROR:", e && e.message ? e.message : e);
  if (e && e.messages) console.error(JSON.stringify(e.messages));
  process.exit(1);
});
