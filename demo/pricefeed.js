// Price & Mark Source (module 5) — independent, swappable.
//
// Pulls the wNEAR/USDC price from MULTIPLE independent sources, takes the
// MEDIAN with a deviation check, and pushes it to the on-chain mark via
// update_mark() on the ledger contract.
//
// The on-chain mark is what the liquidation engine reads. That is the key
// property: once a mark is on NEAR, liquidations keep working even if
// every external feed is down or a chain is congested — any client can
// push a fresh mark (20% deviation guard keeps it honest).
//
// Sources (add more here, or swap — that's the point of the block):
//   1. 1Click /v0/tokens            (intent network, coingecko-backed)
//   2. CoinGecko simple price       (independent aggregator)
//
// CLI:
//   node pricefeed.js                 fetch + aggregate, print report
//   node pricefeed.js push            ...and push the median to the contract
const https = require("https");
const { Account, JsonRpcProvider, teraToGas, nearToYocto } = require("near-api-js");
const fs = require("fs");
const path = require("path");

const USDC = 1e6;
const MAX_DEVIATION_BPS = 2000; // must match contract's MAX_MARK_DEVIATION_BPS

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "prism-pricefeed/1.0 (open-source demo)" } },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            reject(new Error(`non-JSON from ${url}: ${buf.slice(0, 120)}`));
          }
        });
      },
    );
    req.on("error", reject);
  });
}

// --- source 1: 1Click tokens endpoint ---
async function fetch1click(symbol = "wNEAR") {
  const json = await getJson("https://1click.chaindefuser.com/v0/tokens");
  const t = json.find((x) => x.symbol === symbol);
  if (!t) throw new Error(`${symbol} not in 1Click tokens`);
  return { source: "1Click", price: t.price, ts: t.priceUpdatedAt };
}

// --- source 2: CoinGecko (independent aggregator) ---
async function fetchCoinGecko(geckoId = "wrapped-near") {
  const json = await getJson(
    `https://api.coingecko.com/api/v3/simple/price?ids=${geckoId}&vs_currencies=usd`,
  );
  const p = json[geckoId] && json[geckoId].usd;
  if (!p) throw new Error(`${geckoId} not in CoinGecko`);
  return { source: "CoinGecko", price: p, ts: new Date().toISOString() };
}

const SOURCES = {
  wNEAR: [() => fetch1click("wNEAR"), () => fetchCoinGecko("near")],
};

// --- aggregation: median with deviation check ---
function aggregate(readings) {
  const ok = readings.filter((r) => r && r.price > 0);
  if (ok.length === 0) throw new Error("no price source succeeded");
  const prices = ok.map((r) => r.price).sort((a, b) => a - b);
  const median =
    prices.length % 2
      ? prices[(prices.length - 1) / 2]
      : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2;
  const maxDeviationPct =
    ((Math.max(...prices) - Math.min(...prices)) / median) * 100;
  return {
    median,
    sources: ok.map((r) => `${r.source}: $${r.price}`),
    n: ok.length,
    maxDeviationPct: +maxDeviationPct.toFixed(3),
    healthy: maxDeviationPct * 100 <= MAX_DEVIATION_BPS,
  };
}

async function markPrice(symbol = "wNEAR") {
  const fns = (SOURCES[symbol] || SOURCES.wNEAR).map((f, i) => ({ f, label: `source${i + 1}` }));
  const readings = await Promise.all(
    fns.map(({ f, label }) => f().catch((e) => ({ source: label, price: 0, error: e.message }))),
  );
  const agg = aggregate(readings);
  return { symbol, agg, readings };
}

// --- push to the on-chain mark ---
function loadAccount() {
  const txt = fs.readFileSync(path.join(__dirname, "..", ".deploy.env"), "utf8");
  const g = (k) => (txt.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
  return { accountId: g("ACCOUNT_ID"), privateKey: g("PRIVATE_KEY") };
}

async function pushMark(symbol = "wNEAR") {
  const { agg } = await markPrice(symbol);
  if (!agg.healthy) {
    throw new Error(
      `sources disagree by ${agg.maxDeviationPct}% > ${MAX_DEVIATION_BPS / 100}% — NOT pushing`,
    );
  }
  const { accountId, privateKey } = loadAccount();
  const provider = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
  const account = new Account(accountId, provider, privateKey);
  // The contract rejects marks >20% away from the LAST stored mark.
  const prev = await provider.callFunction({
    contractId: accountId,
    method: "get_mark",
    args: {},
  });
  const lastMark = prev && prev[0] ? Number(prev[0]) : null;
  if (lastMark && lastMark > 0) {
    const devBps = (Math.abs(agg.median - lastMark / USDC) / (lastMark / USDC)) * 10000;
    if (devBps > MAX_DEVIATION_BPS) {
      throw new Error(
        `median $${agg.median} deviates ${devBps.toFixed(0)}bps from on-chain mark $${lastMark / USDC} (guard 2000bps) — NOT pushing`,
      );
    }
  }
  const mark = Math.round(agg.median * USDC);
  await account.callFunction({
    contractId: accountId,
    methodName: "update_mark",
    args: { mark },
    gas: teraToGas("50"),
    deposit: nearToYocto("0"),
  });
  const cur = await provider.callFunction({
    contractId: accountId,
    method: "get_mark",
    args: {},
  });
  return { pushed: mark / USDC, onChain: cur };
}

// Push an EXPLICIT raw mark (6dp) to the contract — used by the liquidation
// demo to simulate a price crash within the 20% fresh-mark deviation guard.
async function updateMark(rawMark) {
  const { accountId, privateKey } = loadAccount();
  const provider = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
  const account = new Account(accountId, provider, privateKey);
  await account.callFunction({
    contractId: accountId,
    methodName: "update_mark",
    args: { mark: Math.round(rawMark) },
    gas: teraToGas("50"),
    deposit: nearToYocto("0"),
  });
  const cur = await provider.callFunction({
    contractId: accountId,
    method: "get_mark",
    args: {},
  });
  return { pushed: rawMark / USDC, onChain: cur };
}

module.exports = { markPrice, pushMark, updateMark, aggregate, fetch1click, fetchCoinGecko };

if (require.main === module) {
  const cmd = process.argv[2] || "fetch";
  (async () => {
    if (cmd === "push") {
      const r = await pushMark();
      console.log(`\n  pushed mark $${r.pushed} to contract -> on-chain now: ${JSON.stringify(r.onChain)}`);
    } else {
      const { agg, readings } = await markPrice();
      console.log("Price & Mark Source — wNEAR/USDC");
      for (const r of readings) {
        console.log(r.price > 0 ? `  ${r.source.padEnd(10)} $${r.price}` : `  ${(r.source || "?").padEnd(10)} FAILED: ${r.error}`);
      }
      console.log(`  MEDIAN     $${agg.median}  (n=${agg.n}, max deviation ${agg.maxDeviationPct}%, healthy=${agg.healthy})`);
    }
  })().catch((e) => {
    console.error("ERROR:", e.message);
    process.exit(1);
  });
}
