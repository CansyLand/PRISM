// Candlestick chart on a canvas. The last candle can be "forming": its price walks
// open → one wick → the other wick → close, and the body and wicks grow as it goes.
import { css, fit } from "./theme.js";

export class CandleChart {
  constructor(canvas, { maxCandles = 70 } = {}) {
    this.cv = canvas; this.max = maxCandles; this.candles = []; this.forming = null; this.marks = [];
    new ResizeObserver(() => this.draw()).observe(canvas);
  }
  /** Replace all candles: [[o,h,l,c], …] (or [t,o,h,l,c] rows from the API). */
  set(rows) { this.candles = rows.map((r) => (r.length === 5 ? r.slice(1) : r.slice())); this.forming = null; this.draw(); }
  /** Start animating a new candle toward [o,h,l,c] over `ms`. Resolves when it's closed. */
  play([o, h, l, c], ms) {
    if (this.forming) this.finish();
    const path = c >= o ? [o, l, h, c] : [o, h, l, c]; // bulls usually dip first, bears spike first
    this.forming = { target: [o, h, l, c], path, t0: performance.now(), ms, live: [o, o, o, o] };
    return new Promise((done) => (this.forming.done = done));
  }
  finish() { if (!this.forming) return; this.candles.push(this.forming.target); this.forming.done?.(); this.forming = null; }
  /** Live mode: update the forming candle with a fresh price tick. */
  tick(price) {
    const last = this.candles[this.candles.length - 1];
    if (!last) return;
    last[1] = Math.max(last[1], price); last[2] = Math.min(last[2], price); last[3] = price; this.draw();
  }
  price() { if (this.forming) return this.forming.live[3]; const l = this.candles[this.candles.length - 1]; return l ? l[3] : 0; }
  /** Horizontal marker, e.g. the entry price. */
  mark(price, label) { this.marks = price ? [{ price, label }] : []; this.draw(); }

  step(now) {
    const f = this.forming; if (!f) return;
    const x = Math.min(1, Math.max(0, (now - f.t0) / f.ms)), seg = Math.min(2, Math.floor(x * 3)), u = x * 3 - seg;
    const p = f.path[seg] + (f.path[seg + 1] - f.path[seg]) * (x >= 1 ? 1 : u);
    f.live = [f.target[0], Math.max(f.live[1], p), Math.min(f.live[2], p), p];
    if (x >= 1) this.finish();
  }

  draw() {
    const cv = this.cv, r = cv.getBoundingClientRect(); if (!r.width) return;
    const fitted = fit(cv); if (!fitted) return; const { ctx } = fitted;
    const all = [...this.candles.slice(-(this.max - (this.forming ? 1 : 0)))];
    if (this.forming) all.push(this.forming.live);
    if (!all.length) return;
    let lo = Infinity, hi = -Infinity;
    for (const [, h, l] of all) { lo = Math.min(lo, l); hi = Math.max(hi, h); }
    for (const m of this.marks) { lo = Math.min(lo, m.price); hi = Math.max(hi, m.price); }
    const pad = (hi - lo) * 0.08 || hi * 0.01; lo -= pad; hi += pad;
    const W = r.width - 52, H = r.height, n = Math.max(all.length, Math.min(this.max, 40)), cw = W / n;
    const Y = (v) => (1 - (v - lo) / (hi - lo)) * (H - 8) + 4;
    // grid + price labels
    ctx.font = `10.5px ${css("--mono")}`; ctx.textAlign = "left";
    for (let k = 0; k <= 3; k++) {
      const v = lo + (hi - lo) * k / 3, y = Y(v);
      ctx.fillStyle = css("--line"); ctx.fillRect(0, Math.round(y), W, 1);
      ctx.fillStyle = css("--muted"); ctx.fillText(fmtP(v), W + 6, y + 3.5);
    }
    const up = css("--up"), down = css("--down");
    all.forEach(([o, h, l, c], i) => {
      const x = i * cw + cw / 2, col = c >= o ? up : down;
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = Math.max(1, cw * 0.12);
      ctx.beginPath(); ctx.moveTo(x, Y(h)); ctx.lineTo(x, Y(l)); ctx.stroke();
      const top = Y(Math.max(o, c)), bot = Y(Math.min(o, c)), bw = Math.max(1.5, cw * 0.62);
      ctx.fillRect(x - bw / 2, top, bw, Math.max(1.2, bot - top));
    });
    // last price line
    const last = all[all.length - 1][3], ly = Y(last);
    ctx.setLineDash([3, 3]); ctx.strokeStyle = css("--muted"); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(W, ly); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = last >= all[all.length - 1][0] ? up : down; ctx.fillRect(W + 2, ly - 8, 50, 16);
    ctx.fillStyle = "#fff"; ctx.fillText(fmtP(last), W + 6, ly + 3.5);
    for (const m of this.marks) {
      const y = Y(m.price); ctx.strokeStyle = css("--accent"); ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = css("--accent"); ctx.font = `600 11px ${css("--font")}`; ctx.fillText(m.label, 4, y - 5);
    }
  }
}
export const fmtP = (v) => (v >= 1000 ? "$" + Math.round(v).toLocaleString("en-US") : "$" + v.toFixed(v >= 10 ? 2 : 3));
