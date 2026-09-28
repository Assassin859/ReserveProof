# Security scan: Slither + Foundry invariants

Scan date: 2026-09-28 · commit after `SolvencyGuard` / TSLA work · scope: every contract under `src/`
(46 contracts analyzed, dependencies excluded).

## TL;DR

- **Slither 0.11.6, 102 detectors: 49 results, 0 real issues.** The single High is a known Slither
  false positive (storage written through a pointer). Every Medium is either a zero-initialized local
  that is assigned before use, or a tuple field deliberately ignored. Lows are bounded loops and
  hour-scale timestamp windows.
- **`SolvencyGuard` and `GuardedLendingVault` produced no findings.**
- **9 Foundry invariants hold over 2 × 128 runs × 64 calls** (16,384 random calls, 0 unexpected
  reverts with `fail_on_revert = true`) across `DisputeModule`'s challenge queue and `ExitRight`'s
  bond accounting. Deterministic smoke tests prove the handlers reach every path (answer, expire,
  matching-epoch clear, bond withdrawal, settle, slash), so the invariants are not passing vacuously.
- One property from our own plan turned out **not** to be an invariant: `bondInFlight <= bondBalance`.
  The in-flight cap intentionally lets claims reserve more than the posted bond; it is pinned by a
  test and documented below and in the README's residual risks.

## Reproduce

```bash
# Slither (Windows note: pin cbor2==5.6.5 if Application Control blocks the cbor2 native module)
python -m venv .venv-slither && .venv-slither/bin/pip install slither-analyzer
npx hardhat clean && npx hardhat compile
slither . --compile-force-framework hardhat --hardhat-ignore-compile \
  --filter-paths node_modules --exclude-dependencies

# Foundry fuzz + invariants (config in foundry.toml: [invariant] runs=128 depth=64 fail_on_revert=true)
forge install foundry-rs/forge-std --no-git
forge test
```

## Slither triage

| Severity | Detector | Count | Verdict |
|---|---|---|---|
| High | `uninitialized-state` | 1 | False positive |
| Medium | `uninitialized-local` | 8 | False positive |
| Medium | `unused-return` | 13 | Intentional |
| Low | `timestamp` | 12 | Accepted (see note on Arbitrum timestamps) |
| Low | `calls-loop` | 7 | Accepted |
| Informational | `missing-inheritance` | 3 | Accepted |
| Informational | `cyclomatic-complexity` | 2 | Accepted |
| Informational | `unindexed-event-address` | 1 | Accepted |
| Optimization | `immutable-states` | 2 | Deferred to next deployment |

### High: `ReserveSampler._samples` "never initialized" (false positive)

`recordSample` takes a storage reference (`Sample[] storage list = _samples[...]`) and pushes through
it. Slither does not track writes made through storage pointers. The mapping is written on every sample:
Hardhat tests assert `sampleCount`, and the live Robinhood deployment reports `sampleCount=2` for each
published epoch.

### Medium: `uninitialized-local` (false positive, 8)

Counters and accumulators that rely on Solidity's zero default (`n`, `sum`, `d`, `homeFound`) and three
locals in `SolvencyOracle.status` (`live`, `pendingAt`, `newMul`). The latter are assigned inside a
`try` branch, and every `catch` **returns a failing status** (`LIVE_SHORT` or `MULTIPLIER_DRIFT`), so
the zero value is never read. That is the fail-closed design, not a bug.

### Medium: `unused-return` (intentional, 13)

Destructuring `registry.custodians(id)` to read only `operator` or `active`, and `oracle.isSolvent` to
read only `ok` in `GatedPayout` / `GatedLendWithdraw`. `ok` already folds in staleness, disputes and
exit default, so the ignored `epochId` / `updatedAt` are informational.

### Low: `timestamp` (accepted, 12)

All comparisons are against windows measured in hours or days (challenge window, clear timelock, oracle
max age, ExitRight payout delay, sample gap), not against exact-second values. **Arbitrum note:** the
sequencer may set `block.timestamp` up to 24 h behind or about 1 h ahead of real time. The testnet
deployment uses 1 h challenge and clear windows for demo speed; a production deployment should use
windows of at least 24 h so timestamp skew cannot expire a challenge early.

### Low: `calls-loop` (accepted, 7)

`ReserveSampler` loops over the operator's `sampleWallets` to check registration and read balances. The
list is set by the custodian's own operator, so a long or reverting list can only block that custodian's
own sampling. The oracle wraps `liveReserves` in `try/catch` and fails closed as `LIVE_SHORT`.

### Informational (accepted)

- `missing-inheritance`: `SolvencyOracle` is ABI-compatible with `ISolvencyOracle` (added later for
  integrators) but does not inherit it, which keeps the already-verified bytecode unchanged. The same
  applies to `ExitRight` / `IExitRightFlag` and to `MockStockToken` / `IERC8056`.
- `cyclomatic-complexity`: `AssetConfig.setAssetConfig` and `LiabilityLedger.commitEpoch` are
  validation-heavy by design (immutable fields, no policy weakening, signed commitments). Each branch has
  a Hardhat test.
- `unindexed-event-address`: `ExitRightSet` fires once per deployment.

### Optimization: `immutable-states` (deferred)

`DisputeModule.clearTimelock` and `challengeWindow` are never written after construction and could be
`immutable` (a gas saving only). Changing the source now would break the byte-for-byte match with the
contracts verified on Robinhood and Arbitrum, so this is batched with the next redeploy.

## Foundry invariants

Handlers live in `test/foundry/*Invariants.t.sol` and share `test/foundry/helpers/RPBase.sol`: a real
registry, asset config and ledger, with operator-signed EIP-712 epoch commitments and a 4-leaf
Merkle-sum book that is re-committed at every new epoch.

### `DisputeModule` (`DisputeInvariants.t.sol`)

Random users challenge honest or inflated balances across epochs. The operator answers whatever it can
prove, anyone expires overdue challenges, honest disputes are cleared through a newer matching epoch,
and time warps up to 3 h per step.

| Invariant | Why it matters |
|---|---|
| `challengeHead <= challengeQueueLength` | The FIFO head can never run past the queue. |
| `openChallengeCount` == brute-force count of open challenges | Superseded or closed queue slots never mask or double-count a live challenge (the FIFO-1 fix). |
| `hasOverdueChallenge` == "any open challenge past its deadline" | The O(1) head check the oracle relies on agrees with a full scan. |
| `openDisputeCount` == brute-force open disputes, and `isDisputed` == (count > 0) | The oracle's `DISPUTED` flag cannot drift from the real dispute set. |
| Module's USDG == bonds locked in open challenges + refunds owed | Challenge bonds are always fully backed. |

### `ExitRight` (`ExitRightInvariants.t.sol`)

Users claim against the latest epoch. The operator settles some claims, anyone slashes overdue ones, the
bond is topped up, new epochs are committed, and time warps up to 2 days per step.

| Invariant | Why it matters |
|---|---|
| ExitRight's USDG == `bondBalance`, and posted == `bondBalance` + slashed payouts | Slashes can never pay more than was posted; no bond is created or lost. |
| `bondInFlight` == sum of `bondReserved` over open claims, and <= `maxBondTotalInFlight` | Reservation accounting is exact and the in-flight cap holds. |
| Every claim is exactly one of open / settled / slashed | No double payout, no zombie claims. |
| `exitDefault` is sticky and set iff a claim was slashed | `EXIT_DEFAULT` can't be erased, and can't be set without a missed deadline. |

### Not an invariant: `bondInFlight <= bondBalance`

`openClaim` checks each claim's reservation against the bond balance and the total against
`maxBondTotalInFlight` (at least 3× the per-claim bond). So claims can reserve more than is posted, and
a bank run of slashes pays first-come, capped at what remains.
`ExitRightOversubscriptionTest` pins this behaviour: 3 × 10 USDG reserved against a 10 USDG bond, the
first slasher is paid in full and the rest get nothing, yet every claim still sets `EXIT_DEFAULT`. The
bond is a deterrent, not insurance; the README's residual risks say so, and a custodian that wants full
cover sets `maxBondTotalInFlight` <= posted bond.
