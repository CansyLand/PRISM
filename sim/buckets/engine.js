// Bucketed Uprise market: one shared risk pool, ten Curve Long buckets (x1..x10), one delta-hedged vault as
// the only short. Mirrors the contract in contract/src (bucketed branch): per-bucket NF, shared pool R,
// pro-rata write-down across buckets when total claims reach R, delta-weighted utilization, per-bucket caps.
//
// Funding per bucket, per year:   rate_p = (p(p-1)/2 · σ² · mult_p + baseFee) · m(u)
//   mult_p = 1 + sur · ((p-1)/9)^shape          (x1 = 1, x10 = 1 + sur)
//   u      = min(1, Σ w_p C_p / R),  w_p = 1 + dw · (p-1)
//   m(u)   = prem + slope·u + steep·max(0, u-kink)/(1-kink)
// Daily steps; each day also has an intraday high, and write-downs are checked at the high (a wick that
// prints at the oracle is enough to cut NF, even if the close is lower).
"use strict";

const DT = 1 / 365;

function rng(seed) {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const g = () => Math.sqrt(-2 * Math.log(Math.max(u(), 1e-12))) * Math.cos(2 * Math.PI * u());
  const pois = (l) => { if (l > 40) return Math.max(0, Math.round(l + Math.sqrt(l) * g())); let k = 0, p = 1, L = Math.exp(-l); do { k++; p *= u(); } while (p > L); return k - 1; };
  return { u, g, pois };
}

// ── NEAR-like price paths ──
// Regime-switching volatility (calm ↔ wild), Poisson jumps, intraday wicks. Returns { C: closes, H: highs }.
function nearPath(seed, days, o = {}) {
  const r = rng(seed);
  const volCalm = o.volCalm ?? 0.65, volWild = o.volWild ?? 1.3, pToWild = o.pToWild ?? 1 / 60, pToCalm = o.pToCalm ?? 1 / 20;
  const jumpsPerYear = o.jumps ?? 8, jumpSd = o.jumpSd ?? 0.12, jumpMean = o.jumpMean ?? 0;
  const wicksPerYear = o.wicks ?? 10, wickMax = o.wickMax ?? 0.25;
  const drift = o.drift ?? 0, P0 = o.P0 ?? 5;
  // spd = steps per day (1 = daily, 24 = hourly). jumpSpread = steps a jump is spread over (1 = a true gap).
  const spd = o.spd ?? 1, jumpSpread = o.jumpSpread ?? 1, dt = DT / spd, n = days * spd;
  const C = new Float64Array(n + 1), H = new Float64Array(n);
  C[0] = P0;
  let wild = false, jumpLeft = 0, jumpStep = 0;
  for (let t = 0; t < n; t++) {
    if (t % spd === 0 && (wild ? r.u() < pToCalm : r.u() < pToWild)) wild = !wild;
    const vol = wild ? volWild : volCalm;
    const d = typeof drift === "function" ? drift(Math.floor(t / spd)) : drift;
    let x = (d - vol * vol / 2) * dt + vol * Math.sqrt(dt) * r.g();
    if (r.u() < jumpsPerYear * dt) { jumpStep = (jumpMean + jumpSd * r.g()) / jumpSpread; jumpLeft = jumpSpread; }
    if (jumpLeft > 0) { x += jumpStep; jumpLeft--; }
    C[t + 1] = C[t] * Math.exp(x);
    // intra-step high: brownian-bridge-ish excursion plus occasional wicks
    let hi = Math.max(C[t], C[t + 1]) * Math.exp(Math.abs(r.g()) * vol * Math.sqrt(dt) * 0.5);
    if (r.u() < wicksPerYear * dt) hi *= 1 + 0.05 + r.u() * (wickMax - 0.05);
    H[t] = hi;
  }
  return { C, H, spd };
}

// Real BTC 2020-07..2023-03 daily OHLC, log-moves scaled by `k` (NEAR moves ~1.4× BTC). Window of `days` from `start`.
let BTC = null;
function btcPath(start, days, k = 1.4, P0 = 5) {
  if (!BTC) BTC = require(require("path").join(__dirname, "..", "btc-2020-2023.json"));
  const n = Math.min(days, BTC.c.length - 1 - start);
  const C = new Float64Array(n + 1), H = new Float64Array(n);
  C[0] = P0;
  for (let t = 0; t < n; t++) {
    const a = BTC.c[start + t], b = BTC.c[start + t + 1], hi = BTC.h[start + t + 1];
    C[t + 1] = C[t] * Math.pow(b / a, k);
    H[t] = Math.max(C[t], C[t + 1], C[t] * Math.pow(hi / a, k));
  }
  return { C, H };
}

const MIXES = {
  uniform: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  gentle: [25, 30, 20, 10, 5, 4, 3, 1.5, 1, 0.5],
  steep: [0.5, 1, 1.5, 3, 4, 5, 10, 20, 25, 30],
};

const DEFAULTS = {
  // market
  iv: 0.8, rvWindow: 30, prem: 1.25, slope: 1, kink: 0.5, steep: 4,
  sur: 1, shape: 1, baseFee: 0.1, capB: 0.5, capMax: 0.5, capExp: 1, dw: 0.5,
  maxOpen: 0.2, tradeFee: 0.001, cut: 0.1, minTicket: 10,
  // vault
  V: 1e6, s: 0.5, borrow: 0.06, slip: 0.0005,
  // retail
  N: 200, T: 400, H: 30, mix: "uniform",
};

const multOf = (cfg, p) => 1 + cfg.sur * Math.pow((p - 1) / 9, cfg.shape);
const capOf = (cfg, p) => Math.min(cfg.capMax, cfg.capB / Math.pow(p, cfg.capExp ?? 1));
const weightOf = (cfg, p) => 1 + cfg.dw * (p - 1);

function run(path, cfgIn, seed) {
  const cfg = { ...DEFAULTS, ...cfgIn };
  const P = path.C, HI = path.H, D = P.length, r = rng(seed);
  const spd = path.spd || 1, DT = 1 / 365 / spd; // steps per day; everything below is per step
  const mix = MIXES[cfg.mix], wsum = mix.reduce((a, b) => a + b, 0);
  const pickP = () => { let x = r.u() * wsum; for (let i = 0; i < 10; i++) { x -= mix[i]; if (x <= 0) return i + 1; } return 10; };
  const P0 = P[0];
  const U = new Float64Array(11), NF = new Float64Array(11).fill(1);
  const mult = [0], cap = [0], wt = [0];
  for (let p = 1; p <= 10; p++) { mult.push(multOf(cfg, p)); cap.push(capOf(cfg, p)); wt.push(weightOf(cfg, p)); }
  const idx = (px, p) => Math.pow(px / P0, p);
  const claimP = (px, p) => U[p] > 0 ? U[p] * NF[p] * idx(px, p) : 0;
  const claims = (px) => { let s = 0; for (let p = 1; p <= 10; p++) s += claimP(px, p); return s; };
  const delta = (px) => { let s = 0; for (let p = 1; p <= 10; p++) s += p * claimP(px, p); return s; };
  const wclaims = (px) => { let s = 0; for (let p = 1; p <= 10; p++) s += wt[p] * claimP(px, p); return s; };

  let R = cfg.V * cfg.s, K = cfg.V - R, q = 0, shares = cfg.V;
  const lots = [], done = [];
  const st = {
    writeDowns: 0, writtenOff: 0, writtenOffClaims: 0, opens: 0, refusedCap: 0, clippedCap: 0, refusedPool: 0,
    fundingBy: new Float64Array(11), convexBy: new Float64Array(11), heldBy: new Float64Array(11), protocol: 0, hedgeCost: 0,
    borrow: 0, sumU: 0, maxU: 0, peak: 1, mdd: 0,
  };
  const rets = [];
  let nav = cfg.V;
  for (let t = 0; t < D; t++) {
    const px = P[t];
    // ── arrivals ──
    if (t < D - 1) {
      const n = r.pois(cfg.N / cfg.H / spd);
      for (let i = 0; i < n; i++) {
        const p = pickP();
        let amt = Math.min(250000, Math.max(cfg.minTicket, Math.exp(Math.log(cfg.T) + r.g())));
        const Ct = claims(px);
        if (Ct >= R || R - Ct < 1e-6) { st.refusedPool++; continue; }
        amt = Math.min(amt, cfg.maxOpen * R);
        // bucket cap: C_p + net ≤ cap_p · (R + net)  →  net ≤ (cap·R − C_p) / (1 − cap)
        const room = (cap[p] * R - claimP(px, p)) / (1 - cap[p]) / (1 - cfg.tradeFee);
        if (room < cfg.minTicket) { st.refusedCap++; continue; }
        if (amt > room) { amt = room; st.clippedCap++; }
        const fee = amt * cfg.tradeFee, net = amt - fee, units = net / (NF[p] * idx(px, p));
        U[p] += units; R += net; st.protocol += fee; st.opens++;
        lots.push({ p, units, amt, t0: t, exit: t + Math.max(1, Math.ceil(-Math.log(Math.max(1e-9, r.u())) * cfg.H * spd)), tp: 0.3 + r.u() * 3, sl: 0.4 + r.u() * 0.55 });
      }
    }
    // ── exits ──
    let Ct = claims(px);
    for (let i = lots.length - 1; i >= 0; i--) {
      const lot = lots[i];
      if (lot.t0 === t) continue;
      let v = lot.units * NF[lot.p] * idx(px, lot.p);
      if (Ct > R) v *= R / Ct;
      if (t >= lot.exit || v >= lot.amt * (1 + lot.tp) || v <= lot.amt * (1 - lot.sl) || t === D - 1) {
        const fee = t === D - 1 ? 0 : v * cfg.tradeFee;
        R -= v; U[lot.p] -= lot.units; if (U[lot.p] < 1e-12) U[lot.p] = 0; st.protocol += fee;
        Ct = claims(px);
        done.push({ p: lot.p, amt: lot.amt, out: v - fee, days: t - lot.t0 });
        lots[i] = lots[lots.length - 1]; lots.pop();
      }
    }
    // ── marks ──
    const C = Math.min(Ct, R), F = R - C;
    nav = F + K + q * px;
    const price = nav / shares;
    st.peak = Math.max(st.peak, price); st.mdd = Math.max(st.mdd, 1 - price / st.peak);
    const u = R > 0 ? Math.min(1, wclaims(px) / R) : 0;
    st.sumU += u; st.maxU = Math.max(st.maxU, u);
    for (let p = 1; p <= 10; p++) st.heldBy[p] += claimP(px, p) * DT;
    if (t === D - 1) break;
    // ── hedge: hold Σ p·C_eff,p of the asset (contract: delta_claims × vault share; vault is 100% of shorts here) ──
    const hcap = Ct > 0 ? Math.min(1, R / Ct) : 1;
    const target = delta(px) * hcap / px, trade = target - q, cost = Math.abs(trade) * px * cfg.slip;
    K -= trade * px + cost; q = target; st.hedgeCost += cost;
    // ── funding ──
    if (t > 0) rets.push(Math.log(P[t] / P[t - 1]));
    if (rets.length > cfg.rvWindow * spd) rets.shift();
    let sig = cfg.iv;
    if (rets.length >= 10) { let s2 = 0; for (const x of rets) s2 += x * x; sig = Math.max(sig, Math.min(3, Math.sqrt(s2 / rets.length * 365 * spd))); }
    const m = cfg.prem + cfg.slope * u + cfg.steep * Math.max(0, u - cfg.kink) / (1 - cfg.kink);
    const before = C;
    for (let p = 1; p <= 10; p++) {
      if (U[p] === 0) continue;
      const conv = p * (p - 1) / 2 * sig * sig;
      const rate = (conv * mult[p] + cfg.baseFee) * m;
      const c0 = claimP(px, p);
      NF[p] *= Math.exp(-rate * DT);
      st.fundingBy[p] += c0 - claimP(px, p);
      st.convexBy[p] += c0 * conv * DT;
    }
    const fund = before - Math.min(claims(px), R), cutAmt = fund * cfg.cut;
    R -= cutAmt; st.protocol += cutAmt;
    if (K < 0) { const b = -K * cfg.borrow * DT; K -= b; st.borrow += b; }
    // ── price moves via the intraday high; write down at the high, then at the close ──
    for (const x of [HI[t], P[t + 1]]) {
      const cr = claims(x);
      if (R > 0 && cr >= R) {
        st.writeDowns++; st.writtenOff += cr - R; st.writtenOffClaims += cr;
        const f = R / cr; for (let p = 1; p <= 10; p++) NF[p] *= f;
      }
    }
  }
  const years = (D - 1) / 365 / spd;
  const apy = Math.pow(Math.max(nav / shares, 1e-9), 1 / years) - 1;
  return { apy, mdd: st.mdd, st, done, years, avgU: st.sumU / D };
}

module.exports = { run, nearPath, btcPath, rng, MIXES, DEFAULTS, multOf, capOf, weightOf };
