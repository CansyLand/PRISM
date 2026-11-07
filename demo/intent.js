// Intent wrapper for the NEAR Intents 1Click API.
// Turns an open/close request into a properly formatted swap intent,
// requests a quote (dry-run by default, no funds moved), and exposes the
// real (non-dry) path that returns a depositAddress for execution.
//
//   open  = fund the position's margin:  USDC -> wNEAR
//   close = realize the position:        wNEAR -> USDC
//
// NOTE on networks: the 1Click API (1click.chaindefuser.com) is the production
// MAINNET intent network. It returns real quotes for existing mainnet
// recipients but returns a server error for `.testnet` / non-existent accounts.
// The position *state* lives on the testnet contract (see deploy.js); the
// funding/settlement *intents* below run as dry-run quotes against the mainnet
// 1Click solver using a representative mainnet recipient (default alice.near,
// a standard NEAR placeholder). No funds move in dry-run mode.
const https = require("https");

const ONECLICK = "https://1click.chaindefuser.com";
const ASSETS = {
  wNEAR: "nep141:wrap.near",
  USDC: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
};

// --- tiny JSON-over-https helper (no deps) ---
function post(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      ONECLICK + path,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(buf) });
          } catch (e) {
            reject(new Error(`HTTP ${res.statusCode} non-JSON: ${buf.slice(0, 300)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    https.get(ONECLICK + path, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(buf) });
        } catch (e) {
          reject(new Error(`GET ${path} non-JSON: ${buf.slice(0, 200)}`));
        }
      });
    }).on("error", reject);
  });
}

// Live prices (USDC) from the 1Click tokens endpoint.
async function tokenPrice(symbol) {
  const { json } = await get("/v0/tokens");
  const t = json.find((x) => x.symbol === symbol);
  if (!t) throw new Error(`token ${symbol} not found`);
  return t.price; // USD per 1 token
}

// Build the 1Click quote request for an open/close intent.
function buildIntent({ action, amount, account, dry = true, slippageBps = 100, deadline }) {
  const [origin, dest] = action === "open"
    ? [ASSETS.USDC, ASSETS.wNEAR] // fund margin
    : [ASSETS.wNEAR, ASSETS.USDC]; // realize position
  return {
    dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: slippageBps,
    originAsset: origin,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: dest,
    amount: String(amount),
    recipient: account,
    recipientType: "DESTINATION_CHAIN",
    refundTo: account,
    refundType: "ORIGIN_CHAIN",
    deadline: deadline || new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };
}

// Request a quote. dry=true (default): quote only, no funds. dry=false:
// returns a depositAddress to send the origin asset to in order to execute.
// `account` should be an existing MAINNET account (the 1Click solver validates
// it). In this demo we default to the standard NEAR placeholder alice.near.
async function quote({ action, amount, account = "alice.near", dry = true, slippageBps = 100 }) {
  const body = buildIntent({ action, amount, account, dry, slippageBps });
  const { status, json } = await post("/v0/quote", body);
  if ((status !== 200 && status !== 201) || !json.quote) {
    throw new Error(`quote failed (HTTP ${status}): ${JSON.stringify(json).slice(0, 400)}`);
  }
  return {
    action,
    intent: body,
    quote: json.quote,
    correlationId: json.correlationId,
    signature: json.signature,
    depositAddress: json.depositAddress || null, // present only when dry=false
  };
}

// Track a real (non-dry) swap by its deposit address. Returns the current
// state (pending / processing / success / refunded) plus tx hashes.
// Only meaningful after you've sent the origin asset to the depositAddress.
async function status(depositAddress, depositMemo) {
  const qs = new URLSearchParams({ depositAddress });
  if (depositMemo) qs.set("depositMemo", depositMemo);
  const { status: code, json } = await get(`/v0/status?${qs.toString()}`);
  if (code === 404) return { state: "not_found", raw: json };
  if (code !== 200) throw new Error(`status failed (HTTP ${code}): ${JSON.stringify(json).slice(0, 300)}`);
  return { state: json.state || json.status || "unknown", raw: json };
}

module.exports = { ONECLICK, ASSETS, tokenPrice, buildIntent, quote, status };

// --- CLI: node intent.js <open|close> <amount> [account] [--real] ---
// Default is dry-run (quote only). `--real` requests an executable quote
// (returns a depositAddress); you would then send the origin asset to it.
if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === "status") {
    const depositAddress = argv[1];
    const depositMemo = argv[2];
    if (!depositAddress) {
      console.log("Usage: node intent.js status <depositAddress> [depositMemo]");
      process.exit(1);
    }
    status(depositAddress, depositMemo)
      .then((s) => {
        console.log(`\nswap status: ${s.state}`);
        if (s.state !== "not_found") console.log(JSON.stringify(s.raw, null, 2));
      })
      .catch((e) => {
        console.error("ERROR:", e.message);
        process.exit(1);
      });
    return;
  }

  const [action, amountStr, accountArg, flag] = argv;
  if (!action || !["open", "close"].includes(action) || !amountStr) {
    console.log("Usage:");
    console.log("  node intent.js <open|close> <amountInBaseUnits> [account] [--real]");
    console.log("  node intent.js status <depositAddress> [depositMemo]");
    console.log("  e.g. node intent.js open 100000000        # 100 USDC, dry-run");
    console.log("       node intent.js close 10000000000000000000000 alice.near --real");
    process.exit(1);
  }
  const dry = flag !== "--real";
  const account = accountArg || "alice.near";
  quote({ action, amount: amountStr, account, dry })
    .then((r) => {
      const q = r.quote;
      console.log(`\n${action.toUpperCase()} intent (${dry ? "DRY-RUN quote" : "EXECUTABLE quote"})`);
      console.log("  direction :", r.intent.originAsset, "->", r.intent.destinationAsset);
      console.log("  amount    :", q.amountInFormatted, "(in) =>", q.amountOutFormatted, "(out)");
      console.log("  est value :", q.amountInUsd, "USD | time est:", q.timeEstimate, "s");
      console.log("  recipient :", r.intent.recipient, " refund:", r.intent.refundTo);
      console.log("  correlation:", r.correlationId);
      if (r.depositAddress) console.log("  deposit to:", r.depositAddress);
      if (dry) console.log("\n  [dry-run] no funds moved. Use --real to get a depositAddress.");
    })
    .catch((e) => {
      console.error("ERROR:", e.message);
      process.exit(1);
    });
}
