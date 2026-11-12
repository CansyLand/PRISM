// x¹⁰ celebration ("Stickers, white edge"): a white flash and a thick white shockwave ring, then $ signs
// like die-cut vinyl stickers (lime, cobalt, rose or ink fill with a white outline) that spin and flip,
// and lime/white sparkles with a thin ink edge. Flat, no glow, so it reads on the rose and lime design.
// Draws on a full-screen canvas that only exists while it runs.
const rnd = (a, b) => a + Math.random() * (b - a), pick = (a) => a[Math.floor(Math.random() * a.length)];
const INK = "#1d1530", FILLS = ["#e4f36b", "#3557ff", "#f77fa6", INK], SPARKS = ["#ffffff", "#e4f36b"];

export function supernova(x, y) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cv = document.createElement("canvas"); cv.className = "celebrate"; document.body.append(cv);
  const dpr = devicePixelRatio || 1, W = innerWidth, H = innerHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext("2d"), ps = [];
  const add = (p) => ps.push(Object.assign({ x, y, vx: 0, vy: 0, g: 240, drag: 0.97, rot: rnd(0, 6.28), vr: rnd(-8, 8), age: 0, life: rnd(1.4, 2.2), size: rnd(16, 36), color: pick(FILLS), glyph: "$", flip: rnd(3, 8), tw: rnd(0, 6.28) }, p));
  for (let i = 0; i < 60; i++) { const a = rnd(0, Math.PI * 2), v = rnd(200, 600); add({ vx: Math.cos(a) * v, vy: Math.sin(a) * v }); }
  for (let i = 0; i < 50; i++) { const a = rnd(0, Math.PI * 2), v = rnd(80, 420); add({ vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 100, glyph: "✦", size: rnd(8, 18), color: pick(SPARKS), glitter: true, life: rnd(1, 1.8), flip: 0 }); }
  let t = 0, last = performance.now();
  const frame = (now) => {
    const dt = Math.max(0, Math.min(0.033, (now - last) / 1000)); last = now; t += dt;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    if (t < 0.35) { const a = 1 - t / 0.35, g = ctx.createRadialGradient(x, y, 0, x, y, 220); g.addColorStop(0, `rgba(255,255,255,${0.9 * a})`); g.addColorStop(1, "rgba(255,255,255,0)"); ctx.fillStyle = g; ctx.fillRect(x - 220, y - 220, 440, 440); }
    if (t < 0.7) { const a = 1 - t / 0.7; ctx.save(); ctx.globalAlpha = a; ctx.strokeStyle = "#fff"; ctx.lineWidth = 8 * a + 1.5; ctx.beginPath(); ctx.arc(x, y, t * 520, 0, 7); ctx.stroke(); ctx.restore(); }
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
    for (const p of ps) {
      p.age += dt; p.vx *= p.drag; p.vy = p.vy * p.drag + p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      const fade = Math.max(0, Math.min(1, (p.life - p.age) / 0.5)), tw = p.glitter ? 0.65 + 0.35 * Math.sin(p.age * 18 + p.tw) : 1;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = fade * tw;
      if (p.glyph === "✦") star(ctx, p.size * 0.5, p.color);
      else {
        ctx.font = `900 ${p.size}px "Inter Tight", sans-serif`; ctx.scale(Math.cos(p.age * p.flip) || 1, 1);
        ctx.lineWidth = 4.5; ctx.strokeStyle = "#fff"; ctx.strokeText("$", 0, 0); // the white sticker edge
        ctx.fillStyle = p.color; ctx.fillText("$", 0, 0);
      }
      ctx.restore();
    }
    if (ps.some((p) => p.age < p.life)) requestAnimationFrame(frame); else cv.remove();
  };
  requestAnimationFrame(frame);
}
function star(ctx, s, col) {
  ctx.fillStyle = col; ctx.beginPath();
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2, r = i % 2 ? s * 0.25 : s; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
  ctx.closePath(); ctx.lineWidth = 1.5; ctx.strokeStyle = INK; ctx.lineJoin = "round"; ctx.stroke(); ctx.fill();
}
