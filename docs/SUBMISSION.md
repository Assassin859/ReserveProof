# Hackathon submission draft — ReserveProof (+ ExitRight)

Fill explorer / video links after tomorrow’s funded deploy. See [VERIFY.md](./VERIFY.md).

## Idea field (285 characters — locked)

> ReserveProof: open-source proof of reserves for custodians of USDG and Robinhood Stock Tokens. Reserves read on-chain across Robinhood Chain and Arbitrum, Merkle-sum liabilities with user fraud proofs, and a fail-closed isSolvent(custodian, asset) that payouts and lending can require.

*(Character count: 285 including spaces.)*

## Longer description

**ReserveProof** is an open-source proof-of-reserves and proof-of-liabilities stack for custodians that hold **USDG** and **Robinhood Stock Tokens**. Operators publish a sorted Merkle-sum liability tree; reserves are read on-chain via multi-sample + live balance checks (using `arbBlockNumber` where available). Integrators call `isSolvent(custodianId, asset)` / `status(...)` and get a fail-closed reason code — so payouts and lending can `require` solvency instead of trusting a dashboard.

**ExitRight** is the withdrawability module: bonded claims with on-chain `settle`. Unpaid claims can mark exit default and freeze solvency.

**Positioning**

| Prior art | Gap ReserveProof targets |
|---|---|
| Chainlink PoR | Feed-style reserve attestations; not full user-verifiable liabilities + gated composers |
| Summa | Strong PoL ideas; we ship open contracts + CLI + fail-closed oracle for stock-token / USDG custodians |
| Accountable | Closed / productized; we stay open-source, dual-chain allocations, ERC-8056 multiplier drift, ExitRight |

**Who pays (honest):** mid-tier and SEA fintech custodians (demo persona **Kopi Wallet**) that need auditable backing without building a full ZK stack. Not “retail pays gas for vibes” — operators fund publishing; users verify inclusion for free off-chain / light RPC.

## Tracks

- **Promising Products** — primary aim  
- **Overall Prize** — stretch; Robinhood Chain deploy for reserved-seat eligibility  
- Robinhood reserved seat: deploy + verify on Robinhood testnet (see VERIFY.md)

## Demo script (~90 seconds) — seven scenes

Persona: **Kopi Wallet** (fictional SEA custodian).

| t | Scene | What judges see |
|---|---|---|
| 0–10s | 1 Duplicate wallet | Exclusive reserve wallet — second claim rejected (`WalletTaken`) |
| 10–25s | 2 Epoch @ 103% | Commit + samples → `isSolvent true` / `OK` |
| 25–40s | 3 Inclusion verify | User pastes CLI proof JSON → UI verifies against on-chain root |
| 40–55s | 4 Drain | Reserves emptied → `GatedPayout` blocked / `LIVE_SHORT` |
| 55–65s | 5 Multiplier | `uiMultiplier` moves → `MULTIPLIER_DRIFT` |
| 65–75s | 6 Stale | Time warp → `STALE` |
| 75–90s | 7 Dispute | Mismatch fraud proof → `DISPUTED` |

Local rehearsal (no testnet gas):

```bash
npx hardhat node          # terminal A
npm run demo:deploy       # terminal B
npm run demo:cli          # build out/ from example CSV
npm run ops:publish && npm run ops:sample
npm run demo:web          # http://localhost:3000
# then SCENE=4|5|6|7 npm run demo:prepare
```

## Placeholders (fill after deploy)

| Item | Link |
|---|---|
| Robinhood testnet explorer — CustodianRegistry | _TODO — awaiting funded `deploy:rh` (deployer currently 0 balance)_ |
| Robinhood — SolvencyOracle | _TODO_ |
| Arbitrum Sepolia — allocation twin | _TODO — awaiting funded `deploy:arb`_ |
| Verified contract URLs | _TODO_ — see VERIFY.md checklist |
| Demo video | _TODO_ |
| Repo | https://github.com/Assassin859/ReserveProof |

## Residual risks (one-liner for judges)

Flash-borrowed reserves across the full sample window, ExitRight bond ≠ full insurance, per-chain allocation ≠ global 100% coverage — documented in README.
