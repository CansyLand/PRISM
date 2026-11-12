// Slim card next to "Curve Long": the shape of the chosen strength. X = price move, Y = your PnL.
// The curve morphs smoothly when the slider moves; with an open position a dot shows where you are.
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export class CurveCard {
  constructor(canvas) { this.cv = canvas; this.p = 5; this.shown = 5; this.R = 0.15; // x range: price −R … +R, widens to follow an open position
    this.at = null; this.raf = 0; this.kick(); }
  set(p, at = null) { this.p = p; this.at = Number.isFinite(at) ? at : null; this.kick(); }
  kick() { if (!this.raf) this.raf = requestAnimationFrame(() => this.frame()); }
  frame() {
    this.raf = 0;
    const d = this.p - this.shown; this.shown = Math.abs(d) < 0.005 ? this.p : this.shown + d * 0.18;
    const wantR = Math.min(0.6, Math.max(0.15, Math.abs(this.at ?? 0) * 1.2)); this.R += (wantR - this.R) * 0.1;
    this.draw();
    if (this.shown !== this.p || this.at != null) this.kick();
  }
  draw() {
    const cv = this.cv, rect = cv.getBoundingClientRect(); if (!rect.width) return;
    const dpr = devicePixelRatio || 1; cv.width = rect.width * dpr; cv.height = rect.height * dpr;
    const ctx = cv.getContext("2d"); ctx.scale(dpr, dpr);
    const W = rect.width, H = rect.height, p = this.shown, R = this.R, f = (r) => Math.pow(1 + r, p) - 1;
    const top = Math.max(0.2, f(R)) * 1.08, bot = Math.min(-0.2, f(-R)) * 1.08, pl = 4, pr = 4, pt = 8, pb = 16;
    const X = (r) => pl + (r + R) / (2 * R) * (W - pl - pr), Y = (v) => pt + (top - v) / (top - bot) * (H - pt - pb);
    // axes
    ctx.strokeStyle = css("--line"); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pl, Y(0)); ctx.lineTo(W - pr, Y(0)); ctx.moveTo(X(0), pt); ctx.lineTo(X(0), H - pb); ctx.stroke();
    // 1× reference
    ctx.setLineDash([3, 3]); ctx.strokeStyle = css("--muted"); ctx.beginPath(); ctx.moveTo(X(-R), Y(-R)); ctx.lineTo(X(R), Y(R)); ctx.stroke(); ctx.setLineDash([]);
    // the curve: red below zero, green above
    for (const [a, b, col] of [[-R, 0, "--down"], [0, R, "--up"]]) {
      ctx.beginPath();
      for (let k = 0; k <= 40; k++) { const r = a + (b - a) * k / 40; k ? ctx.lineTo(X(r), Y(f(r))) : ctx.moveTo(X(r), Y(f(r))); }
      ctx.strokeStyle = css(col); ctx.lineWidth = 3; ctx.lineCap = "round"; ctx.stroke();
    }
    // ±10% markers
    ctx.font = `700 10px ${css("--mono")}`;
    for (const r of [0.1, -0.1]) {
      const v = f(r), up = r > 0; ctx.fillStyle = css(up ? "--up" : "--down");
      ctx.beginPath(); ctx.arc(X(r), Y(v), 3.5, 0, 7); ctx.fill();
      ctx.textAlign = up ? "right" : "left"; ctx.fillText(pctTxt(v), X(r) + (up ? -6 : 4), up ? Y(v) + 4 : Math.min(H - pb - 3, Y(v) + 15));
    }
    // where an open position is right now
    if (this.at != null) {
      const r = this.at, v = f(r), pulse = 4 + 2 * Math.sin(performance.now() / 180);
      ctx.fillStyle = css("--ink"); ctx.beginPath(); ctx.arc(X(r), Y(v), pulse, 0, 7); ctx.fill();
    }
    ctx.fillStyle = css("--muted"); ctx.font = `600 9.5px ${css("--font")}`;
    ctx.textAlign = "left"; ctx.fillText(pctTxt(-R), pl, H - 3); ctx.textAlign = "right"; ctx.fillText(pctTxt(R), W - pr, H - 3);
    ctx.textAlign = "center"; ctx.fillText("price", X(0), H - 3);
  }
}
export const pctTxt = (v) => (v >= 0 ? "+" : "−") + Math.abs(v * 100).toFixed(0) + "%";
