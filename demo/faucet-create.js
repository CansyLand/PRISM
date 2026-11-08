// Create a fresh testnet account via the NEAR faucet (helper.nearprotocol.com),
// attaching OUR public key so the existing PRIVATE_KEY can operate it.
// Usage: node faucet-create.js <new_account_id>
const fs = require("fs");
const path = require("path");

const TARGET = process.argv[2];
if (!TARGET) { console.error("usage: node faucet-create.js <account_id>"); process.exit(1); }

function loadPub() {
  const txt = fs.readFileSync(path.join(__dirname, "..", "..", ".deploy.env"), "utf8");
  const g = (k) => (txt.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
  return g("PRIVATE_KEY");
}

const pk = loadPub();
const pub = new URLSearchParams({});
const keypair = require("near-api-js").KeyPair.fromString(pk);
const publicKey = keypair.getPublicKey().toString();

async function main() {
  const res = await fetch("https://helper.nearprotocol.com/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: TARGET, newAccountPublicKey: publicKey }),
  });
  const text = await res.text();
  console.log("status:", res.status);
  console.log(text.slice(0, 500));
  try {
    const j = JSON.parse(text);
    if (j && j.accountId) {
      console.log("\nFAUCET_CREATED:", j.accountId);
      if (j.accountId !== TARGET) console.log("(faucet chose a different id:", j.accountId, "— use this one)");
    }
  } catch { /* non-JSON error */ }
}
main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
