import { CandleChart, fmtP } from "./candles.js";
import { Demo, CANDLE_MS, timeLeft, meltSeconds } from "./demo.js";
import { supernova } from "./celebrate.js";
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
// Live: one bucket per strength, x¹…x¹⁰, all open. Each has its own funding rate, max buy and position.
const bucketOf = (p) => live?.state?.market?.buckets?.[p - 1];
const heldLongs = () => (mode === "live" ? live?.state?.ledgerAcc?.longs || [] : []);
const heldLong = (p) => heldLongs().find((l) => l.power === p);
// rewrite only on change: the position card repaints several times a second and a replaced link would swallow taps
const setHTML = (el, html) => { if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; } };
let browseBuy = false; // live: show the buy side even though the selected strength has a position (to add to it or pick another)
const showsPosition = (p) => !!heldLong(p) && !browseBuy;
// position face: the other strengths you hold (tap to switch) and a way back to the slider
function renderOthers(p) {
  const others = heldLongs().filter((l) => l.power !== p);
  $("posOthers").hidden = mode !== "live" || !others.length; // only the other positions you hold, no "buy another" link
  setHTML($("posOthers"), others.length ? "Also: " + others.map((l) => `<a href="#" data-pick="${l.power}">${pw(l.power)} ${fmt(Number(l.value) / E6)}</a>`).join(", ") : "");
}
function renderStrength() {
  const p = P();
  $("pLabel").textContent = pw(p);
  // positions in other strengths: one tap switches the slider to them
  const others = heldLongs().filter((l) => l.power !== p);
  setHTML($("pNote"), others.length ? "You also hold " + others.map((l) => `<a href="#" data-pick="${l.power}">${pw(l.power)} ${fmt(Number(l.value) / E6)}</a>`).join(", ") : "");
  $("pNote").hidden = !others.length;
  showCurve(p); renderFunding(); paintSlider();
}
for (const id of ["pNote", "posOthers"]) $(id).addEventListener("click", (e) => {
  const a = e.target.closest("[data-pick],[data-buy]"); if (!a) return;
  e.preventDefault();
  if (a.dataset.buy != null) { browseBuy = true; flip(false); renderStrength(); renderPreview(); return; }
  browseBuy = false; $("p").value = a.dataset.pick; $("p").dispatchEvent(new Event("input"));
});
// the slim card follows the slider, or the open position (with a dot at today's price move)
function showCurve(p, at = null) {
  curve.set(p, at);
  $("ccP").textContent = pw(p);
}
let lastP = +$("p").value;
$("p").addEventListener("input", () => {
  const p = P();
  if (p === 10 && lastP < 10) { const r = $("p").getBoundingClientRect(); supernova(r.left + r.width - 10, r.top + r.height / 2); }
  lastP = p; renderStrength(); renderPreview();
  if (mode === "live" && live?.state?.market) { if (heldLong(p)) browseBuy = false; flip(showsPosition(p)); renderPosition(); }
});
// Funding at the top: what a Curve Long at this strength melts per day. Demo: the straight timer means it
// loses 1/(days in the window) of its curve value every day. Live: the market's current funding rate.
function renderFunding() {
  if (mode === "demo") {
    const p = demo?.position?.p ?? P(), days = meltSeconds(p) / (CANDLE_MS / 1000);
    $("fundLbl").textContent = "funding"; $("fundRate").textContent = `−${(100 / days).toFixed(1)}% day`;
  } else {
    const b = bucketOf(P()); $("fundLbl").textContent = "funding";
    $("fundRate").textContent = b ? `−${(b.funding_rate_annual_bps / 1e4 / 365 * 100).toFixed(2)}% day` : "—";
  }
}

// ── amount + preview ──
const amount = () => { const v = Number(String($("amt").value).replace(",", ".")); return isFinite(v) && v > 0 ? v : 0; };
function cash() { return mode === "demo" ? demo.balance : Number(live?.cash?.() ?? 0n) / E6; }
function renderPreview() {
  const a = amount(), p = P(), net = a * 0.997;
  let rows = [];
  if (a > 0) {
    if (mode === "live" && bucketOf(p)) { const f = bucketOf(p).funding_rate_annual_bps / 1e4; rows.push(["Funding now", `${fmt(net * f / 365)}/day (${Math.round(f * 100)}%/yr)`]); }
  }
  $("preview").innerHTML = rows.map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join("");
  // each strength has its own limit: 20% of the pool, and a cap on its share of the pool (tighter for steeper curves)
  const maxOpen = mode === "live" && bucketOf(p) ? Number(bucketOf(p).max_open) / E6 : Infinity;
  $("amtErr").hidden = !(a > maxOpen); if (a > maxOpen) $("amtErr").textContent = maxOpen < 1 ? `${pw(p)} is full right now. Try a gentler curve.` : `Too big for ${pw(p)} right now. Max ${fmt(Math.floor(maxOpen * 100) / 100)}.`;
  let err = "";
  if (mode === "live" && !live?.connected) err = "";
  else if (a > cash() + 1e-9) err = mode === "demo" ? "More than your play money." : "Not enough balance. Tap your balance to add money.";
  else if (mode === "live" && a > maxOpen) err = `Largest ${pw(p)} buy right now is ${fmt(Math.floor(maxOpen * 100) / 100)}.`;
  $("buyErr").textContent = err;
  $("buy").disabled = !a || !!err || busy || (mode === "live" && !live?.connected) || a > maxOpen;
  $("buy").textContent = a ? `Buy ${fmt(a, a % 1 ? 2 : 0)}` : "Buy";
}
$("amt").addEventListener("input", renderPreview);
// quick amounts: a share of what you have (25%, 50%, 75%) or all of it
document.querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => { const v = b.dataset.a, c = cash(); $("amt").value = Math.floor((v === "max" ? c : c * v / 100) * 100) / 100 || ""; renderPreview(); }));
// the slider's left part is filled in ink: keep its fill in step with the value
const paintSlider = () => { const s = $("p"); s.style.setProperty("--p", (s.value - s.min) / (s.max - s.min)); };
$("p").addEventListener("input", paintSlider); paintSlider();

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
  $("px").textContent = fmtP(exitPx);
  const m = r.out / r.stake, melted = why === "melted";
  trail.push({ m: exitPx / r.entry - 1, v: m - 1 });
  flip(false); ff(false); chart.mark(null); renderStrength();
  $("rIco").textContent = r.pnl > 0 ? (m >= 3 ? "🚀" : "🎉") : melted ? "🫠" : "☠️";
  // win / loss: the % sits big behind the chart; a melt down keeps its title
  $("rBig").textContent = r.out > 0 ? pct(m - 1, 0) : "Melt Down"; $("rBig").className = "r-pct " + (r.out > 0 && m >= 1 ? "pos" : "neg");
  $("rBig").style.fontSize = r.out > 0 ? "" : "40px";
  $("rSub").textContent = `${pw(r.p)} curve`;
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
  const top = (big > 1 ? 44 : 14) * big, Y = (v) => top + (hi - v) / (hi - lo) * (H - top - 6);
  ctx.setLineDash([3, 3]); ctx.strokeStyle = css("--line"); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(6, Y(0)); ctx.lineTo(R, Y(0)); ctx.stroke(); ctx.setLineDash([]);
  const per = Math.max(1, Math.ceil(n / 28)), cw = (R - 6) / Math.ceil(n / per);
  for (let k = 0; k < n; k += per) {
    const g = pts.slice(k, k + per + 1).map((s) => s.m), o = g[0], c = g.at(-1), h = Math.max(...g), l = Math.min(...g), cx = X(Math.min(n - 1, k + per / 2));
    ctx.strokeStyle = ctx.fillStyle = css(c >= o ? "--muted" : "--line");
    ctx.lineWidth = big; ctx.beginPath(); ctx.moveTo(cx, Y(h)); ctx.lineTo(cx, Y(l)); ctx.stroke();
    ctx.fillRect(cx - cw * 0.3, Y(Math.max(o, c)), cw * 0.6, Math.max(big, Y(Math.min(o, c)) - Y(Math.max(o, c))));
  }
  const up = css("--up"), down = css("--down"), gray = css("--muted"), bgc = css("--panel"); // a melt down fades into the card color
  ctx.lineWidth = 3.2 * big; ctx.lineCap = "round";
  for (let i = 1; i < n; i++) {
    const a = pts[i - 1], b = pts[i], base = (a.v + b.v) / 2 >= 0 ? up : down, fade = melted ? Math.round(100 - 85 * (i / (n - 1))) : 100;
    ctx.strokeStyle = fade < 100 ? `color-mix(in srgb, ${base} ${fade}%, ${bgc})` : base;
    ctx.beginPath(); ctx.moveTo(X(i - 1), Y(a.v)); ctx.lineTo(X(i), Y(b.v)); ctx.stroke();
  }
  // "x¹⁰ / curve" above the start
  const sy = Math.max(top - 6 * big, Y(pts[0].v) - 16 * big);
  if (big > 1) { // the in-app card says "x⁸ curve" above the chart; the share image labels it here
    ctx.fillStyle = up; ctx.textAlign = "left";
    ctx.font = `800 ${20 * big}px ${css("--font")}`; ctx.fillText(pw(p), 8, sy - 14 * big);
    ctx.font = `700 ${11 * big}px ${css("--font")}`; ctx.fillText("curve", 9, sy);
  }
  const end = pts.at(-1), endCol = melted ? `color-mix(in srgb, ${down} 30%, ${bgc})` : end.v >= 0 ? up : down, yv = Y(end.v), ym = Y(end.m), apart = Math.abs(ym - yv) < 14 * big ? (yv < ym ? -7 : 7) * big : 0;
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
const LOGO = new Image(); LOGO.src = "brand/logo-uprise.svg"; // white logo for the share image (dark background)
function shareCanvas(r) {
  const W = 1200, H = 675, cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d"), win = r.out > 0 && r.mult >= 1, tint = css(win ? "--up" : "--down");
  const g = ctx.createRadialGradient(W * 0.25, 0, 0, W * 0.25, 0, W * 0.9); g.addColorStop(0, `color-mix(in srgb, ${tint} 22%, ${css("--panel")})`); g.addColorStop(0.7, css("--panel")); g.addColorStop(1, css("--bg"));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  if (LOGO.complete && LOGO.naturalWidth) ctx.drawImage(LOGO, 56, 48, 240, 240 * 278.54 / 1000);
  else { ctx.fillStyle = "#fff"; ctx.font = `800 34px ${css("--font")}`; ctx.textAlign = "left"; ctx.fillText("Uprise", 56, 86); }
  ctx.textAlign = "left";
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
function flip(on) { $("flip").classList.toggle("flipped", on); $("buy").hidden = on; $("close").hidden = !on; $("buyErr").hidden = on; }

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
    const curveV = q.net * Math.pow(px / q.entry, q.p); $("posFundRow").hidden = false;
    $("posFund").textContent = "−" + fmt(Math.max(0, curveV - v));
    const pnl = v - q.stake; $("posPnl").textContent = `${pnl >= 0 ? "+" : "−"}${fmt(Math.abs(pnl))} · ×${(v / q.stake).toFixed(2)}`; $("posPnl").className = "num " + (pnl >= 0 ? "pos" : "neg");
    $("meltBar").style.width = left * 100 + "%";
    $("meltNote").textContent = "";
    $("chg").textContent = pct(px / q.entry - 1, 1) + " since you bought"; $("chg").className = "small num " + (px >= q.entry ? "pos" : "neg");
    $("balance").textContent = fmt(demo.balance + v);
  } else {
    const p = P(), a = heldLong(p); if (!a || browseBuy) return;
    renderOthers(p);
    const v = Number(a.value) / E6, c = Number(a.cost) / E6, m = live.state.market, b = bucketOf(p);
    $("posFundRow").hidden = true; renderFunding();
    $("posP").textContent = pw(p); $("posValue").textContent = fmt(v); $("posPaid").textContent = fmt(c);
    const known = Number(ls.get(`uprise.v1.entry.${live.accountId}.${p}`) || 0), pNow = Number(m.price) / E6;
    // estimate if we didn't see the buy: value ≈ cost × (P/E)^p  →  E ≈ P × (cost/value)^(1/p) (melt makes it a little high)
    const entry = known || (v > 0 ? pNow * Math.pow(c * 0.997 / v, 1 / p) : 0);
    $("posEntry").textContent = entry ? (known ? "" : "≈ ") + fmtP(entry) : "—"; $("posNow").textContent = fmtP(pNow);
    showCurve(p, entry ? pNow / entry - 1 : null); // your dot on the curve, no ±10% markers
    $("posPnl").textContent = `${v >= c ? "+" : "−"}${fmt(Math.abs(v - c))} · ×${(v / c).toFixed(2)}`; $("posPnl").className = "num " + (v >= c ? "pos" : "neg");
    // at today's rate the position pays v·f/365 a day, so it would melt away in about 365/f days
    const f = b.funding_rate_annual_bps / 1e4, days = f > 0 ? 365 / f : Infinity;
    // the bar is your position, not time: full = what you paid, it shrinks by the funding taken so far.
    // Funding only lowers NF, so the share left is NF now / NF when you bought (remembered at buy, per strength).
    // A rebase re-anchors the bucket (new ref price or unit scale): then the remembered NF no longer compares.
    const nf0 = Number(ls.get(`uprise.v1.nf.${live.accountId}.${p}`) || 0), ref0 = ls.get(`uprise.v1.ref.${live.accountId}.${p}`);
    const left = nf0 && ref0 === `${b.ref_price}/${b.scale}` ? Number(b.nf) / nf0 : null;
    $("meltBar").parentElement.hidden = left == null; if (left != null) $("meltBar").style.width = Math.max(2, Math.min(100, left * 100)) + "%";
    $("meltNote").textContent = `Funding: ${fmt(v * f / 365)} per day (~${isFinite(days) ? Math.round(days) : "∞"} days)`;
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
let range = "1d", lastCandleT = 0, streamAt = 0, stream = null, pxPaint = 0;
// Live chart: Coinbase's public ticker stream moves the candles several times a second. Trades still use the
// on-chain price (the keeper writes it every 15 s), so this only makes the chart feel live.
function startStream() {
  if (stream || mode !== "live") return;
  try {
    stream = new WebSocket("wss://ws-feed.exchange.coinbase.com");
    stream.onopen = () => stream.send(JSON.stringify({ type: "subscribe", product_ids: [`${live?.cfg?.asset || "NEAR"}-USD`], channels: ["ticker"] }));
    stream.onmessage = (e) => {
      const m = JSON.parse(e.data); if (m.type !== "ticker" || mode !== "live") return;
      const p = Number(m.price), now = Date.now() / 1000; streamAt = Date.now();
      if (now - lastCandleT >= GRAN[range]) { chart.candles.push([p, p, p, p]); lastCandleT = now; chart.draw(); } else chart.tick(p);
      if (Date.now() - pxPaint > 250) { $("px").textContent = fmtP(p); pxPaint = Date.now(); }
    };
    stream.onclose = () => { stream = null; if (mode === "live") setTimeout(startStream, 3000); };
  } catch { stream = null; }
}
function stopStream() { try { stream?.close(); } catch {} stream = null; }
const GRAN = { "5m": 5, "1h": 60, "1d": 300, "1w": 3600 }; // seconds per candle
async function loadLiveChart() {
  startStream();
  try { const rows = await fetch(`/api/history?range=${range}`).then((r) => r.json()); chart.set(rows.slice(-70)); lastCandleT = rows.length ? rows[rows.length - 1][0] : 0; chart.mark(null); } catch {}
  $("mkt").textContent = `${live.cfg.asset} / USD`; $("mktNote").textContent = live.cfg.testnet ? "Live · testnet" : "Live";
}
// ── "Add USDC to start": bridge, swap (scan the wallet's tokens), or testnet USDC ──
let fundShown = false;
function openFund() {
  $("fTest").hidden = !live.cfg.testnet; $("fSwapPane").hidden = true; modal("fundModal");
}
$("fTest").onclick = () => withBusy($("fTest"), "Adding…", async () => { await live.faucet(); toast("1,000 test USDC added"); modal("fundModal", false); await liveRefresh(); });
$("fBridge").onclick = () => { modal("fundModal", false); renderWallet(); modal("wallet"); document.querySelector('#wSeg [data-w="in"]').click(); };
// wallet tokens (FastNEAR API), without USDC since that's what we swap into
async function walletTokens() {
  const api = live.cfg.testnet ? "https://test.api.fastnear.com" : "https://api.fastnear.com";
  const r = await fetch(`${api}/v1/account/${live.accountId}/ft`).then((x) => x.json());
  const toks = (r.tokens || []).filter((t) => BigInt(t.balance || 0) > 0n && t.contract_id !== live.cfg.usdc).slice(0, 8);
  const rows = await Promise.all(toks.map(async (t) => { const m = await live.view(t.contract_id, "ft_metadata").catch(() => null); const d = m?.decimals ?? 0; return { sym: m?.symbol || t.contract_id, amt: Number(BigInt(t.balance)) / 10 ** d }; }));
  const acct = await live.provider.viewAccount({ accountId: live.accountId }).catch(() => null), nearBal = acct ? Number(BigInt(acct.amount) / 10n ** 20n) / 1e4 : 0;
  if (nearBal > 0) rows.unshift({ sym: "NEAR", amt: nearBal });
  return rows;
}
const tokenRows = (rows) => rows.length ? rows.map((t) => `<div class="tok-row"><b>${t.sym}</b><span>${t.amt.toLocaleString("en-US", { maximumFractionDigits: 4 })}</span><button class="chip" ${live.cfg.testnet ? "disabled" : ""}>Swap</button></div>`).join("") : '<p class="hint">No tokens found in this wallet.</p>';
const SWAP_NOTE = () => (live.cfg.testnet ? "Swaps run through NEAR Intents on mainnet. On testnet, use the test USDC button." : "Pick a token to swap into USDC. NEAR Intents finds the best price.");
$("fSwap").onclick = async () => {
  $("fSwapPane").hidden = false; $("fTokens").innerHTML = '<p class="hint">Looking at your wallet…</p>'; $("fSwapNote").textContent = SWAP_NOTE();
  try { $("fTokens").innerHTML = tokenRows(await walletTokens()); } catch { $("fTokens").innerHTML = '<p class="hint">Couldn\'t read your wallet right now.</p>'; }
};
async function fillSwapCard() {
  $("swHint").textContent = SWAP_NOTE(); $("swBtn").disabled = live.cfg.testnet; $("swTokens").innerHTML = '<p class="hint">Looking at your wallet…</p>';
  try { $("swTokens").innerHTML = tokenRows(await walletTokens()); } catch { $("swTokens").innerHTML = '<p class="hint">Couldn\'t read your wallet right now.</p>'; }
}

async function liveRefresh() {
  if (mode !== "live" || !live) return;
  try {
    await live.refresh();
    const p = Number(live.state.market.price) / E6, now = Date.now() / 1000;
    if (Date.now() - streamAt > 10_000) { // no live Coinbase ticks: move the chart with the on-chain price instead
      if (now - lastCandleT >= GRAN[range]) { chart.candles.push([p, p, p, p]); lastCandleT = now; chart.draw(); } else chart.tick(p);
      $("px").textContent = fmtP(p);
    }
    // first refresh with positions: show one you hold if the slider sits on an empty strength
    const held = heldLongs();
    if (held.length && !heldLong(P()) && !liveRefresh.picked) { $("p").value = held[0].power; renderStrength(); renderPreview(); }
    liveRefresh.picked = true;
    flip(showsPosition(P())); renderStrength();
    // no USDC anywhere yet: offer the ways to get some (once per session)
    if (live.connected && !fundShown && Number(live.state.usdc || 0n) === 0 && Number(live.cash()) === 0 && heldLongs().length === 0) { fundShown = true; openFund(); }
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
  const p = P(), had = !!heldLong(p), pBuy = Number(live.state.market.price) / E6, b = bucketOf(p), sfx = `${live.accountId}.${p}`;
  await live.buy(BigInt(Math.floor(a * E6)), p); $("amt").value = ""; browseBuy = false;
  if (!had) { ls.set(`uprise.v1.entry.${sfx}`, String(pBuy)); ls.set(`uprise.v1.nf.${sfx}`, String(b.nf)); ls.set(`uprise.v1.ref.${sfx}`, `${b.ref_price}/${b.scale}`); }
  else { for (const k of ["entry", "nf", "ref"]) localStorage.removeItem(`uprise.v1.${k}.${sfx}`); } // adding to a position: fall back to estimates
  toast(`Bought ${fmt(a)} of ${pw(p)} Curve Long`); await liveRefresh();
});
$("close").onclick = () => {
  if (mode === "demo") return demoClose("manual");
  const p = P();
  withBusy($("close"), "Closing…", async () => { await live.close(p); toast(`Closed ${pw(p)} and cashed out`); await liveRefresh(); });
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
    // funding the longs pay per year, summed over the ten strengths, times our share of the short pool, minus the 10% protocol cut
    const share = Number(m.short_shares) > 0 ? Number(s.short_shares) / Number(m.short_shares) : 0;
    const perYear = (m.buckets || []).reduce((t, b) => t + Number(b.claims) / E6 * b.funding_rate_annual_bps / 1e4, 0) * share * 0.9;
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
  $("faucet").hidden = !live.cfg.testnet || !live.connected;
  // right card: wallet users swap what they hold; device wallets get their deposit address
  const ext = live.kind === "wallet"; $("depSwap").hidden = !ext; $("depNear").hidden = ext; if (ext) fillSwapCard();
  document.querySelector('#wSeg [data-w="key"]').textContent = live.kind === "device" ? "Security" : "Sign out";
  $("xBtn").disabled = live.cfg.testnet; $("xHint").textContent = live.cfg.testnet ? "Cross-chain deposits through NEAR Intents run on mainnet. On testnet, use the test USDC button." : "Send USDC from Ethereum, Solana, Base or Arbitrum. NEAR Intents delivers it here as USDC on NEAR.";
  $("secHint").textContent = live.kind === "device" ? "Your key lives on this device. Save a recovery email so you can't lose it." : "You're signed in with your NEAR wallet. Your keys stay in your wallet.";
  $("backupOpen").hidden = $("showKey").hidden = live.kind !== "device";
}
// wallet tabs: switch the pane and animate the sheet's height so it doesn't jump
document.querySelectorAll("#wSeg button").forEach((b) => (b.onclick = () => {
  const sheet = $("wallet").querySelector(".sheet"), from = sheet.getBoundingClientRect().height;
  document.querySelectorAll("#wSeg button").forEach((x) => x.setAttribute("aria-selected", x === b));
  document.querySelectorAll("[data-wpane]").forEach((p) => (p.hidden = p.dataset.wpane !== b.dataset.w));
  const to = sheet.getBoundingClientRect().height;
  if (from !== to && !matchMedia("(prefers-reduced-motion: reduce)").matches) sheet.animate([{ height: from + "px" }, { height: to + "px" }], { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" });
}));
$("sMax").onclick = () => { $("sAmt").value = Math.floor(Number(live?.state?.usdc || 0n) / E6 * 100) / 100 || ""; };
$("demoReset").onclick = () => { if (demo.position) demoClose("manual"); demo.reset(); loadDemoChart(); render(); modal("wallet", false); toast("Play money reset to $1,000"); };
$("faucet").onclick = () => withBusy($("faucet"), "Minting…", async () => { await live.faucet(); toast("1,000 test USDC added"); await liveRefresh(); renderWallet(); });
$("copy").onclick = async () => { try { await navigator.clipboard.writeText(live.accountId); toast("Address copied"); } catch { toast("Select the address and copy it", true); } };
$("sendBtn").onclick = () => withBusy($("sendBtn"), "Sending…", async () => { const to = $("sTo").value.trim(), a = Number($("sAmt").value); if (!to || !(a > 0)) throw new Error("Enter a receiver and an amount"); await live.send(to, BigInt(Math.floor(a * E6))); toast(`Sent ${fmt(a)}`); await liveRefresh(); });
$("backupOpen").onclick = () => { modal("wallet", false); modal("backup"); };
$("showKey").onclick = () => { $("keyOut").hidden = false; $("keyOut").textContent = live.secret(); };
$("disconnect").onclick = async () => { if (live.kind === "device" && !ls.get("uprise.v1.backedUp") && !confirm("Without a recovery email or a saved key, signing out loses this wallet. Sign out anyway?")) return; await live.disconnect(); modal("wallet", false); render(); };
const ASSETS = [["USDC on Ethereum", "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", 6], ["USDC on Solana", "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", 6], ["USDC on Base", "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", 6], ["USDC on Arbitrum", "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", 6]];
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
  mode = m; ls.set("uprise.mode", m); if (m === "demo") stopStream();
  document.querySelectorAll("[data-mode]").forEach((x) => x.setAttribute("aria-selected", x.dataset.mode === m));
  $("ranges").hidden = m !== "live";
  if (m === "demo") { $("mkt").textContent = "Demo market"; $("mktNote").textContent = "Demo replay of real history"; $("assetLabel").textContent = "play money"; loadDemoChart(); flip(false); }
  else {
    try { await ensureLive(); } catch (e) { toast("Live mode can't reach the network: " + e.message, true); return setMode("demo"); }
    $("assetLabel").textContent = `on ${live.cfg.asset}`; liveRefresh.picked = false; await loadLiveChart(); await liveRefresh();
  }
  if (tab === "stats") arena.start(mode, live);
  renderStrength(); render();
}

function render() {
  const liveNoWallet = mode === "live" && !live?.connected;
  $("liveStart").hidden = !liveNoWallet; $("netTag").hidden = !(mode === "live" && live?.cfg?.testnet);
  $("tab-bull").classList.toggle("start-only", liveNoWallet); // Live without a wallet: just the start card
  $("balLabel").textContent = mode === "demo" ? "Play money" : live?.connected ? "Balance" : "Not signed in";
  if (mode === "demo") $("balance").textContent = fmt(demo.balance + (demo.position?.value || 0));
  else $("balance").textContent = live?.connected ? fmt(Number(live.cash()) / E6) : "—";
  renderPreview(); renderPosition(); renderFunding();
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
  $("howTrade").onclick = intro; // replays the intro slides
  $("crabHelp").onclick = () => modal("crabIntro");
  if (!ls.get("uprise.v1.onboarded")) intro();
})();
