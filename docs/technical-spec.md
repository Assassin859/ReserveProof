# ReserveProof — Technical Specification

**Product:** ReserveProof  
**Modules:** Solvency oracle · Merkle-sum liabilities · On-chain reserve sampling · Dispute / fraud proofs · ExitRight (bonded withdrawal)  
**Hackathon:** Arbitrum Open House Singapore — Online Buildathon  
**Primary chains:** Robinhood Chain (testnet `46630`) · Arbitrum Sepolia  
**Settlement / bond asset:** Paxos USDG  
**Status:** Specification v1.1

---

## 1. Executive summary

ReserveProof is an **open-source proof-of-reserves and proof-of-exit** system for custodians that hold **USDG** and/or **Robinhood Stock Tokens** on behalf of users (omnibus / hot-wallet style apps).

It does three jobs:

1. **Commit liabilities** — a Merkle-sum tree of what each user is owed (default: **raw token units**).
2. **Measure reserves on-chain** — read custodian wallets directly (USDG on Robinhood Chain + Arbitrum; stock tokens via `balanceOf` × `uiMultiplier` only for reserve *display / economic measurement* when configured; liability roots default to raw — see §2.3 / §9).
3. **Expose a fail-closed gate** — `isSolvent(custodianId, asset)` that other contracts can `require` before payouts or lending withdrawals.

**ExitRight** extends solvency with a **USDG bond + withdrawal deadline**. If a user proves inclusion and is not paid in time through the contract, the bond compensates them and solvency flips false.

**One-liner for judges:**  
*ReserveProof reads a custodian's reserves directly on-chain, checks them against a user-verifiable liabilities root, and exposes a fail-closed `isSolvent(custodianId, asset)` that any contract can require — plus ExitRight so users can force a bonded withdrawal.*

---

## 2. Problem statement

### 2.1 Custodial trust failure modes

Apps that hold user balances off their personal wallets must continuously convince users and counterparties that:

| Claim | Failure mode |
|---|---|
| Assets exist | Fake screenshots, borrowed reserves at attestation time, drain after sampling |
| Liabilities are complete | Hidden accounts, omitted leaves |
| Books track corporate actions | Share-based internal ledger that fails to credit users after a dividend or split |
| Withdrawals work | Solvent on paper, exits frozen |

These are distinct failures. Proving reserves alone does not prove withdrawability.

### 2.2 Why existing tools are insufficient for this product

| Approach | What it gives | What it leaves out |
|---|---|---|
| Reserve feeds | A reported backing amount per issuer | Per-user custodial liabilities; the figure is often self-reported |
| Liability proofs alone | On-chain liability roots and inclusion proofs | The solvency check against reserves stays off-chain |
| One-off attestations | A point-in-time statement of solvency | Nothing on chain that *gates* payouts or lending on it |
| Closed proof-of-reserves products | Published proofs that some contracts can read | Open, composable infrastructure native to Stock Tokens and USDG |

### 2.3 Stock Token–specific hazard (ERC-8056)

Robinhood Stock Tokens implement **ERC-8056 (Scaled UI Amount)**:

- Raw `balanceOf` / `totalSupply` can stay fixed through corporate actions.
- UI / economic amount = `raw × uiMultiplier() / 1e18` (display and share-count semantics).
- Interface ID: `0xa60bf13d` (`IScaledUIAmount`).
- Pending multipliers via `newUIMultiplier()` / `effectiveAt()` (`IScaledUIAmountNewUIMultiplier`, `0x4bd27648`).

**Important ratio fact:** Scaling **both** reported reserves and reported liabilities by the same multiplier does **not** change the solvency ratio. Blind “multiply both sides” is not a security feature.

**Real risk:** A custodian that keeps a **share-based internal ledger** and fails to credit users after a dividend or split will under-owe on their private books while on-chain raw reserves look unchanged. Users think they own more economic value than the custodian’s committed raw liabilities reflect.

**MVP protection:**

1. Liabilities **default to raw token units** (aligned with ERC-8056 draft guidance: raw is canonical on-chain; UI amount is for display).
2. **Fail-closed on multiplier drift** — if `uiMultiplier` changes (or a pending update becomes relevant) since the epoch snapshot, `isSolvent` is false until the custodian **recommits** a new epoch. That forces an explicit new liability root after corporate actions.
3. If a custodian optionally commits in **economic units**, a multiplier snapshot is **mandatory** and reserves must be measured consistently in the same unit mode.

Verified token reads only: `balanceOf`, `uiMultiplier()`, `newUIMultiplier()`, `effectiveAt()`. Do **not** rely on `balanceOfUI` / `toUIAmount`.

**Issuer caveat:** the token issuer controls `uiMultiplier`. ReserveProof cannot prevent malicious issuer updates; it fail-closes until the custodian recommits.

---

## 3. Goals and non-goals

### 3.1 Goals (MVP)

- Open, permissionless contracts anyone can deploy or integrate.
- On-chain reserve reads (no trusted “we pinky-promise the CSV of wallets”).
- User-verifiable Merkle-sum inclusion **and** omission disputes for users holding signed statements.
- Fail-closed `isSolvent(custodianId, asset)` plus rich `status(...)`.
- Multiplier-drift fail-closed for stock tokens; raw liabilities by default.
- Dual-chain USDG via **per-chain allocations** (no bridge required).
- Fraud / dispute path that flips solvency.
- Sample composers: `GatedPayout`, `GatedLendWithdraw`.
- ExitRight: USDG bond, on-chain `settle`, slash → insolvent.
- Demo persona **Kopi Wallet** (fictional SEA fintech).

### 3.2 Non-goals (MVP)

- ZK privacy for liabilities (classic Merkle-sum only; ZK is v2).
- Replacing Robinhood / Alpaca / RHJ legal custody of *underlying shares*.
- Real bank / CeFi API attestations.
- Building a bridge product.
- Claiming MAS/regulatory compliance in Singapore.
- Guaranteeing flash-loan-free reserves across an entire sampling *window* if capital is borrowed for the whole window (document honestly).

---

## 4. Users and value

### 4.1 Personas

| Persona | Need |
|---|---|
| **End user** | “Am I on the books? Are they solvent? Can I exit?” |
| **Custodian** (mid-tier exchange, payments firm, neobank-style app) | Publish proofs; earn trust; optional bond for ExitRight |
| **Protocol integrator** | `require(isSolvent)` before moving funds |
| **Judge / mentor** | Clear problem, verified contracts, live fail-closed demo |

### 4.2 Who pays (honest framing)

- **Exchanges / platforms** in the Global Dollar Network directory (mid-tier names; OKX-scale already run their own ZK PoR).
- **Payment / custody firms** (SEA names in directory — holdings unverified).
- **Tokenized-stock omnibus apps** — present as market direction; third-party Stock Token custodians are not assumed to be widely live today.

Pitch: **trust product for custodians**, not a Singapore regulatory checkbox.

---

## 5. System architecture

```
                    ┌─────────────────────────────────────────┐
                    │              Off-chain tooling           │
                    │  CSV → Merkle-sum tree → proofs CLI     │
                    │  Custodian dashboard · Verify-my-balance│
                    └───────────────┬─────────────────────────┘
                                    │ txs / proofs
                                    ▼
┌──────────────────────────────────────────────────────────────────┐
│                         On-chain core                            │
│                                                                  │
│  CustodianRegistry          AssetConfig                          │
│       │                          │                               │
│       ▼                          ▼                               │
│  LiabilityLedger  ←—— MerkleSumVerifier (sorted, prefixed)       │
│       │                                                          │
│       ▼                                                          │
│  ReserveSampler (arbBlockNumber + time gap + live balance)       │
│       │                                                          │
│       ▼                                                          │
│  DisputeModule ◄── mismatch + omission (signed stmt + neighbors) │
│       │                                                          │
│       ▼                                                          │
│  SolvencyOracle.isSolvent / status                               │
│       │                                                          │
│       ├──────────────► GatedPayout                               │
│       ├──────────────► GatedLendWithdraw                         │
│       └──────────────► ExitRight (bond · claim · settle · slash) │
└──────────────────────────────────────────────────────────────────┘
```

### 5.1 Trust boundaries

| Component | Trusted for | Not trusted for |
|---|---|---|
| Custodian operator | Publishing truthful CSVs *until challenged* | Final solvency (users + contracts verify) |
| Reserve wallets | On-chain balances at sample / live reads | Future balances |
| Merkle proofs | Inclusion / omission given sorted root + statements | Unsigned claims of omission |
| Oracle contract | Faithfully combining roots + samples + rules | Off-chain bank reserves |
| Token issuer | `uiMultiplier` correctness | (out of scope) |

---

## 6. Core concepts

### 6.1 Custodian

An entity registered on-chain with:

- Unique `custodianId` (bytes32 or uint256).
- Operator address.
- Set of **reserve wallets** (each wallet exclusive to one custodian; ownership proven by signature; removal delayed).
- Optional ExitRight bond parameters.
- Per-chain **liability allocations** for dual-chain assets (see §11).

### 6.2 Asset

Configured per custodian (or globally) with:

- Token address + chain id.
- Decimals.
- Kind: `USDG` | `STOCK_TOKEN` | `ERC20`.
- Unit mode: **`RAW` (default)** or `ECONOMIC` (requires multiplier snapshot).
- Coverage floor (e.g. `103%` = 10300 bps).
- Freshness window (`maxOracleAge`).
- Minimum independent reserve samples.
- `minSampleGap` (seconds) between samples.

### 6.3 Epoch / period

A discrete liabilities snapshot:

- `epochId`
- `liabilityRoot` (Merkle-sum root) — **same root committed on each chain** for dual-chain assets
- `totalLiability`
- `allocation` on this chain (must sum across chains to `totalLiability`)
- `multiplierSnapshot` (required for `ECONOMIC` mode; also stored for drift checks on stock tokens)
- `committedAt`
- Unit mode flag

### 6.4 Solvency result

**Gate (composers / `require`):**

```solidity
function isSolvent(bytes32 custodianId, address asset)
    external
    view
    returns (bool ok, uint64 epochId, uint64 updatedAt);
```

**Full status (UI / indexers / debugging):**

```solidity
struct SolvencyStatus {
    bool ok;
    uint64 epochId;
    uint64 updatedAt;
    uint8 reason; // reason code when !ok; 0 when ok
}

function status(bytes32 custodianId, address asset)
    external
    view
    returns (SolvencyStatus memory);
```

This splits gas-cheap gating from rich reason codes (open decision 4 — settled).

---

## 7. Smart contracts

### 7.1 `CustodianRegistry`

**Responsibilities**

- Register / deactivate custodians.
- Bind reserve wallets with **EIP-712 or personal_sign** ownership proofs.
- Enforce **one custodian per wallet**.
- Delayed wallet removal (`removalDelay`) to stop last-second reserve juggling.

**Key functions (sketch)**

```solidity
function registerCustodian(bytes32 id, address operator) external;
function addReserveWallet(bytes32 id, uint64 chainId, address wallet, bytes calldata ownershipProof) external;
function initiateWalletRemoval(bytes32 id, uint64 chainId, address wallet) external;
function finalizeWalletRemoval(bytes32 id, uint64 chainId, address wallet) external;
```

### 7.2 `AssetConfig`

Stores per-(custodian, asset) parameters: token, chain, kind, unit mode, coverage floor, freshness, sample count, `minSampleGap`, stock-token flag.

### 7.3 `LiabilityLedger`

Stores epoch commitments in **raw units by default**.

```solidity
function commitEpoch(
    bytes32 custodianId,
    address asset,
    uint64 epochId,
    bytes32 liabilityRoot,
    uint256 totalLiability,
    uint256 allocation,          // this chain's share of totalLiability
    uint256 multiplierSnapshot,  // uiMultiplier at commit; mandatory if ECONOMIC
    uint8 unitMode               // RAW | ECONOMIC
) external onlyOperator;
```

Rules:

- Leaves sorted by `userId` (wallet address when ExitRight enabled — see §8).
- For dual-chain assets, the **same** `liabilityRoot` and `totalLiability` are committed on each chain; per-chain `allocation` values must be configured such that they **sum to `totalLiability`** (enforced as a parameter invariant the operator must satisfy; UI rejects misconfigured publishes; optional on-chain check if both allocations are known on one chain, else documented operator duty + UI verification).
- Stock tokens: store `multiplierSnapshot` from `uiMultiplier()` at commit time for drift detection even in `RAW` mode.
- If `unitMode == ECONOMIC`, multiplier snapshot is mandatory and must equal current `uiMultiplier()` (no pending update that would change economic interpretation mid-epoch — fail commit if pending `effectiveAt` is set unsafely per §9).

### 7.4 `MerkleSumVerifier`

Verifies inclusion and supports neighbour proofs for omission.

Domain-separated hashing:

- Leaf prefix: `0x00`
- Node prefix: `0x01`

```text
leafHash = keccak256(0x00 || abi.encodePacked(DOMAIN, custodianId, asset, epochId, userId, amount))
nodeHash = keccak256(0x01 || left.hash || right.hash || left.sum || right.sum)
nodeSum  = left.sum + right.sum  // checked no overflow; amounts non-negative
```

Because node hashes bind the child sums, separate “parent-sum inconsistency” disputes are unnecessary.

### 7.5 `ReserveSampler`

Reads balances of registered **local** wallets on this chain.

**USDG (test addresses)**

- Robinhood testnet: `0x7E955252E15c84f5768B83c41a71F9eba181802F` (6 decimals).
- Arbitrum Sepolia: `0xFFC95faa3d63Cde504a05B567C600B78C0b41892` (6 decimals).

**Stock tokens — verified reads only**

```text
raw = token.balanceOf(wallet)
m   = token.uiMultiplier()        // 1e18 fixed-point
// If measuring economic reserves (ECONOMIC mode only):
economic = raw * m / 1e18
// RAW mode liabilities/reserves comparison uses raw balances.
```

Also read `newUIMultiplier()` / `effectiveAt()` for pending-update fail-closed (see §9). Never call `balanceOfUI` / `toUIAmount`.

**Sampling rules**

1. **Epoch-tied:** Only samples recorded **after** that epoch’s `commitEpoch` count toward it.
2. **Arbitrum block identity:** Distinct samples require distinct `ArbSys(address(100)).arbBlockNumber()` values — **not** `block.number` (on Arbitrum-based chains `block.number` is the L1 block number and many L2 blocks share it).
3. **Time gap:** Additionally enforce `minSampleGap` seconds between samples.
4. **Aggregate sample figure:** `sampleMin = min(accepted samples)`.
5. **Live balance:** On every `isSolvent` / `status` read, also sum current `balanceOf` of all local reserve wallets → `liveReserves`.
6. **Effective reserves:** `effectiveReserves = min(sampleMin, liveReserves)`.

Without the live leg, a custodian can pass sampling fully funded and then drain wallets before a payout.

**Flash-loan note:** A single live read is flash-loanable in isolation; safety depends on `sampleMin` from prior post-commit samples binding the `min`. Residual risk if wallets stay funded across all sample blocks then drain after remains partially addressed by live min; capital borrowed for the whole window is still a documented residual (§3.2).

### 7.6 `DisputeModule`

EIP-712 **balance statement** fields (all required):

```text
custodianId, asset, epochId, user, amount
```

Including `epochId` prevents normal balance changes across epochs from looking like fraud (replay of old statements).

**Dispute paths**

1. **Mismatch:** Valid inclusion proof for amount `A` + custodian-signed statement for amount `B` at the **same** epoch with `A != B`.
2. **Omission:** Custodian-signed statement for `(epoch, user, amount)` + **neighbour proof** that `user` is not present in the sorted tree (two adjacent leaves that bound the missing key).

**Removed:** Parent-sum inconsistency challenges (node hashes already commit to sums).

**Clearing rule (open decision 3 — settled)**

A dispute clears **only** when:

1. A **new epoch** is committed in which the disputing user’s leaf **matches** their statement (inclusion with same amount), and  
2. A **timelock** since that new epoch has elapsed.

The operator **cannot** clear a dispute directly.

Effect while open: `isSolvent → false` (`DISPUTED`).

### 7.7 `SolvencyOracle`

```solidity
function isSolvent(bytes32 custodianId, address asset)
    external view returns (bool ok, uint64 epochId, uint64 updatedAt);

function status(bytes32 custodianId, address asset)
    external view returns (SolvencyStatus memory);
```

Per-chain check (see §11): compare `effectiveReserves` to this chain’s `allocation` (not necessarily full `totalLiability`).

**Fail-closed conditions (`ok == false`)**

| Condition | Reason |
|---|---|
| No epoch committed | `NO_EPOCH` |
| `block.timestamp - updatedAt > maxOracleAge` | `STALE` |
| Disputed | `DISPUTED` |
| Reserve samples < required (post-commit) | `INSUFFICIENT_SAMPLES` |
| `effectiveReserves` below coverage floor vs **allocation** | `UNDERCOLLATERALIZED` |
| Live reserves below floor (even if samples looked fine) | `LIVE_SHORT` (or folded into undercollateralized) |
| `uiMultiplier` / pending update drift since snapshot | `MULTIPLIER_DRIFT` |
| ExitRight unpaid default | `EXIT_DEFAULT` |
| Custodian deactivated | `INACTIVE` |

### 7.8 Composers

**`GatedPayout`** — calls `isSolvent` before release.  
**`GatedLendWithdraw`** — withdraw only if solvent.

Fuzz invariant: **no value leaves either composer while `ok == false`.**

### 7.9 `MockStockToken`

ERC-20 + ERC-8056 with owner-settable `uiMultiplier` / scheduled pending multiplier — required because official test TSLA/AMZN multipliers may be immutable.

### 7.10 `ExitRight`

See §10.

---

## 8. Merkle-sum liabilities (detail)

### 8.1 Tree format (MVP)

**Decision (former open decision 5 — settled):** **one tree per `(custodian, asset, epoch)`** (single-asset trees).

**Sorting:** Leaves sorted ascending by `userId`.

**ExitRight mode:** `userId` **is the user wallet address** (payout key). This avoids a separate binding from hashed ID → payout address.

**Prefixes:** `0x00` leaf · `0x01` node (see §7.4).

```text
leafHash = keccak256(0x00 || encode(DOMAIN, custodianId, asset, epochId, userWallet, amount))
```

Amounts are **raw** by default; if `ECONOMIC` mode, amounts are economic units and multiplier snapshot is mandatory.

### 8.2 Off-chain CLI

Input: CSV `user,amount` (wallets; raw amounts by default)  
Output:

- Sorted tree → `root`, `total`
- Per-user inclusion proof JSON
- Neighbour proofs for omission challenges
- Calldata helpers for `commitEpoch`

### 8.3 Omission security

With **sorted leaves** + **EIP-712 statements that include epoch**:

- Any user holding a signed statement can prove they were **left out** by exhibiting neighbour leaves that bound their `userId` and showing no leaf for them.
- Omission is therefore a **first-class dispute**, not merely “users who never check might be missing.”

Residual: users with **no** statement and **no** inclusion still cannot prove omission — custodians should issue statements broadly; demo shows statement + omission path.

---

## 9. Multiplier policy (Stock Tokens)

**Do not** treat “scale both sides by M” as protection — the ratio is unchanged.

**Do** treat corporate actions as a **recommmit trigger**:

On each `isSolvent` / `status` for an ERC-8056 asset:

1. Read `uiMultiplier()`, `newUIMultiplier()`, `effectiveAt()`.
2. If a pending update is scheduled / newly effective such that economic interpretation changed since `multiplierSnapshot` → **fail-closed** (`MULTIPLIER_DRIFT`).
3. If `uiMultiplier() != epoch.multiplierSnapshot` → **fail-closed**.
4. Custodian must `commitEpoch` again (new root reflecting any share-ledger credits they owe users in raw or economic mode as configured).

**RAW mode (default):** liabilities and reserve comparisons use `balanceOf` raw units; multiplier snapshot still stored so drift can force recommit after corporate actions (when internal share ledgers typically change).

**ECONOMIC mode (optional):** liabilities are economic units; reserves use `balanceOf * uiMultiplier / 1e18`; snapshot mandatory at commit.

---

## 10. ExitRight module

### 10.1 Intent

Prove **withdrawability**, not only solvency math.

### 10.2 Flow

```text
1. Custodian deposits USDG bond; sets delays and caps
2. User proves inclusion in the LATEST epoch for amount A
3. User opens Claim(latestEpoch, A) — at most once per (user, epoch)
4. Custodian MUST pay via ExitRight.settle(claimId) (on-chain transfer observed)
5. If unpaid by deadline:
     - bond (up to per-claim and remaining total caps) → user
     - EXIT_DEFAULT → isSolvent = false
```

Off-chain payments **do not** count.

### 10.3 Claim rules

- Only against the **latest** committed epoch.
- **Once** per `(user, epoch)`.
- Leaf key = user wallet (see §8.1).

### 10.4 Payout asset (open decision 2 — settled)

**MVP: pay in the same token as the liability asset** (stock token or USDG).  
Avoids needing a claim-time price oracle for stock tokens.

(USDG-priced settlement of stock claims is a future option.)

### 10.5 Bond caps and bank runs

| Param | Meaning |
|---|---|
| `bondAmount` | USDG posted |
| `maxPayoutDelay` | Seconds after claim |
| `maxBondPerClaim` | Cap of bond consumed by one claim |
| `maxBondTotalInFlight` | Cap across concurrent claims |

**Bank-run note:** Many simultaneous claims are an **intended stress test**. The bond is not a full insurance fund for all liabilities; it is a deterrent + partial compensation. Caps must be stated in UI and README. Exhausted bonds still flip `EXIT_DEFAULT` / block new healthy optics per policy (document: unpaid claims beyond bond still mark default).

### 10.6 Interaction with oracle

Any unresolved ExitRight default → `EXIT_DEFAULT` → fail-closed for that custodian (MVP: **per-custodian freeze** on the asset, or global — prefer **per asset** unless demo clarity wants global).

---

## 11. Cross-chain USDG (per-chain allocations)

**Open decision 1 — settled. No bridge. No remote attestation options A/B/C.**

### 11.1 Model

For an asset tracked on multiple chains (notably USDG):

1. Build **one** Merkle-sum liability tree; `totalLiability` and `liabilityRoot` are identical on every chain.
2. Assign each chain an **`allocation`** (e.g. Robinhood 60%, Arbitrum 40%) such that  
   `Σ allocation_chain = totalLiability`.
3. Commit the same root + total on each chain with that chain’s allocation.
4. Each chain’s `SolvencyOracle` checks **local** `effectiveReserves` against **local** `allocation` (with coverage floor).
5. The **UI** shows the combined picture (all chains’ statuses).

Fully verifiable on each chain without cross-chain messaging.

### 11.2 Integrator semantics (important)

- `isSolvent` on Robinhood means: **this chain’s allocation is covered under policy** — not necessarily “100% of global liabilities sit on this chain.”
- Global “fully backed” in the demo UI = **AND** of per-chain statuses (each `ok`).
- Composers should run on the chain where funds move and gate on **that** chain’s oracle.

---

## 12. Security model and attacks

| Attack | MVP mitigation |
|---|---|
| Flash-loan reserves at single block | Multi-sample `min` over distinct `arbBlockNumber` + `minSampleGap` |
| Borrowed reserves for entire window | Document residual risk |
| Drain after sampling | `effectiveReserves = min(sampleMin, liveBalances)` |
| Relying on `block.number` on Arbitrum | Use `ArbSys.arbBlockNumber()` |
| Omit users from tree | Sorted tree + omission dispute with signed statement + neighbours |
| Old statements replayed across epochs | `epochId` inside EIP-712 statement |
| Two custodians claim same wallet | Exclusive registration + signature |
| Last-second wallet rotate | Removal delay |
| Stale happy path | Fail-closed on age |
| Ignore dividend/split / share-ledger lag | Multiplier drift fail-closed + recommit |
| Fake solvency while exits frozen | ExitRight + `EXIT_DEFAULT` |
| ExitRight double claims | Latest epoch only; once per `(user, epoch)` |
| Off-chain “we paid you” | Only `ExitRight.settle` counts |
| Operator clears dispute instantly | New matching epoch + timelock only |

### 12.1 Fuzz / invariant targets

- `ok` never true when stale, disputed, under-sampled, under coverage, multiplier drift, or exit default.
- `ok` never true when **live** reserves are below the floor.
- Zero outbound value from `GatedPayout` / `GatedLendWithdraw` while `!ok`.
- Merkle verify rejects tampered amounts.
- Wallet cannot be registered to two custodians.
- ExitRight claim cannot be opened twice per `(user, epoch)`.
- Sum of per-chain allocations equals `totalLiability` (for dual-chain publishes).

Static analysis: Slither on all contracts.

---

## 13. Off-chain applications

### 13.1 CLI

- Build **sorted** tree from CSV  
- Emit inclusion + neighbour proofs  
- Submit `commitEpoch` helpers (multi-chain allocation aware)

### 13.2 Web app (demo)

**Kopi Wallet** persona — seven scenes:

1. Duplicate reserve wallet rejected  
2. Epoch committed at 103% coverage  
3. User verifies balance inclusion  
4. Reserves drop → payout blocked + lending frozen  
5. Multiplier change → fail-closed  
6. Stale data → fail-closed  
7. Fraud proof → disputed  

### 13.3 Operator dashboard

- Register wallets  
- Upload CSV / publish epoch (with per-chain allocations)  
- Monitor `status` reasons  
- Manage ExitRight bond / `settle`

---

## 14. Tech stack

| Layer | Choice |
|---|---|
| Smart contracts | Solidity 0.8.x · Foundry (Forge/Cast/Anvil) |
| Libraries | OpenZeppelin (Ownable, ECDSA, ReentrancyGuard) |
| Tests | Forge unit · fuzz · invariants |
| Frontend | Next.js · viem · wagmi |
| Chains | Robinhood Chain testnet `46630` · Arbitrum Sepolia |
| RPC (RH testnet) | `https://rpc.testnet.chain.robinhood.com` |

---

## 15. Repository layout (target)

```text
ReserveProof/
├── docs/
│   └── technical-spec.md          ← this document
├── foundry.toml
├── src/                           # or contracts/
│   ├── CustodianRegistry.sol
│   ├── AssetConfig.sol
│   ├── LiabilityLedger.sol
│   ├── MerkleSumVerifier.sol
│   ├── ReserveSampler.sol
│   ├── DisputeModule.sol
│   ├── SolvencyOracle.sol
│   ├── ExitRight.sol
│   ├── composers/
│   │   ├── GatedPayout.sol
│   │   └── GatedLendWithdraw.sol
│   └── mocks/
│       └── MockStockToken.sol
├── test/
├── script/
├── packages/
│   ├── cli/
│   └── web/
└── README.md
```

---

## 16. Hackathon submission

**Idea field (285 characters):**

> ReserveProof: open-source proof of reserves for custodians of USDG and Robinhood Stock Tokens. Reserves read on-chain across Robinhood Chain and Arbitrum, Merkle-sum liabilities with user fraud proofs, and a fail-closed isSolvent(custodian, asset) that payouts and lending can require.

*(ExitRight described in long description / demo as the withdrawability module.)*

**Prize tracks**

- **Overall Prize** (primary stretch) — deploy on Robinhood Chain for reserved-spot eligibility  
- **Promising Products** (primary aim)

Grants are discretionary (not a track).

---

## 17. Success criteria for MVP

| # | Criterion |
|---|---|
| 1 | Verified contracts on Robinhood testnet (+ Arb Sepolia for allocation model) |
| 2 | CLI produces sorted tree + inclusion/neighbour proofs from CSV |
| 3 | User inclusion verification works in UI |
| 4 | Live demo: under-reserves / stale / multiplier / dispute each flip `ok` to false |
| 5 | Gated composers revert while insolvent |
| 6 | ExitRight unpaid claim slashes bond (via missed `settle`) and freezes solvency |
| 7 | README documents residual risks and non-goals honestly |
| 8 | Fuzz suite covers fail-closed invariants including live short + allocation sum |

---

## 18. Open decisions

| # | Topic | Status |
|---|---|---|
| 1 | Cross-chain USDG | **Settled — per-chain allocations** (§11) |
| 2 | ExitRight payout asset | **Settled — same token as liability** (§10.4) |
| 3 | Dispute clearing | **Settled — new matching epoch + timelock** (§7.6) |
| 4 | Reason codes | **Settled — `status()` full; `isSolvent` triple** (§6.4 / §7.7) |
| 5 | Tree shape | **Settled — single-asset trees** (§8.1) |

No open product decisions remain for MVP scope.

---

## 19. Glossary

| Term | Meaning |
|---|---|
| **PoR** | Proof of reserves (assets) |
| **PoL** | Proof of liabilities |
| **Solvency** | Effective reserves ≥ allocation (per chain) under policy |
| **Merkle-sum tree** | Sorted Merkle tree that also commits to summed balances |
| **Fail-closed** | Ambiguity or staleness ⇒ treat as insolvent |
| **Raw units** | ERC-20 `balanceOf` amounts (default liability unit) |
| **Economic / UI units** | `raw × uiMultiplier / 1e18` (display; optional commit mode) |
| **Allocation** | Per-chain slice of `totalLiability` that local reserves must cover |
| **ExitRight** | Bonded withdrawal claim module with on-chain `settle` |
| **Kopi Wallet** | Fictional SEA fintech demo custodian |

---

## 20. References (implementation bookmarks)

- Robinhood Stock Tokens docs — ERC-8056 / `uiMultiplier`  
- EIP-8056 — Scaled UI Amount Extension (`0xa60bf13d`)  
- Paxos / Global Dollar (USDG) test token addresses above  
- Robinhood Chain testnet — chain id `46630` · `ArbSys` precompile `address(100)`  

---

*Document version: 1.1 · Project: ReserveProof · Incorporates review deltas (solvency API, sampler, raw units, disputes, ExitRight, allocations)*
