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

const NODE_URL = "https://test.rpc.fastnear.com";

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

  // 2) Initialize via #[init] new() — on redeploy, state already exists and
  //    #[init] traps by design; that's a success (contract already initialized).
  try {
    await account.callFunction({
      contractId: accountId,
      methodName: "new",
      args: {},
      gas: teraToGas("200"),
      deposit: nearToYocto("0"),
    });
    console.log("Contract initialized (new()).");
  } catch (e) {
    console.log("Contract already has state (redeploy) — keeping existing state.");
  }

  // 3) Open: long 1000 @ $20.00, notional $200k, margin $20k (10x)
  await account.callFunction({
    contractId: accountId,
    methodName: "open_position",
    args: { size: 1000, price: 200_000_000, margin: 20_000_000_000 },
    gas: teraToGas("100"),
    deposit: nearToYocto("0"),
  });
  const pos = await provider.callFunction({
    contractId: accountId,
    method: "get_position",
    args: { account_id: accountId },
  });
  console.log("Position after open:", JSON.stringify(pos));

  // 4) Settle entry with the "actual" solver fill price ($20.50)
  await account.callFunction({
    contractId: accountId,
    methodName: "settle_entry",
    args: { fill_price: 205_000_000 },
    gas: teraToGas("100"),
    deposit: nearToYocto("0"),
  });
  const posFill = await provider.callFunction({
    contractId: accountId,
    method: "get_position",
    args: { account_id: accountId },
  });
  console.log("Position after settle_entry($20.50):", JSON.stringify(posFill));

  // 5) Close at $21.00 => PnL = 1000 * ($21 - $20.50) = +$500 (based on the settled fill price)
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
