import { CandleChart, fmtP } from "./candles.js";
import { Demo, CANDLE_MS, meltSeconds } from "./demo.js";
import { showOnboarding } from "./onboarding.js";
import { Arena } from "./analytics.js";

const $ = (id) => document.getElementById(id);
const E6 = 1e6;
const fmt = (v, d = 2) => (v < 0 ? "−" : "") + "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v, d = 0) => (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(d) + "%";
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

let mode = ls.get("uprise.mode") || "demo", tab = "bull", live = null, demo = null, busy = false;
const chart = new CandleChart($("candles"));
const arena = new Arena($("arena"));

// ── toast + busy buttons ──
let tt;
function toast(msg, err) { const t = $("toast"); t.textContent = msg; t.className = "toast" + (err ? " err" : ""); t.hidden = false; clearTimeout(tt); tt = setTimeout(() => (t.hidden = true), err ? 6000 : 3200); }
async function withBusy(btn, label, fn) {
  if (busy) return; busy = true; const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spin"></span> ${label}`;
  try { await fn(); } catch (e) { toast(String(e.message || e).slice(0, 180), true); } finally { busy = false; btn.innerHTML = old; btn.disabled = false; render(); }
}
const modal = (id, show = true) => { $(id).hidden = !show; };
document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => (b.closest(".modal-bg").hidden = true)));
document.querySelectorAll(".modal-bg").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) m.hidden = true; }));

// ── strength (curvature) selector ──
const P = () => +$("p").value;
function renderStrength() {
  const p = P(), name = mode === "live" ? (live?.cfg?.asset || "NEAR") : "the price";
  $("pLabel").textContent = p + "×";
  const up = Math.pow(1.1, p) - 1, down = Math.pow(0.9, p) - 1;
  $("pNote").textContent = mode === "demo"
    ? `${name === "the price" ? "Price" : name} +10% → ${pct(up)} · −10% → ${pct(down)}. A flat market melts it in ${Math.round(meltSeconds(p))} s of fast-forward.`
    : p !== live?.cfg?.power ? `The live market offers ${live?.cfg?.power}× right now. More strengths are coming.` : `${name} +10% → ${pct(up)} · −10% → ${pct(down)}. Pays funding every second you hold it.`;
}
$("p").addEventListener("input", () => { renderStrength(); renderPreview(); });

// ── amount + preview ──
const amount = () => { const v = Number(String($("amt").value).replace(",", ".")); return isFinite(v) && v > 0 ? v : 0; };
function cash() { return mode === "demo" ? demo.balance : Number(live?.cash?.() ?? 0n) / E6; }
function renderPreview() {
  const a = amount(), p = P(), net = a * 0.997;
  let rows = [];
  if (a > 0) {
    rows = [["If price +10%", `${fmt(net * 1.1 ** p)} (${pct(1.1 ** p * 0.997 - 1)})`], ["If price +25%", `${fmt(net * 1.25 ** p)} (${pct(1.25 ** p * 0.997 - 1)})`], ["If price −10%", `${fmt(net * 0.9 ** p)} (${pct(0.9 ** p * 0.997 - 1)})`]];
    if (mode === "demo") rows.push(["Melts if flat", `${pct(-demo.meltPerMinute(p))} per minute`]);
    else if (live?.state?.market) { const f = live.state.market.funding_rate_annual_bps / 1e4; rows.push(["Funding now", `${fmt(net * f / 365)}/day (${Math.round(f * 100)}%/yr)`]); }
  }
  $("preview").innerHTML = rows.map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join("");
  let err = "";
  if (mode === "live" && !live?.connected) err = "";
  else if (a > cash() + 1e-9) err = mode === "demo" ? "More than your play money." : "Not enough balance. Tap your balance to add money.";
  else if (mode === "live" && p !== live?.cfg?.power) err = `Pick ${live?.cfg?.power}× for the live market.`;
  else if (mode === "live" && live?.state?.market && a > Number(live.state.market.max_long_open) / E6) err = `Largest buy right now is ${fmt(Number(live.state.market.max_long_open) / E6)}.`;
  $("buyErr").textContent = err;
  $("buy").disabled = !a || !!err || busy || (mode === "live" && !live?.connected);
  $("buy").textContent = a ? `Buy ${fmt(a)} at ${p}×` : "Buy";
}
$("amt").addEventListener("input", renderPreview);
document.querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => { const v = b.dataset.a; $("amt").value = v === "max" ? Math.floor(cash() * 100) / 100 : v; renderPreview(); }));

// ── DEMO: fast-forward replay ──
let playing = null; // { stop }
function loadDemoChart() { chart.set(demo.history()); chart.mark(null); $("px").textContent = fmtP(chart.price()); $("chg").textContent = ""; }
async function demoBuy() {
  const a = amount(), p = P();
  demo.open(a, p);
  $("amt").value = "";
  chart.mark(demo.position.entry, `your entry ${fmtP(demo.position.entry)}`);
  flip(true); ff(true, "1 day = ⅓ s");
  const future = demo.future(); let i = 0, stopped = false, last = performance.now();
  playing = { stop: () => (stopped = true) };
  const frame = (now) => {
    if (stopped) return;
    chart.step(now); chart.draw();
    const dt = Math.max(0, (now - last) / 1000); last = now;
    const q = demo.update(chart.price(), dt);
    renderPosition();
    if (q?.melted) return demoClose("melted");
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  (async () => { for (; i < future.length && !stopped; i++) await chart.play(future[i], CANDLE_MS); if (!stopped) demoClose("ended"); })();
}
function demoClose(why) {
  if (!demo.position) return;
  playing?.stop(); playing = null;
  const r = demo.close();
  flip(false); ff(false); chart.mark(null);
  const m = r.out / r.stake;
  $("rIco").textContent = r.pnl > 0 ? (m >= 3 ? "🚀" : "🎉") : why === "melted" ? "🫠" : "📉";
  $("rTitle").textContent = r.pnl > 0 ? `+${fmt(r.pnl)}` : r.out > 0 ? `${fmt(r.pnl)}` : `Melted away`;
  $("rText").textContent = (r.out > 0 ? `You turned ${fmt(r.stake)} into ${fmt(r.out)} (×${m.toFixed(2)}) at ${r.p}×. ` : `The price didn't rise fast enough, so the ${r.p}× position melted. That's the time window at work. `)
    + (r.pnl > 0 ? "Closing at the right moment matters: the position keeps melting while you wait." : why === "ended" ? "The replay ended, so the position was closed." : "Try a lower strength or close sooner next time.");
  modal("result");
  $("result").querySelector("[data-close]").onclick = () => {
    modal("result", false); loadDemoChart(); render();
    if (demo.trades === 1 && mode === "demo") pointAtLive();
  };
  render();
}
function pointAtLive() {
  const b = document.querySelector('[data-mode="live"]').getBoundingClientRect(), h = $("hand");
  h.style.left = b.left + b.width / 2 - 40 + "px"; h.style.top = b.bottom + 4 + "px"; h.hidden = false;
  setTimeout(() => (h.hidden = true), 9000);
}
function ff(on, text) { $("ff").hidden = !on; if (text) $("ffText").textContent = text; }
function flip(on) { $("flip").classList.toggle("flipped", on); }

function renderPosition() {
  if (mode === "demo") {
    const q = demo.position; if (!q) return;
    const left = Math.max(0, Math.exp(-Math.log(100) / meltSeconds(q.p) * q.t));
    $("posP").textContent = q.p + "×"; $("posValue").textContent = fmt(q.value); $("posPaid").textContent = fmt(q.stake);
    $("posEntry").textContent = fmtP(q.entry); $("posNow").textContent = fmtP(chart.price()); $("px").textContent = fmtP(chart.price());
    const pnl = q.value - q.stake; $("posPnl").textContent = `${pnl >= 0 ? "+" : "−"}${fmt(Math.abs(pnl))} · ×${(q.value / q.stake).toFixed(2)}`; $("posPnl").className = "num " + (pnl >= 0 ? "pos" : "neg");
    $("meltBar").style.width = left * 100 + "%";
    $("meltNote").textContent = `Time left in the window: ${Math.round(left * 100)}%. The longer you hold, the more it melts.`;
    $("chg").textContent = pct(chart.price() / q.entry - 1, 1) + " since you bought"; $("chg").className = "small num " + (chart.price() >= q.entry ? "pos" : "neg");
    $("balance").textContent = fmt(demo.balance + q.value);
  } else {
    const a = live?.state?.ledgerAcc; if (!a || BigInt(a.long_units) === 0n) return;
    const v = Number(a.long_value) / E6, c = Number(a.long_cost) / E6, m = live.state.market;
    $("posP").textContent = m.power + "×"; $("posValue").textContent = fmt(v); $("posPaid").textContent = fmt(c);
    $("posEntry").textContent = "—"; $("posNow").textContent = fmtP(Number(m.price) / E6);
    $("posPnl").textContent = `${v >= c ? "+" : "−"}${fmt(Math.abs(v - c))} · ×${(v / c).toFixed(2)}`; $("posPnl").className = "num " + (v >= c ? "pos" : "neg");
    const f = m.funding_rate_annual_bps / 1e4; $("meltBar").style.width = Math.max(4, Math.min(100, (1 - f / 10) * 100)) + "%";
    $("meltNote").textContent = `Funding: ${fmt(v * f / 365)} per day (${Math.round(f * 100)}% a year), paid to the Crab vault.`;
  }
}

// ── LIVE ──
async function ensureLive() {
  if (live) return live;
  const { Live } = await import("./live.js");
  live = await new Live().init();
  live.onChange = () => { render(); liveRefresh(); };
  return live;
}
let range = "1d", lastCandleT = 0;
const GRAN = { "1h": 60, "1d": 300, "1w": 3600 };
async function loadLiveChart() {
  try { const rows = await fetch(`/api/history?range=${range}`).then((r) => r.json()); chart.set(rows.slice(-70)); lastCandleT = rows.length ? rows[rows.length - 1][0] : 0; chart.mark(null); } catch {}
  $("mkt").textContent = `${live.cfg.asset} / USD`; $("mktNote").textContent = live.cfg.testnet ? "Live · testnet" : "Live";
}
async function liveRefresh() {
  if (mode !== "live" || !live) return;
  try {
    await live.refresh();
    const p = Number(live.state.market.price) / E6, now = Date.now() / 1000;
    if (now - lastCandleT >= GRAN[range]) { chart.candles.push([p, p, p, p]); lastCandleT = now; chart.draw(); } else chart.tick(p);
    $("px").textContent = fmtP(p);
    const has = live.state.ledgerAcc && BigInt(live.state.ledgerAcc.long_units) > 0n;
    flip(has);
    if (live.kind === "device" && Number(live.cash()) > 0 && !ls.get("uprise.v1.backedUp") && !ls.get("uprise.v1.backupLater")) { modal("backup"); ls.set("uprise.v1.backupLater", "1"); }
    render();
  } catch (e) { console.warn(e); }
}
setInterval(() => { if (!document.hidden) liveRefresh(); }, 8000);
document.querySelectorAll("#ranges .chip").forEach((b) => (b.onclick = () => { range = b.dataset.r; document.querySelectorAll("#ranges .chip").forEach((x) => x.setAttribute("aria-pressed", x === b)); loadLiveChart(); }));

$("createWallet").onclick = () => withBusy($("createWallet"), "Creating your wallet…", async () => { await live.createDevice(); toast(live.cfg.testnet ? "Wallet ready: 1,000 test USDC added" : "Wallet ready. Add money to start."); await liveRefresh(); });
$("connectWallet").onclick = () => withBusy($("connectWallet"), "Opening wallets…", async () => { await live.connectWallet(false); });
$("restoreBtn").onclick = () => modal("restore");
$("rSend").onclick = () => withBusy($("rSend"), "Sending…", async () => { await live.recoverStart($("rEmail").value); toast("If that email has a wallet, a code is on its way"); });
$("rDone").onclick = () => withBusy($("rDone"), "Restoring…", async () => { await live.recoverFinish($("rEmail").value, $("rCode").value); ls.set("uprise.v1.backedUp", "1"); modal("restore", false); toast("Wallet restored"); await liveRefresh(); });
$("bSave").onclick = () => withBusy($("bSave"), "Saving…", async () => { await live.backup($("bEmail").value); ls.set("uprise.v1.backedUp", "1"); modal("backup", false); toast("Recovery email saved"); });

// ── buy / close ──
$("buy").onclick = () => withBusy($("buy"), "Buying…", async () => {
  if (mode === "demo") return demoBuy();
  const a = amount();
  await live.buy(BigInt(Math.floor(a * E6))); $("amt").value = ""; toast(`Bought ${fmt(a)} of Curve Long`); await liveRefresh();
});
$("close").onclick = () => {
  if (mode === "demo") return demoClose("manual");
  withBusy($("close"), "Closing…", async () => { await live.closeAll(); toast("Closed and cashed out"); await liveRefresh(); });
};

// ── CRAB ──
let vMode = "dep";
function renderCrab() {
  $("crabTag").textContent = mode === "demo" ? "demo" : live?.cfg?.testnet ? "live · testnet" : "live";
  if (mode === "demo") {
    const tvl = 250_000 + demo.vault.stake;
    $("vYield").textContent = "+18%"; $("vTvl").textContent = fmt(tvl, 0); $("vFund").textContent = "$124/day"; $("vUtil").textContent = "31%";
    $("vBar").innerHTML = `<i style="width:62%;background:var(--usdc)"></i><i style="width:38%;background:var(--near)"></i>`;
    $("vHedge").textContent = "Demo vault. Your stake grows a day every second while you watch.";
    $("sValue").textContent = fmt(demo.vault.stake); const e = demo.vault.stake - demo.vault.cost; $("sEarned").textContent = (e >= 0 ? "+" : "") + fmt(e); $("sEarned").className = e > 0 ? "pos" : "";
    $("sPendRow").hidden = true; $("vNote").textContent = "";
  } else {
    const st = live?.state || {}, v = st.vault, m = st.market;
    if (!v || !m) return;
    const s = v.snapshot, nav = Number(s.nav) / E6, assetV = Number(v.hedge_value) / E6, usdcV = Math.max(0, nav - assetV);
    const claims = Number(m.long_claims) / E6, share = Number(m.short_shares) > 0 ? Number(s.short_shares) / Number(m.short_shares) : 0;
    const perYear = m.funding_rate_annual_bps / 1e4 * claims * share * 0.9;
    $("vYield").textContent = nav > 0 ? pct(perYear / nav, 1) : "—"; $("vTvl").textContent = fmt(nav, 0); $("vFund").textContent = fmt(perYear / 365) + "/day"; $("vUtil").textContent = (m.utilization_bps / 100).toFixed(0) + "%";
    const tot = Math.max(1e-9, usdcV + assetV);
    $("vBar").innerHTML = `<i style="width:${usdcV / tot * 100}%;background:var(--usdc)"></i><i style="width:${assetV / tot * 100}%;background:var(--near)"></i>`;
    $("vHedge").textContent = `${live.cfg.asset} balance ${fmt(assetV, 0)} of ${fmt(Number(s.hedge_target_usd) / E6, 0)} target. Rebalanced by the keeper, updated ${v.snapshot_age_secs}s ago.`;
    const pos = st.pos;
    if (pos) {
      const val = Number(pos.value) / E6, cost = Number(ls.get("uprise.v1.vaultIn") || 0);
      $("sValue").textContent = fmt(val); $("sEarned").textContent = cost ? (val - cost >= 0 ? "+" : "") + fmt(val - cost) : "—";
      const pend = Number(pos.pending_deposit) / E6, pw = Number(pos.pending_withdraw_shares) * Number(v.share_price_e6) / E6 / E6;
      $("sPendRow").hidden = !(pend || pw); $("sPend").textContent = [pend ? `+${fmt(pend)} in` : "", pw ? `${fmt(pw)} out` : ""].filter(Boolean).join(" · ");
    }
    $("vNote").textContent = "Deposits and withdrawals settle at the next vault update, usually within a minute.";
  }
  const a = vAmount(); let err = "";
  if (mode === "live" && !live?.connected) err = "Create or connect a wallet on the Bull tab first.";
  else if (vMode === "dep" && a > (mode === "demo" ? demo.balance : Number(live.state.usdc) / E6) + 1e-9) err = "More than you have.";
  $("vErr").textContent = err; $("vBtn").disabled = !a || !!err || busy; $("vBtn").textContent = (vMode === "dep" ? "Deposit" : "Withdraw") + (a ? " " + fmt(a) : "");
}
const vAmount = () => { const v = Number(String($("vAmt").value).replace(",", ".")); return isFinite(v) && v > 0 ? v : 0; };
$("vAmt").addEventListener("input", renderCrab);
document.querySelectorAll("#vSeg button").forEach((b) => (b.onclick = () => { vMode = b.dataset.v; document.querySelectorAll("#vSeg button").forEach((x) => x.setAttribute("aria-selected", x === b)); renderCrab(); }));
document.querySelectorAll("[data-va]").forEach((b) => (b.onclick = () => {
  const x = b.dataset.va;
  $("vAmt").value = x !== "max" ? x : Math.floor((mode === "demo" ? (vMode === "dep" ? demo.balance : demo.vault.stake) : vMode === "dep" ? Number(live.state.usdc) / E6 : Number(live.state.pos?.value || 0) / E6) * 100) / 100;
  renderCrab();
}));
$("vBtn").onclick = () => withBusy($("vBtn"), vMode === "dep" ? "Depositing…" : "Withdrawing…", async () => {
  const a = vAmount();
  if (mode === "demo") { vMode === "dep" ? demo.vaultDeposit(a) : demo.vaultWithdraw(a); toast(vMode === "dep" ? `${fmt(a)} is now earning` : `${fmt(a)} back in your balance`); }
  else if (vMode === "dep") { await live.vaultDeposit(BigInt(Math.floor(a * E6))); ls.set("uprise.v1.vaultIn", String(Number(ls.get("uprise.v1.vaultIn") || 0) + a)); toast(`Deposit of ${fmt(a)} queued`); }
  else { const pps = Number(live.state.vault.share_price_e6) / E6, all = a >= Number(live.state.pos.value) / E6 - 0.01; await live.vaultWithdraw(all ? null : Math.floor(a / pps * E6)); toast(`Withdrawal of ${fmt(a)} queued`); }
  $("vAmt").value = ""; if (mode === "live") await liveRefresh();
});
let crabTimer = 0;
setInterval(() => { // demo vault: one day per second while you watch
  const on = mode === "demo" && tab === "crab" && demo.vault.stake > 0;
  if (on) { demo.vaultAccrue(1); crabTimer++; if (crabTimer % 5 === 0) demo.save(); render(); }
  if (tab === "crab" && !demo.position) ff(on, "1 day = 1 s");
}, 1000);

// ── WALLET SHEET ──
$("walletBtn").onclick = () => { renderWallet(); modal("wallet"); };
function renderWallet() {
  $("wDemo").hidden = mode !== "demo"; $("wLive").hidden = mode !== "live";
  if (mode !== "live" || !live) return;
  const st = live.state || {};
  $("wAcct").textContent = live.accountId || "not connected"; $("addr").textContent = live.accountId || "—";
  $("wUsdc").textContent = fmt(Number(st.usdc || 0n) / E6); $("wFree").textContent = fmt(Number(st.ledgerAcc?.free || 0) / E6);
  $("wGas").textContent = live.kind === "device" ? "paid by Uprise" : "your wallet";
  $("faucet").hidden = !live.cfg.testnet || !live.connected || live.kind !== "device";
  $("xBtn").disabled = live.cfg.testnet; $("xHint").textContent = live.cfg.testnet ? "Cross-chain deposits through NEAR Intents run on mainnet. On testnet, use the test USDC button." : "Pay with USDC, ETH, SOL or BTC from another chain. NEAR Intents swaps it and delivers USDC here.";
  $("secHint").textContent = live.kind === "device" ? "Your key lives on this device. Save a recovery email so you can't lose it." : "You're signed in with your NEAR wallet. Your keys stay in your wallet.";
  $("backupOpen").hidden = $("showKey").hidden = live.kind !== "device";
}
document.querySelectorAll("#wSeg button").forEach((b) => (b.onclick = () => { document.querySelectorAll("#wSeg button").forEach((x) => x.setAttribute("aria-selected", x === b)); document.querySelectorAll("[data-wpane]").forEach((p) => (p.hidden = p.dataset.wpane !== b.dataset.w)); }));
$("demoReset").onclick = () => { if (demo.position) demoClose("manual"); demo.reset(); loadDemoChart(); render(); modal("wallet", false); toast("Play money reset to $1,000"); };
$("faucet").onclick = () => withBusy($("faucet"), "Minting…", async () => { await live.faucet(); toast("1,000 test USDC added"); await liveRefresh(); renderWallet(); });
$("copy").onclick = async () => { try { await navigator.clipboard.writeText(live.accountId); toast("Address copied"); } catch { toast("Select the address and copy it", true); } };
$("sendBtn").onclick = () => withBusy($("sendBtn"), "Sending…", async () => { const to = $("sTo").value.trim(), a = Number($("sAmt").value); if (!to || !(a > 0)) throw new Error("Enter a receiver and an amount"); await live.send(to, BigInt(Math.floor(a * E6))); toast(`Sent ${fmt(a)}`); await liveRefresh(); });
$("backupOpen").onclick = () => { modal("wallet", false); modal("backup"); };
$("showKey").onclick = () => { $("keyOut").hidden = false; $("keyOut").textContent = live.secret(); };
$("disconnect").onclick = async () => { if (live.kind === "device" && !ls.get("uprise.v1.backedUp") && !confirm("Without a recovery email or a saved key, signing out loses this wallet. Sign out anyway?")) return; await live.disconnect(); modal("wallet", false); render(); };
const ASSETS = [["USDC on Ethereum", "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", 6], ["USDC on Solana", "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", 6], ["USDC on Base", "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", 6], ["USDC on Arbitrum", "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", 6], ["ETH", "nep141:eth.omft.near", 18], ["SOL", "nep141:sol.omft.near", 9], ["BTC", "nep141:btc.omft.near", 8]];
$("xAsset").innerHTML = ASSETS.map(([n], i) => `<option value="${i}">${n}</option>`).join("");
$("xBtn").onclick = () => withBusy($("xBtn"), "Asking NEAR Intents…", async () => {
  const [name, asset, dec] = ASSETS[+$("xAsset").value], a = Number($("xAmt").value); if (!(a > 0)) throw new Error("Enter an amount");
  const raw = BigInt(Math.round(a * 10 ** Math.min(dec, 9))) * 10n ** BigInt(Math.max(0, dec - 9));
  const r = await live.depositAddress(asset, String(raw));
  $("xOut").hidden = false; $("xOut").textContent = `Send ${a} ${name} to ${r.quote?.depositAddress || r.depositAddress}. USDC arrives in this wallet within minutes.`;
});

// ── tabs + mode ──
document.querySelectorAll("nav.tabs button").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
function setTab(t) {
  tab = t;
  document.querySelectorAll("nav.tabs button").forEach((x) => x.setAttribute("aria-selected", x.dataset.tab === t));
  for (const k of ["bull", "crab", "stats"]) $("tab-" + k).hidden = k !== t;
  if (t === "crab" && !ls.get("uprise.v1.crabSeen")) { modal("crabIntro"); ls.set("uprise.v1.crabSeen", "1"); }
  if (t === "stats") { arena.start(mode, live); $("arenaTag").textContent = mode; $("arenaNote").textContent = mode === "demo" ? "A simulated crowd: bulls buy curves (gold), pay premium (purple) into the vault, and hunters deposit (orange bars)." : "Real accounts from the ledger. Coins show the changes between updates every 8 seconds, so they're an approximation of the on-chain flows."; }
  else arena.stop();
  if (t !== "crab" && !demo.position) ff(false);
  render(); chart.draw();
}
document.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
async function setMode(m) {
  $("hand").hidden = true;
  if (m === mode && (m === "demo" || live)) return;
  if (demo.position) demoClose("manual");
  mode = m; ls.set("uprise.mode", m);
  document.querySelectorAll("[data-mode]").forEach((x) => x.setAttribute("aria-selected", x.dataset.mode === m));
  $("ranges").hidden = m !== "live";
  if (m === "demo") { $("mkt").textContent = "Demo market"; $("mktNote").textContent = "Demo replay of real history"; $("assetLabel").textContent = "play money"; loadDemoChart(); flip(false); }
  else {
    try { await ensureLive(); } catch (e) { toast("Live mode can't reach the network: " + e.message, true); return setMode("demo"); }
    $("assetLabel").textContent = `on ${live.cfg.asset}`; $("p").value = live.cfg.power; await loadLiveChart(); await liveRefresh();
  }
  if (tab === "stats") arena.start(mode, live);
  renderStrength(); render();
}

function render() {
  const liveNoWallet = mode === "live" && !live?.connected;
  $("liveStart").hidden = !liveNoWallet;
  $("balLabel").textContent = mode === "demo" ? "Play money" : live?.connected ? "Balance" : "Not signed in";
  if (mode === "demo") $("balance").textContent = fmt(demo.balance + (demo.position?.value || 0));
  else $("balance").textContent = live?.connected ? fmt(Number(live.cash()) / E6) : "—";
  renderPreview(); renderPosition();
  if (tab === "crab") renderCrab();
}

// ── start ──
(async () => {
  const snippets = await fetch("demo-snippets.json").then((r) => r.json());
  demo = new Demo(snippets);
  document.querySelectorAll("[data-mode]").forEach((x) => x.setAttribute("aria-selected", x.dataset.mode === mode));
  renderStrength();
  if (mode === "live") await setMode("live"); else { mode = "demo"; await setMode("demo").catch(() => {}); loadDemoChart(); $("mkt").textContent = "Demo market"; }
  render();
  if (!ls.get("uprise.v1.onboarded")) showOnboarding($("onboarding"), () => { ls.set("uprise.v1.onboarded", "1"); $("amt").focus(); });
})();
