# ReserveProof

Open-source proof of reserves and proof of exit for custodians of **USDG** and **Robinhood Stock Tokens**.

- On-chain reserve reads (multi-sample + live balance)
- Merkle-sum liabilities with user inclusion / omission proofs
- Fail-closed `isSolvent(custodianId, asset)` that payouts and lending can `require`
- **ExitRight** — bonded withdrawal with on-chain `settle`

See [docs/technical-spec.md](docs/technical-spec.md) for the full design.

Hackathon packet: [docs/SUBMISSION.md](docs/SUBMISSION.md) · [docs/VERIFY.md](docs/VERIFY.md)

## Stack

- Solidity 0.8.24
- Hardhat (compile / test) — Foundry layout is present; `forge` may be blocked by Windows Application Control on some machines
- OpenZeppelin Contracts 5.1.0
- Next.js + wagmi + viem demo UI (`packages/web`)

## Quick start

```bash
npm install
npm test
npm run build
```

## Kopi Wallet UI

`npm run demo:web` → http://localhost:3000. The UI opens on the live **Robinhood testnet** deployment
(switch to **Arbitrum Sepolia** or **Local Hardhat** in the header). Scenes 1–3 run against testnet,
including inclusion verification with a bundled sample proof. Set `NEXT_PUBLIC_DEFAULT_NETWORK=localhost`
to open on the local node instead.

After redeploying or changing contracts, run `npm run web:sync` to refresh the UI's ABIs, testnet
address books, and sample proofs.

## Local Kopi Wallet demo (no testnet gas)

```bash
# terminal A
npm run demo:node

# terminal B
npm run demo:deploy
npm run demo:cli
npm run ops:publish
npm run ops:sample
npm run demo:web
# → http://localhost:3000 — pick "Local Hardhat", scenes 1–7

# fail-closed scenes (against the running node)
SCENE=4 npm run demo:prepare   # drain → payout blocked
SCENE=5 npm run demo:prepare   # MULTIPLIER_DRIFT
npm run demo:warp              # or SCENE=6 npm run demo:prepare → STALE
SCENE=7 npm run demo:prepare   # DISPUTED
```

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
| Robinhood Chain testnet | 46630 | RPC `https://rpc.testnet.chain.robinhood.com` |
| Arbitrum Sepolia | 421614 | Dual-chain USDG **allocations** (no bridge) |

## Deploy

```bash
cp .env.example .env
# set DEPLOYER_PRIVATE_KEY=…  (needs testnet ETH)

npm run deploy:rh    # Robinhood — official USDG 0x7E95…802F
npm run deploy:arb   # Arbitrum Sepolia — official USDG 0xFFC9…0892
```

Address books land in [`deployments/`](deployments/). See [`deployments/README.md`](deployments/README.md).

Faucets: [Robinhood](https://faucet.testnet.chain.robinhood.com/) · [Chainlink Arb Sepolia](https://faucets.chain.link/arbitrum-sepolia)

Dry-run (no key): `npm run deploy` on the in-process Hardhat network.

## Residual risks (read before integrating)

- **Flash-loan / borrowed reserves:** samples use `min` across distinct `arbBlockNumber` values plus a time gap, then `min(sampleMin, liveBalance)`. Capital borrowed for the *entire* sampling window can still inflate reserves — documented, not fully eliminated.
- **ExitRight bond ≠ full insurance:** the USDG bond is a deterrent with per-claim and in-flight caps. A bank run of many claims is an intentional stress case; unpaid claims beyond the bond still mark exit default.
- **Per-chain allocation:** `isSolvent` on one chain means that chain’s **allocation** is covered, not that 100% of global liabilities sit there. Treat “fully backed” as AND across chains in the UI.
- **Non-ZK omission:** users with a custodian-signed EIP-712 balance statement can prove omission via neighbours. Users with neither inclusion nor a statement cannot.
- **Issuer-controlled multiplier:** ERC-8056 `uiMultiplier` is controlled by the token issuer; ReserveProof fail-closes on drift until the custodian recommits.

## License

MIT
