# ReserveProof

[![CI](https://github.com/Assassin859/ReserveProof/actions/workflows/ci.yml/badge.svg)](https://github.com/Assassin859/ReserveProof/actions/workflows/ci.yml)
[![Ops epoch](https://github.com/Assassin859/ReserveProof/actions/workflows/ops-epoch.yml/badge.svg)](https://github.com/Assassin859/ReserveProof/actions/workflows/ops-epoch.yml)

Open-source proof of reserves and proof of exit for custodians of **USDG** and **Robinhood Stock Tokens**,
shipped as one modifier any lending market can add: `onlySolvent(asset)`.

**Live demo:** [reserveproof-teal.vercel.app](https://reserveproof-teal.vercel.app) (Kopi Wallet on Robinhood testnet and Arbitrum Sepolia)
· **145 tests** (`npm run test:count`) · 13 of 13 contracts verified on both testnets

## Why

On Robinhood Chain mainnet today (block 75,032,783, 28 Sep 2026, [`npm run market:size`](scripts/market-size.ts),
raw output in [`docs/market-size.json`](docs/market-size.json)):

- **675.5M USDG** in circulation.
- **50 stock and ETF tokens are used as Morpho collateral**, with **$158.3M** of total supply between them
  (ERC-8056 tokens only; stock tokens never posted on Morpho aren't counted).
- **167 Morpho Blue markets** lend USDG against those tokens: **745,012 USDG** supplied, **675,019 USDG**
  borrowed.
- **We found no reserve-proof oracle behind any of them.** Of the 167 distinct market oracles, 113 are
  Morpho's standard Chainlink-style oracle reading price feeds only (none of the feeds describes a reserve
  proof); the other 54 are custom contracts we couldn't classify. A Morpho market only asks its oracle for
  `price()`.

ReserveProof gives them that signal, fail-closed:

- On-chain reserve reads (multi-sample + live balance)
- Merkle-sum liabilities with user inclusion / omission proofs
- Fail-closed `isSolvent(custodianId, asset)` that payouts and lending can `require`
- **ExitRight** — bonded withdrawal with on-chain `settle`

See [docs/technical-spec.md](docs/technical-spec.md) for the full design.

Hackathon packet: [docs/SUBMISSION.md](docs/SUBMISSION.md) · [docs/VERIFY.md](docs/VERIFY.md)

## How it works

```mermaid
flowchart LR
  subgraph custodian [Custodian operator]
    book[Liability book CSV] --> tree[Merkle-sum tree]
    tree -->|"commitEpoch: root, total, EIP-712 sig"| ledger[LiabilityLedger]
  end
  reserves[Reserve wallets] -->|"recordSample: min over blocks"| sampler[ReserveSampler]
  ledger --> oracle[SolvencyOracle]
  sampler --> oracle
  disputes[DisputeModule] -->|"open challenge = DISPUTED"| oracle
  exit[ExitRight] -->|"unpaid claim = EXIT_DEFAULT"| oracle
  oracle -->|"isSolvent / status"| apps[GatedPayout, GatedLend, any integrator]
  user[User] -->|"rebuild tree, verify leaf"| ledger
  user -->|"challenge or fraud proof"| disputes
  user -->|"openClaim with leaf proof"| exit
```

1. **The custodian publishes** a sorted Merkle-sum root of what it owes per asset and per epoch, signed with a chain-agnostic EIP-712 commitment.
2. **The operator samples reserves.** `ReserveSampler.recordSample` is operator-gated; it records the reserve wallets' balances at several distinct blocks, and the oracle takes `min(samples, live balance)` against 103% of the allocation.
3. **The oracle answers** `isSolvent(custodianId, asset)` with a reason code (OK, STALE, DISPUTED, LIVE_SHORT, MULTIPLIER_DRIFT, EXIT_DEFAULT, …). It fails closed on anything it can't prove.
4. **Users verify** that their leaf is in the committed root. The Kopi UI rebuilds the tree in the browser.
5. **Anyone disputes.** Unanswered inclusion challenges, signed-statement mismatches and equivocation flip the oracle to DISPUTED.
6. **ExitRight** lets a user with a leaf proof open a bonded withdrawal claim. If the operator doesn't `settle` in time, the bond is slashed to the user and the asset is marked EXIT_DEFAULT.

## The product: any lending market adds one line, `onlySolvent(asset)`

```solidity
import {SolvencyGuard} from "reserveproof/src/guards/SolvencyGuard.sol";
import {ISolvencyOracle} from "reserveproof/src/interfaces/ISolvencyOracle.sol";

contract MyMarket is SolvencyGuard {
    constructor(ISolvencyOracle oracle, bytes32 custodianId) SolvencyGuard(oracle, custodianId) {}
    function borrow(uint256 amt) external onlySolvent(address(mTSLA)) { /* ... */ } // reverts Insolvent(reason)
}
```

[`src/examples/GuardedLendingVault.sol`](src/examples/GuardedLendingVault.sol) is a worked example: lenders
supply USDG, borrowers post mTSLA and borrow at 50% LTV. `borrow` stops the moment the custodian's proof
fails, and so does `withdrawCollateral` while the caller still has debt. Repaying, adding collateral and
withdrawing collateral with no debt never stop, so nobody is trapped while de-risking, even if a dispute
keeps the oracle red indefinitely. It is deployed and verified on both testnets, and the web simulator
shows it flipping from Allowed to `Insolvent (STALE)` etc. against the live contracts.

| Network | GuardedLendingVault | Demo borrower |
|---|---|---|
| Robinhood testnet | [`0x6c7C…73a9`](https://explorer.testnet.chain.robinhood.com/address/0x6c7C5100C812e1c95B2D745a33004Ef85E4573a9#code) | 10 mTSLA collateral, owes 1 USDG; 4 USDG liquidity |
| Arbitrum Sepolia | [`0x99Eb…46EF`](https://repo.sourcify.dev/421614/0x99EbFe9eB529cfE13828ba42684761B6920046EF) | 10 mTSLA collateral, no debt (shows the debt-free exit) |

## Morpho Blue: wrap the oracle, not the market

Morpho markets are immutable, so the guard goes in front of the market's oracle:
[`SolvencyGatedMorphoOracle`](src/integrations/SolvencyGatedMorphoOracle.sol) forwards the base oracle's
`price()` and reverts `Insolvent(reason)` whenever the custodian's proof fails, for any reason.

```solidity
IOracle gated = new SolvencyGatedMorphoOracle(
    existingOracle, solvencyOracle, custodianId, TSLA,
    72 hours, // maxFreeze: how long one continuous failure blocks pricing
    6 hours,  // maxPokeGap: an incident clock nobody pokes for this long is void
    5000      // postCapBps: after maxFreeze, price at 50% of the base oracle
);
// createMarket({loanToken: USDG, collateralToken: TSLA, oracle: gated, irm, lltv})
```

**Every failed proof blocks.** `status()` reports only the first failing check, and `INACTIVE`, `NO_EPOCH`,
`STALE` and `INSUFFICIENT_SAMPLES` are checked before `LIVE_SHORT`. A wrapper that ignored any of them
could keep quoting full price while the reserves are drained behind that earlier reason.

The trade-off, stated plainly: Morpho calls `price()` in `borrow`, indebted `withdrawCollateral` and
`liquidate` alike, so while the wrapper reverts, underwater loans can't be liquidated either. So the
freeze is bounded, and tied to one incident:

- **One continuous incident.** Anyone can call `poke()` while the proof fails. The first poke starts the
  clock and later pokes keep it alive. If nobody pokes for `maxPokeGap`, the clock is void, and the next
  poke starts a new incident. A clock started during an earlier, since-restored shortfall therefore
  can't pre-pay the next freeze. A healthy poke clears it.
- **After the cap, a discounted price, not full value.** Once one incident has lasted `maxFreeze`,
  `price()` returns the base price times `postCapBps`. Underwater loans become liquidatable, and new
  borrowing reopens only at half value. Liquidators have every reason to keep poking.

The residual risk: a custodian can hold a visible failure for 72 hours while someone keeps poking, then
drain. By then the market has been frozen for three days, which is time for vault curators to pull
liquidity or set caps to zero, and it prices the collateral at half.

It reverts instead of returning 0 because a zero price would let liquidators seize every position for
free. `supply`, `withdraw`, `supplyCollateral`, `repay` and debt-free exits always work because Morpho
skips the oracle for positions without debt.
[`test/foundry/MorphoIntegration.t.sol`](test/foundry/MorphoIntegration.t.sol) runs each path against the
unmodified Morpho Blue v1.0.0 core, including:

- a drain hidden behind `INSUFFICIENT_SAMPLES`, `STALE` or `INACTIVE`;
- a pre-started clock;
- liquidation at the discounted price after the cap.

| Network | SolvencyGatedMorphoOracle (mTSLA, base 250 USDG) |
|---|---|
| Robinhood testnet | [`0x36a8…03B8`](https://explorer.testnet.chain.robinhood.com/address/0x36a84f430973d2AE6B2Cc4710003204027c203B8#code) |
| Arbitrum Sepolia | [`0xdAD1…4aD4`](https://repo.sourcify.dev/421614/0xdAD1A4478C30a87EBa2DBd64CE21E8eFAb354aD4) |

## Stack

- Solidity 0.8.24
- Hardhat (compile / test)
- **145 tests** (`npm run test:count`, printed in CI): 50 Hardhat, 61 Foundry fuzz properties, 20 Foundry unit tests and 14 stateful invariants.
- **Fuzzed with Foundry:** property tests on `MerkleSumVerifier`, every `SolvencyOracle` reason code (coverage boundary, sample-dip window dressing, staleness, disputes, split drift, reason priority), the lending vault, registry and config ratchets, ledger commits and the Morpho wrapper inside a real Morpho Blue market.
- **Invariant-tested + Slither-scanned:** handler-driven invariants on the `DisputeModule` challenge queue, `ExitRight` bond accounting and the vault (no borrow while insolvent; repay and debt-free exit never blocked), plus a triaged Slither report: [docs/SECURITY-SCAN.md](docs/SECURITY-SCAN.md).
- OpenZeppelin Contracts 5.1.0
- Next.js + wagmi + viem demo UI (`packages/web`)

## Quick start

Prerequisites: Node 24 and npm 11 or newer (`npm ci` on npm 9/10 is rejected by `engine-strict`), plus
[Foundry](https://book.getfoundry.sh/getting-started/installation) for the fuzz and invariant suites.

```bash
npm ci
npm test
npm run build

# Foundry fuzz + invariant tests. lib/ is gitignored, so install the two libraries once first.
forge install foundry-rs/forge-std --no-git
forge install morpho-org/morpho-blue@v1.0.0 --no-git
forge test
npm run test:count
```

## Kopi Wallet UI

Hosted at [reserveproof-teal.vercel.app](https://reserveproof-teal.vercel.app), or `npm run demo:web` →
http://localhost:3000. The UI opens on the live **Robinhood testnet** deployment (switch to **Arbitrum
Sepolia** in the header). A live strip shows the latest epoch, when it was published, mTSLA coverage
against the 103% floor, and contract verification. **Local Hardhat** is offered only under `next dev`
(`packages/web/.env.development`), so the hosted site never calls 127.0.0.1.

- **Verify my balance:** enter an address (or press *Try demo user*). The browser rebuilds the
  Merkle-sum tree from the published book for the latest on-chain epoch, shows your leaf and proof path,
  and checks the computed root against the committed one.
- **What-if simulator:** *Drain reserves*, *Skip 8 days*, *Stock split* and *Fraud dispute* each run a
  read-only `eth_call` against the live contracts with one storage slot or the block time overridden, and
  show the oracle flip to LIVE_SHORT, STALE, MULTIPLIER_DRIFT or DISPUTED while `GatedPayout` and the
  lending vault revert `Insolvent`. No wallet, no gas. `npm run whatif:check:rh` / `whatif:check:arb`
  asserts the same results from the command line.
- **ExitRight:** live bond, in-flight bond, claim count and the recorded claim-and-settle transactions on
  Robinhood.

After redeploying, publishing or changing contracts, run `npm run web:sync` to refresh the UI's ABIs,
testnet address books, liability books and ExitRight record.

## Local Kopi Wallet demo (no testnet gas)

```bash
# terminal A
npm run demo:node

# terminal B
npm run demo:setup     # deploy → CLI build → publish → sample → evm_snapshot
npm run demo:web       # → http://localhost:3000, pick "Local Hardhat"

# fail-closed scenes (against the running node)
SCENE=4 npm run demo:prepare   # drain → payout blocked
SCENE=5 npm run demo:prepare   # MULTIPLIER_DRIFT
npm run demo:warp              # or SCENE=6 npm run demo:prepare → STALE
SCENE=7 npm run demo:prepare   # DISPUTED

npm run demo:reset     # evm_revert to the post-setup snapshot (and re-snapshot)
```

The local book (`packages/cli/examples/liabilities.csv`) uses Hardhat accounts #2–#5, so challenges and
ExitRight claims can be signed locally.

Operator aliases: `ops:publish` (commitEpoch from `out/root.json`), `ops:sample` (recordSample).

## CLI — CSV → Merkle proofs

Build a sorted Merkle-sum tree and per-user proofs (leaf count must be a power of two: 2, 4, 8, …):

```bash
npm run cli:build -- \
  --csv packages/cli/examples/liabilities.csv \
  --custodian kopi \
  --asset 0xYourTokenAddress \
  --epoch 1 \
  --out ./out
```

CSV format (`user,amount`):

```text
user,amount
0x1111…1111,100000000000000000000
0x2222…2222,200000000000000000000
```

Outputs:

- `out/root.json` — root, total, sorted leaves
- `out/proofs/<address>.json` — inclusion proof nodes
- `out/neighbours/<address>.json` — neighbour bounds (omission disputes)

`--custodian` accepts a `bytes32` hex value or a string (hashed with `ethers.id`).

## Networks (test)

| Chain | ID | Notes |
|---|---|---|
| Robinhood Chain testnet | 46630 | RPC `https://rpc.testnet.chain.robinhood.com`; mTSLA + USDG books, ExitRight live |
| Arbitrum Sepolia | 421614 | Same contract addresses; mTSLA book (identical root to Robinhood) |

## Deploy

```bash
cp .env.example .env
# set DEPLOYER_PRIVATE_KEY=… (needs testnet ETH) and DEPLOYMENT_SALT=… (same value on every chain)

npm run wallets                          # gitignored reserve + demo-user keys (deployments/wallets.local.json)
RESERVE_WALLET_FUNDING=0 npm run deploy:rh    # Robinhood — official USDG 0x7E95…802F
RESERVE_WALLET_FUNDING=0 npm run deploy:arb   # Arbitrum Sepolia — official USDG 0xFFC9…0892
npm run verify:rh                        # Blockscout (FORCE=1 if a byte-identical redeploy shows as a "twin")
DEPLOYMENT=deployments/arbitrumSepolia.json npm run verify:sourcify
```

Address books land in [`deployments/`](deployments/). See [`deployments/README.md`](deployments/README.md).

Faucets: [Robinhood](https://faucet.testnet.chain.robinhood.com/) · [Paxos USDG](https://faucet.paxos.com/?network=robinhood) · [Chainlink Arb Sepolia](https://faucets.chain.link/arbitrum-sepolia)

Dry-run (no key): `npm run deploy` on the in-process Hardhat network.

## Testnet operations

```bash
npm run ops:cycle:rh      # build latest+1 from each book, commitEpoch, recordSample, print status
npm run ops:cycle:arb
npm run status:rh         # mTSLA + USDG oracle status
npm run exitright:setup   # post a 60 USDG bond, cap claims at 10 USDG each / 30 USDG in flight
npm run exitright:demo    # demo user opens a claim, operator settles it in the same run
```

Books live in [`scripts/books.ts`](scripts/books.ts) (`packages/cli/examples/testnet-*.csv`). The
[Ops epoch](.github/workflows/ops-epoch.yml) workflow runs the cycle every three days (well inside the
7-day `maxOracleAge`) and on demand. It needs the `DEPLOYER_PRIVATE_KEY` and `DEPLOYMENT_SALT`
repository secrets.

**Settle every demo claim in the same session.** A claim left unsettled past its 72h payout window can
be slashed by anyone, which permanently flips that asset to EXIT_DEFAULT. `exitright:demo` opens and
settles in one run; `status:rh` lists any unsettled claim with its deadline.

## Residual risks (read before integrating)

- **Flash-loan / borrowed reserves:** samples use `min` across distinct `arbBlockNumber` values plus a time gap, then `min(sampleMin, liveBalance)`. Capital borrowed for the *entire* sampling window can still inflate reserves — documented, not fully eliminated.
- **Operator-only sampling:** only the custodian's operator can call `recordSample`, so it chooses when samples land. The oracle's `min(sampleMin, liveBalance)` means reserves must still be present when an integrator reads `isSolvent`. Permissionless sampling is future work.
- **Equivocation settle loop (SETTLE-1):** `openEquivocationDispute` settles every live challenge in one loop. At roughly 909 open challenges it exceeds block gas, so an equivocation proof can't land while that many are live. Each challenge costs a 1 USDG bond from a distinct address, and overdue challenges flip the oracle to DISPUTED anyway. Paginated settlement is future work.
- **ExitRight bond ≠ full insurance:** the USDG bond is a deterrent with per-claim and in-flight caps. A bank run of many claims is an intentional stress case; unpaid claims beyond the bond still mark exit default.
- **Per-chain allocation:** `isSolvent` on one chain means that chain’s **allocation** is covered, not that 100% of global liabilities sit there. Treat “fully backed” as AND across chains in the UI.
- **Non-ZK omission:** users with a custodian-signed EIP-712 balance statement can prove omission via neighbours. Users with neither inclusion nor a statement cannot.
- **Issuer-controlled multiplier:** ERC-8056 `uiMultiplier` is controlled by the token issuer; ReserveProof fail-closes on drift until the custodian recommits.
- **Leaves bind the local token address:** a leaf commits to the asset's address on the chain it is published on. USDG's official addresses differ between Robinhood and Arbitrum, so a USDG inclusion proof only verifies on its home chain, and the testnets publish USDG on Robinhood only. Binding leaves to the cross-chain `assetId` instead is future work.
- **ExitRight default is permanent:** once any claim is slashed, `exitDefault[custodian][asset]` stays set and the oracle reports EXIT_DEFAULT for that asset for good. Anyone holding a leaf's key can open a claim, which is why the testnet book uses a private demo user rather than public Hardhat keys.

## License

MIT
