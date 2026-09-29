# Hackathon submission — ReserveProof (+ ExitRight)

**Live demo:** [reserveproof-teal.vercel.app](https://reserveproof-teal.vercel.app) · **Repo:** https://github.com/Assassin859/ReserveProof

**150 tests** (51 Hardhat + 61 Foundry fuzz + 24 Foundry unit + 14 stateful invariants) · **every contract verified on both testnets** (13 on Robinhood, 14 on Arbitrum) · **SolvencyGatedMorphoOracle tested against the real Morpho Blue v1.0.0 core**

See [VERIFY.md](./VERIFY.md) for how to check every claim below yourself.

## The problem, in numbers

Read on chain from Robinhood Chain mainnet at block 75,032,783 (28 Sep 2026) by
[`npm run market:size`](../scripts/market-size.ts); raw output in [`market-size.json`](./market-size.json).

| | |
|---|---|
| USDG in circulation on Robinhood Chain | **675.5M USDG** |
| Stock and ETF tokens used as Morpho collateral (ERC-8056 tokens only; stock tokens never posted on Morpho are not counted) | **50 tokens, $158.3M** of total supply (SPY $22.9M, NVDA $19.1M, SPCX $12.1M, TSLA $5.1M, AAPL $5.1M, …) |
| Morpho Blue markets lending USDG against those tokens | **167 of 287 markets**: **745,012 USDG** supplied, **675,019 USDG** borrowed, **$1.72M** of stock tokens posted as collateral |
| Reserve-proof oracles behind those markets | **None found.** Of the 167 distinct oracles, 113 are Morpho's standard Chainlink-style oracle reading price feeds only (no feed describes a reserve proof); the other 54 are custom contracts we couldn't classify. Morpho asks its oracle only for `price()` |

ReserveProof puts a fail-closed proof of reserves in front of that lending, and ships it as one modifier.

## The product: one line for any lending market

```solidity
contract MyMarket is SolvencyGuard {
    function borrow(uint256 amt) external onlySolvent(address(TSLA)) { /* ... */ } // reverts Insolvent(reason)
}
```

For Morpho Blue, where markets can't be modified, wrap the market's existing oracle instead:

```solidity
// price() forwards the base oracle and reverts Insolvent(reason) whenever the proof fails. Once one
// continuously poked incident lasts 72h, it prices at 50% so liquidations can clear.
new SolvencyGatedMorphoOracle(existingOracle, solvencyOracle, custodianId, TSLA, 72 hours, 6 hours, 5000);
```

Curators get a live risk view of every gated market at [/risk](https://reserveproof-teal.vercel.app/risk), also available as JSON at `/api/risk`. It shows:
- coverage against the 103% floor, and how far reserves can fall before the proof fails;
- time until the proof goes stale, against the next scheduled publish;
- open disputes, challenges and exit claims;
- which consumers would freeze, including the Morpho wrapper's freeze clock.

**Every failed proof blocks.** The oracle reports only its first failing check (`STALE`, missing samples
and a deactivated custodian come before `LIVE_SHORT`), so ignoring any reason would let a drain hide
behind it.

The trade-off: Morpho calls `price()` in `borrow`, indebted `withdrawCollateral` and `liquidate` alike, so
a reverting oracle also stops liquidations. The freeze is therefore bounded per incident. A custodian
that genuinely restores reserves and then drains again starts a new incident; this is disclosed below as
CLOCK-RESET.

- `poke()` starts the clock and keeps it alive.
- A clock nobody pokes for 6 hours is void, so a clock started during an earlier shortfall can't pre-pay
  the next freeze.
- After 72 hours, the price comes back at 50%, not full value. Underwater loans clear, and new borrowing
  reopens only at half value.

It reverts rather than returning 0 because a zero price would make every position liquidatable for free.
`supply`, `withdraw`, `supplyCollateral`, `repay` and debt-free exits always work, because Morpho skips
the oracle for positions without debt.
[`MorphoIntegration.t.sol`](../test/foundry/MorphoIntegration.t.sol) proves each path against the
unmodified Morpho Blue core, including:

- a drain hidden behind `INSUFFICIENT_SAMPLES`, `STALE` or `INACTIVE`;
- a pre-started clock;
- liquidation at the discounted price after the cap.

**Re-run it yourself on mainnet state:** `npm run demo:morpho-fork` forks Robinhood Chain mainnet in memory
(no keys, nothing broadcast). It gates the real TSLA token, wraps the real TSLA/USDG oracle and opens a
market on the real Morpho Blue. Then it drains the reserves and prints 20 PASS/FAIL checks:
- borrow works while healthy;
- `price()`, borrow, indebted withdraw and liquidate revert `Insolvent(6)`;
- repay, supplyCollateral and lender withdraw still work;
- the price is still frozen at 71 hours and 50% at 72 hours;
- the liquidation clears;
- after the reserves are restored, one poke brings back full price and borrowing.

It takes about 45 seconds. Details, and what is simulated (balances, and the feed transmitters during the 72h warp), are in the
[README](../README.md#re-run-the-morpho-freeze-yourself).

## By the numbers (the build)

| | |
|---|---|
| Tests | **150**: 51 Hardhat, 61 Foundry fuzz properties (512 runs each), 24 Foundry unit tests, 14 stateful invariants (128 runs × depth 64, `fail_on_revert`) across the oracle, Merkle-sum proofs, the vault, registry/config, the ledger, disputes, ExitRight and the Morpho wrapper. `npm run test:count` prints the breakdown; Slither triage in [SECURITY-SCAN.md](./SECURITY-SCAN.md) |
| Chains live | **2** testnets: Robinhood Chain testnet (home) and Arbitrum Sepolia |
| Contracts verified | **All of them**: 13 of 13 on Blockscout (Robinhood), 14 of 14 Sourcify exact match (Arbitrum, including the vault's own mock USDG) |
| Assets under proof | **3** on Robinhood testnet: mTSLA (ERC-8056 mock), USDG, and Robinhood's real testnet **TSLA** stock token ([`0xC9f9…Bd4E`](https://explorer.testnet.chain.robinhood.com/address/0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E)); mTSLA is also allocated on Arbitrum |
| Epochs committed | Re-published every 3 days by the [ops workflow](https://github.com/Assassin859/ReserveProof/actions/workflows/ops-epoch.yml) |
| Integrations gated on solvency | **3**: `GatedPayout`, `GuardedLendingVault` (drop-in `onlySolvent`, [SolvencyGuard](../src/guards/SolvencyGuard.sol)) and [`SolvencyGatedMorphoOracle`](../src/integrations/SolvencyGatedMorphoOracle.sol) |
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
| 2 | **Mainnet pilot** | Robinhood Chain and Arbitrum One deployment with one partner custodian on real USDG and stock tokens, plus one lending integration using `SolvencyGuard` | 90 days of uninterrupted epochs, a public status page, and a post-pilot report on coverage, incidents and costs |

## Tracks

- **Promising Products** — primary aim
- **Overall Prize** — stretch; Robinhood Chain deploy for reserved-seat eligibility
- Robinhood reserved seat: deployed and verified on Robinhood testnet (see VERIFY.md)

## Demo script (~110 seconds), on the hosted site plus one terminal shot

Persona: **Kopi Wallet** (fictional SEA custodian). Everything below runs on the live testnet contracts at
[reserveproof-teal.vercel.app](https://reserveproof-teal.vercel.app) with no wallet and no gas.

| t | Scene | What judges see |
|---|---|---|
| 0–10s | Hero + mainnet numbers | 675M USDG on Robinhood Chain mainnet; 50 stock tokens ($158M supply) used as Morpho collateral in 167 markets with 675K USDG borrowed; no reserve-proof oracle found behind any of them; 150 tests under the CTAs |
| 10–15s | Live strip | Latest epoch, last publish time, 200% coverage vs the 103% floor, every contract verified; mTSLA, USDG and real TSLA all solvent |
| 15–20s | 1 One wallet, one custodian | The reserve wallet is bound to Kopi; a second custodian would revert `WalletTaken` |
| 20–30s | 2 Liabilities vs reserves | Owed 500 mTSLA, live reserves 1,000 mTSLA, coverage above the floor → solvent |
| 30–45s | 3 Verify my balance | *Try demo user* → browser rebuilds the tree, root matches on-chain, leaf proven; switch to TSLA to prove 1.5 real TSLA |
| 45–85s | 4 What-if simulator | Drain → `LIVE_SHORT`, skip 8 days → `STALE`, stock split → `MULTIPLIER_DRIFT`, fraud dispute → `DISPUTED`; `GatedPayout` and the lending vault (borrow USDG, withdraw collateral while in debt) flip from Allowed to `Insolvent (reason)` in every scenario, while repaying and debt-free withdrawal stay open. The Morpho oracle row goes from `250 USDG per mTSLA` to `Insolvent (reason)` in all four scenarios |
| 85–95s | 5 ExitRight | Live bonded claim opened by the demo user and settled by the operator, with explorer links |
| (optional) | Curator risk (`/risk`) | Both chains side by side: 200% coverage vs the 103% floor, "48.5% can go before LIVE_SHORT", stale in ~7 days against the next publish on the 3-day schedule, no open disputes, and all 8 gated consumers open, with what each would freeze and the Morpho wrapper's 72h clock |
| 95–110s | Morpho (code + terminal) | `SolvencyGatedMorphoOracle` in one constructor line; `forge test` runs `MorphoIntegration` against the real Morpho Blue core: a drain hidden behind a fresh unsampled epoch, `STALE` or a deactivated custodian still blocks borrow, while repay and lender withdraw work; a pre-started clock buys nothing; after 72 hours of one poked incident, `price()` returns 50% of the base and an underwater position is liquidated |

Local rehearsal with real state changes (no testnet gas):

```bash
npm run demo:node         # terminal A
npm run demo:setup        # terminal B: deploy → build → publish → sample → snapshot
npm run demo:web          # http://localhost:3000
# then SCENE=4|5|6|7 npm run demo:prepare, and npm run demo:reset between takes
```

## Live deployment

The registry, ledger, sampler, ExitRight and mTSLA share addresses on both chains (identical deployer nonce sequence). The dispute layer (DisputeModule, SolvencyOracle, the gated composers, the lending vault and the Morpho wrapper) was redeployed per chain for the SETTLE-1 fix, keeping every epoch and sample (`npm run disputes:redeploy:rh`; old addresses under `previous` in the deployment files). Robinhood: all 13 contracts verified on Blockscout (`npm run verify:rh`). Arbitrum Sepolia: all 14 exact-match on Sourcify (`npm run verify:sourcify`), including the vault's own mock USDG.

| Contract | Robinhood testnet | Arbitrum Sepolia |
|---|---|---|
| CustodianRegistry | [0x364c…0F9E](https://explorer.testnet.chain.robinhood.com/address/0x364c1D50910e3FadED506d38FabeAFc828C30F9E#code) | [Sourcify](https://repo.sourcify.dev/421614/0x364c1D50910e3FadED506d38FabeAFc828C30F9E) |
| LiabilityLedger | [0x1F6f…3537](https://explorer.testnet.chain.robinhood.com/address/0x1F6fAfc59FFe60f2d8d779d202be17d8b36b3537#code) | [Sourcify](https://repo.sourcify.dev/421614/0x1F6fAfc59FFe60f2d8d779d202be17d8b36b3537) |
| ReserveSampler | [0x88ec…5616](https://explorer.testnet.chain.robinhood.com/address/0x88ecb274A5Eb6Dc3310c532b8c94795e65605616#code) | [Sourcify](https://repo.sourcify.dev/421614/0x88ecb274A5Eb6Dc3310c532b8c94795e65605616) |
| DisputeModule (SETTLE-1 fix) | [0x7EBe…116b](https://explorer.testnet.chain.robinhood.com/address/0x7EBe151E45ff79DAb358cb5363F363385b12116b#code) | [0x59B7…EeE4](https://repo.sourcify.dev/421614/0x59B7613228a61091BFE9e4aA2607F12F6916EeE4) |
| SolvencyOracle | [0x7eb2…86A7](https://explorer.testnet.chain.robinhood.com/address/0x7eb23Aa9D81a6a08af61FF1A5Ac8FBDD312686A7#code) | [0xe5c7…cD10](https://repo.sourcify.dev/421614/0xe5c748abc5649a32F99a6BBB296787E64486cD10) · [Arbiscan](https://sepolia.arbiscan.io/address/0xe5c748abc5649a32F99a6BBB296787E64486cD10) |
| ExitRight | [0x2726…EfB6](https://explorer.testnet.chain.robinhood.com/address/0x272644a119088A096F7fDBFE76da71fF01C0EfB6#code) | [Sourcify](https://repo.sourcify.dev/421614/0x272644a119088A096F7fDBFE76da71fF01C0EfB6) |
| GatedPayout | [0x075A…B176](https://explorer.testnet.chain.robinhood.com/address/0x075AD5416F2b10B228a8Ca9D8518b4cf5152B176#code) | [0x5c6A…d513](https://repo.sourcify.dev/421614/0x5c6Ae244BA83c024e4063C49D56f068E0A94d513) |
| MockStockToken (mTSLA) | [0x6606…A248](https://explorer.testnet.chain.robinhood.com/address/0x66069A805d8c96a710B800066FdcEAfdfBcaA248#code) | [Sourcify](https://repo.sourcify.dev/421614/0x66069A805d8c96a710B800066FdcEAfdfBcaA248) |
| GuardedLendingVault | [0xBf5E…b8eF](https://explorer.testnet.chain.robinhood.com/address/0xBf5E41bEAE435E7D19F8dD4E6928e2c2a198b8eF#code) | [0x2C2b…606C](https://repo.sourcify.dev/421614/0x2C2b8B1BD101a177dee6C2f62ccED6C25e9a606C) (lends its own mock USDG [0xa650…C35D](https://repo.sourcify.dev/421614/0xa650A341583de45DfF8d5570236E39dfbf76C35D)) |
| SolvencyGatedMorphoOracle (mTSLA, 72h cap, then 50%) | [0x55bc…847e](https://explorer.testnet.chain.robinhood.com/address/0x55bcE99CF827F940D8138104e6dF0004630A847e#code) | [0xdE3b…c1ea](https://repo.sourcify.dev/421614/0xdE3be6d66148290316F6bb4638E1EfE3233bC1ea) |
| FixedPriceMorphoOracle (base, 250 USDG/mTSLA) | [0xb505…391B](https://explorer.testnet.chain.robinhood.com/address/0xb50515952ABF6332cdd58F07292357980A1B391B#code) | [0x254B…65cb](https://repo.sourcify.dev/421614/0x254B0D3aC4bA80B5AfADBa73A3c78D2a495E65cb) |
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
| Scheduled re-publishing | [Ops epoch workflow](https://github.com/Assassin859/ReserveProof/actions/workflows/ops-epoch.yml) (every 3 days); [first run](https://github.com/Assassin859/ReserveProof/actions/runs/36323953179) published epoch 2 on both chains. The hourly [watchtower](https://github.com/Assassin859/ReserveProof/actions/workflows/watchtower.yml) re-publishes if a scheduled run is missed, pokes the Morpho wrapper, and fails loudly on anything it can't heal |
| Live app | [reserveproof-teal.vercel.app](https://reserveproof-teal.vercel.app) |
| Demo video | _TODO_ |
| Repo | https://github.com/Assassin859/ReserveProof |

## Security review

| ID | Finding | Status |
|---|---|---|
| FIFO-1 | The challenge queue stored bare addresses. When a user's answered challenge was followed by a new one, the stale queue slot pointed at the fresh challenge, so its later deadline could mask an older overdue challenge behind it and keep the oracle reporting solvent. | **Fixed** — queue entries carry a per-challenge sequence number and only count while `open && seq` matches ([regression test](../test/zz_poc_review.ts), "FIFO-1"). Deployed in the current testnet contracts. |
| SETTLE-1 | `openEquivocationDispute` settled every live challenge in one loop (`_settleAllOpenChallenges`). With roughly 909 open challenges the loop exceeded the block gas limit, so an equivocation proof could not be submitted while that many challenges were live. | **Fixed.** The proof now settles at most 64 queue entries inline (about 2.3M gas whatever the queue length), and anyone can refund the rest in pages with `settleChallengesAfterEquivocation(custodianId, asset, maxCount)`, which resumes from a cursor. `expireChallenge` still refunds any single challenge. A Foundry test proves an equivocation with 2,000 open challenges and pages through every refund ([`EquivocationSettlement.t.sol`](../test/foundry/EquivocationSettlement.t.sol)); the dispute invariants now include equivocation and partial settlement. Redeployed and re-verified on both testnets. |
| ADV-1 | Capital borrowed or flash-held for the whole sampling window can inflate reserves. | **Open, disclosed.** Samples take the minimum across distinct `arbBlockNumber` values with a minimum time gap, and the oracle then takes `min(sampleMin, live balance)`. This narrows the attack to capital held across every sample plus the read, but does not eliminate it. |
| VAULT-1 | `GuardedLendingVault.withdrawCollateral` was gated even when the borrower had no debt, so a failing proof that never clears (for example an unresolved dispute) locked collateral that backed nothing, contradicting the contract's own "never trap anyone de-risking" rule. | **Fixed.** The solvency check applies only while the caller has debt; regression tests cover a 30-day lock and repay-then-withdraw while insolvent. Both testnet vaults redeployed and re-verified. |
| WRAP-1 | The Morpho wrapper blocked only on "shortfall" reasons (`LIVE_SHORT`, `UNDERCOLLATERALIZED`, `DISPUTED`, `EXIT_DEFAULT`). `status()` reports only the first failing check, so a drain behind an earlier reason (a fresh epoch with no samples, 7 days without publishing, or a deactivated custodian) kept the wrapper quoting full price. Separately, its freeze clock could be started during a brief shortfall and left running, pre-paying the next freeze, and it reopened full-price borrowing after the cap. | **Fixed.** Every failure reason blocks. The clock belongs to one continuous incident (void if nobody pokes for 6 h), and after the 72 h cap the price is 50% of the base, not full value. Foundry regressions against real Morpho cover each attack. Redeployed and re-verified on both testnets. |
| CLOCK-RESET | The freeze bound is per incident, not cumulative. A healthy poke clears the clock and an unpoked clock is void after 6 h, so a custodian that restores reserves long enough to pass a fresh proof, then drains again, starts a new 72 h freeze, and can repeat this. | **Open, disclosed.** Each round needs the reserves genuinely back on chain (fresh samples and the live balance), and each is public (`FreezeCleared` then `FreezeStarted`, plus the freeze clock on [/risk](https://reserveproof-teal.vercel.app/risk)). The hourly [watchtower](https://github.com/Assassin859/ReserveProof/actions/workflows/watchtower.yml) pokes, so a quiet spell can't void a live clock. A decaying freeze budget carried across incidents is future work. |
| SAMPLE-1 | Reserve sampling is operator-only: `ReserveSampler.recordSample` reverts unless the caller is the custodian's operator, so the operator chooses when samples are taken. | **Open, disclosed.** The live-balance floor at read time limits what timing can buy (reserves must still be there when an integrator calls `isSolvent`). Permissionless sampling is future work. |

Foundry fuzzing in CI covers Merkle-sum proofs ([`MerkleSumFuzz.t.sol`](../test/foundry/MerkleSumFuzz.t.sol)), every oracle reason code including sample-dip window dressing, drift and reason priority ([`SolvencyOracleFuzz.t.sol`](../test/foundry/SolvencyOracleFuzz.t.sol)), the lending vault ([`GuardedVaultFuzz.t.sol`](../test/foundry/GuardedVaultFuzz.t.sol)), registry and config ratchets ([`RegistryConfigFuzz.t.sol`](../test/foundry/RegistryConfigFuzz.t.sol)), ledger commits ([`LedgerFuzz.t.sol`](../test/foundry/LedgerFuzz.t.sol)) and the Morpho wrapper ([`MorphoIntegration.t.sol`](../test/foundry/MorphoIntegration.t.sol)). Stateful invariants cover the DisputeModule challenge queue, ExitRight bond accounting and the vault (no borrow while insolvent, repay and debt-free exit never blocked, accounting and LTV always hold), and every Slither finding is triaged in [SECURITY-SCAN.md](./SECURITY-SCAN.md).

## Residual risks (one-liner for judges)

Flash-borrowed reserves across the full sample window, operator-only sampling, ExitRight bond ≠ full insurance, per-chain allocation ≠ global 100% coverage, and USDG proofs verify only on their home chain (leaves bind the local token address) — documented in README.

Testnet operating rule: any ExitRight demo claim must be settled in the same session. A claim left unsettled past the 72h payout window is slashed and permanently flips mTSLA to EXIT_DEFAULT (reason 8). `npm run status:rh` lists any unsettled claim with its deadline.
