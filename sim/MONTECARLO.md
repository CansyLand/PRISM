# Monte Carlo: Curve Long vs Curve Short

`node sim/montecarlo.js` runs 3,000 random NEAR paths per scenario through the same model as
`curve-simulator.html`. Every path uses daily steps, p = 2, 80% implied volatility, a 0.1% trade fee and a
10% funding cut. Full output is in [`montecarlo-results.txt`](montecarlo-results.txt).

## Findings

1. **A long is a lottery ticket; a short is insurance.** At fair volatility over 90 days, Curve Long
   ends in profit on only 35–38% of paths, with a median of about −22% and an average near 0. Curve Short
   ends in profit on 60–64% of paths, with a median of about +4%. Over a year the long's median is −65%.
2. **The pool cap is what tilts the game toward shorts.** Fair funding `p(p−1)/2·σ²` assumes the long's
   upside is unlimited. In our pool the upside stops when long claims reach the pool. That cuts off the
   rare huge wins that make the long's average fair. With funding fixed at the fair rate:

   | Shorts per $1,000 long | Long, avg 1 year | Short, avg 1 year | Short wiped out |
   |---|---|---|---|
   | $5,000 (17% util) | −30% | +4.8% | 8.4% of paths |
   | $20,000 (5%) | −8% | 0% | 1.1% |
   | $100,000 (1%) | +0.5% | −0.2% | 0% |

   The game is only fair when the pool is deep. A shallow pool overcharges longs.
3. **Steep utilization funding makes it worse for longs.** Utilization usually rises because the price
   rallied, not because new longs arrived. Steep funding then taxes the longs exactly on their winning
   paths. A 20× steepness lowers the long's 1-year average from −21% (no steepness) to −32%. It does cut
   wipe-outs from 9% to 2%.
4. **Scarce shorts are paid well.** At 40–48% utilization, shorts average +12% to +23% in 90 days and
   win on 69–74% of paths. That's the incentive that should pull short capital in.
5. **Trends dominate.** A +60%/yr trend gives longs +31% in 90 days; a −60%/yr trend gives shorts +4% and
   longs −23%.

## What this means for balancing (long and short only)

- **Price funding for the capped payoff, not the uncapped one.** The fair rate should fall as the pool
  gets shallower relative to the longs, because the longs own less convexity. The scarcity incentive for
  shorts should come from flows (new longs opening into a thin pool), not from price-driven utilization.
- **Show the cap.** "Curve Long pays up to N× right now" (N = pool / long claims) is honest and lets
  longs price it.
- **Deepen the pool with capital that has no directional view.** That's what Curve Short + long NEAR
  (Crab-style) brings: market makers and NEAR holders who want yield without direction. A deeper pool is
  fairer for longs and makes the system safer.
- **Give shorts a base yield.** Short collateral sits idle; lending it out (for example on Burrow) adds a
  floor yield, so shorts stay even when funding is low.
- **Lower p reduces the problem.** The cap bites less at p = 1.5 than at p = 2 or 3.
