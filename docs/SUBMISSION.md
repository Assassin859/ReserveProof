# Hackathon submission — ReserveProof (+ ExitRight)

**Live demo:** [reserveproof-teal.vercel.app](https://reserveproof-teal.vercel.app) · **Repo:** https://github.com/Assassin859/ReserveProof

See [VERIFY.md](./VERIFY.md) for how to check every claim below yourself.

## By the numbers

| | |
|---|---|
| Chains live | **2**: Robinhood Chain testnet (home) and Arbitrum Sepolia |
| Contracts verified | **11 of 11 on each chain**: Blockscout on Robinhood, Sourcify exact match on Arbitrum |
| Assets under proof | **3** on Robinhood: mTSLA (ERC-8056 mock), USDG, and Robinhood's real testnet **TSLA** stock token ([`0xC9f9…Bd4E`](https://explorer.testnet.chain.robinhood.com/address/0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E)); mTSLA is also allocated on Arbitrum |
| Epochs committed | **10** across 4 books, re-published every 3 days by the [ops workflow](https://github.com/Assassin859/ReserveProof/actions/workflows/ops-epoch.yml) |
| Tests | **40** Hardhat, **5** Foundry fuzz properties, **9** Foundry invariants (128 runs × depth 64, `fail_on_revert`), plus Slither triage: [SECURITY-SCAN.md](./SECURITY-SCAN.md) |
| Integrations gated on solvency | **2**: `GatedPayout` and `GuardedLendingVault` (drop-in `onlySolvent` modifier, [SolvencyGuard](../src/guards/SolvencyGuard.sol)) |
| ExitRight | Live bonded claim opened by the demo user and **settled on-chain** (tx links below) |
| Try it | [What-if simulator](https://reserveproof-teal.vercel.app): make the custodian misbehave on the real contracts, no wallet, no gas |
| Publishing cost | about 0.00001 ETH per asset per cycle, so roughly 0.0012 ETH per asset per year at a 3-day cadence |

## Idea field (285 characters — locked)

> ReserveProof: open-source proof of reserves for custodians of USDG and Robinhood Stock Tokens. Reserves read on-chain across Robinhood Chain and Arbitrum, Merkle-sum liabilities with user fraud proofs, and a fail-closed isSolvent(custodian, asset) that payouts and lending can require.

*(Character count: 285 including spaces.)*

## Longer description

**ReserveProof** is an open-source proof-of-reserves and proof-of-liabilities stack for custodians that hold **USDG** and **Robinhood Stock Tokens**. Operators publish a sorted Merkle-sum liability tree; reserves are read on-chain via multi-sample + live balance checks (using `arbBlockNumber` where available). Integrators call `isSolvent(custodianId, asset)` / `status(...)` and get a fail-closed reason code — so payouts and lending can `require` solvency instead of trusting a dashboard.

**ExitRight** is the withdrawability module: bonded claims with on-chain `settle`. Unpaid claims are slashed to the user and permanently mark the asset as exit-defaulted.

**Positioning**

| Prior art | Gap ReserveProof targets |
|---|---|
| Chainlink PoR | Feed-style reserve attestations; not full user-verifiable liabilities + gated composers |
| Summa | Strong PoL ideas; we ship open contracts + CLI + fail-closed oracle for stock-token / USDG custodians |
| Accountable | Closed / productized; we stay open-source, dual-chain allocations, ERC-8056 multiplier drift, ExitRight |

## Business model

The contracts, CLI and verifier stay MIT-licensed. Revenue comes from running the operator side well and from the integrations that depend on it. Users never pay: they verify their own balance in the browser against a public RPC.

| Who pays | Why they pay | Pricing sketch |
|---|---|---|
| **Custodians** (mid-tier and SEA fintechs holding USDG and stock tokens; demo persona Kopi Wallet) | Auditable backing without building a ZK stack or hiring an audit firm every quarter; a solvency status that partners can gate on | Hosted operator: book ingestion, epoch publishing, sampling, monitoring and alerting. Per asset per month, with a free self-hosted tier. On-chain cost is negligible (see above), so pricing is value-based |
| **Stock-token and RWA issuers** | Distributors holding their tokens can prove backing, and ERC-8056 multiplier drift after a corporate action is caught automatically | Annual issuer licence covering every custodian that lists the token, plus a verified-backing badge for distributor apps |
| **Lending and payout protocols** | One `onlySolvent(asset)` modifier fails closed on shortfall, stale data, split drift, disputes or exit default, with no oracle committee to trust | Reading the oracle is free forever, which drives adoption. Paid tier: cross-chain status relay, keeper-triggered market pauses and an SLA'd alert feed |

The wedge is the free integrator side: every protocol that gates on `isSolvent` gives custodians a reason to publish.

## Grant milestone plan

| # | Milestone | Deliverables | Done when |
|---|---|---|---|
| 1 | **Permissionless sampling** (closes SAMPLE-1) | Anyone can call `recordSample` in randomised windows, with a small keeper reward from the custodian's fee deposit; operator-only mode kept as a fallback | Invariant suite extended to non-operator samplers; deployed on both testnets; the ops workflow runs as a third-party keeper |
| 2 | **Paginated equivocation settlement** (closes SETTLE-1) | `openEquivocationDispute` settles challenges in bounded batches with a resumable cursor, so no challenge count can push it past the block gas limit | Gas test with 5,000 open challenges; FIFO and dispute invariants still pass; external review of `DisputeModule` |
| 3 | **Mainnet pilot** | Robinhood Chain and Arbitrum One deployment with one partner custodian on real USDG and stock tokens, plus one lending integration using `SolvencyGuard` | 90 days of uninterrupted epochs, a public status page, and a post-pilot report on coverage, incidents and costs |

## Tracks

- **Promising Products** — primary aim
- **Overall Prize** — stretch; Robinhood Chain deploy for reserved-seat eligibility
- Robinhood reserved seat: deployed and verified on Robinhood testnet (see VERIFY.md)

## Demo script (~100 seconds), all on the hosted site

Persona: **Kopi Wallet** (fictional SEA custodian). Everything below runs on the live testnet contracts at
[reserveproof-teal.vercel.app](https://reserveproof-teal.vercel.app) with no wallet and no gas.

| t | Scene | What judges see |
|---|---|---|
| 0–10s | Hero + live strip | Latest epoch, last publish time, 200% coverage vs the 103% floor, 11/11 contracts verified; mTSLA, USDG and real TSLA all solvent |
| 10–20s | 1 One wallet, one custodian | The reserve wallet is bound to Kopi; a second custodian would revert `WalletTaken` |
| 20–30s | 2 Liabilities vs reserves | Owed 500 mTSLA, live reserves 1,000 mTSLA, coverage above the floor → solvent |
| 30–45s | 3 Verify my balance | *Try demo user* → browser rebuilds the tree, root matches on-chain, leaf proven; switch to TSLA to prove 1.5 real TSLA |
| 45–85s | 4 What-if simulator | Drain → `LIVE_SHORT`, skip 8 days → `STALE`, stock split → `MULTIPLIER_DRIFT`, fraud dispute → `DISPUTED`; each time `GatedPayout` and the lending vault (withdraw collateral, borrow USDG) flip from Allowed to `Insolvent (reason)`, while repay stays open |
| 85–100s | 5 ExitRight | Live bonded claim opened by the demo user and settled by the operator, with explorer links |

Local rehearsal with real state changes (no testnet gas):

```bash
npm run demo:node         # terminal A
npm run demo:setup        # terminal B: deploy → build → publish → sample → snapshot
npm run demo:web          # http://localhost:3000
# then SCENE=4|5|6|7 npm run demo:prepare, and npm run demo:reset between takes
```

## Live deployment

The core contracts share addresses on both chains (identical deployer nonce sequence); the lending vault was deployed later and differs per chain. Robinhood: all 11 contracts verified on Blockscout (`npm run verify:rh`). Arbitrum Sepolia: all 11 exact-match on Sourcify (`npm run verify:sourcify`).

| Contract | Robinhood testnet | Arbitrum Sepolia |
|---|---|---|
| CustodianRegistry | [0x364c…0F9E](https://explorer.testnet.chain.robinhood.com/address/0x364c1D50910e3FadED506d38FabeAFc828C30F9E#code) | [Sourcify](https://repo.sourcify.dev/421614/0x364c1D50910e3FadED506d38FabeAFc828C30F9E) |
| LiabilityLedger | [0x1F6f…3537](https://explorer.testnet.chain.robinhood.com/address/0x1F6fAfc59FFe60f2d8d779d202be17d8b36b3537#code) | [Sourcify](https://repo.sourcify.dev/421614/0x1F6fAfc59FFe60f2d8d779d202be17d8b36b3537) |
| ReserveSampler | [0x88ec…5616](https://explorer.testnet.chain.robinhood.com/address/0x88ecb274A5Eb6Dc3310c532b8c94795e65605616#code) | [Sourcify](https://repo.sourcify.dev/421614/0x88ecb274A5Eb6Dc3310c532b8c94795e65605616) |
| DisputeModule | [0xA755…4f41](https://explorer.testnet.chain.robinhood.com/address/0xA755d7b51Ee9E452dB7de6D87Efca2aCC0834f41#code) | [Sourcify](https://repo.sourcify.dev/421614/0xA755d7b51Ee9E452dB7de6D87Efca2aCC0834f41) |
| SolvencyOracle | [0xFeD7…8E2f](https://explorer.testnet.chain.robinhood.com/address/0xFeD7650622256e3c4CbC8642D0d4F230224D8E2f#code) | [Sourcify](https://repo.sourcify.dev/421614/0xFeD7650622256e3c4CbC8642D0d4F230224D8E2f) · [Arbiscan](https://sepolia.arbiscan.io/address/0xFeD7650622256e3c4CbC8642D0d4F230224D8E2f) |
| ExitRight | [0x2726…EfB6](https://explorer.testnet.chain.robinhood.com/address/0x272644a119088A096F7fDBFE76da71fF01C0EfB6#code) | [Sourcify](https://repo.sourcify.dev/421614/0x272644a119088A096F7fDBFE76da71fF01C0EfB6) |
| GatedPayout | [0xed67…a430](https://explorer.testnet.chain.robinhood.com/address/0xed67EC461D64e42ed1472d3d74cbb32ee143a430#code) | [Sourcify](https://repo.sourcify.dev/421614/0xed67EC461D64e42ed1472d3d74cbb32ee143a430) |
| MockStockToken (mTSLA) | [0x6606…A248](https://explorer.testnet.chain.robinhood.com/address/0x66069A805d8c96a710B800066FdcEAfdfBcaA248#code) | [Sourcify](https://repo.sourcify.dev/421614/0x66069A805d8c96a710B800066FdcEAfdfBcaA248) |
| GuardedLendingVault | [0x3405…31a3](https://explorer.testnet.chain.robinhood.com/address/0x34058dc47D9D107622C265B6767A96A7DC2031a3#code) | [0xfC18…68Fe](https://repo.sourcify.dev/421614/0xfC18e00Be3fE26d5F280CF3A6006A664D5F868Fe) |
| TSLA (Robinhood's testnet stock token, not ours) | [0xC9f9…Bd4E](https://explorer.testnet.chain.robinhood.com/address/0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E) | home chain only |
| Full address book | [`deployments/robinhoodTestnet.json`](../deployments/robinhoodTestnet.json) | [`deployments/arbitrumSepolia.json`](../deployments/arbitrumSepolia.json) |

| Event | Link |
|---|---|
| Robinhood — mTSLA epoch 1 `commitEpoch` | [0x1f43…465f](https://explorer.testnet.chain.robinhood.com/tx/0x1f43227849ec6c50b7df6ec4c0368f58253fdbe4355a4eb2ffed8207269f465f) |
| Arbitrum Sepolia — mTSLA epoch 1 `commitEpoch` (same root as Robinhood) | [0x9bc4…127c](https://sepolia.arbiscan.io/tx/0x9bc4ae6e3c458a2a67b2bc80cc8f6e44b5364ef2b1db4e5a8bba4ef72026127c) |
| Robinhood — USDG epoch 1 `commitEpoch` (80 USDG book, reserves 200 USDG) | [0x42a4…1562](https://explorer.testnet.chain.robinhood.com/tx/0x42a4b41f6cf511e4f9631dd49ee6f9492a0c72377b5ad9bef29a8c6f54911562) |
| Robinhood — ExitRight `postBond` (60 USDG) | [0x5956…6c40](https://explorer.testnet.chain.robinhood.com/tx/0x5956e7386986c47e0377150204bf7ca97c33d5a28c514dbd1cad8ef776d40c66) |
| Robinhood — ExitRight `openClaim` #0 (demo user, 100 mTSLA) | [0xb1dc…b297](https://explorer.testnet.chain.robinhood.com/tx/0xb1dc7b713cbd07fdaaaaf2fd5599cb706cee9fd2c7e1bb3568702810ef65b297) |
| Robinhood — ExitRight `settle` #0 (operator) | [0x8fec…e2e9](https://explorer.testnet.chain.robinhood.com/tx/0x8fec3e59a1824b8d09da32529f27454a2c56e1344ecc5d56c18708ce8679e2e9) |
| ExitRight record | [`deployments/robinhoodTestnet.exitright.json`](../deployments/robinhoodTestnet.exitright.json) |
| Scheduled re-publishing | [Ops epoch workflow](https://github.com/Assassin859/ReserveProof/actions/workflows/ops-epoch.yml) (every 3 days); [first run](https://github.com/Assassin859/ReserveProof/actions/runs/36323953179) published epoch 2 on both chains |
| Live app | [reserveproof-teal.vercel.app](https://reserveproof-teal.vercel.app) |
| Demo video | _TODO_ |
| Repo | https://github.com/Assassin859/ReserveProof |

## Security review

| ID | Finding | Status |
|---|---|---|
| FIFO-1 | The challenge queue stored bare addresses. When a user's answered challenge was followed by a new one, the stale queue slot pointed at the fresh challenge, so its later deadline could mask an older overdue challenge behind it and keep the oracle reporting solvent. | **Fixed** — queue entries carry a per-challenge sequence number and only count while `open && seq` matches ([regression test](../test/zz_poc_review.ts), "FIFO-1"). Deployed in the current testnet contracts. |
| SETTLE-1 | `openEquivocationDispute` settles every live challenge in one loop (`_settleAllOpenChallenges`). With roughly 909 open challenges the loop exceeds the block gas limit, so an equivocation proof cannot be submitted while that many challenges are live. | **Open, disclosed.** Each challenge costs a 1 USDG bond from a distinct subject address, and any challenge left unanswered past its deadline already flips the oracle to DISPUTED, so the blocking window is bounded by the challenge window. Fix: paginated settlement. |
| ADV-1 | Capital borrowed or flash-held for the whole sampling window can inflate reserves. | **Open, disclosed.** Samples take the minimum across distinct `arbBlockNumber` values with a minimum time gap, and the oracle then takes `min(sampleMin, live balance)`. This narrows the attack to capital held across every sample plus the read, but does not eliminate it. |
| SAMPLE-1 | Reserve sampling is operator-only: `ReserveSampler.recordSample` reverts unless the caller is the custodian's operator, so the operator chooses when samples are taken. | **Open, disclosed.** The live-balance floor at read time limits what timing can buy (reserves must still be there when an integrator calls `isSolvent`). Permissionless sampling is future work. |

Merkle-sum verification is property-tested with Foundry fuzzing in CI ([`test/foundry/MerkleSumFuzz.t.sol`](../test/foundry/MerkleSumFuzz.t.sol)). The DisputeModule challenge queue and the ExitRight bond accounting are covered by stateful Foundry invariants ([`DisputeInvariants.t.sol`](../test/foundry/DisputeInvariants.t.sol), [`ExitRightInvariants.t.sol`](../test/foundry/ExitRightInvariants.t.sol)), and every Slither finding is triaged in [SECURITY-SCAN.md](./SECURITY-SCAN.md).

## Residual risks (one-liner for judges)

Flash-borrowed reserves across the full sample window, operator-only sampling, the equivocation settle loop's gas ceiling (SETTLE-1), ExitRight bond ≠ full insurance, per-chain allocation ≠ global 100% coverage, and USDG proofs verify only on their home chain (leaves bind the local token address) — documented in README.

Testnet operating rule: any ExitRight demo claim must be settled in the same session. A claim left unsettled past the 72h payout window is slashed and permanently flips mTSLA to EXIT_DEFAULT (reason 8). `npm run status:rh` lists any unsettled claim with its deadline.
