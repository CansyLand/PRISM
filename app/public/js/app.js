import { CandleChart, fmtP } from "./candles.js";
import { Demo, CANDLE_MS, timeLeft } from "./demo.js";
import { showOnboarding } from "./onboarding.js";
import { Arena } from "./analytics.js";
import { CurveCard } from "./curvecard.js";
import { css, fit, pw } from "./theme.js";
import { crabIntro } from "./crabintro.js";

const $ = (id) => document.getElementById(id);
const E6 = 1e6;
const fmt = (v, d = 2) => (v < 0 ? "−" : "") + "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v, d = 0) => (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(d) + "%";
try { if (new URLSearchParams(location.search).has("fresh")) { ["uprise.v1.onboarded", "uprise.v1.crabSeen", "uprise.demo.v2", "uprise.mode"].forEach((k) => localStorage.removeItem(k)); history.replaceState(null, "", location.pathname); } } catch {}
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

let mode = ls.get("uprise.mode") || "demo", tab = "bull", live = null, demo = null, busy = false;
const chart = new CandleChart($("candles"));
const arena = new Arena($("arena"));
crabIntro($("crabIntro"));
const curve = new CurveCard($("curveCv"));

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
  $("pLabel").textContent = pw(p);
  const mismatch = mode === "live" && live?.cfg && p !== live.cfg.power;
  $("pNote").textContent = mismatch ? `The live market offers ${pw(live.cfg.power)} right now. More strengths are coming.` : "";
  $("pNote").hidden = !mismatch;
  showCurve(p);
}
// the slim card follows the slider, or the open position (with a dot at today's price move)
function showCurve(p, at = null) {
  curve.set(p, at);
  $("ccP").textContent = pw(p);
}
$("p").addEventListener("input", () => { renderStrength(); renderPreview(); });

// ── amount + preview ──
const amount = () => { const v = Number(String($("amt").value).replace(",", ".")); return isFinite(v) && v > 0 ? v : 0; };
function cash() { return mode === "demo" ? demo.balance : Number(live?.cash?.() ?? 0n) / E6; }
function renderPreview() {
  const a = amount(), p = P(), net = a * 0.997;
  let rows = [];
  if (a > 0) {
    if (mode === "live" && live?.state?.market) { const f = live.state.market.funding_rate_annual_bps / 1e4; rows.push(["Funding now", `${fmt(net * f / 365)}/day (${Math.round(f * 100)}%/yr)`]); }
  }
  $("preview").innerHTML = rows.map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join("");
  let err = "";
  if (mode === "live" && !live?.connected) err = "";
  else if (a > cash() + 1e-9) err = mode === "demo" ? "More than your play money." : "Not enough balance. Tap your balance to add money.";
  else if (mode === "live" && p !== live?.cfg?.power) err = `Pick ${pw(live?.cfg?.power)} for the live market.`;
  else if (mode === "live" && live?.state?.market && a > Number(live.state.market.max_long_open) / E6) err = `Largest buy right now is ${fmt(Number(live.state.market.max_long_open) / E6)}.`;
  $("buyErr").textContent = err;
  $("buy").disabled = !a || !!err || busy || (mode === "live" && !live?.connected);
  $("buy").textContent = a ? `Buy ${fmt(a, a % 1 ? 2 : 0)}` : "Buy";
}
$("amt").addEventListener("input", renderPreview);
document.querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => { const v = b.dataset.a; $("amt").value = v === "max" ? Math.floor(cash() * 100) / 100 : v; renderPreview(); }));

// ── DEMO: fast-forward replay ──
// One continuous market: each trade plays the next history snippet scaled to start at the last price.
let playing = null, trail = []; // { stop }, samples { m: market move, v: position move } while open
function loadDemoChart() { chart.set(demo.history()); chart.mark(null); $("px").textContent = fmtP(chart.price()); $("chg").textContent = ""; }
async function demoBuy() {
  const a = amount(), p = P();
  demo.open(a, p);
  $("amt").value = "";
  const entry = demo.position.entry;
  chart.mark(entry, `your entry ${fmtP(entry)}`);
  flip(true); ff(true);
  const future = demo.future(), wick = demo.wickAt(); let i = 0, stopped = false, last = performance.now(), lastS = 0, wickShown = false;
  trail = [{ m: 0, v: demo.position.value / demo.position.stake - 1 }];
  playing = { stop: () => (stopped = true) };
  const frame = (now) => {
    if (stopped) return;
    chart.step(now); chart.draw();
    const dt = Math.max(0, (now - last) / 1000); last = now;
    const px = chart.price(), q = demo.update(px, dt);
    if (now - lastS > 80 && Number.isFinite(px)) { trail.push({ m: px / entry - 1, v: q.value / q.stake - 1 }); lastS = now; }
    if (!wickShown && i === wick && px < future[i][0] * 0.88) { wickShown = true; wickHint(); }
    renderPosition();
    if (q?.melted) return demoClose("melted");
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  (async () => { for (; i < future.length && !stopped; i++) await chart.play(future[i], CANDLE_MS); if (!stopped) demoClose("ended"); })();
}
// a deep wick (20% down inside one candle): leveraged perps get wiped out by these, a Curve Long stays open
function wickHint() { toast("Wick −20%! Dips like this liquidate leveraged perps. Your Curve Long is still open."); }
function demoClose(why) {
  if (!demo.position) return;
  playing?.stop(); playing = null;
  chart.freeze();
  const exitPx = chart.price(), r = demo.close(exitPx);
  const m = r.out / r.stake, melted = why === "melted";
  trail.push({ m: exitPx / r.entry - 1, v: m - 1 });
  flip(false); ff(false); chart.mark(null); renderStrength();
  $("rIco").textContent = r.pnl > 0 ? (m >= 3 ? "🚀" : "🎉") : melted ? "🫠" : "☠️";
  $("rTitle").textContent = r.out > 0 ? pct(m - 1, 0) : "Melt Down"; $("rTitle").className = r.out > 0 ? (m >= 1 ? "pos" : "neg") : "neg";
  lastResult = { pts: trail.slice(), p: r.p, melted, out: r.out, mult: m, move: exitPx / r.entry - 1 };
  $("result").querySelector(".modal").className = "modal r-card " + (r.out > 0 && m >= 1 ? "win" : "lose");
  modal("result"); drawResult($("rChart"), trail, r.p, melted);
  $("rText").textContent = r.out > 0 ? (r.pnl <= 0 && why === "ended" ? "The replay ended, so the position was closed." : "")
    : `The price didn't rise fast enough before the ${pw(r.p)} timer ran out.`;
  $("result").querySelector("[data-close]").onclick = () => {
    modal("result", false); $("px").textContent = fmtP(chart.price()); $("chg").textContent = ""; render();
    if (demo.trades === 1 && mode === "demo") pointAtLive();
  };
  render();
}
// result chart: the market as gray candles and your curve, both in % on ONE scale, so +45% vs +3000%
// looks like it is. The curve is green while in profit and red while under; a melt down fades to gray.
function drawResult(cv, pts, p, melted) { const f = fit(cv); if (f) paintResult(f.ctx, f.W, f.H, pts, p, melted); }
function paintResult(ctx, W, H, pts, p, melted, big = 1) {
  if (pts.length < 2) return;
  const R = W - 58 * big, n = pts.length, X = (i) => 6 + i / (n - 1) * (R - 6);
  let lo = 0, hi = 0; for (const s of pts) { lo = Math.min(lo, s.m, s.v); hi = Math.max(hi, s.m, s.v); }
  const pad = (hi - lo) * 0.06 || 0.05; lo -= pad; hi += pad;
  const top = 44 * big, Y = (v) => top + (hi - v) / (hi - lo) * (H - top - 6);
  ctx.setLineDash([3, 3]); ctx.strokeStyle = css("--line"); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(6, Y(0)); ctx.lineTo(R, Y(0)); ctx.stroke(); ctx.setLineDash([]);
  const per = Math.max(1, Math.ceil(n / 28)), cw = (R - 6) / Math.ceil(n / per);
  for (let k = 0; k < n; k += per) {
    const g = pts.slice(k, k + per + 1).map((s) => s.m), o = g[0], c = g.at(-1), h = Math.max(...g), l = Math.min(...g), cx = X(Math.min(n - 1, k + per / 2));
    ctx.strokeStyle = ctx.fillStyle = css(c >= o ? "--muted" : "--line");
    ctx.lineWidth = big; ctx.beginPath(); ctx.moveTo(cx, Y(h)); ctx.lineTo(cx, Y(l)); ctx.stroke();
    ctx.fillRect(cx - cw * 0.3, Y(Math.max(o, c)), cw * 0.6, Math.max(big, Y(Math.min(o, c)) - Y(Math.max(o, c))));
  }
  const up = css("--up"), down = css("--down"), gray = css("--muted");
  ctx.lineWidth = 3.2 * big; ctx.lineCap = "round";
  for (let i = 1; i < n; i++) {
    const a = pts[i - 1], b = pts[i], base = (a.v + b.v) / 2 >= 0 ? up : down, fade = melted ? Math.round(100 - 85 * (i / (n - 1))) : 100;
    ctx.strokeStyle = fade < 100 ? `color-mix(in srgb, ${base} ${fade}%, ${gray})` : base;
    ctx.beginPath(); ctx.moveTo(X(i - 1), Y(a.v)); ctx.lineTo(X(i), Y(b.v)); ctx.stroke();
  }
  // "x¹⁰ / curve" above the start
  const sy = Math.max(top - 6 * big, Y(pts[0].v) - 16 * big);
  ctx.fillStyle = up; ctx.textAlign = "left";
  ctx.font = `800 ${20 * big}px ${css("--font")}`; ctx.fillText(pw(p), 8, sy - 14 * big);
  ctx.font = `700 ${11 * big}px ${css("--font")}`; ctx.fillText("curve", 9, sy);
  const end = pts.at(-1), endCol = melted ? gray : end.v >= 0 ? up : down, yv = Y(end.v), ym = Y(end.m), apart = Math.abs(ym - yv) < 14 * big ? (yv < ym ? -7 : 7) * big : 0;
  ctx.font = `700 ${12 * big}px ${css("--mono")}`;
  ctx.fillStyle = endCol; ctx.beginPath(); ctx.arc(X(n - 1), yv, 4.5 * big, 0, 7); ctx.fill();
  ctx.fillText(pct(end.v, 0), R + 8 * big, yv + 4 * big + apart);
  ctx.fillStyle = gray; ctx.fillText(pct(end.m, 0), R + 8 * big, ym + 4 * big - apart);
  if (melted) {
    const x = X(n - 1); ctx.strokeStyle = down; ctx.lineWidth = 2.5 * big; ctx.beginPath(); ctx.moveTo(x, 6); ctx.lineTo(x, H - 6); ctx.stroke();
    ctx.fillStyle = down; ctx.font = `800 ${11 * big}px ${css("--font")}`; ctx.textAlign = "right"; ctx.fillText("MELT DOWN", x - 6 * big, 16 * big);
  }
}
// Share: draw a 1200×675 image (the X card size). Phones get the share sheet with the image; desktop
// downloads it and opens a prepared X post (X's web share link can't carry an image).
let lastResult = null;
function shareCanvas(r) {
  const W = 1200, H = 675, cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d"), win = r.out > 0 && r.mult >= 1, tint = css(win ? "--up" : "--down");
  const g = ctx.createRadialGradient(W * 0.25, 0, 0, W * 0.25, 0, W * 0.9); g.addColorStop(0, `color-mix(in srgb, ${tint} 22%, ${css("--panel")})`); g.addColorStop(0.7, css("--panel")); g.addColorStop(1, css("--bg"));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = css("--accent"); ctx.font = `800 34px ${css("--font")}`; ctx.textAlign = "left"; ctx.fillText("⇡ Uprise", 56, 86);
  ctx.fillStyle = win ? css("--up") : css("--down"); ctx.font = `800 110px ${css("--mono")}`; ctx.fillText(r.out > 0 ? pct(r.mult - 1, 0) : "Melt Down", 56, 250);
  ctx.fillStyle = css("--muted"); ctx.font = `600 30px ${css("--font")}`; ctx.fillText(`market ${pct(r.move, 0)} · ${pw(r.p)} curve`, 60, 306);
  ctx.font = `600 24px ${css("--font")}`; ctx.fillText("No liquidation. Just a curve. · uprise.wtf", 60, H - 52);
  ctx.save(); ctx.translate(500, 110); paintResult(ctx, 660, 470, r.pts, r.p, r.melted, 1.7); ctx.restore();
  return cv;
}
window.uprise = { shareCanvas: () => lastResult && shareCanvas(lastResult) }; // for checking the share image
async function shareResult() {
  const r = lastResult; if (!r) return;
  const cv = shareCanvas(r), win = r.out > 0 && r.mult >= 1;
  const blob = await new Promise((ok) => cv.toBlob(ok, "image/png")), file = new File([blob], "uprise-trade.png", { type: "image/png" });
  const text = r.out > 0 ? `Market ${pct(r.move, 0)}.\nMy ${pw(r.p)} curve: ${pct(r.mult - 1, 0)} ${win ? "🚀" : ""}\n\nNo liquidation, just a curve.\n\nuprise.wtf` : `Melt Down 🫠 My ${pw(r.p)} curve ran out of time.\n\nuprise.wtf`;
  try { if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], text }); return; } } catch (e) { if (e.name === "AbortError") return; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "uprise-trade.png"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  window.open("https://x.com/intent/post?text=" + encodeURIComponent(text), "_blank", "noopener");
  toast("Image saved. Attach it to your post.");
}
$("rShare").onclick = () => shareResult().catch((e) => toast(String(e.message || e), true));
function pointAtLive() {
  const b = document.querySelector('[data-mode="live"]').getBoundingClientRect(), h = $("hand");
  h.style.left = b.left + b.width / 2 - 40 + "px"; h.style.top = b.bottom + 4 + "px"; h.hidden = false;
  setTimeout(() => (h.hidden = true), 9000);
}
// your vault stake over time: green area, dashed line = what you put in, the crab walks at the head
function drawStake(cv, hist, cost) {
  const f = fit(cv); if (!f || hist.length < 2) return; const { ctx, W, H } = f;
  const step = Math.max(1, Math.floor(hist.length / 200)), pts = hist.filter((_, i) => i % step === 0 || i === hist.length - 1);
  let lo = Math.min(cost, ...pts), hi = Math.max(cost, ...pts); const pad = (hi - lo) * 0.15 || 1; lo -= pad; hi += pad * 1.6;
  const X = (i) => 2 + i / (pts.length - 1) * (W - 34), Y = (v) => 18 + (hi - v) / (hi - lo) * (H - 34);
  ctx.beginPath(); pts.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.lineTo(X(pts.length - 1), H - 16); ctx.lineTo(X(0), H - 16); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, `color-mix(in srgb, ${css("--up")} 35%, transparent)`); g.addColorStop(1, "transparent");
  ctx.fillStyle = g; ctx.fill();
  ctx.setLineDash([3, 3]); ctx.strokeStyle = css("--muted"); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, Y(cost)); ctx.lineTo(W, Y(cost)); ctx.stroke(); ctx.setLineDash([]);
  ctx.beginPath(); pts.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)))); ctx.strokeStyle = css("--up"); ctx.lineWidth = 2.2; ctx.lineJoin = "round"; ctx.stroke();
  const ex = X(pts.length - 1), ey = Y(pts.at(-1));
  ctx.font = "20px sans-serif"; ctx.textAlign = "center"; ctx.fillText("🦀", ex + 2, ey + 4);
  ctx.font = `600 10px ${css("--font")}`; ctx.fillStyle = css("--muted"); ctx.textAlign = "left";
  ctx.fillText("start", 2, H - 3); ctx.textAlign = "right"; ctx.fillText("today", W - 2, H - 3); ctx.fillText(`you put in ${fmt(cost, 0)}`, W - 30, Y(cost) + 13);
}
function ff(on) { $("ff").hidden = !on; }
function flip(on) { $("flip").classList.toggle("flipped", on); }

// While a trade runs the price moves every frame (each candle walks open → wick → wick → close in ⅓ s).
// The numbers show an eased value (about ¼ s behind) and are repainted ~8 times a second, so they're readable.
let shown = null;
function renderPosition() {
  if (mode === "demo") {
    const q = demo.position; if (!q) { shown = null; return; }
    const now = performance.now(), rawPx = chart.price();
    if (!shown || shown.q !== q) shown = { q, v: q.value, px: rawPx, t: now, paint: 0 };
    const k = 1 - Math.exp(-(now - shown.t) / 250); shown.t = now;
    shown.v += (q.value - shown.v) * k; shown.px += (rawPx - shown.px) * k;
    if (now - shown.paint < 120) return; shown.paint = now;
    const v = shown.v, px = shown.px;
    showCurve(q.p, px / q.entry - 1);
    const left = timeLeft(q.p, q.t);
    $("posP").textContent = pw(q.p); $("posValue").textContent = fmt(v); $("posPaid").textContent = fmt(q.stake);
    $("posEntry").textContent = fmtP(q.entry); $("posNow").textContent = fmtP(px); $("px").textContent = fmtP(px);
    const pnl = v - q.stake; $("posPnl").textContent = `${pnl >= 0 ? "+" : "−"}${fmt(Math.abs(pnl))} · ×${(v / q.stake).toFixed(2)}`; $("posPnl").className = "num " + (pnl >= 0 ? "pos" : "neg");
    $("meltBar").style.width = left * 100 + "%";
    $("meltNote").textContent = `Time left in the window: ${Math.round(left * 100)}%. The longer you hold, the more it melts.`;
    $("chg").textContent = pct(px / q.entry - 1, 1) + " since you bought"; $("chg").className = "small num " + (px >= q.entry ? "pos" : "neg");
    $("balance").textContent = fmt(demo.balance + v);
  } else {
    const a = live?.state?.ledgerAcc; if (!a || BigInt(a.long_units) === 0n) return;
    const v = Number(a.long_value) / E6, c = Number(a.long_cost) / E6, m = live.state.market;
    showCurve(m.power);
    $("posP").textContent = pw(m.power); $("posValue").textContent = fmt(v); $("posPaid").textContent = fmt(c);
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
    $("vYield").textContent = "+18%"; $("vTvl").textContent = fmt(tvl, 0); $("vFund").textContent = "$124/day";
    $("vBar").innerHTML = `<i style="width:62%;background:var(--usdc)"></i><i style="width:38%;background:var(--near)"></i>`;
    $("stakeCv").parentElement.hidden = false; drawStake($("stakeCv"), demo.vault.hist, demo.vault.cost);
    const mo = demo.vault.days / 30.44; $("sSince").textContent = mo >= 1 ? `${mo.toFixed(mo < 10 ? 1 : 0)} months in` : "";
    $("vHedge").textContent = "";
    $("sValue").textContent = fmt(demo.vault.stake); const e = demo.vault.stake - demo.vault.cost; $("sEarned").textContent = (e >= 0 ? "+" : "") + fmt(e); $("sEarned").className = e > 0 ? "pos" : "";
    $("sPendRow").hidden = true; $("vNote").textContent = "";
  } else {
    const st = live?.state || {}, v = st.vault, m = st.market;
    $("stakeCv").parentElement.hidden = true; $("sSince").textContent = "";
    if (!v || !m) return;
    const s = v.snapshot, nav = Number(s.nav) / E6, assetV = Number(v.hedge_value) / E6, usdcV = Math.max(0, nav - assetV);
    const claims = Number(m.long_claims) / E6, share = Number(m.short_shares) > 0 ? Number(s.short_shares) / Number(m.short_shares) : 0;
    const perYear = m.funding_rate_annual_bps / 1e4 * claims * share * 0.9;
    $("vYield").textContent = nav > 0 ? pct(perYear / nav, 1) : "—"; $("vTvl").textContent = fmt(nav, 0); $("vFund").textContent = fmt(perYear / 365) + "/day";
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
  $("vErr").textContent = err; $("vBtn").disabled = busy; $("vBtn").classList.toggle("soft", !a || !!err); $("vBtn").textContent = (vMode === "dep" ? "Deposit" : "Withdraw") + (a ? " " + fmt(a) : "");
}
const vAmount = () => { const v = Number(String($("vAmt").value).replace(",", ".")); return isFinite(v) && v > 0 ? v : 0; };
$("vAmt").addEventListener("input", renderCrab);
document.querySelectorAll("#vSeg button").forEach((b) => (b.onclick = () => { vMode = b.dataset.v; document.querySelectorAll("#vSeg button").forEach((x) => x.setAttribute("aria-selected", x === b)); renderCrab(); }));
document.querySelectorAll("[data-va]").forEach((b) => (b.onclick = () => {
  const x = b.dataset.va;
  $("vAmt").value = x !== "max" ? x : Math.floor((mode === "demo" ? (vMode === "dep" ? demo.balance : demo.vault.stake) : vMode === "dep" ? Number(live.state.usdc) / E6 : Number(live.state.pos?.value || 0) / E6) * 100) / 100;
  renderCrab();
}));
// always clickable: with no amount it jumps to the input, with a problem it says so
$("vBtn").onclick = () => {
  if (!vAmount()) { $("vAmt").focus(); return; }
  if ($("vErr").textContent) { toast($("vErr").textContent, true); return; }
  vSubmit();
};
const vSubmit = () => withBusy($("vBtn"), vMode === "dep" ? "Depositing…" : "Withdrawing…", async () => {
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
  if (t === "stats") { arena.start(mode, live); $("arenaTag").textContent = mode; $("arenaNote").hidden = mode === "demo"; $("arenaNote").textContent = "Real accounts from the ledger, refreshed every 8 seconds. Coins show what changed between updates."; }
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
  const intro = () => showOnboarding($("onboarding"), () => { ls.set("uprise.v1.onboarded", "1"); $("amt").focus(); });
  $("helpBtn").onclick = () => (tab === "crab" ? modal("crabIntro") : intro());
  $("crabHelp").onclick = () => modal("crabIntro");
  if (!ls.get("uprise.v1.onboarded")) intro();
})();
