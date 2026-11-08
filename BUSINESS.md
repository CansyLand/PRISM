# PRISM — Business Plan: Distribution, Liquidity & Go-To-Market

*Drafted 2026-11-08 from live research (sources in §6). Updated 2026-11-08
13:40 UTC: NEAR Hackathon 2026 discovered — **submission deadline 2026-11-14
23:59 UTC**, $250K pool; it is now the top-distribution-priority (below §3.0).
Status: plan; every action below is executable by the owner with the testnet
build in hand.*

## 1. Positioning (one paragraph)

PRISM is the first **perpetual-futures market on NEAR that settles through
Intents**: positions, margin, funding and liquidation live in a non-custodial
NEAR contract; the actual token movement is delegated to the 1Click solver
network. The wedge vs incumbent perps (Hyperliquid, GMX, dYdX):

1. **Chain abstraction is native** — collateral can arrive from any chain the
   Intents network supports (verified: ETH on Ethereum → USDC on NEAR and on
   Polygon, both quoted live), and the perps book itself never feels congestion:
   liquidation settles against an on-chain mark.
2. **No operator to be attacked or paused** — no admin, no freeze, no seize.
   The only forced mutation is liquidation of an underwater position, callable
   by anyone, rewarded 50% of remaining equity.
3. **Liquidity is inherited, not bootstrapped** — the underlying fill is a swap
   on the existing Intents solver network; PRISM does not need its own DEX.

## 2. Revenue model (what PRISM can actually earn)

| Stream | Mechanism | Status |
|---|---|---|
| **Trading fee** (basis points on realized PnL) | contract change + own test pass | not built — see MAINNET.md §4 |
| **1Click fee share** | with a partner API key, 1Click keeps ≥20 bps and splits `appFees` **50/50**; stablecoin pairs (our exact USDC↔wNEAR pair) cost only **1 bp** at the base tier | apply at `partners.near-intents.org` |
| **Liquidator ecosystem** | 50%-of-equity reward means third-party liquidation bots earn *us*; PRISM monetizes by not running them | already designed |
| **Data/indexing API** | structured event logs already emitted; index + sell to market-makers | later |

**Cost note:** every margin open/close is a 1Click swap. Base cost with a
partner key on stablecoin pairs is 1 bp + our 50/50 fee share — thin enough
that a 1–5 bp perp fee (industry-standard 2–5 bp on taker) has real margin.

## 3. Distribution (where users find PRISM)

### 3.0 **NEAR HACKATHON 2026 — DEADLINE 2026-11-14 23:59 UTC (top priority)**

Discovered 2026-11-08: `$250,000` pool, 13 tracks, no sign-up — the final
submission IS the registration (one attempt per project; fixes only via
`nearhackathon.com/request-changes`). PRISM is a direct fit:

- **Track `defi` (Unstoppable DeFi)** — the track literally says "perps …
  settle across chains through NEAR Intents". PRISM is exactly that, live on
  testnet with 28 e2e flows.
- Secondary track `agents` (Agent Economy) — the liquidation bot + intent
  settlement angle.

| Item | Value |
|---|---|
| Deadline | 2026-11-14T23:59Z |
| Prize | Grand $55K; 1st/2nd/3rd per track $10K/$3K/$2K, paid in NEAR to a **mainnet** account |
| Judges | NEAR core, a16z crypto, Electric Capital, Dragonfly, Synthetix/Infinex, cyberFund + AI screening (Claude Code/Codex) |
| Repo | `github.com/CansyLand/PRISM` — already public ✅, `HACKATHON.md` committed (judge-readable, "do X — see Y" steps) |
| Demo post | X post required: tag @NEARProtocol #NEARHackathon, attach demo video/screenshots — **draft in `hackathon-x-post.md`** |
| Submission | Template in `hackathon-submission.json` (gitignored — personal data). Tracks: `["defi","agents"]`, size `1`, payload pre-validated (1.7KB < 12KB) |

**What Artur must supply (3 values, then confirm):** lead name, email, a
**mainnet** NEAR account for prize payout, and the X post URL. Everything else
in the payload is final. **Do not submit without explicit yes** — one attempt.

Prize math: even 3rd in `defi` = $2K; 1st = $10K + exposure to NEAR's whole
builder audience at the exact moment the P1/P2 phases need it. Expected value
is strongly positive given the fit; cost to submit ≈ 30 minutes of Artur's
time.

### 3.1 Other channels

Ranked by effort-to-traction for a solo builder, all verified as real channels:

1. **NEAR ecosystem directory** (`near.org/ecosystem`) — searchable app
   directory; list PRISM under DeFi/Perps. Free, permanent, discovered by
   wallet users and devs. *Action: submit a listing entry with the dashboard
   URL + one-paragraph positioning.*
2. **NEAR Intents partner portal** (`partners.near-intents.org`) — an API key
   (fee tier improvement) and, more importantly, **visibility to the people who
   already route swap volume on NEAR**: wallets, agents, and solvers. PRISM's
   intents are their traffic. *Action: partner application — "perps on NEAR,
   volume arrives as standard 1Click swaps."*
3. **NEAR Horizon / Founder Hub** (`near.org/founder-hub`) — the current
   official builder path: mentorship, funding, and **$500K+ in builder
   perks**. (Direct NEAR Foundation grants are closed — 404 since Oct 2026 —
   and Protocol Rewards cohorts are paused; Horizon is the live program.)
   *Action: apply with the 24-test e2e suite + deployed testnet contract as the
   traction proof.*
4. **Community funding listed on near.org/funding** — DevHub bounties, Potlock
   rounds, Meta Pool grants (DeFi/TVL focus — a perps book with TVL is a fit).
   *Action: watch for open rounds; Potlock is donation-style, early-mover.*
5. **X/Twitter + NEAR Dev** — build-in-public: the liquidation demo (stranger
   liquidates on-chain while the feed is dead) is a 30-second clip. The
   "congestion-proof liquidation" story is the hook; link the dashboard.
6. **Hackathons** — **NEAR Hackathon 2026 deadline is 2026-11-14 (see §3.0);
   a perps-on-Intents entry is a repeatable win and a funnel into Horizon.**

**Do NOT spend on:** paid ads, KOLs, airdrops — before product-market signal
on mainnet.

## 4. Liquidity (the two questions)

**(a) Fill liquidity — already solved by design.** Opening/closing a position
is a USDC↔wNEAR swap on 1Click; the solver network (multiple market makers)
provides it. Verified routes include cross-chain ETH→USDC on NEAR and Polygon.
PRISM's job is to express the right swap (size × mark), not to host an order
book.

**(b) Counterparty for the leverage — the real build.** Today 10× is modeled
in margin math; the extra 9× has no owner. Two credible designs, in order of
prudence:

1. **Vault/CDP model (recommended first)**: a PRISM vault on NEAR lends the
   9×. Depositors back the vault with USDC/wNEAR (via Intents from any chain),
   earn the funding spread + a share of fees; the vault's max loan-to-value is
   the protocol's global cap. This is the Aave/Compound pattern the audience
   already trusts, and it is pure on-chain accounting PRISM is already good at.
2. **Delta-neutral solver model (later)**: the intent to open 10× is routed so
   the solver hedges the underlying in the spot market (1Click already quotes
   the hedge — we verified the liquidation-hedge intent); PRISM becomes a pure
   risk-venue with the solver as counterparty.

Either way: **first mainnet liquidity is the team's own vault capital**
(bootstrap a few hundred USDC, show the spread being earned, public
dashboard) — then open to public vault deposits.

## 5. Go-to-market sequence

| Phase | Gate (must be true) | What happens |
|---|---|---|
| **P0 testnet (now)** | 28/28 e2e + dashboard | **submit NEAR Hackathon (by Nov 14)**; build in public; ecosystem listing + Intents partner app; apply to Horizon |
| **P1 mainnet core** | MAINNET.md launch gate green (authorized mark pusher, mainnet e2e, real-USDC liquidation cycle) | deploy; UI + MyNearWallet; own vault with bootstrap capital; invite 50 users from NEAR community for a soft open |
| **P2 public vault** | 24 h bot uptime, no missed liquidations, real volume | vault deposits open (Intents-routed from any chain); public TVL dashboard; first fee layer |
| **P3 cross-chain collateral** | lego block 8 (Chain Signatures) integrated | "collateral on any chain, perps on NEAR" is the headline; partner with one EVM wallet on Polygon/ETH for co-distribution |

**KPIs per phase:** P0 — partner approval + listing live. P1 — 100 unique
traders, 24 h of clean liquidation bot operation. P2 — $50K vault TVL,
realized fee revenue > 0. P3 — >20% of collateral arriving cross-chain.

## 6. Sources (checked 2026-11-08)

- 1Click fees & partner portal: `docs.near-intents.org/resources/fees` (no key
  +25 bps; key = 20 bps base, **1 bp stablecoin pairs**; `appFees` split 50/50,
  1Click keeps ≥20 bps), `partners.near-intents.org` (apply).
- 1Click changelog: limit orders, Confidential Intents B2B, quote signature
  verification — all available partner features (docs.near-intents.org).
- NEAR funding landscape: `near.org/funding` (DevHub/Potlock/Meta Pool —
  community-run); web3grant.com audit Oct 2026 (Foundation grants 404,
  Protocol Rewards paused after Cohort 3); `near.org/founder-hub` (Horizon
  accelerator, $500K+ perks); `near.org/ecosystem` (directory).

## 7. Immediate next actions (owner checklist)

- [ ] **NEAR Hackathon (by 2026-11-14 23:59 UTC)** — Artur supplies name/email/mainnet-account, posts the X demo (draft ready), then confirms the one submission (§3.0)
- [ ] Apply to `partners.near-intents.org` (fee tier + visibility)
- [ ] Submit PRISM to `near.org/ecosystem` directory
- [ ] Apply to NEAR Horizon via `near.org/founder-hub`
- [ ] Complete MAINNET.md launch gate (authorized pusher + mainnet e2e)
- [ ] Bootstrap vault: $200–500 USDC, public TVL page
- [ ] 30-sec liquidation clip for X/NEAR Dev
