# The research behind Uprise

Uprise didn't start from zero. It builds on ten years of work on perpetual futures, power perpetuals and options that never expire. These are the papers we read, with links to the public originals and one line on why each one mattered.

**New to finance?** Read the first three. They explain the two ideas Uprise is made of:

- a position whose value grows faster than the price, a *power* payoff;
- a position that never expires and never gets liquidated, but slowly shrinks instead, *continuous expiry*.

## Start here

| Paper | In plain words | Why it matters for Uprise |
|---|---|---|
| [Power Perpetuals](https://www.paradigm.xyz/2021/08/power-perpetuals). White, Robinson, Koticha and others, Paradigm, 2021 | A perpetual whose value follows the price squared (or any power). It invented "squeeth". | Where our funding rate `p(p−1)/2 · σ²` comes from. |
| [Everlasting Options](https://www.paradigm.xyz/2021/05/everlasting-options). White and Bankman-Fried, Paradigm, 2021 | An option that never expires, paid for by a small fee every day instead of a premium up front. | The "continuous expiry" idea in our name. |
| [A Primer on Perpetuals](https://arxiv.org/abs/2209.03307). Angeris, Chitra, Evans, Lorig, 2022 | Two kinds of perpetuals: one pays a fee, the other just shrinks over time. | Uprise is the second kind: your position melts instead of paying funding. Our main theoretical reference. |

## How these products are priced

| Paper | In plain words | Why it matters |
|---|---|---|
| [Amortizing Perpetual Options](https://arxiv.org/abs/2512.06505). Feinstein, 2025 | Options whose size decays smoothly; nothing lapses, nothing is liquidated. | The closest match to "your position melts over time". Has formulas for value and risk. |
| [Perpetual Futures Pricing](https://arxiv.org/abs/2310.11771). Ackerer, Hugonnier, Jermann | Fair prices for perpetuals and everlasting options. | Background for setting fees. |
| [Fundamentals of Perpetual Futures](https://arxiv.org/abs/2212.06888). He, Manela, Ross, von Wachter, 2022 | Real crypto data on funding rates and how far perps drift from spot. | Helped choose realistic volatility and funding numbers. |
| Shiller, *Measuring Asset Values for Cash Settlement in Derivative Markets*, Cowles Foundation Discussion Paper 1036, 1992 | The original idea of a futures contract that never expires. | Where perpetuals come from. |
| Nilsen, *Power Claims*, 2021 (informal notes) | An early construction of power payoffs. | Background. |

## Other designs we looked at

| Paper | In plain words | What we took from it |
|---|---|---|
| Opyn Squeeth and the [Crab strategy](https://www.opyn.co) (live on Ethereum since 2022) | A real power-perpetual product, and a vault that sells it while hedging with ETH. | Our 🦀 Yield vault is a Crab: it sells the curve to traders and hedges with NEAR. |
| [Panoptic](https://arxiv.org/abs/2204.14232). Lambert and Kristensen, 2022 | Perpetual options built from Uniswap liquidity, with a streaming premium. | Another way to charge a continuous fee, without a price oracle. |
| [Replicating Market Makers](https://arxiv.org/abs/2103.14769) and [Replicating Monotonic Payoffs](https://arxiv.org/abs/2111.13740). Angeris, Evans, Chitra | Any curved payoff can be built from an automated market maker. | A possible future route to Uprise without an oracle. |
| [Everlasting Options: Proactive Market Making](https://arxiv.org/abs/2508.07068). Mohanty and others, 2025 | How liquidity providers can quote everlasting options. | Ideas for the vault side. |
| *pvpAMM: perpetual markets with unbalanced long and short sides* (AFT 2025) | What happens when one side of a market is much bigger than the other. | Relevant when many more people buy than the vault can cover. |
| Singh, Michalopoulos, Veneris, *Option Contracts in DeFi* (University of Toronto, 2024) | A survey of option designs on blockchains. | Overview of the field. |
| Paradigm, *Everything Is a Perp* ([paradigm.xyz](https://www.paradigm.xyz/writing)), 2024 | Any payoff can be turned into a perpetual. | Framing for the idea. |

## Our own simulations

The papers gave the formulas; our simulators tested them on real price history and thousands of random futures before anything went on chain. See the [lab](https://uprise.wtf/lab) for the interactive ones, and [`sim/buckets/README.md`](../sim/buckets/README.md) for the Monte Carlo search that picked today's settings.
