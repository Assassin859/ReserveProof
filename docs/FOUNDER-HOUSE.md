# ReserveProof: go-to-market pack (Founder House)

**One line:** a fail-closed proof of reserves that any lending market on Robinhood Chain can require, so
curators can lend USDG against stock tokens without trusting a custodian's dashboard.

Live: [site](https://reserveproof-teal.vercel.app) · [mainnet radar](https://reserveproof-teal.vercel.app/radar)
· [curator risk](https://reserveproof-teal.vercel.app/risk) · [status](https://reserveproof-teal.vercel.app/status)
· [submission](./SUBMISSION.md)

Every number below is reproducible without keys:

- `npm run market:size` writes [`market-size.json`](./market-size.json) (on chain, block 75,032,783, 28 Sep 2026);
- `npm run gtm:targets` writes [`gtm-targets.json`](./gtm-targets.json) (Morpho API plus the live radar, block 75,768,198, 29 Sep 2026).

## 1. Why now

| | Figure | Source |
|---|---|---|
| USDG in circulation on Robinhood Chain | **675.5M** | market-size.json |
| Issuer-listed stock and ETF tokens used as Morpho collateral | **50 tokens, $158.3M** total supply | market-size.json (all 50 are in Robinhood's asset registry) |
| USDG lent through Morpho on the chain | **$508M**, almost all against USDe ($334M), syrupUSDG ($127M), mGLO ($32M) and spUSDG ($13M) | gtm-targets.json `usdgLendingTop` |
| USDG vaults (Morpho V2) | **32 vaults, $507.4M**; 5 hold more than $1K, and Steakhouse USDG alone holds $506M | gtm-targets.json `curators` |
| Markets lending USDG against stock tokens | **179 markets, 706.5K USDG supplied, 682.1K borrowed** | radar |
| Utilization of the four largest (AAPL, NVDA, SPCX, GOOGL) | **99.99 to 100%** | gtm-targets.json `topWouldGateMarkets` |
| Vaults supplying the top 15 stock-token markets | **0** | Morpho API `supplyingVaults` |
| Markets lending a fake "USDG" | **6**, across 2 impostor tokens; one copies Paxos's name "Global Dollar" with 0 decimals | radar, `copycats` |
| Reserve-proof oracles behind any of these markets | **none found** | market-size.json oracle scan |

The read: USDG lending on Robinhood Chain is a half-billion-dollar business run by professional curators,
and stock-token lending is a rounding error beside it. It is fully borrowed and has no curator money in it.
Our bet, which the first calls must test, is that curators stay out partly because nothing on chain tells
them the collateral is really backed. A price feed can't see a perfectly priced token whose custodian has
sold the stock behind it. ReserveProof blocks exactly that case, and it stacks on top of any price oracle.

## 2. Buyers and the wedge

We land where adoption is free and let the pull reach the side that pays.

| Step | Who | What they get | What they pay |
|---|---|---|---|
| 1. Land | **Morpho curators** and lending protocols | Radar of every market by custody risk, the `SolvencyGatedMorphoOracle` wrapper, `onlySolvent` for their own contracts, the status page and alerts | Nothing to read the oracle, ever. Later: an SLA'd alert feed and keeper-poked freezes |
| 2. Pull | **Custodians and distributors** holding USDG or stock tokens for users (fintech wallets, brokers, SEA apps; demo persona Kopi Wallet) | A solvency status that curators already gate on, so their users' tokens stay borrowable against; auditable backing without their own ZK stack | Hosted operator per asset per month; self-hosting stays free |
| 3. Expand | **Stock-token and RWA issuers** | Every distributor listing their token can prove backing; ERC-8056 multiplier drift after a split is caught automatically | Annual issuer licence plus a verified-backing badge |

The wedge is curator demand. One curator saying "we will allocate to stock-token markets if the collateral's
custodian publishes" is what makes a custodian publish.

## 3. Design-partner targets

**Targets, not relationships.** These come from public on-chain and API data. Nobody here has been contacted
or has endorsed ReserveProof. Addresses were checked over RPC on 29 Sep 2026: `name()`, `asset()` (the real
USDG, `0x5fc5…d168`), `curator()` and `totalAssets()` all match the Morpho API.

| Vault | TVL | Vault | Curator |
|---|---|---|---|
| Steakhouse USDG | $506.1M | `0xBeEff033F34C046626B8D0A041844C5d1A5409dd` | `0x9023FBD6A08C666491A2d1648737E400cF42D2Fb` |
| NetNet Credit | $1.17M | `0x99347d5F70D3838763f6Bddcf80304C8aa953B57` | `0x3Bb7A23316f82C0e984fA2E784846d8928a35f42` |
| Grove x Steakhouse USDG | $100K | `0xBEEff039907422219Fb367e525954DDC092854d9` | `0x622E19d6903BD4507cfc70b31d5B99535114C0FC` |
| Purinta USDG | $54K | `0x37788ff0c1d4e45A7FE06BC7e71e0cc00121d0A8` | `0x370EC5d1809B27F1fB18e002cf79837c46F5134c` |
| MEV Capital USDG | $51K | `0xaED8B69FBd85aB131fAbC9312D9E0BD7A08fd5Be` | `0x1B6EaFf09bE2c263B9848708DD08809C44AF09EE` |

How we'd approach each:

- **Steakhouse USDG:** the anchor. They hold 99.7% of USDG vault TVL and none of it is in stock-token
  markets. The question for the first call: what would they need to add a capped AAPL/USDG market?
- **NetNet Credit, Purinta, MEV Capital:** smaller curators with more room for a new market type. The
  likely first pilot.
- **Grove x Steakhouse:** a second Steakhouse relationship, useful as a test vault for the wrapper before
  the main vault.
- **The borrowers already in stock markets:** the top four markets (AAPL, NVDA, SPCX, GOOGL, about 677K
  USDG borrowed) are fully utilized. Borrowers want more USDG than lenders supply, so demand exists on the
  other side of any curator allocation.

Custodian and issuer targets can't be read from chain data. We'd source them through Robinhood Chain BD and
Paxos (see the ask).

## 4. The 90-day pilot offer

**What the partner curator gets, free for 90 days:**

1. A mainnet deployment of the oracle stack on Robinhood Chain, run by us, with one partner custodian's
   book under proof (USDG or one stock token).
2. One `SolvencyGatedMorphoOracle` wrapping the price oracle of their choice, for one new market they cap
   as they like.
3. A fork drill on their exact market before any money goes in: `npm run demo:morpho-fork`, pointed at their
   token, oracle and parameters, prints the freeze, the 72-hour cap and the 50% liquidation price as PASS or
   FAIL.
4. Alerts to their Discord or Slack from the watchtower, a public status page, and a weekly report.

**What we ask for:** a capped allocation to the gated market, a named contact, and permission to publish the
pilot report.

**Success criteria (all public on the status page):**

| Criterion | Target |
|---|---|
| Missed epochs (proof reaching `STALE`) | 0 in 90 days |
| Alert latency, from an on-chain failure to a curator notification | under 1 hour |
| Markets gated on mainnet with non-zero supply | at least 1 |
| Fork drill on the partner's market | passes before launch and after any parameter change |
| Pilot report (coverage, incidents, costs) | published at day 90 |

This matches grant milestone 2 in [SUBMISSION.md](./SUBMISSION.md#grant-milestone-plan).

## 5. Pricing hypotheses

These are **hypotheses to validate in the first ten calls**, not quotes. They build on the business model in
SUBMISSION. On-chain cost is negligible, about 0.0012 ETH per asset per year at a 3-day cadence, so pricing
is set by value.

| Buyer | Hypothesis | What would prove it wrong |
|---|---|---|
| Curators | Free forever to read and wrap. Paid tier about **$500 per vault per month** for an SLA'd alert feed, keeper-poked freezes and fork drills on every parameter change | Curators treat alerts as table stakes and won't pay separately; then it becomes a cost of acquiring custodians |
| Custodians | **$1,000 to $2,500 per asset per month** hosted (book ingestion, publishing, sampling, monitoring). First asset free during a pilot. Self-hosted free | Custodians only publish if a curator asks, and the curator won't pay; then we price per gated market instead |
| Issuers | **$50K to $150K per year** licence covering every custodian and distributor that lists their tokens | Issuers see custodian proofs as the distributor's problem; then we sell a badge to distributors instead |

## 6. 30/60/90-day plan and KPIs

| Window | Goals |
|---|---|
| Days 1 to 30 | 10 discovery calls: the five curators, two custodians and three borrowers or protocols. Mainnet deployment of the stack on Robinhood Chain. Move the watchtower from GitHub cron (which runs late; see [/status](https://reserveproof-teal.vercel.app/status)) to a dedicated keeper. Spec permissionless sampling (grant milestone 1) |
| Days 31 to 60 | One signed pilot: a curator plus a custodian. Fork drill on their market, then launch one gated market with a capped allocation. Alerts wired to the partner |
| Days 61 to 90 | Pilot running with zero missed epochs. Second custodian or second asset. First issuer conversation. Test the pricing hypotheses against the pilot's real costs |

| KPI | Day 30 | Day 60 | Day 90 |
|---|---|---|---|
| Discovery calls held | 10 | 15 | 20 |
| Signed pilots or LOIs | 0 | 1 | 2 |
| Assets under proof on mainnet | 0 (deployed) | 1 | 2 |
| Gated markets on mainnet | 0 | 1 | 1 to 2 |
| USDG supplied to gated markets | 0 | pilot cap | pilot cap, growing |
| Missed epochs | 0 | 0 | 0 |
| Hourly watchtower slots that ran (the "N of 48" on /status) | GitHub cron baseline | over 95% (keeper) | over 99% |

## 7. Channels

- **Morpho curators directly.** The radar is the opener: "here are the 179 markets on your chain, and here is
  which would freeze on a failed proof." Curators already read risk dashboards.
- **Robinhood Chain ecosystem.** Arbitrum and Robinhood Chain BD, Founder House, and the teams building
  lending and wallets on the chain.
- **Paxos USDG partners.** Firms already distributing USDG are the natural custodians to publish first.
- **SEA fintechs.** Singapore and the region's wallets and brokers adding stock tokens: the Kopi Wallet
  persona is the pitch.
- **Public content.** A weekly radar note on new copycat tokens and pending corporate actions. The 6 fake-USDG
  markets are the first issue.

## 8. Moat

The moat is the integrations, not the math. That means the Morpho wrapper tested against the real Morpho Blue
core, `onlySolvent` in partners' contracts, and the radar's map of every market. Once curators gate on
`isSolvent`, custodians publish to us because that's what the markets read. Open source removes the trust
objection to a new vendor.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Chicken and egg:** custodians won't publish until markets gate, and markets won't gate until custodians publish | The curator side is free and works with a single custodian. We act as the custodian's hosted operator, so publishing costs them one CSV per epoch. The radar makes the gap visible |
| **Demand is small today:** stock-token markets hold about 0.7M USDG | They are fully utilized, so borrowing demand exceeds supply. The wedge is the $508M of USDG curators already manage. USDG custodian proofs apply beyond stock markets |
| **SAMPLE-1:** reserve sampling is operator-only | The live-balance floor at read time limits what timing buys. Permissionless sampling is grant milestone 1 |
| **CLOCK-RESET:** the freeze bound is per incident, so a custodian can restore and drain repeatedly | Every round is public (`FreezeCleared` then `FreezeStarted`) and needs reserves genuinely back on chain. The watchtower pokes hourly. A decaying freeze budget is future work |
| **Scope confusion:** we prove a custodian's on-chain token reserves against its published liabilities, not an issuer's off-chain shares | Say so in every pitch. Issuer backing is the issuer's attestation. We catch ERC-8056 multiplier drift so a corporate action can't silently break the link |
| **Regulatory:** stock tokens aren't offered everywhere, and a proof of reserves isn't an audit | We never custody or distribute tokens. We sell monitoring to institutions, and the wording stays "proof", not "attestation" or "audit" |
| **Operations:** GitHub cron runs late (a scheduled epoch ran 6 hours late on 28 Sep) | The 7-day stale window absorbs it. [/status](https://reserveproof-teal.vercel.app/status) shows every late slot honestly. A dedicated keeper comes in days 1 to 30 |

## 10. The ask

1. **An intro to Robinhood Chain BD**, for custodian and distributor introductions and a mainnet pilot slot.
2. **An intro to Paxos**, the USDG issuer, and its distribution partners, so the first custodian publishes USDG.
3. **Intros to the curators behind the five vaults above**, Steakhouse first. One call each, to test whether
   a custody gate would unlock a capped stock-token market.
4. **Grant funding for the two milestones** in [SUBMISSION.md](./SUBMISSION.md#grant-milestone-plan):
   permissionless sampling (closes SAMPLE-1), then a 90-day mainnet pilot with one custodian and one gated
   lending market.

## 11. Ten-slide outline

| # | Slide | The figure it uses |
|---|---|---|
| 1 | Title: proof of reserves any market can require | Live site and the one-line `onlySolvent` |
| 2 | The market | 675.5M USDG; 50 issuer-listed stock tokens, $158.3M |
| 3 | The gap | $508M of USDG lent by curators, about 0.7M against stocks, 100% utilized, 0 vaults supplying |
| 4 | The failure nobody blocks | Perfectly priced token, custodian sold the stock; no reserve-proof oracle behind any of the 179 markets |
| 5 | Already happening | 6 markets lending fake USDG, one named "Global Dollar" with 0 decimals (radar) |
| 6 | Product | `isSolvent` reason codes; the Morpho wrapper (freeze, 72h cap, 50% price); ExitRight bonds |
| 7 | Proof it works | 150 tests; the fork drill on real TSLA, its oracle and Morpho Blue (20 PASS checks); /risk and /status live |
| 8 | Go to market | Curators, then custodians, then issuers; the five named vault targets; the pilot offer |
| 9 | Business model | Free reads; custodian per-asset hosting; issuer licence; the pricing hypotheses |
| 10 | The ask | Intros (Robinhood Chain BD, Paxos, curators) and the two grant milestones |
