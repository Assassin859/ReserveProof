# Verify every claim

**One click: [reserveproof-teal.vercel.app/verify](https://reserveproof-teal.vercel.app/verify).** The page
checks each claim below live when it opens, against the chains, the block explorers and GitHub Actions. The
balance proof runs in your browser against a public RPC. The same checks are available as JSON at
[`/api/verify`](https://reserveproof-teal.vercel.app/api/verify).

| Claim | Live check | Reproduce locally |
|---|---|---|
| 150 tests pass in CI | [/verify#tests](https://reserveproof-teal.vercel.app/verify#tests) (latest CI run on master) | `npm test`, `forge test`, `npm run test:count` (see below) |
| Every contract is source-verified on both chains | [/verify#contracts](https://reserveproof-teal.vercel.app/verify#contracts) (Blockscout and Sourcify, queried live) | `npm run verify:rh`, `npm run verify:sourcify` |
| Every published proof is live and solvent | [/verify#proofs](https://reserveproof-teal.vercel.app/verify#proofs) (coverage, epoch, time to stale) | `npm run status:rh`, `npm run status:arb` |
| The same mTSLA liability root is on both chains | [/verify#same-root](https://reserveproof-teal.vercel.app/verify#same-root) | `cast call <LiabilityLedger> "getEpoch(bytes32,address,uint256)"` on both RPCs (commands on the card) |
| Your balance is in the book | [/verify#balance](https://reserveproof-teal.vercel.app/verify#balance) (in-browser Merkle-sum proof, any address) | `npm run cli:build -- --csv packages/cli/examples/testnet-stock.csv …` (full command on the card) |
| Gated integrations fail closed | [/verify#consumers](https://reserveproof-teal.vercel.app/verify#consumers), then the what-if simulator on the [live demo](https://reserveproof-teal.vercel.app) | `npm run whatif:check:rh`, `forge test --match-path test/foundry/MorphoIntegration.t.sol` |
| An ExitRight claim was opened and settled on chain | [/verify#exitright](https://reserveproof-teal.vercel.app/verify#exitright) (transaction receipts) | `cast receipt <tx> --rpc-url https://rpc.testnet.chain.robinhood.com` |
| Proofs are re-published on schedule | [/verify#schedule](https://reserveproof-teal.vercel.app/verify#schedule), and [/status](https://reserveproof-teal.vercel.app/status) for the hourly history | `npm run watch:rh` with `WATCH_ACT=0` (read-only) |
| The mainnet numbers are live | [/verify#mainnet](https://reserveproof-teal.vercel.app/verify#mainnet) and [/radar](https://reserveproof-teal.vercel.app/radar) | `npm run market:size` (writes [`market-size.json`](./market-size.json)) |
| A drained custodian freezes a real Morpho Blue market (**fork-only today**) | [/verify#morpho-fork](https://reserveproof-teal.vercel.app/verify#morpho-fork): the 20 recorded checks and the [daily fork drill](https://github.com/Assassin859/ReserveProof/actions/workflows/fork-drill.yml) | `npm run demo:morpho-fork` (~45s, no keys, nothing broadcast) |

**Fork-only means:** no ReserveProof contract is deployed on Robinhood Chain mainnet yet. The drill forks the
latest mainnet state in memory. It gates the real TSLA token, wraps the real TSLA/USDG oracle and opens a
market on the real Morpho Blue, then drains the custodian and checks every step. It runs daily in GitHub
Actions and prints every PASS/FAIL line in the run summary. A live pilot needs a partner custodian's real book
and reserve wallet; the offer is in [FOUNDER-HOUSE.md](./FOUNDER-HOUSE.md#4-the-90-day-pilot-offer).

## Run the tests yourself

Needs Node 24, npm 11 or newer, and [Foundry](https://book.getfoundry.sh/getting-started/installation).

```bash
npm ci                                                 # npm 9/10 is rejected by engine-strict
npm test                                               # Hardhat unit + integration tests
forge install foundry-rs/forge-std --no-git            # once: lib/ is gitignored
forge install morpho-org/morpho-blue@v1.0.0 --no-git   # unmodified Morpho Blue core for the wrapper tests
forge test                                             # fuzzing, unit tests, invariants, real Morpho Blue
npm run test:count                                     # prints the 150 breakdown
```

The Slither triage is in [SECURITY-SCAN.md](./SECURITY-SCAN.md).

## Re-verify the contracts

Addresses are in [`deployments/robinhoodTestnet.json`](../deployments/robinhoodTestnet.json) and
[`deployments/arbitrumSepolia.json`](../deployments/arbitrumSepolia.json) (addresses only, no keys).

| Network | Explorer | Command |
|---|---|---|
| Robinhood Chain testnet (46630) | [explorer.testnet.chain.robinhood.com](https://explorer.testnet.chain.robinhood.com) (Blockscout) | `npm run verify:rh` |
| Arbitrum Sepolia (421614) | [Sourcify](https://repo.sourcify.dev/421614) and [sepolia.arbiscan.io](https://sepolia.arbiscan.io) | `npm run verify:sourcify` |

Both use the compiler settings in `hardhat.config.ts` (optimizer 200 runs, `viaIR: true`); the explorers only
match bytecode built with the same settings.

RPCs: `https://rpc.testnet.chain.robinhood.com` and `https://sepolia-rollup.arbitrum.io/rpc`.
