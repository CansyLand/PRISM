// Parameter search for the two-sided setup (retail Curve Long vs one hedged short vault).
// Reuses the engine from two-sided-vault.html, so the page and the search can't drift apart.
// Usage: node sim/search.js > sim/search-results.txt
const fs = require("fs");
const html = fs.readFileSync(__dirname + "/two-sided-vault.html", "utf8");
const src = html.slice(html.indexOf("const DT = 1 / 365"), html.indexOf("// ── controls ──"));
const { run, gbm } = new Function(src + "; return { run, gbm };")();

const BENCH = 0.03, TARGET = 0.07;
const SCEN = [
  { name: "calm", vol: 0.6, drift: 0 },
  { name: "wild", vol: 0.9, drift: 0 },
  { name: "bull", vol: 0.6, drift: 0.8 },
  { name: "bear", vol: 0.6, drift: -0.5 },
];
const PATHS = 8;
const base = { T: 400, H: 30, mix: "uniform", V: 1e6, s: 0.5, borrow: 0.06, slip: 0.0005, iv: 0.6, rv: true, slope: 1, cut: 0.1, hedge: true, flow: false, bench: BENCH };
const grid = [];
for (const N of [50, 100, 200, 400, 800])
  for (const prem of [-0.5, -0.25, 0, 0.25, 0.5, 1])
    for (const pmax of [2, 3, 4, 5, 6, 8, 10])
      for (const sur of [0, 0.5, 1, 2]) {
        if (pmax <= 2 && sur > 0) continue; // surcharge does nothing below p = 3 worth testing
        grid.push({ N, prem, pmax, sur });
      }

const q = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const rows = [];
const t0 = Date.now();
grid.forEach((g, gi) => {
  const cfg = { ...base, ...g }, apy = [], mdd = [], byScen = {};
  let paidIn = 0, paidOut = 0, n = 0, wins = 0, x2 = 0, x5 = 0, best = 0; const rets = [];
  for (const sc of SCEN) {
    byScen[sc.name] = [];
    for (let k = 0; k < PATHS; k++) {
      const P = gbm(100 + k, 365, sc.vol, sc.drift), r = run(P, cfg, 500 + k, false);
      apy.push(r.apy); mdd.push(r.mdd); byScen[sc.name].push(r.apy);
      for (const d of r.done) { paidIn += d.amt; paidOut += d.out; n++; const m = d.out / d.amt; wins += m > 1; x2 += m >= 2; x5 += m >= 5; best = Math.max(best, m); rets.push(m - 1); }
    }
  }
  rows.push({ ...g, med: q(apy, 0.5), p10: q(apy, 0.1), mdd90: q(mdd, 0.9), scen: Object.fromEntries(Object.entries(byScen).map(([k, v]) => [k, q(v, 0.5)])),
    rtp: paidOut / paidIn, win: wins / n, x2: x2 / n, x5: x5 / n, best, medRet: q(rets, 0.5) });
  if (gi % 100 === 0) process.stderr.write(`${gi}/${grid.length} ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
});

const f = (v, d = 1) => (v >= 0 ? "+" : "") + (v * 100).toFixed(d) + "%";
const line = (r) => `N=${String(r.N).padStart(3)} prem=${f(r.prem, 0).padStart(5)} pmax=${String(r.pmax).padStart(2)} sur=${f(r.sur, 0).padStart(5)} | vault med ${f(r.med).padStart(7)} p10 ${f(r.p10).padStart(7)} dd90 ${f(-r.mdd90).padStart(6)} [calm ${f(r.scen.calm)} wild ${f(r.scen.wild)} bull ${f(r.scen.bull)} bear ${f(r.scen.bear)}] | retail $1→$${r.rtp.toFixed(2)} win ${(r.win * 100).toFixed(0)}% 2x ${(r.x2 * 100).toFixed(1)}% 5x ${(r.x5 * 100).toFixed(2)}% best ${r.best.toFixed(1)}x`;
const out = [];
out.push(`Two-sided search: ${grid.length} settings × ${SCEN.length} scenarios × ${PATHS} paths, 1 year each. Vault $1M, ticket $400, hold 30 days, retail picks p uniformly up to pmax.`);
out.push(`Feasible = vault median ≥ ${f(TARGET, 0)} and 10th percentile ≥ ${f(BENCH, 0)} (beats staking in 9 of 10 years). Among feasible, best retail payback.\n`);
for (const N of [50, 100, 200, 400, 800]) {
  const feas = rows.filter((r) => r.N === N && r.med >= TARGET && r.p10 >= BENCH).sort((a, b) => b.rtp - a.rtp);
  out.push(`── ${N} open players (${N * 400 / 1e3}k of tickets vs $1M vault): ${feas.length} feasible`);
  feas.slice(0, 5).forEach((r) => out.push("  " + line(r)));
  if (!feas.length) { const near = rows.filter((r) => r.N === N).sort((a, b) => b.p10 - a.p10).slice(0, 3); out.push("  none; closest:"); near.forEach((r) => out.push("  " + line(r))); }
}
out.push("\n── Today's contract multiplier (prem −50%), any curvature, 200 players:");
rows.filter((r) => r.N === 200 && r.prem === -0.5 && r.sur === 0).forEach((r) => out.push("  " + line(r)));
out.push("\n── Effect of the curvature cap at 200 players, prem +25%, no surcharge:");
rows.filter((r) => r.N === 200 && r.prem === 0.25 && r.sur === 0).forEach((r) => out.push("  " + line(r)));

console.log(out.join("\n"));
