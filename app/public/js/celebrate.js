// "Supernova" celebration for reaching x¹⁰: a dark purple nebula opens behind it (so the gold shows on the
// colorful app), then a gold shockwave ring, gold $ signs that spin and flip, and white sparkles that glitter. Draws on a full-screen canvas that only exists while it runs.
const rnd = (a, b) => a + Math.random() * (b - a), pick = (a) => a[Math.floor(Math.random() * a.length)];
const NEB_HOLD = 1.2, NEB_FADE = 1.4;
const GOLD = ["#f5c542", "#ffd60a", "#ffb020", "#ffe58a"];

export function supernova(x, y) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cv = document.createElement("canvas"); cv.className = "celebrate"; document.body.append(cv);
  const dpr = devicePixelRatio || 1, W = innerWidth, H = innerHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext("2d"), ps = [];
  const add = (p) => ps.push(Object.assign({ x, y, vx: 0, vy: 0, g: 240, drag: 0.97, rot: rnd(0, 6.28), vr: rnd(-8, 8), age: 0, life: rnd(1.4, 2.2), size: rnd(14, 34), color: pick(GOLD), glyph: "$", glow: 26, flip: rnd(3, 8), tw: rnd(0, 6.28) }, p));
  for (let i = 0; i < 60; i++) { const a = rnd(0, Math.PI * 2), v = rnd(200, 600); add({ vx: Math.cos(a) * v, vy: Math.sin(a) * v }); }
  for (let i = 0; i < 50; i++) { const a = rnd(0, Math.PI * 2), v = rnd(80, 420); add({ vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 100, glyph: "✦", size: rnd(6, 16), color: "#fff", glow: 18, glitter: true, life: rnd(1, 1.8), flip: 0 }); }
  let t = 0, last = performance.now();
  const frame = (now) => {
    const dt = Math.max(0, Math.min(0.033, (now - last) / 1000)); last = now; t += dt;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    // purple nebula: grows in 0.18 s, holds 1.2 s, fades over 1.4 s
    if (t < NEB_HOLD + NEB_FADE) {
      const a = t < NEB_HOLD ? 1 : 1 - (t - NEB_HOLD) / NEB_FADE, R = 340 * (0.55 + 0.45 * Math.min(1, t / 0.18)), g = ctx.createRadialGradient(x, y, 0, x, y, R);
      g.addColorStop(0, "rgba(20,6,46,1)"); g.addColorStop(0.4, "rgba(58,18,120,.92)"); g.addColorStop(0.75, "rgba(120,60,220,.55)"); g.addColorStop(1, "rgba(120,60,220,0)");
      ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = g; ctx.fillRect(x - R, y - R, 2 * R, 2 * R); ctx.restore();
    }
    if (t < 0.7) { const a = 1 - t / 0.7; ctx.save(); ctx.strokeStyle = `rgba(245,197,66,${a})`; ctx.lineWidth = 6 * a + 1; ctx.shadowColor = "#f5c542"; ctx.shadowBlur = 30; ctx.beginPath(); ctx.arc(x, y, t * 520, 0, 7); ctx.stroke(); ctx.restore(); }
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const p of ps) {
      p.age += dt; p.vx *= p.drag; p.vy = p.vy * p.drag + p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      const fade = Math.max(0, Math.min(1, (p.life - p.age) / 0.5)), tw = p.glitter ? 0.65 + 0.35 * Math.sin(p.age * 18 + p.tw) : 1;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = fade * tw; ctx.shadowColor = p.color; ctx.shadowBlur = p.glow;
      if (p.glyph === "✦") star(ctx, p.size * 0.5, p.color);
      else { ctx.fillStyle = p.color; ctx.font = `900 ${p.size}px "Inter Tight", sans-serif`; ctx.scale(Math.cos(p.age * p.flip) || 1, 1); ctx.fillText("$", 0, 0); }
      ctx.restore();
    }
    if (t < NEB_HOLD + NEB_FADE || ps.some((p) => p.age < p.life)) requestAnimationFrame(frame); else cv.remove();
  };
  requestAnimationFrame(frame);
}
function star(ctx, s, col) {
  ctx.fillStyle = col; ctx.beginPath();
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2, r = i % 2 ? s * 0.25 : s; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
  ctx.closePath(); ctx.fill();
}
