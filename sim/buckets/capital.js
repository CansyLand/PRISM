// How much vault capital keeps the bucketed market stable? Sweeps vault size against retail flow.
// Usage: node sim/buckets/capital.js 8 > sim/buckets/capital-results.txt
"use strict";
const { run } = require("./engine");
const { SCENARIOS } = require("./scenarios");
const CHOSEN = { prem: 1, kink: 0.4, steep: 10, slope: 1, sur: 1, shape: 2, baseFee: 0.1, capB: 0.25, dw: 0.5 };
const PATHS = Number(process.argv[2] || 8), SCEN = Object.keys(SCENARIOS), cache = {};
const pathOf = (s, k) => (cache[s + k] ||= SCENARIOS[s](k));
const q = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const pc = (v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";

function ev(cfg) {
  const apy = [], mdd = [];
  let wd = 0, n = 0, inn = 0, out = 0, refused = 0, opens = 0;
  for (const s of SCEN) for (let k = 0; k < PATHS; k++) {
    const r = run(pathOf(s, k), cfg, 900 + k * 7 + s.length);
    apy.push(r.apy); mdd.push(r.mdd); n++; wd += r.st.writeDowns > 0;
    refused += r.st.refusedCap + r.st.refusedPool; opens += r.st.opens;
    for (const d of r.done) { inn += d.amt; out += d.out; }
  }
  return { med: q(apy, 0.5), p5: q(apy, 0.05), worst: q(apy, 0), dd90: q(mdd, 0.9), wd: wd / n, rtp: out / inn, refused: refused / (opens + refused) };
}

const L = [];
const row = (label, r) => L.push(`${label.padEnd(26)} vault med ${pc(r.med).padStart(8)} p5 ${pc(r.p5).padStart(8)} worst ${pc(r.worst).padStart(8)} dd90 ${pc(-r.dd90).padStart(7)} | write-down years ${(r.wd * 100).toFixed(1).padStart(5)}% | refused ${(r.refused * 100).toFixed(1).padStart(5)}% | retail $1→$${r.rtp.toFixed(2)}`);
L.push(`Capital sweep, chosen setting, ${SCEN.length} scenarios × ${PATHS} one-year paths. Retail: N open positions on average, $400 median ticket.\n`);
L.push(`── 1. Fixed retail flow (200 open positions), vault size varies`);
for (const V of [50e3, 100e3, 200e3, 350e3, 500e3, 750e3, 1e6, 2e6, 5e6, 10e6]) row(`vault $${V / 1e3}k`, ev({ ...CHOSEN, V, N: 200 }));
L.push(`\n── 2. Fixed vault ($1M), retail flow varies`);
for (const N of [25, 50, 100, 200, 400, 800, 1600, 3200]) row(`${N} open`, ev({ ...CHOSEN, N }));
L.push(`\n── 3. Same ratio at different scale (vault $1M : 200 open, scaled together)`);
for (const k of [0.1, 0.5, 1, 5, 20]) row(`vault $${1e3 * k}k, ${200 * k} open`, ev({ ...CHOSEN, V: 1e6 * k, N: 200 * k }));
L.push(`\n── 4. Steep mix (most retail in x8-x10), 200 open, vault size varies`);
for (const V of [100e3, 250e3, 500e3, 1e6, 2e6, 5e6]) row(`vault $${V / 1e3}k`, ev({ ...CHOSEN, V, N: 200, mix: "steep" }));
console.log(L.join("\n"));
