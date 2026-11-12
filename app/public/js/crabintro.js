// Little animations for the Crab explainer. They only run while the modal is open.
import { css, fit } from "./theme.js";

export function crabIntro(root) {
  const premium = root.querySelector("#ciPremium"), balance = root.querySelector("#ciBalance");
  let raf = 0, t0 = 0;
  const loop = (now) => {
    if (root.hidden) { raf = 0; return; }
    const t = (now - t0) / 1000;
    drawPremium(premium, t); drawBalance(balance, t);
    raf = requestAnimationFrame(loop);
  };
  new MutationObserver(() => { if (!root.hidden && !raf) { t0 = performance.now(); raf = requestAnimationFrame(loop); } })
    .observe(root, { attributes: true, attributeFilter: ["hidden"] });
}

// Bulls on the left keep paying: premium coins stream into the crab on the right.
function drawPremium(cv, t) {
  const f = fit(cv); if (!f) return; const { ctx, W, H } = f;
  const bulls = [H * 0.2, H * 0.5, H * 0.8], cx = W - 26, cy = H / 2;
  ctx.font = "18px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  bulls.forEach((y) => ctx.fillText("🐂", 16, y));
  ctx.font = "28px sans-serif"; ctx.fillText("🦀", cx, cy + Math.sin(t * 3) * 1.5);
  ctx.fillStyle = css("--accent");
  for (let b = 0; b < 3; b++) for (let k = 0; k < 4; k++) {
    const u = (t * 0.55 + k / 4 + b * 0.13) % 1, e = u * u * (3 - 2 * u), y0 = bulls[b];
    const x = 32 + (cx - 50) * e, y = y0 + (cy - y0) * e - Math.sin(Math.PI * e) * 8;
    ctx.globalAlpha = Math.min(1, (1 - u) * 6, u * 8); ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.textBaseline = "alphabetic";
}

// NEAR swings, the short side swings the other way, your total barely moves and creeps up.
// The crab walks sideways at the head of the total.
function drawBalance(cv, t) {
  const f = fit(cv); if (!f) return; const { ctx, W, H } = f;
  const T = 6, x = Math.min(1, (t % (T + 1.2)) / T), L = 6, R = W - 64, mid = H * 0.45, amp = H * 0.27;
  const swing = (u) => Math.sin(u * 9) * 0.7 + Math.sin(u * 23 + 1) * 0.3, X = (u) => L + u * (R - L);
  const lines = [
    ["NEAR", "--near", (u) => mid - amp * swing(u), 2],
    ["short", "--usdc", (u) => mid + amp * swing(u), 2],
    ["you", "--up", (u) => mid - u * H * 0.16 - Math.sin(u * 40) * 1.2, 3],
  ];
  for (const [label, col, fy, w] of lines) {
    ctx.beginPath(); for (let k = 0; k <= 90; k++) { const u = (k / 90) * x; k ? ctx.lineTo(X(u), fy(u)) : ctx.moveTo(X(u), fy(u)); }
    ctx.strokeStyle = css(col); ctx.lineWidth = w; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke();
  }
  ctx.font = `700 10px ${css("--font")}`; ctx.textAlign = "left"; let lx = 6;
  for (const [label, col] of [["NEAR", "--near"], ["short side", "--usdc"], ["you (both together)", "--up"]]) { ctx.fillStyle = css(col); ctx.fillText(label, lx, H - 5); lx += ctx.measureText(label).width + 12; }
  const hx = X(x) + 14 + Math.sin(t * 9) * 2.5, hy = lines[2][2](x); // sideways scuttle
  ctx.font = "20px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("🦀", hx, hy); ctx.textBaseline = "alphabetic";
}
