// Is the jumpy scenario's damage real gap risk, or an artefact of hedging once a day?
// Same jump statistics (16 jumps/yr, sd 20%, wicks to +40%), three ways:
//   daily              re-hedge once a day, jumps land between hedges (the main search)
//   hourly, gap jumps  re-hedge every hour, jumps are still instant gaps between two prints
//   hourly, 6h jumps   re-hedge every hour, each jump unfolds over 6 hours (a fast move the keeper can follow)
// Usage: node sim/buckets/hedgefreq.js 12 > sim/buckets/hedgefreq-results.txt
"use strict";
const { run, nearPath } = require("./engine");
const q = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const pc = (v) => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%";
const J = { jumps: 16, jumpSd: 0.2, wicks: 16, wickMax: 0.4 };
const MODES = [["daily", { spd: 1 }], ["hourly, gap jumps", { spd: 24 }], ["hourly, 6h jumps", { spd: 24, jumpSpread: 6 }]];
const CFGS = [
  ["current defaults", { prem: 1, kink: 0.4, steep: 10, slope: 1, sur: 1, shape: 2, baseFee: 0.1, capB: 0.25, dw: 0.5 }],
  ["p5-safe pick", { prem: 1.25, kink: 0.4, steep: 10, slope: 1, sur: 3, shape: 2, baseFee: 0.1, capB: 0.25, capExp: 2, dw: 0.5 }],
];
const PATHS = Number(process.argv[2] || 12);
const out = [`Jumpy scenario, ${PATHS} one-year paths each, 200 open positions.\n`];
for (const [cname, cfg] of CFGS) for (const V of [1e6, 5e6]) {
  out.push(`${cname}, vault $${V / 1e6}M:`);
  for (const [mname, m] of MODES) {
    const apy = [], dd = []; let wd = 0;
    for (let k = 0; k < PATHS; k++) {
      const r = run(nearPath(5000 + k, 365, { ...J, ...m }), { ...cfg, V, N: 200 }, 900 + k * 7 + 5);
      apy.push(r.apy); dd.push(r.mdd); wd += r.st.writeDowns > 0;
    }
    out.push(`  ${mname.padEnd(18)} median ${pc(q(apy, 0.5)).padStart(7)} p10 ${pc(q(apy, 0.1)).padStart(7)} worst ${pc(q(apy, 0)).padStart(7)} losing years ${apy.filter((x) => x < 0).length}/${PATHS}  max drawdown ${pc(-q(dd, 1))}  write-down years ${wd}`);
  }
}
console.log(out.join("\n"));
