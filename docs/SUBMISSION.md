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
| Robinhood testnet — CustodianRegistry | [0x59Da…D998](https://explorer.testnet.chain.robinhood.com/address/0x59DaBFa5ed05506c130dB72ce78eAFAFFa6DD998#code) |
| Robinhood — SolvencyOracle (`isSolvent` = true, epoch 1) | [0xa175…4dc8](https://explorer.testnet.chain.robinhood.com/address/0xa175E68aB9439950D1005E187f02CcaB83334dc8#code) |
| Robinhood — LiabilityLedger | [0x5DB7…2A89](https://explorer.testnet.chain.robinhood.com/address/0x5DB78Bf53c197257EF55945C25229AC25cBF2A89#code) |
| Robinhood — DisputeModule | [0x4Fa1…653C](https://explorer.testnet.chain.robinhood.com/address/0x4Fa1ac2bA85a5aB4Ee2B9A54c9BEA275Ee2C653C#code) |
| Robinhood — ExitRight | [0x7757…cc6d](https://explorer.testnet.chain.robinhood.com/address/0x77578143aba958687369c6f181b2B6342ba7cc6d#code) |
| Robinhood — ReserveSampler | [0xD15a…188D](https://explorer.testnet.chain.robinhood.com/address/0xD15a2BEfe47d56F03e80adD82FCE5b28c5b4188D#code) |
| Robinhood — GatedPayout | [0xEbD3…A9b3](https://explorer.testnet.chain.robinhood.com/address/0xEbD3EF538daF09153ffC05b38e37e6e822E1A9b3#code) |
| Robinhood — commitEpoch tx | [0xa3c7…763f](https://explorer.testnet.chain.robinhood.com/tx/0xa3c79d40da287cf5753f791931bbe5f5e2dc4e807f1878e78e2c92618845763f) |
| Robinhood — full address book | [`deployments/robinhoodTestnet.json`](../deployments/robinhoodTestnet.json) — all 10 contracts verified (`npm run verify:rh`) |
| Arbitrum Sepolia — SolvencyOracle (`isSolvent` = true, epoch 1) | [0xa175…4dc8](https://repo.sourcify.dev/421614/0xa175E68aB9439950D1005E187f02CcaB83334dc8) · [Arbiscan](https://sepolia.arbiscan.io/address/0xa175E68aB9439950D1005E187f02CcaB83334dc8) |
| Arbitrum Sepolia — DisputeModule | [0x4Fa1…653C](https://repo.sourcify.dev/421614/0x4Fa1ac2bA85a5aB4Ee2B9A54c9BEA275Ee2C653C) |
| Arbitrum Sepolia — commitEpoch tx | [0x42d9…925f](https://sepolia.arbiscan.io/tx/0x42d92feb8e211f9ae1882cac78cf0a01616edd67059aa2f740c60f13b079925f) |
| Arbitrum Sepolia — full address book | [`deployments/arbitrumSepolia.json`](../deployments/arbitrumSepolia.json) — same addresses as Robinhood (identical deployer nonce sequence); all 10 exact-match verified on Sourcify (`npm run verify:sourcify`) |
| Demo video | _TODO_ |
| Repo | https://github.com/Assassin859/ReserveProof |

## Residual risks (one-liner for judges)

Flash-borrowed reserves across the full sample window, ExitRight bond ≠ full insurance, per-chain allocation ≠ global 100% coverage — documented in README.
