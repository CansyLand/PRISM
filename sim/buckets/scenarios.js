// Price scenarios for the bucketed search. Each returns `n` one-year paths.
"use strict";
const { nearPath, btcPath } = require("./engine");

const DAYS = 365;
const SCENARIOS = {
  // sideways NEAR: calm 65% / wild 130% regimes, 8 jumps a year (sd 12%), 10 upward wicks of 5-25%
  base: (k) => nearPath(1000 + k, DAYS, {}),
  // +100%/yr trend, same noise
  bull: (k) => nearPath(2000 + k, DAYS, { drift: 1.0 }),
  // −60%/yr bleed
  bear: (k) => nearPath(3000 + k, DAYS, { drift: -0.6 }),
  // NEAR 2021-style mania: +6/yr drift for 90 days (≈ +330%), then −3/yr for 120 days, then sideways; extra wild time
  mania: (k) => nearPath(4000 + k, DAYS, { drift: (t) => (t < 90 ? 6 : t < 210 ? -3 : 0), pToWild: 1 / 25, jumps: 12 }),
  // fat-tailed jumps: 16 jumps a year with sd 20% (and big wicks up to 40%)
  jumpy: (k) => nearPath(5000 + k, DAYS, { jumps: 16, jumpSd: 0.2, wicks: 16, wickMax: 0.4 }),
  // real BTC 2020-07..2023-03, log-moves × 1.4, rolling one-year windows
  btc14: (k) => btcPath((k * 53) % 630, DAYS, 1.4),
};
module.exports = { SCENARIOS, DAYS };
