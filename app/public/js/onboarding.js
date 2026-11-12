// First-visit explainer: three short screens, ELI5.
import { css, fit } from "./theme.js";
const SLIDES = [
  {
    kicker: "Continuous-Expiry Power Perpetuals",
    title: "When the price rises, your position grows faster.",
    text: "A power perpetual multiplies your gains as the price climbs, so a big move can pay many times more than a normal leveraged perpetual.",
    draw: drawCurves,
  },
  {
    kicker: "What's new",
    title: "No liquidation on wicks.",
    text: "A normal perpetual gets liquidated in a dip and it's over. Uprise rises faster, survives the dip and comes back. You pay by slowly melting over time, so you're betting on a rise within a time window.",
    draw: drawWick,
  },
  {
    kicker: "Try it",
    title: "Here's $1,000 of play money.",
    text: "Pick a strength, buy, and watch time fast-forward. When you're ready, switch to Live.",
    draw: drawCoins,
  },
];

export function showOnboarding(root, onDone) {
  let i = 0, raf = 0, t0 = performance.now();
  root.hidden = false;
  root.innerHTML = `<div class="ob">
    <canvas class="ob-cv" aria-hidden="true"></canvas>
    <div class="ob-kicker"></div><h1 class="ob-title"></h1><p class="ob-text"></p>
    <div class="ob-dots">${SLIDES.map(() => "<i></i>").join("")}</div>
    <div class="ob-actions"><button class="btn ghost small" data-skip>Skip</button><button class="btn" data-next>Next</button></div>
  </div>`;
  const cv = root.querySelector(".ob-cv");
  const show = () => {
    const s = SLIDES[i];
    root.querySelector(".ob-kicker").textContent = s.kicker;
    root.querySelector(".ob-title").textContent = s.title;
    root.querySelector(".ob-text").textContent = s.text;
    root.querySelectorAll(".ob-dots i").forEach((d, k) => d.classList.toggle("on", k === i));
    root.querySelector("[data-next]").textContent = i === SLIDES.length - 1 ? "Start the demo" : "Next";
    t0 = performance.now();
  };
  const loop = (now) => {
    const r = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    const fitted = fit(cv); if (!fitted) { raf = requestAnimationFrame(loop); return; } const { ctx } = fitted;
    SLIDES[i].draw(ctx, r.width, r.height, (now - t0) / 1000);
    raf = requestAnimationFrame(loop);
  };
  const done = () => { cancelAnimationFrame(raf); root.hidden = true; root.innerHTML = ""; onDone(); };
  // last slide: the background fades, the money flies into the balance at the top
  const fly = () => {
    cancelAnimationFrame(raf);
    const r = cv.getBoundingClientRect(), t = (performance.now() - t0) / 1000, W = r.width, H = r.height, bal = document.getElementById("balance");
    if (!bal || matchMedia("(prefers-reduced-motion: reduce)").matches) return done();
    const b = bal.getBoundingClientRect(), tx = b.left + b.width / 2, ty = b.top + b.height / 2, finalText = bal.textContent;
    const layer = document.createElement("div"); layer.className = "ob-fly"; document.body.append(layer);
    const put = (cls, x, y, html) => { const e = document.createElement("div"); e.className = cls; e.style.left = x + "px"; e.style.top = y + "px"; if (html) e.textContent = html; layer.append(e); return e; };
    const amt = put("ob-fly-amt", r.left + W / 2, r.top + H / 2 - 2, "$1,000"); amt.style.fontSize = Math.min(64, W / 6) + "px";
    const coins = Array.from({ length: 14 }, (_, k) => { const a = k / 14 * Math.PI * 2 + t * 0.8, rr = Math.min(W, H) * 0.38 + Math.sin(t * 2 + k) * 6; return put("ob-fly-coin", r.left + W / 2 + Math.cos(a) * rr, r.top + H / 2 + Math.sin(a) * rr * 0.55); });
    cv.style.visibility = "hidden";
    root.style.transition = "opacity .45s ease"; root.style.opacity = "0"; root.style.pointerEvents = "none";
    bal.textContent = "$0.00";
    const go = (el, delay, dur, scale) => el.animate([{ transform: "translate(-50%,-50%)" }, { transform: `translate(calc(-50% + ${tx - parseFloat(el.style.left)}px), calc(-50% + ${ty - parseFloat(el.style.top)}px)) scale(${scale})`, opacity: 0.85 }],
      { duration: dur, delay, easing: "cubic-bezier(.55,0,.25,1)", fill: "forwards" }).finished;
    let got = 0; const tick = () => { got++; bal.textContent = "$" + (1000 * got / coins.length).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    Promise.all([go(amt, 200, 950, 0.22), ...coins.map((c, k) => go(c, 380 + k * 45, 700, 0.6).then(tick))]).then(() => {
      layer.remove(); bal.textContent = finalText;
      const btn = bal.closest("button"); btn?.classList.add("pop"); setTimeout(() => btn?.classList.remove("pop"), 700);
      root.style.cssText = ""; cv.style.visibility = ""; done();
    });
  };
  root.querySelector("[data-next]").onclick = () => (i < SLIDES.length - 1 ? (i++, show()) : fly());
  root.querySelector("[data-skip]").onclick = done;
  show(); raf = requestAnimationFrame(loop);
}

// Price climbs with small wiggles; 1×, 5×, 10× follow price^p.
function pricePath(x) { return 1 + 0.16 * x + 0.012 * Math.sin(x * 19) + 0.008 * Math.sin(x * 47); }
function drawCurves(ctx, W, H, t) {
  const T = 4.5, x = Math.min(1, (t % (T + 1.5)) / T), pad = 14, cols = [["1×", 1, "--muted"], ["5×", 5, "--accent"], ["10×", 10, "--up"]];
  const yMax = Math.max(1.25, Math.pow(pricePath(x), 10) * 1.12), Y = (v) => H - pad - (v - 0.8) / (yMax - 0.8) * (H - 2 * pad), X = (u) => pad + u * (W - 90);
  ctx.strokeStyle = css("--line"); ctx.beginPath(); ctx.moveTo(pad, Y(1)); ctx.lineTo(W - 60, Y(1)); ctx.stroke();
  for (const [label, p, col] of cols) {
    ctx.beginPath();
    for (let k = 0; k <= 80; k++) { const u = (k / 80) * x, v = Math.pow(pricePath(u), p); k ? ctx.lineTo(X(u), Y(v)) : ctx.moveTo(X(u), Y(v)); }
    ctx.strokeStyle = css(col); ctx.lineWidth = p === 1 ? 2 : 3; ctx.stroke();
    const v = Math.pow(pricePath(x), p);
    ctx.fillStyle = css(col); ctx.font = `700 13px ${css("--mono")}`; ctx.textAlign = "left";
    ctx.fillText(`${label}  ${pnl(v)}`, X(x) + 8, Y(v) + 4);
  }
  ctx.fillStyle = css("--muted"); ctx.font = `600 12px ${css("--font")}`;
  ctx.fillText(`price ${(pricePath(x) - 1 >= 0 ? "+" : "")}${((pricePath(x) - 1) * 100).toFixed(1)}%`, pad, pad + 4);
}
// Two positions on the same price: an 8× perpetual (linear, liquidated at 10% left) and an 8× power
// perpetual (price^8, slowly melting). Uprise rises faster; the perp is liquidated halfway down a deep
// wick, while Uprise rides it out and recovers far above the start.
const KEYS = [[0, 1], [0.25, 1.06], [0.5, 0.7], [1, 1.2]];
function crashPath(x) {
  let k = 0; while (k < KEYS.length - 2 && x > KEYS[k + 1][0]) k++;
  const [x0, y0] = KEYS[k], [x1, y1] = KEYS[k + 1], u = Math.min(1, Math.max(0, (x - x0) / (x1 - x0))), e = (1 - Math.cos(Math.PI * u)) / 2;
  return y0 + (y1 - y0) * e + 0.004 * Math.sin(x * 37) * Math.sin(Math.PI * u);
}
let LIQ_X = 0.5; const perpV = (x) => 1 + 8 * (crashPath(x) - 1), powerV = (x) => Math.pow(crashPath(x), 8) * Math.exp(-0.173 * x);
// the 8× perp is liquidated (10% of margin left) about halfway down the drop
for (let x = 0.25; x < 0.5; x += 0.001) if (perpV(x) <= 0.1) { LIQ_X = x; break; }
function drawWick(ctx, W, H, t) {
  const T = 6, x = Math.min(1, (t % (T + 1.8)) / T), pad = 14, liq = x >= LIQ_X;
  let hi = 1.25; for (let k = 0; k <= 40; k++) hi = Math.max(hi, powerV((k / 40) * x) * 1.12);
  const Y = (v) => H - pad - (v - 0) / (hi - 0) * (H - 2 * pad - 20) , X = (u) => pad + u * (W - 165);
  ctx.strokeStyle = css("--line"); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad, Y(1)); ctx.lineTo(W - 60, Y(1)); ctx.stroke();
  const line = (fn, to, col, w) => { ctx.beginPath(); for (let k = 0; k <= 90; k++) { const u = (k / 90) * to, v = fn(u); k ? ctx.lineTo(X(u), Y(v)) : ctx.moveTo(X(u), Y(v)); } ctx.strokeStyle = css(col); ctx.lineWidth = w; ctx.lineCap = "round"; ctx.stroke(); };
  line(perpV, Math.min(x, LIQ_X), "--down", 3);
  line(powerV, x, "--up", 3);
  ctx.font = `700 13px ${css("--mono")}`; ctx.textAlign = "left";
  const ex = Math.min(x, LIQ_X), pv = perpV(ex), uv = powerV(x);
  if (liq) {
    ctx.beginPath(); ctx.moveTo(X(LIQ_X), Y(pv)); ctx.lineTo(X(LIQ_X), Y(0)); ctx.strokeStyle = css("--down"); ctx.lineWidth = 3; ctx.stroke();
    ctx.font = "20px sans-serif"; ctx.textAlign = "center"; ctx.fillText("💥", X(LIQ_X), Y(0) - 2); ctx.textAlign = "left";
    ctx.font = `700 12px ${css("--font")}`; ctx.fillStyle = css("--down"); ctx.fillText("Perp 8×: liquidated", Math.max(pad, X(LIQ_X) - 60), Y(0) + 11);
  } else { ctx.fillStyle = css("--down"); ctx.fillText(`Perp 8×  ${pnl(pv)}`, X(ex) + 8, Y(pv) + (pv > uv ? -6 : 14)); }
  ctx.font = `700 13px ${css("--mono")}`; ctx.fillStyle = css("--up");
  ctx.fillText(`Uprise 8×  ${pnl(uv)}`, X(x) + 8, Y(uv) + (liq || uv >= pv ? 4 : -8));
  ctx.fillStyle = css("--muted"); ctx.font = `600 12px ${css("--font")}`;
  ctx.fillText(`price ${(crashPath(x) - 1 >= 0 ? "+" : "")}${((crashPath(x) - 1) * 100).toFixed(1)}%`, pad, pad + 4);
}
function pnl(v) { return (v >= 1 ? "+" : "−") + Math.abs((v - 1) * 100).toFixed(0) + "%"; }
function drawCoins(ctx, W, H, t) {
  ctx.textAlign = "center"; ctx.font = `800 ${Math.min(64, W / 6)}px ${css("--mono")}`; ctx.fillStyle = css("--gold");
  ctx.fillText("$1,000", W / 2, H / 2 + 18);
  for (let k = 0; k < 14; k++) {
    const a = k / 14 * Math.PI * 2 + t * 0.8, rr = Math.min(W, H) * 0.38 + Math.sin(t * 2 + k) * 6;
    ctx.beginPath(); ctx.arc(W / 2 + Math.cos(a) * rr, H / 2 + Math.sin(a) * rr * 0.55, 6, 0, 7); ctx.fill();
  }
}
