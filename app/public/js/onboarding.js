// First-visit explainer: three short screens, ELI5.
import { css, fit, pw } from "./theme.js";
const SLIDES = [
  {
    kicker: "Power Perpetuals",
    title: "When the price rises, your position grows faster.",
    text: "A power perpetual multiplies your gains as the price climbs, so a big move can pay many times more than a normal leveraged perpetual.",
    draw: drawCurves,
  },
  {
    kicker: "What's new",
    title: "No liquidation on wicks.",
    text: "A normal perpetual gets liquidated in a dip and it's over. Uprise rises faster, survives the dip and comes back.",
    draw: drawWick,
  },
  {
    kicker: "Continuous-Expiry",
    title: "Time melts your position.",
    text: "Instead of a liquidation price, your position has a clock: it melts a little every day. You're betting the price rises before it melts away.",
    draw: drawMelt,
  },
  {
    kicker: "Bridged via NEAR Intents",
    title: "1,000 USDC just landed on NEAR.",
    text: "You moved it from Ethereum in one step, no bridge to pick, no gas to buy. This one is demo money: pick a strength, buy and watch time fast-forward. When you're ready, switch to Live.",
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

// Slide 1 (plays once): the price as gray candles in the lower band, and the Uprise curve (green) =
// price^10: almost flat at first, then bending up hard. The curve follows the price's wiggles but its bend upward is unmistakable by the end.
const P1 = 10, N1 = 22, curve1 = (u) => Math.pow(smooth1(u), P1) * Math.pow(noisy1(u) / smooth1(u), 2.5), smooth1 = (u) => 1 + 0.3 * u, noisy1 = (u) => smooth1(u) + 0.022 * Math.sin(u * 23) + 0.012 * Math.sin(u * 61 + 1);
function drawCurves(ctx, W, H, t) {
  const T = 5, x = Math.min(1, t / T), pad = 14, X = (u) => pad + u * (W - 165);
  // candles get their own scale in the lower 40% so they're readable; the curve uses the full height
  const cLo = 0.96, cHi = 1.36, bandTop = H * 0.58, YC = (v) => H - pad - (v - cLo) / (cHi - cLo) * (H - pad - bandTop);
  let vHi = 1.6; for (let k = 0; k <= 60; k++) vHi = Math.max(vHi, curve1((k / 60) * x) * 1.08);
  const YV = (v) => H - pad - (v - 1) / (vHi - 1) * (H - 2 * pad - 10) - (YC(cLo) - YC(1));
  ctx.strokeStyle = css("--line"); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad, YC(1)); ctx.lineTo(W - 20, YC(1)); ctx.stroke();
  const slot = (X(1) - X(0)) / N1;
  for (let k = 0; k < N1; k++) {
    const u0 = k / N1; if (u0 > x) break;
    const u1 = Math.min(x, (k + 1) / N1), o = noisy1(u0), c = noisy1(u1), wig = 0.01 + 0.012 * Math.abs(Math.sin(k * 7.3));
    const h = Math.max(o, c) + wig * (u1 - u0) * N1, l = Math.min(o, c) - wig * 0.8 * (u1 - u0) * N1, cx = X(u0) + slot / 2;
    ctx.strokeStyle = ctx.fillStyle = css(c >= o ? "--muted" : "--line");
    ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx, YC(h)); ctx.lineTo(cx, YC(l)); ctx.stroke();
    ctx.fillRect(cx - slot * 0.3, YC(Math.max(o, c)), slot * 0.6, Math.max(1, YC(Math.min(o, c)) - YC(Math.max(o, c))));
  }
  ctx.beginPath(); for (let k = 0; k <= 120; k++) { const u = (k / 120) * x, v = curve1(u); k ? ctx.lineTo(X(u), YV(v)) : ctx.moveTo(X(u), YV(v)); }
  ctx.strokeStyle = css("--up"); ctx.lineWidth = 3.5; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke();
  const pv = noisy1(x), uv = curve1(x);
  ctx.font = `700 13px ${css("--mono")}`; ctx.textAlign = "left";
  ctx.fillStyle = css("--muted"); ctx.fillText(`price ${pnl(pv)}`, X(x) + slot + 6, YC(pv) + 4);
  ctx.fillStyle = css("--up"); ctx.font = `700 14px ${css("--font")}`; ctx.fillText(`Uprise ${pw(P1)} ${pnl(uv)}`, X(x) + 8, YV(uv) + 4);
}
// Slide 2: a leveraged perp (red) moves like Uprise (green) but is liquidated halfway down the drop;
// Uprise dips all the way, survives and climbs back far above the start.
const KEYS = [[0, 1], [0.25, 1.06], [0.5, 0.7], [1, 1.2]];
function crashPath(x) {
  let k = 0; while (k < KEYS.length - 2 && x > KEYS[k + 1][0]) k++;
  const [x0, y0] = KEYS[k], [x1, y1] = KEYS[k + 1], u = Math.min(1, Math.max(0, (x - x0) / (x1 - x0))), e = (1 - Math.cos(Math.PI * u)) / 2;
  return y0 + (y1 - y0) * e + 0.004 * Math.sin(x * 37) * Math.sin(Math.PI * u);
}
const powerV = (x) => Math.pow(crashPath(x), 8) * Math.exp(-0.173 * x), perpV = (x) => 1 + 0.5 * (powerV(x) - 1); // first hill half as high as Uprise's
let LIQ_X = 0.4;
{ // liquidation: halfway (in height) between the perp's peak and Uprise's lowest point
  let peak = 0, peakX = 0, bottom = Infinity;
  for (let x = 0; x <= 1; x += 0.002) { if (perpV(x) > peak && x < 0.4) { peak = perpV(x); peakX = x; } bottom = Math.min(bottom, powerV(x)); }
  const target = (peak + bottom) / 2;
  for (let x = peakX; x < 1; x += 0.001) if (perpV(x) <= target) { LIQ_X = x; break; }
}
function drawWick(ctx, W, H, t) {
  const T = 6, x = Math.min(1, (t % (T + 1.8)) / T), pad = 14, liq = x >= LIQ_X;
  let hi = 1.25; for (let k = 0; k <= 40; k++) hi = Math.max(hi, powerV((k / 40) * x) * 1.12);
  const Y = (v) => H - pad - 6 - v / hi * (H - 2 * pad - 20), X = (u) => pad + u * (W - 165);
  ctx.strokeStyle = css("--line"); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad, Y(1)); ctx.lineTo(W - 60, Y(1)); ctx.stroke();
  const line = (fn, to, col, w) => { ctx.beginPath(); for (let k = 0; k <= 90; k++) { const u = (k / 90) * to, v = fn(u); k ? ctx.lineTo(X(u), Y(v)) : ctx.moveTo(X(u), Y(v)); } ctx.strokeStyle = css(col); ctx.lineWidth = w; ctx.lineCap = "round"; ctx.stroke(); };
  line(powerV, x, "--up", 3);
  line(perpV, Math.min(x, LIQ_X), "--down", 3); // drawn on top so it's never hidden
  const ex = Math.min(x, LIQ_X), pv = perpV(ex), uv = powerV(x);
  if (liq) {
    ctx.font = "22px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("💥", X(LIQ_X), Y(pv)); ctx.textBaseline = "alphabetic";
    ctx.font = `700 12px ${css("--font")}`; ctx.fillStyle = css("--down"); ctx.textAlign = "right"; ctx.fillText("Perp 10×: liquidated", Math.max(X(LIQ_X) - 14, pad + ctx.measureText("Perp 10×: liquidated").width), Y(pv) + (X(LIQ_X) - 14 < pad + 130 ? 24 : 4));
  } else { ctx.font = `700 13px ${css("--mono")}`; ctx.textAlign = "left"; ctx.fillStyle = css("--down"); ctx.fillText(`Perp 10× ${pnl(pv)}`, X(ex) + 8, Y(pv) + 16); }
  ctx.font = `700 13px ${css("--mono")}`; ctx.textAlign = "left"; ctx.fillStyle = css("--up");
  ctx.fillText(`Uprise ${pnl(uv)}`, X(x) + 8, Y(uv) + (liq ? 4 : -8));
  ctx.fillStyle = css("--muted"); ctx.font = `600 12px ${css("--font")}`;
  ctx.fillText(`price ${(crashPath(x) - 1 >= 0 ? "+" : "")}${((crashPath(x) - 1) * 100).toFixed(1)}%`, pad, pad + 4);
}
// Slide 3: the Melt Down card come to life. The market (gray candles) barely moves, the x⁶ curve (on the
// same % scale) melts a little more every moment, fades to gray and ends at the red MELT DOWN line.
const P3 = 6, N3 = 24, mkt3 = (u) => 0.03 * Math.sin(u * 9) + 0.012 * Math.sin(u * 31 + 2) + 0.02 * u, val3 = (u) => Math.pow(1 + mkt3(u), P3) * (1 - u) - 1;
function drawMelt(ctx, W, H, t) {
  const T = 6, x = Math.min(1, t / T), pad = 14, R = W - 100, X = (u) => pad + u * (R - pad);
  const lo = -1.08, hi = 0.45, Y = (v) => pad + 30 + (hi - v) / (hi - lo) * (H - 2 * pad - 30);
  ctx.setLineDash([3, 3]); ctx.strokeStyle = css("--line"); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad, Y(0)); ctx.lineTo(R, Y(0)); ctx.stroke(); ctx.setLineDash([]);
  const slot = (R - pad) / N3;
  for (let k = 0; k < N3; k++) {
    const u0 = k / N3; if (u0 > x) break;
    const u1 = Math.min(x, (k + 1) / N3), o = mkt3(u0), c = mkt3(u1), h = Math.max(o, c) + 0.012, l = Math.min(o, c) - 0.01, cx = X(u0) + slot / 2;
    ctx.strokeStyle = ctx.fillStyle = css(c >= o ? "--muted" : "--line");
    ctx.beginPath(); ctx.moveTo(cx, Y(h)); ctx.lineTo(cx, Y(l)); ctx.stroke();
    ctx.fillRect(cx - slot * 0.3, Y(Math.max(o, c)), slot * 0.6, Math.max(1, Y(Math.min(o, c)) - Y(Math.max(o, c))));
  }
  const up = css("--up"), down = css("--down"), gray = css("--muted");
  ctx.lineWidth = 3.2; ctx.lineCap = "round";
  for (let k = 1; k <= 120; k++) {
    const u0 = ((k - 1) / 120) * x, u1 = (k / 120) * x, base = val3(u1) >= 0 ? up : down;
    ctx.strokeStyle = `color-mix(in srgb, ${base} ${Math.round(100 - 85 * u1)}%, ${gray})`;
    ctx.beginPath(); ctx.moveTo(X(u0), Y(val3(u0))); ctx.lineTo(X(u1), Y(val3(u1))); ctx.stroke();
  }
  ctx.fillStyle = up; ctx.textAlign = "left"; ctx.font = `800 20px ${css("--font")}`; ctx.fillText(pw(P3), pad + 2, Y(0) - 26);
  ctx.font = `700 11px ${css("--font")}`; ctx.fillText("curve", pad + 3, Y(0) - 12);
  ctx.font = `700 12px ${css("--mono")}`; ctx.fillStyle = gray; ctx.fillText(`market ${pnl(1 + mkt3(x))}`, R + 6, Y(mkt3(x)) + 4);
  if (x < 1) { ctx.fillStyle = `color-mix(in srgb, ${val3(x) >= 0 ? up : down} ${Math.round(100 - 85 * x)}%, ${gray})`; ctx.fillText(pnl(1 + val3(x)), R + 6, Y(val3(x)) + 4); }
  // time left
  ctx.font = `800 22px ${css("--mono")}`; ctx.fillStyle = css("--ink"); ctx.fillText(`⏱ day ${Math.round(x * 90)}`, pad, pad + 12); ctx.font = `600 12px ${css("--font")}`; ctx.fillStyle = gray; ctx.fillText("of 90", pad + 128, pad + 12);
  if (x >= 1) {
    ctx.strokeStyle = down; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(X(1), pad + 14); ctx.lineTo(X(1), H - pad); ctx.stroke();
    ctx.fillStyle = down; ctx.font = `800 12px ${css("--font")}`; ctx.textAlign = "right"; ctx.fillText("MELT DOWN 🫠", X(1) - 6, pad + 26);
  }
}
function pnl(v) { return (v >= 1 ? "+" : "−") + Math.abs((v - 1) * 100).toFixed(0) + "%"; }
function drawCoins(ctx, W, H, t) {
  // route on top: Ethereum → NEAR, a pulse travels along it
  const y = 22, x0 = W * 0.18, x1 = W * 0.82, u = (t * 0.6) % 1;
  ctx.font = `700 13px ${css("--font")}`; ctx.textAlign = "center"; ctx.fillStyle = css("--muted");
  ctx.fillText("Ethereum", x0, y + 4); ctx.fillText("NEAR", x1, y + 4);
  ctx.strokeStyle = css("--line"); ctx.lineWidth = 2; ctx.setLineDash([4, 5]); ctx.beginPath(); ctx.moveTo(x0 + 40, y); ctx.lineTo(x1 - 30, y); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = css("--usdc"); ctx.beginPath(); ctx.arc(x0 + 40 + (x1 - x0 - 70) * u, y, 4, 0, 7); ctx.fill();
  ctx.font = `600 11px ${css("--font")}`; ctx.fillStyle = css("--muted"); ctx.fillText("USDC via Intents", W / 2, y + 22);
  ctx.textAlign = "center"; ctx.font = `800 ${Math.min(64, W / 6)}px ${css("--mono")}`; ctx.fillStyle = css("--gold");
  ctx.fillText("$1,000", W / 2, H / 2 + 18);
  for (let k = 0; k < 14; k++) {
    const a = k / 14 * Math.PI * 2 + t * 0.8, rr = Math.min(W, H) * 0.38 + Math.sin(t * 2 + k) * 6;
    ctx.beginPath(); ctx.arc(W / 2 + Math.cos(a) * rr, H / 2 + Math.sin(a) * rr * 0.55, 6, 0, 7); ctx.fill();
  }
}
