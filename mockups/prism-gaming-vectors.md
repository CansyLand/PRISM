# PRISM — How the Protocol Could Be Gamed or Hacked

*Adversarial review of the intent-based perpetuals design (contract v4 + full-1Click
settlement proposal). Written as a red-team brief: each vector lists the attack,
why it works with today's mechanics, and the fix. Status tags: **PROVEN** (exists in
code/sim today), **AT-RISK** (design gap), **MITIGATED** (already defended).*

---

## 1. Price-feed attack surface (the #1 risk)

PRISM is a pure price-discovery protocol: the vault's whole PnL is a function of the
mark price. Whoever moves the mark moves the house's wallet.

### 1.1 Pusher collusion / capture — **AT-RISK**
`update_mark()` and `set_funding_rate()` are pusher-only (v4 governance). The pusher
is the single point of trust:

- A malicious or bribed pusher posts a mark spike in the direction of the largest
  open positions, then (with a related account) liquidates those positions and takes
  the 50% `LIQ_PENALTY_BPS` reward. The vault pays the losing side's margin, the
  liquidator pocket half of it. Repeat every hour.
- Even a *lazy* pusher is a vector: if the pusher oracle goes stale, a whale can wait
  for spot to move far from the last mark, then liquidate against the stale mark at a
  price that no longer reflects reality.

**Fixes:** require a quorum of ≥3 independent oracles (Binance/OKX/Bybit median with
deviation bounds); stale-mark circuit breaker (halt liquidations if
`|mark − oracle_median| > x`); pusher bond that is slashed on provable manipulation;
time-weighted mark (VWAP over last N minutes, not a point price).

### 1.2 Stale-mark sandwich (the "gap" trade) — **PROVEN in sim**
No pusher collusion needed. The sim shows the real version: a 1–2%/day chance of a
2.5–8% gap jumping through the 5% maintenance line. An informed trader who sees the
gap coming (funding, order flow, spot breaking a level) can:

1. Open a large position *before* the gap in the direction of the move.
2. Let the gap print against the *opposing* crowd's positions.
3. The opposing positions liquidate at a gapped price — the vault absorbs the full
   gap loss on their book (the "insolvent tail"), while the attacker's position
   profits 1:1 with the gap.

The vault is long volatility's opposite: **crowded one-sided books + a jump = the
house eats the tail.** The MC sim quantified this: jump gaps were the dominant
depletion driver in the grind scenario (89% depletion at v2 params).

**Fixes:** cap per-liquidation batch notional; widen maintenance to 10% at high
leverage (the sim's 10× with 5% maintenance is the dangerous corner); delta-hedge the
vault on-chain (the known hole: "edge is real, hole is no delta management");
require liquidation settlement at a *median* of 3 snapshots, not the mark that
triggered it.

### 1.3 Funding-rate manipulation — **AT-RISK**
Funding flows long↔short every interval and (by design) $0 goes to the vault. But the
*rate* is set by the pusher (or, in the full design, derived from premium):

- An attacker who can influence the premium input can set funding against a crowded
  side, forcing that side to bleed or exit early (funding-bail: the sim's smart
  traders bail when cumulative funding > 4% of margin).
- In full-1Click, funding is settled in USDC on-chain. A manipulated negative funding
  rate during a long squeeze *pays* longs and starves shorts — a subsidized squeeze.

**Fixes:** funding derived from published oracle premium only, clamped
(±0.1%/8h), with rate-of-change limits; publish the formula on-chain; no pusher
override in normal operation (emergency override requires owner + bond).

---

## 2. Auction / solver attack surface

### 2.1 Quote sniping (information leakage) — **AT-RISK**
Intents are private until the auction, but the auction itself leaks: when an intent
is broadcast for solver quoting, solvers learn the size and direction. A solver who
also trades for their own account can:

1. See a $500k long intent entering the book.
2. Front-run: take the other side of the *underlying* (spot wNEAR) before the vault
   settles the synthetic, or open their own PRISM short at the pre-fill mark.
3. Submit a losing-but-cheapest-looking quote while their own account captures the move.

**Fixes:** commit-reveal auction (solvers hash quotes, reveal after clearing);
fill price = oracle mark ± max-slippage band, *not* the quoted price for size above a
threshold; solver cooldown + on-chain disclosure of own book.

### 2.2 Solver cartel / round-robin — **AT-RISK**
With 20 solvers, a coalition of 19 can fix quotes: one "winner" always wins with a
price that favors *its own* hidden position, others submit junk quotes. The winner
extracts the spread between mark and fill repeatedly — a hidden tax that flows from
traders to the cartel, not the vault.

**Fixes:** quote = mark ± bounded band enforced on-chain (no free discretion);
random subset of 3 solvers per intent (already in the design — keep it); public
fill-price vs mark audit trail; slashing if a solver's fill deviates from oracle
outside the band.

### 2.3 Dust-quote latency attacks — **PROVEN (trivial)**
A solver that is just a fast bot can always post the in-band best quote and earn the
spread on every fill. That's *fine* if the band is tight and the spread goes to the
vault — but if the spread goes to the solver, the auction degenerates into a
latency race where one actor captures all protocol fees.

**Fix:** routing: fill price is the *mark*, solver compensation is a flat on-chain fee
paid by the protocol, not the spread. Removes the latency race entirely.

---

## 3. Liquidation mechanics

### 3.1 Liquidator-supplied price — **PROVEN (v4 code)**
In v4, `liquidate(account_id, mark_price)` takes the mark price *as an argument from
the liquidator*. Anyone can pass a price that makes the target look liquidatable. If
the contract trusts that input, an attacker liquidates positions at a phantom price:
the vault settles the close at the phantom mark, and the "residual" split transfers
real USDC from the vault to the attacker at a price that never existed.

**Fix (mandatory before any real deployment):** the contract must ignore the
supplied price and use the stored on-chain mark (itself oracle-governed per §1), or
verify `|supplied − stored| < ε`. Today this is a unit-test-level gap, not a theory.

### 3.2 Liquidation-sniping the mark — **PROVEN in sim**
Even with a trusted mark: the 50% residual reward is a bounty. In a trending market,
the first liquidator to a large weak position takes the best price (gap through
maintenance is settled at the worst price for the liquidated side). The sim shows the
liquidator earns the gap: "gap settled @ X, residual split 50/50." An attacker farms
this by:

1. Letting (or pushing, via §1) a position near its liq price.
2. Holding a competing position on the other side so the vault's gap loss is offset
   by their own gain.

Net effect: the vault is the *only* party that always loses a gap. The house edge
assumes gaps are symmetric noise; an attacker makes them one-directional.

**Fix:** settle liquidations at the median of 3 mark snapshots taken 100ms apart
(makes sniping expensive: you must be first *thrice*); cap liquidator bounty as % of
notional; partial liquidation (close half) to reduce the gap tail.

### 3.3 Re-entrancy / state ordering — **AT-RISK (full-1Click)**
When settlement moves to on-chain 1Click delivery (solver delivers wNEAR + USDC
margin at open), the open→fund→settle sequence must be atomic. If `settle_entry` can
be called before the USDC is escrowed, an attacker opens a position, gets the vault's
commitment, then abandons funding — the vault is now counterparty to an unfunded
book. The v4 contract has this exact seam (`open_position` then separate
`settle_entry`).

**Fix:** single-call open that escrows margin in the same transaction; positions in
`pending` state are not mark-priced and cannot be liquidated until funded.

---

## 4. Crowd / game-theory attacks (no contract bug required)

### 4.1 The vault is a casino without a house edge in trends — **PROVEN in sim**
The honest numbers from the replay sim (real Binance history, 100-trader crowd):

| Period | Market | Vault Δ | Fees | Crowd realized | Liqs |
|---|---|---|---|---|---|
| last 7d (bear) | −7.1% | **+ $7,932** | $4,643 | −$3,061 | 1 |
| last 90d (parabolic bull, $1.54→$6.00) | +120% | **− $24,968** | $21,456 | +$35,774 | 77 |
| last 1y (bull, $0.84→$6.00) | +84% | **− $25,778** | $15,205 | +$15,421 | 272 |

Read: in a one-directional trending market, leveraged trend-followers (the majority
crowd) win big and the vault — their counterparty — pays it out. Fees and
liquidation bounties are the house edge, but a +120% market dwarfs 2–4bp per trade.
**The protocol is structurally short the trend of its own user base.** A whale who
understands this simply *is* the crowd: open max leverage in the trend direction, let
the vault absorb the opposite side, close before any reversal. The "insolvent tail"
only bites the vault if the reversal comes in a gap — which the whale controls the
timing of, not the direction of.

**Fix:** this is the delta-management hole, made concrete. Options: (a) vault hedges
net book delta in spot (on-chain wNEAR collateral, auto-hedge bands); (b) dynamic
fee that scales with |book delta| (crowded = expensive — the crowd *is* the risk,
price it); (c) per-direction capacity limits (long capacity ≠ short capacity, set by
book composition). Without (a)/(b)/(c), the vault is a donation engine in bull runs.

### 4.2 Wash-volume fee gaming — **AT-RISK**
Fees are the vault's main income. Two-sided wash trading (open + immediate close, or
ping-pong between two accounts) mints fee income that funds the vault's PnL while
carrying ~zero delta. An attacker with cheap NEAR gas can "earn" the protocol's fee
revenue back out through the vault's own PnL share if any fee revenue is
redistributed — or simply to inflate volume metrics that drive investor confidence /
APR claims.

**Fix:** fee netting per account per interval (charge on net flow, not gross);
on-chain volume dashboard that separates unique-counterparty volume from ping-pong
volume; no fee rebates of any kind.

### 4.3 Funding-bail cascade (self-fulfilling exit) — **PROVEN in sim**
The sim's smart traders bail when cumulative funding paid > 4% of margin. In a
crowded market, one pusher-set funding spike (§1.3) makes the crowded side bail in
unison → their exits move the mark → more funding against them → more bail. The vault
watches the book unwind into weakness. A coordinated group can orchestrate this:
crowd the long side, wait for positive funding, mass-exit on the same candle, take
the spread off the vault's stale quotes.

**Fix:** funding clamps (§1.3); exit flow rate-limiting is *not* the answer (breaks
the product) — delta hedging (4.1a) is.

### 4.4 Whale privacy inversion — **AT-RISK**
Intents are private until auction — that's the whale value prop. But the *fill* is
visible (tape, vault book delta). A whale's footprint is legible from the vault's
delta swings: "vault delta jumped +$2M long" = someone took $2M short, or vice
versa. Smaller traders can trade against the whale's visible footprint (fade the
delta jump). This is an information asymmetry in the *opposite* direction from the
intent design — the book delta leaks the big fish.

**Fix:** publish vault delta on a delayed/rounded basis only; or make the vault's
*apparent* delta noisy (hedge splits across multiple sub-accounts on-chain).

---

## 5. Operational / deployment attacks

### 5.1 Owner-key compromise — **AT-RISK (all NEAR contracts)**
`set_pusher` is owner-only. Compromised owner = full price control (§1.1) + pusher
swap. Standard but fatal: the protocol's trust anchor is one key.

**Fix:** multi-sig owner (NEAR Access Control / multisig contract); timelocked
governance changes (24h delay on set_pusher); owner key in hardware storage, rotation
policy.

### 5.2 Pusher DoS (availability, not integrity) — **AT-RISK**
A pusher can simply stop posting marks. If the contract halts liquidations on stale
marks (the correct fix from §1.1), a determined attacker who *owns* the pusher slot
can freeze the protocol's risk engine indefinitely — positions can't be liquidated,
the vault's exposure grows unbounded, and depositors can't exit at fair prices.

**Fix:** multi-oracle pusher (§1.1) so no single DoS point; emergency owner
liquidation mode at stored mark (with disclosure + bond).

### 5.3 NEAR-protocol-level — **MITIGATED / standard**
- Contract is near-asm with view methods; state reads are public — the book delta
  leak (4.4) is inherent to transparency, accept and manage it.
- Storage-stuck attacks (attacker forces storage for millions of accounts): position
  keys are per-trader, capped by margin requirements — an attacker can't create
  positions without USDC, so storage DoS is bounded by capital. **MITIGATED.**
- Reentrancy: NEAR has no external-call reentrancy in the EVM sense; cross-contract
  callback loops are possible in full-1Click settlement (solver contract calling back
  into PRISM during settle). **AT-RISK** until the settlement flow is written:
  standard fix — no outbound calls from within state-mutating settlement; queue
  payouts.

---

## Priority list (what to fix before any real money)

1. **`liquidate()` must not trust the caller's price** (3.1) — code gap, fix now.
2. **Oracle quorum for mark + funding** (1.1, 1.3) — single pusher is the protocol.
3. **Delta management or dynamic fees** (4.1) — the replay sim proves the vault is
   short the crowd's trend; a +120% month costs it ~10% of seed equity.
4. **Atomic open+escrow** (3.3) — before full-1Click ships.
5. **Commit-reveal auction or mark-anchored fills** (2.1, 2.3) — kills sniping and
   the latency race.
6. **Fee netting** (4.2) — trivial to add, prevents wash-volume metric fraud.
7. **Owner multisig + timelock** (5.1).

The honest one-liner: *the contract mechanics are defensible; the economics are not
yet.* Every vector in §1–§3 is a standard oracle/DeFi fix. §4.1 is the real
design decision: either the vault hedges its book, or fees must scale with book
asymmetry, or the protocol will be a reliable way to convert a trending NEAR market
into vault loss.
