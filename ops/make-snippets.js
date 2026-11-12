// Picks the demo market's chart snippets from real price history (BTC daily, Jul 2020 – Mar 2023).
//   node ops/make-snippets.js   →  app/public/demo-snippets.json
// Each snippet: HISTORY candles shown before you buy, then FUTURE candles that play in fast-forward.
// 7 rally right after entry (a bet that can pay), 3 dump (a bet that loses).
// Every second snippet gets one deep wick early in the future part (a 20% spike down that closes back),
// so the demo shows a Curve Long riding out a dip that would liquidate a leveraged perp.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const src = JSON.parse(fs.readFileSync(path.join(DIR, "..", "sim", "btc-2020-2023.json"), "utf8"));
const N = src.c.length, HISTORY = 50, FUTURE = 360, LOOK = 45;
const candle = (i) => [src.o[i], src.h[i], src.l[i], src.c[i]];
const cands = [];
for (let s = HISTORY; s + FUTURE < N; s++) {
  const entry = src.c[s];
  let hi = 0, lo = Infinity;
  for (let k = 1; k <= LOOK; k++) { hi = Math.max(hi, src.h[s + k]); lo = Math.min(lo, src.l[s + k]); }
  cands.push({ s, up: hi / entry, down: lo / entry });
}
function pick(list, n, score) {
  const out = [];
  for (const c of list.slice().sort((a, b) => score(b) - score(a))) {
    if (out.every((o) => Math.abs(o.s - c.s) > 25)) out.push(c);
    if (out.length === n) break;
  }
  return out;
}
const wins = pick(cands.filter((c) => c.up >= 1.2), 7, (c) => c.up - Math.max(0, 1 - c.down) * 2);
const losses = pick(cands.filter((c) => c.up <= 1.03 && c.down <= 0.85), 3, (c) => 1 - c.down);
const START = 3.6; // shown around a NEAR-like price
const snippets = [...wins.map((c) => ({ ...c, kind: "rally" })), ...losses.map((c) => ({ ...c, kind: "dump" }))].map((c) => {
  const k = START / src.c[c.s];
  const rows = [];
  for (let i = c.s - HISTORY + 1; i <= c.s + FUTURE; i++) rows.push(candle(i).map((v) => +(v * k).toFixed(4)));
  const out = { kind: c.kind, from: new Date(Date.parse(src.start) + (c.s - HISTORY + 1) * 864e5).toISOString().slice(0, 10), entry: HISTORY - 1, best: +c.up.toFixed(3), worst: +c.down.toFixed(3), candles: rows };
  return out;
}).map((s, n) => {
  if (n % 2) return s;
  const w = HISTORY + 12 + n * 2, [o, h, l, cl] = s.candles[w];
  s.candles[w] = [o, h, +(Math.min(o, cl) * 0.8).toFixed(4), cl];
  return { ...s, wick: w };
});
fs.writeFileSync(path.join(DIR, "..", "app", "public", "demo-snippets.json"), JSON.stringify(snippets));
for (const s of snippets) console.log(s.kind.padEnd(5), s.from, `best ×${s.best} worst ×${s.worst} within ${LOOK} candles`);
