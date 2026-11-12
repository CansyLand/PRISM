// First-visit explainer: three short screens, ELI5.
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const SLIDES = [
  {
    kicker: "Continuous-Expiry Power Perpetuals",
    title: "When the price rises, your position grows faster.",
    text: "Pick how strong: 1× follows the price, 5× and 10× grow much faster on every step up.",
    draw: drawCurves,
  },
  {
    kicker: "What's new",
    title: "No liquidation on wicks.",
    text: "A sudden dip can't knock you out. Instead your position slowly melts over time, so you're betting on a rise within a time window.",
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
    cv.width = r.width * dpr; cv.height = r.height * dpr;
    const ctx = cv.getContext("2d"); ctx.scale(dpr, dpr);
    SLIDES[i].draw(ctx, r.width, r.height, (now - t0) / 1000);
    raf = requestAnimationFrame(loop);
  };
  const done = () => { cancelAnimationFrame(raf); root.hidden = true; root.innerHTML = ""; onDone(); };
  root.querySelector("[data-next]").onclick = () => (i < SLIDES.length - 1 ? (i++, show()) : done());
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
    ctx.fillText(`${label}  ×${v.toFixed(2)}`, X(x) + 8, Y(v) + 4);
  }
  ctx.fillStyle = css("--muted"); ctx.font = `600 12px ${css("--font")}`;
  ctx.fillText(`price ${(pricePath(x) - 1 >= 0 ? "+" : "")}${((pricePath(x) - 1) * 100).toFixed(1)}%`, pad, pad + 4);
}
// A wick: price drops 30% for a moment, then recovers above the start.
function wickPath(x) { return x < 0.45 ? 1 + 0.05 * x : x < 0.5 ? 1.0225 - 6 * (x - 0.45) : x < 0.55 ? 0.7225 + 6 * (x - 0.5) : 1.0225 + 0.25 * (x - 0.55); }
function drawWick(ctx, W, H, t) {
  const T = 5, x = Math.min(1, (t % (T + 1.5)) / T), pad = 16, X = (u) => pad + u * (W - 2 * pad - 10), Y = (v) => H - pad - (v - 0.6) / 0.6 * (H - 2 * pad);
  ctx.beginPath(); for (let k = 0; k <= 120; k++) { const u = (k / 120) * x; k ? ctx.lineTo(X(u), Y(wickPath(u))) : ctx.moveTo(X(u), Y(wickPath(u))); }
  ctx.strokeStyle = css("--muted"); ctx.lineWidth = 2; ctx.stroke();
  const liq = x >= 0.47, uv = Math.pow(wickPath(x), 3) * (1 - 0.06 * x);
  ctx.font = `700 13px ${css("--font")}`; ctx.textAlign = "left";
  ctx.fillStyle = css("--down"); ctx.fillText(liq ? "Regular leverage: liquidated 💥" : "Regular leverage: fine…", pad, pad + 4);
  ctx.fillStyle = css("--up"); ctx.fillText(`Uprise: still in, ×${uv.toFixed(2)}`, pad, pad + 24);
  if (x >= 0.47) { ctx.fillStyle = css("--down"); ctx.font = "22px sans-serif"; ctx.fillText("💥", X(0.48) - 10, Y(0.74) + 8); }
}
function drawCoins(ctx, W, H, t) {
  ctx.textAlign = "center"; ctx.font = `800 ${Math.min(64, W / 6)}px ${css("--mono")}`; ctx.fillStyle = css("--gold");
  ctx.fillText("$1,000", W / 2, H / 2 + 18);
  for (let k = 0; k < 14; k++) {
    const a = k / 14 * Math.PI * 2 + t * 0.8, rr = Math.min(W, H) * 0.38 + Math.sin(t * 2 + k) * 6;
    ctx.beginPath(); ctx.arc(W / 2 + Math.cos(a) * rr, H / 2 + Math.sin(a) * rr * 0.55, 6, 0, 7); ctx.fill();
  }
}
