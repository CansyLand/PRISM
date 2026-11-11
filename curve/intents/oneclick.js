// NEAR Intents 1Click client: deposit and withdraw quotes plus status.
// Pure HTTP, no custody. The solver network and the intents.near verifier do the bridging.
//
//   deposit : <any chain asset>  ──1Click──►  USDC on NEAR → relayer account
//   withdraw: USDC on NEAR (from the ledger) ──1Click──► <any chain asset> → user address
//
// 1Click runs on MAINNET only. Testnet demos use dry-run quotes plus `--simulate`
// in relayer.js. Set ONECLICK_JWT if your partner key is required (fee-free quotes).

const BASE = process.env.ONECLICK_URL || "https://1click.chaindefuser.com";
const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

function headers() {
  const h = { "Content-Type": "application/json" };
  if (process.env.ONECLICK_JWT) h.Authorization = `Bearer ${process.env.ONECLICK_JWT}`;
  return h;
}

async function call(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: headers(), body: body && JSON.stringify(body) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`1Click ${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`1Click ${path} HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

/** Supported assets: [{assetId, blockchain, symbol, decimals, price}] */
const tokens = () => call("GET", "/v0/tokens");

const deadline = (min = 30) => new Date(Date.now() + min * 60_000).toISOString();

/**
 * Deposit: user sends `originAsset` from their chain, and USDC lands on NEAR at `relayer`.
 * Returns { depositAddress, depositMemo?, quote } (no depositAddress when dry).
 */
async function depositQuote({ originAsset, amount, refundTo, relayer, dry = false, slippageBps = 100 }) {
  return call("POST", "/v0/quote", {
    dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: slippageBps,
    originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: USDC_NEAR,
    amount: String(amount),
    refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: relayer,
    recipientType: "DESTINATION_CHAIN",
    deadline: deadline(),
  });
}

/**
 * Withdraw: the ledger sends USDC (NEAR) to the returned depositAddress, and 1Click
 * delivers `destinationAsset` to `recipient` on its chain. Refunds go to `refundTo`
 * on NEAR (the relayer), which re-credits the user.
 */
async function withdrawQuote({ destinationAsset, amount, recipient, refundTo, dry = false, slippageBps = 100 }) {
  return call("POST", "/v0/quote", {
    dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: slippageBps,
    originAsset: USDC_NEAR,
    depositType: "ORIGIN_CHAIN",
    destinationAsset,
    amount: String(amount),
    refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: deadline(),
  });
}

/** Optional: tell 1Click the deposit tx so it doesn't wait on chain scanning. */
const submitDepositTx = (txHash, depositAddress) =>
  call("POST", "/v0/deposit/submit", { txHash, depositAddress });

/** { status: PENDING_DEPOSIT|KNOWN_DEPOSIT_TX|PROCESSING|SUCCESS|INCOMPLETE_DEPOSIT|REFUNDED|FAILED, swapDetails } */
async function status(depositAddress, depositMemo) {
  const qs = new URLSearchParams({ depositAddress });
  if (depositMemo) qs.set("depositMemo", depositMemo);
  return call("GET", `/v0/status?${qs}`);
}

const FINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

async function waitFor(depositAddress, { depositMemo, timeoutMs = 20 * 60_000, everyMs = 5_000, onTick } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const s = await status(depositAddress, depositMemo);
    onTick && onTick(s);
    if (FINAL.has(s.status)) return s;
    if (Date.now() > until) throw new Error(`timeout waiting for ${depositAddress} (last: ${s.status})`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

module.exports = { USDC_NEAR, tokens, depositQuote, withdrawQuote, submitDepositTx, status, waitFor };
