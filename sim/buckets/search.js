// Parameter search for the bucketed market (x1..x10 in one pool, hedged vault as the only short).
// Usage: node sim/buckets/search.js [paths-per-scenario] > sim/buckets/search-results.txt
// Stage 1: funding curve (surcharge size and shape), x1 base fee, per-bucket caps, delta weight.
// Stage 2: utilization multiplier m(u) (premium, kink, steepness) for the best stage-1 settings.
// Stage 3: the chosen setting on 4× the paths, per scenario, per bucket, plus stress mixes and sizes.
"use strict";
const { run, multOf, capOf, weightOf } = require("./engine");
const { SCENARIOS } = require("./scenarios");

const PATHS = Number(process.argv[2] || 8);
const SCEN = Object.keys(SCENARIOS);
const pathCache = {};
const pathOf = (s, k) => (pathCache[s + k] ||= SCENARIOS[s](k));
const q = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const pc = (v, d = 1) => (v >= 0 ? "+" : "") + (v * 100).toFixed(d) + "%";

function evaluate(cfg, paths = PATHS, scen = SCEN) {
  const apy = [], mdd = [], by = {};
  let pathsWd = 0, wdEvents = 0, writtenOff = 0, heldYears = 0, opens = 0, refusedCap = 0, clippedCap = 0, n = 0, avgU = 0;
  const inB = new Float64Array(11), outB = new Float64Array(11), winB = new Float64Array(11), nB = new Float64Array(11), x2B = new Float64Array(11);
  const fundB = new Float64Array(11), convB = new Float64Array(11), heldB = new Float64Array(11);
  const multiples = Array.from({ length: 11 }, () => []);
  for (const s of scen) {
    by[s] = { apy: [], wd: 0 };
    for (let k = 0; k < paths; k++) {
      const r = run(pathOf(s, k), cfg, 900 + k * 7 + s.length);
      n++; apy.push(r.apy); mdd.push(r.mdd); by[s].apy.push(r.apy); avgU += r.avgU;
      if (r.st.writeDowns > 0) { pathsWd++; by[s].wd++; }
      wdEvents += r.st.writeDowns; writtenOff += r.st.writtenOff;
      opens += r.st.opens; refusedCap += r.st.refusedCap; clippedCap += r.st.clippedCap;
      for (let p = 1; p <= 10; p++) { fundB[p] += r.st.fundingBy[p]; convB[p] += r.st.convexBy[p]; heldB[p] += r.st.heldBy[p]; heldYears += r.st.heldBy[p]; }
      for (const d of r.done) { inB[d.p] += d.amt; outB[d.p] += d.out; nB[d.p]++; const m = d.out / d.amt; winB[d.p] += m > 1; x2B[d.p] += m >= 2; multiples[d.p].push(m); }
    }
  }
  const bucket = [];
  for (let p = 1; p <= 10; p++) bucket.push({
    p, rtp: outB[p] / inB[p], win: winB[p] / nB[p], x2: x2B[p] / nB[p], p95: q(multiples[p], 0.95), med: q(multiples[p], 0.5),
    fundYr: fundB[p] / heldB[p], convYr: convB[p] / heldB[p], fundOverConv: convB[p] > 0 ? fundB[p] / convB[p] : NaN, share: heldB[p] / heldYears,
  });
  let totIn = 0, totOut = 0; for (let p = 1; p <= 10; p++) { totIn += inB[p]; totOut += outB[p]; }
  return {
    cfg, med: q(apy, 0.5), p10: q(apy, 0.1), p5: q(apy, 0.05), worst: q(apy, 0), mdd90: q(mdd, 0.9),
    wdPathFreq: pathsWd / n, wdPerYear: wdEvents / n, writtenOffPerYear: writtenOff / n,
    capRefused: refusedCap / Math.max(1, opens + refusedCap), capClipped: clippedCap / Math.max(1, opens),
    rtp: totOut / totIn, minRtp: Math.min(...bucket.map((b) => b.rtp)), avgU: avgU / n,
    scen: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { med: q(v.apy, 0.5), p10: q(v.apy, 0.1), wd: v.wd / v.apy.length }])),
    bucket,
  };
}

const label = (c) => `sur=${c.sur} shape=${c.shape} base=${pc(c.baseFee, 0)} capB=${c.capB} dw=${c.dw} prem=${c.prem} kink=${c.kink} steep=${c.steep}`;
const line = (r) => `${label(r.cfg).padEnd(78)} | vault med ${pc(r.med).padStart(6)} p10 ${pc(r.p10).padStart(6)} p5 ${pc(r.p5).padStart(6)} dd90 ${pc(-r.mdd90).padStart(6)} | write-down paths ${(r.wdPathFreq * 100).toFixed(1).padStart(4)}% (${r.wdPerYear.toFixed(2)}/yr) | cap-refused ${(r.capRefused * 100).toFixed(1)}% | retail $1→$${r.rtp.toFixed(3)} (min bucket $${r.minRtp.toFixed(3)})`;

// Feasible: vault median ≥ 8%, p10 ≥ 3% (beats staking 9 years in 10), write-downs in ≤ 5% of path-years.
const feasible = (r) => r.med >= 0.08 && r.p10 >= 0.03 && r.wdPathFreq <= 0.05;
// Among feasible, the best deal for retail: total payback, with a penalty if any bucket is far worse than the rest.
const score = (r) => r.rtp + 0.5 * r.minRtp - 2 * r.wdPathFreq;

const out = [];
const log = (s = "") => { out.push(s); process.stderr.write(s + "\n"); };
const t0 = Date.now();

log(`Bucketed search: ${SCEN.length} scenarios (${SCEN.join(", ")}) × ${PATHS} one-year paths each.`);
log(`Vault $1M (50% in the pool, 50% cash for the hedge), 200 open retail positions on average, $400 median ticket, 30-day holds, uniform across x1..x10.`);
log(`Feasible = vault median ≥ +8%, p10 ≥ +3%, write-downs in ≤ 5% of path-years. Score = retail payback + 0.5 × worst bucket's payback − 2 × write-down frequency.\n`);

// ── stage 1 ──
const S1 = { prem: 1.25, kink: 0.5, steep: 4, slope: 1 };
const curves = [{ sur: 0, shape: 1 }];
for (const sur of [0.5, 1, 1.5, 2, 3]) for (const shape of [0.5, 1, 2]) curves.push({ sur, shape });
const grid1 = [];
for (const c of curves) for (const baseFee of [0, 0.05, 0.1, 0.2]) for (const capB of [0.25, 0.5, 1, 5]) for (const dw of [0, 0.25, 0.5, 1])
  grid1.push({ ...S1, ...c, baseFee, capB, dw });
const rows1 = grid1.map((g, i) => { if (i % 100 === 0) process.stderr.write(`stage 1: ${i}/${grid1.length} ${((Date.now() - t0) / 1000).toFixed(0)}s\n`); return evaluate(g); });
const f1 = rows1.filter(feasible).sort((a, b) => score(b) - score(a));
log(`── Stage 1: ${grid1.length} settings, ${f1.length} feasible. Top 15:`);
f1.slice(0, 15).forEach((r) => log("  " + line(r)));
log(`\n  Surcharge curve alone (base fee 10%, capB 0.5, dw 0.5): what x10 pays vs convexity, and the vault`);
rows1.filter((r) => r.cfg.baseFee === 0.1 && r.cfg.capB === 0.5 && r.cfg.dw === 0.5).forEach((r) => log("  " + line(r)));
log(`\n  x1 base fee (sur 1, shape 1, capB 0.5, dw 0.5):`);
rows1.filter((r) => r.cfg.sur === 1 && r.cfg.shape === 1 && r.cfg.capB === 0.5 && r.cfg.dw === 0.5).forEach((r) => log(`  ${line(r)}  | x1 $1→$${r.bucket[0].rtp.toFixed(3)} x1 funding ${pc(r.bucket[0].fundYr)}/yr`));
log(`\n  Caps (sur 1, shape 1, base 10%, dw 0.5):`);
rows1.filter((r) => r.cfg.sur === 1 && r.cfg.shape === 1 && r.cfg.baseFee === 0.1 && r.cfg.dw === 0.5).forEach((r) => log("  " + line(r)));
log(`\n  Delta weight (sur 1, shape 1, base 10%, capB 0.5):`);
rows1.filter((r) => r.cfg.sur === 1 && r.cfg.shape === 1 && r.cfg.baseFee === 0.1 && r.cfg.capB === 0.5).forEach((r) => log(`  ${line(r)}  | avg u ${pc(r.avgU, 0)}`));

// ── stage 2 ──
// The user's decision pins x10 at ~2× its convexity rate: keep sur ≈ 1 candidates first, then the best of the rest.
const pinned = f1.filter((r) => r.cfg.sur === 1);
const seeds = [...pinned.slice(0, 4), ...f1.filter((r) => r.cfg.sur !== 1).slice(0, 2)];
const grid2 = [];
for (const s of seeds) for (const prem of [1, 1.1, 1.25, 1.5]) for (const kink of [0.4, 0.5, 0.6, 0.75]) for (const steep of [4, 10, 20])
  grid2.push({ ...s.cfg, prem, kink, steep });
const rows2 = grid2.map((g, i) => { if (i % 50 === 0) process.stderr.write(`stage 2: ${i}/${grid2.length} ${((Date.now() - t0) / 1000).toFixed(0)}s\n`); return evaluate(g); });
const f2 = rows2.filter(feasible).sort((a, b) => score(b) - score(a));
log(`\n── Stage 2: utilization multiplier for ${seeds.length} stage-1 seeds, ${grid2.length} settings, ${f2.length} feasible. Top 15:`);
f2.slice(0, 15).forEach((r) => log("  " + line(r)));
const f2pinned = f2.filter((r) => r.cfg.sur === 1);
log(`\n  Best with x10 pinned at 2× (sur = 1):`);
f2pinned.slice(0, 8).forEach((r) => log("  " + line(r)));

const chosen = (f2pinned[0] || f2[0] || f1[0]).cfg;
// ── stage 3: validation ──
const big = PATHS * 4;
const V = evaluate(chosen, big);
log(`\n── Stage 3: chosen setting on ${big} paths per scenario (${big * SCEN.length} path-years)`);
log(`  ${label(chosen)}`);
log(`  per-bucket multiplier mult_p: ${Array.from({ length: 10 }, (_, i) => multOf({ ...chosen }, i + 1).toFixed(2)).join(" ")}`);
log(`  per-bucket cap (share of pool): ${Array.from({ length: 10 }, (_, i) => pc(capOf({ capMax: 0.5, ...chosen }, i + 1), 0)).join(" ")}`);
log(`  utilization weight w_p: ${Array.from({ length: 10 }, (_, i) => weightOf(chosen, i + 1).toFixed(2)).join(" ")}`);
log(`  vault APY median ${pc(V.med)}, p10 ${pc(V.p10)}, p5 ${pc(V.p5)}, worst ${pc(V.worst)}, 90th-pct drawdown ${pc(-V.mdd90)}`);
log(`  write-downs: ${(V.wdPathFreq * 100).toFixed(1)}% of path-years, ${V.wdPerYear.toFixed(3)} events/yr, $${V.writtenOffPerYear.toFixed(0)} written off per year on average`);
log(`  opens refused by a bucket cap ${(V.capRefused * 100).toFixed(1)}%, clipped ${(V.capClipped * 100).toFixed(1)}%; average utilization ${pc(V.avgU, 0)}`);
log(`  per scenario:`);
for (const [k, v] of Object.entries(V.scen)) log(`    ${k.padEnd(6)} vault med ${pc(v.med).padStart(6)} p10 ${pc(v.p10).padStart(6)}  write-down paths ${(v.wd * 100).toFixed(0)}%`);
log(`  per bucket (retail):`);
for (const b of V.bucket) log(`    x${String(b.p).padEnd(2)} $1→$${b.rtp.toFixed(3)}  win ${(b.win * 100).toFixed(0).padStart(2)}%  ≥2× ${(b.x2 * 100).toFixed(1).padStart(4)}%  median ${b.med.toFixed(2)}×  p95 ${b.p95.toFixed(2)}×  funding ${pc(b.fundYr).padStart(7)}/yr  convexity ${pc(b.convYr).padStart(7)}/yr  paid/convexity ${isFinite(b.fundOverConv) ? b.fundOverConv.toFixed(2) + "×" : "—"}  share of claims ${pc(b.share, 0)}`);

log(`\n  Stress (chosen setting, ${PATHS * 2} paths per scenario):`);
const stress = [
  ["steep mix (most retail in x8-x10)", { mix: "steep" }],
  ["gentle mix (most retail in x1-x3)", { mix: "gentle" }],
  ["400 open positions", { N: 400 }],
  ["800 open positions", { N: 800 }],
  ["100 open positions", { N: 100 }],
  ["$5k median ticket (whales)", { T: 5000 }],
  ["vault puts 80% in the pool", { s: 0.8 }],
  ["no caps", { capB: 100, capMax: 0.99 }],
  ["no surcharge (sur 0)", { sur: 0 }],
  ["no delta weight (dw 0)", { dw: 0 }],
  ["no x1 base fee", { baseFee: 0 }],
  ["looser caps (capB 0.5)", { capB: 0.5 }],
  ["vol floor 60% (iv)", { iv: 0.6 }],
  ["vol floor 100% (iv)", { iv: 1.0 }],
  ["hedge slippage 0.3%", { slip: 0.003 }],
];
for (const [name, o] of stress) { const r = evaluate({ ...chosen, ...o }, PATHS * 2); log(`    ${name.padEnd(36)} ${line(r).split("|").slice(1).join("|")}`); }
log(`\n  Contract defaults derived from this: see README.md. Runtime ${((Date.now() - t0) / 1000).toFixed(0)}s.`);
console.log(out.join("\n"));
console.log("\nCHOSEN " + JSON.stringify(chosen));
