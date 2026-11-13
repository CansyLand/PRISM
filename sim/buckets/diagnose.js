// Where do the vault's losing years come from? Breaks vault P&L into funding, hedge, slippage, borrow.
"use strict";
const { run } = require("./engine");
const { SCENARIOS } = require("./scenarios");
const CHOSEN = { prem: 1, kink: 0.4, steep: 10, slope: 1, sur: 1, shape: 2, baseFee: 0.1, capB: 0.25, dw: 0.5 };
const over = JSON.parse(process.argv[2] || "{}");
for (const V of [0.5e6, 1e6, 2e6, 5e6]) {
  const rows = [];
  for (const s of Object.keys(SCENARIOS)) for (let k = 0; k < 8; k++) {
    const r = run(SCENARIOS[s](k), { ...CHOSEN, V, N: 200, ...over }, 900 + k * 7 + s.length);
    let fund = 0; for (let p = 1; p <= 10; p++) fund += r.st.fundingBy[p];
    let paidOut = 0, paidIn = 0; for (const d of r.done) { paidIn += d.amt; paidOut += d.out; }
    rows.push({ s, k, apy: r.apy, fund: fund / V, wd: r.st.writeDowns, retail: (paidOut - paidIn) / V });
  }
  rows.sort((a, b) => a.apy - b.apy);
  const neg = rows.filter((r) => r.apy < 0);
  const by = {}; for (const r of neg) by[r.s] = (by[r.s] || 0) + 1;
  console.log(`vault $${V / 1e6}M: ${neg.length}/${rows.length} losing years, by scenario ${JSON.stringify(by)}`);
  for (const r of rows.slice(0, 5)) console.log(`   ${r.s}#${r.k} apy ${(r.apy * 100).toFixed(1)}% funding earned ${(r.fund * 100).toFixed(1)}% of vault, retail net P&L ${(r.retail * 100).toFixed(1)}% of vault, write-downs ${r.wd}`);
}
