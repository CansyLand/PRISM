// Which settings keep the vault from losing money in bad years, at every vault size?
// Every losing year in the main search comes from jumps: a hedge that rebalances can't follow a gap,
// and a gap costs bucket p about (1+J)^p − 1 − pJ, far more than the p(p−1)/2·J² that σ²-priced
// funding charges at high p. The losses grow with vault size because utilization (so m(u)) falls.
// Levers: m(0) floor (prem), surcharge size and shape, caps that tighten faster than 1/p, vol floor.
// Usage: node sim/buckets/nodrawdown.js 8 > sim/buckets/nodrawdown-results.txt
"use strict";
const { run, multOf, capOf } = require("./engine");
const { SCENARIOS } = require("./scenarios");
const PATHS = Number(process.argv[2] || 8), SCEN = Object.keys(SCENARIOS), cache = {};
const pathOf = (s, k) => (cache[s + k] ||= SCENARIOS[s](k));
const q = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const pc = (v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";
const BASE = { kink: 0.4, steep: 10, slope: 1, baseFee: 0.1, N: 200 };
const SIZES = [0.5e6, 1e6, 2e6, 5e6]; // vault : open retail ≈ 4×, 8×, 15×, 38×

function evalAt(cfg, V, paths = PATHS) {
  const apy = [], mdd = []; let wd = 0, n = 0, inn = 0, out = 0;
  const inB = new Float64Array(11), outB = new Float64Array(11);
  for (const s of SCEN) for (let k = 0; k < paths; k++) {
    const r = run(pathOf(s, k), { ...cfg, V }, 900 + k * 7 + s.length);
    apy.push(r.apy); mdd.push(r.mdd); n++; wd += r.st.writeDowns > 0;
    for (const d of r.done) { inn += d.amt; out += d.out; inB[d.p] += d.amt; outB[d.p] += d.out; }
  }
  return { med: q(apy, 0.5), p5: q(apy, 0.05), worst: q(apy, 0), dd90: q(mdd, 0.9), ddMax: q(mdd, 1), wd: wd / n, rtp: out / inn, rtpB: Array.from({ length: 10 }, (_, i) => outB[i + 1] / inB[i + 1]) };
}
function evalAll(cfg, paths) {
  const at = SIZES.map((V) => evalAt(cfg, V, paths));
  return { cfg, at, minP5: Math.min(...at.map((a) => a.p5)), minWorst: Math.min(...at.map((a) => a.worst)), maxDd: Math.max(...at.map((a) => a.dd90)), rtp: at.reduce((s, a) => s + a.rtp, 0) / at.length, maxWd: Math.max(...at.map((a) => a.wd)) };
}
const label = (c) => `prem=${c.prem} sur=${c.sur} shape=${c.shape} capB=${c.capB} capExp=${c.capExp} iv=${c.iv} dw=${c.dw}`;
const line = (r) => `${label(r.cfg).padEnd(62)} | p5 min ${pc(r.minP5).padStart(7)} worst ${pc(r.minWorst).padStart(7)} dd90 max ${pc(-r.maxDd).padStart(7)} write-down ≤ ${(r.maxWd * 100).toFixed(1)}% | medians ${r.at.map((a) => pc(a.med)).join(" / ")} | retail $1→$${r.rtp.toFixed(3)}`;

const grid = [];
for (const prem of [1, 1.25, 1.5, 2]) for (const sur of [1, 2, 3]) for (const shape of [2, 3]) for (const capB of [0.25, 0.5])
  for (const capExp of [1, 1.5, 2]) for (const iv of [0.8, 1.0]) for (const dw of [0.5, 1])
    grid.push({ ...BASE, prem, sur, shape, capB, capExp, iv, dw });

const t0 = Date.now(), rows = [];
grid.forEach((g, i) => { if (i % 50 === 0) process.stderr.write(`${i}/${grid.length} ${((Date.now() - t0) / 1000).toFixed(0)}s\n`); rows.push(evalAll(g)); });
const out = [];
out.push(`No-drawdown search: ${grid.length} settings × vault $0.5M/$1M/$2M/$5M (≈ 4×, 8×, 15×, 38× open retail) × ${SCEN.length} scenarios × ${PATHS} paths.`);
out.push(`Fixed: base fee 10%, kink 40%, steepness 10, 200 open positions. "p5 min" / "worst" = the vault's 5th-percentile / worst year at the worst of the four sizes.\n`);
const today = rows.find((r) => r.cfg.prem === 1 && r.cfg.sur === 1 && r.cfg.shape === 2 && r.cfg.capB === 0.25 && r.cfg.capExp === 1 && r.cfg.iv === 0.8 && r.cfg.dw === 0.5);
out.push(`Current defaults:\n  ${line(today)}\n`);
const A = rows.filter((r) => r.minP5 >= 0).sort((a, b) => b.rtp - a.rtp);
out.push(`── A. p5 ≥ 0 at every size (loses money in < 1 year in 20): ${A.length} settings. Best for retail:`);
A.slice(0, 12).forEach((r) => out.push("  " + line(r)));
const B = rows.filter((r) => r.minWorst >= 0).sort((a, b) => b.rtp - a.rtp);
out.push(`\n── B. No losing year at all, at any size: ${B.length} settings. Best for retail:`);
B.slice(0, 12).forEach((r) => out.push("  " + line(r)));
const C = rows.filter((r) => r.minWorst >= 0 && r.maxDd <= 0.1).sort((a, b) => b.rtp - a.rtp);
out.push(`\n── C. No losing year and 90th-pct intra-year drawdown ≤ 10%: ${C.length} settings. Best for retail:`);
C.slice(0, 8).forEach((r) => out.push("  " + line(r)));
// one lever at a time from today's defaults
out.push(`\n── One lever at a time from the current defaults:`);
for (const [name, o] of [["prem 1.25", { prem: 1.25 }], ["prem 1.5", { prem: 1.5 }], ["prem 2", { prem: 2 }], ["sur 2", { sur: 2 }], ["sur 3", { sur: 3 }], ["shape 3", { shape: 3 }], ["capExp 1.5", { capExp: 1.5 }], ["capExp 2", { capExp: 2 }], ["iv 100%", { iv: 1.0 }], ["dw 1", { dw: 1 }]]) {
  const r = rows.find((x) => Object.entries({ ...today.cfg, ...o }).every(([k, v]) => x.cfg[k] === v));
  if (r) out.push(`  ${name.padEnd(11)} ${line(r).split("|").slice(1).join("|")}`);
}
const pick = (C[0] || B[0] || A[0]);
if (pick) {
  const V = evalAll(pick.cfg, PATHS * 4);
  out.push(`\n── Pick, validated on ${PATHS * 4} paths per scenario:\n  ${line(V)}`);
  out.push(`  surcharge mult_p: ${Array.from({ length: 10 }, (_, i) => multOf(pick.cfg, i + 1).toFixed(2)).join(" ")}`);
  out.push(`  caps: ${Array.from({ length: 10 }, (_, i) => (capOf({ capMax: 0.5, ...pick.cfg }, i + 1) * 100).toFixed(2) + "%").join(" ")}`);
  SIZES.forEach((s, i) => { const a = V.at[i]; out.push(`  vault $${s / 1e6}M: median ${pc(a.med)} p5 ${pc(a.p5)} worst ${pc(a.worst)} dd90 ${pc(-a.dd90)} max dd ${pc(-a.ddMax)} write-down years ${(a.wd * 100).toFixed(1)}% retail $1→$${a.rtp.toFixed(2)}; per bucket ${a.rtpB.map((x) => x.toFixed(2)).join(" ")}`); });
  out.push(`\nPICK ${JSON.stringify(pick.cfg)}`);
}
console.log(out.join("\n"));
