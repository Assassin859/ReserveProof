# Explorer verify prep

Do this **after** funded `deploy:rh` / `deploy:arb`. No live verify until addresses exist.

## Checklist

1. Fund deployer on Robinhood testnet (`46630`) and Arbitrum Sepolia (`421614`).
2. `npm run deploy:rh` → writes `deployments/robinhoodTestnet.json`
3. `npm run deploy:arb` → writes `deployments/arbitrumSepolia.json`
4. Verify each contract (or at least Registry, Oracle, Ledger, Dispute, ExitRight, Sampler).
5. Paste explorer + verified URLs into [SUBMISSION.md](./SUBMISSION.md) placeholders.
6. Optional: point `packages/web` at testnet RPC + deployment JSON for a public demo.

## Explorers

| Network | Explorer | Notes |
|---|---|---|
| Robinhood Chain testnet | https://explorer.testnet.chain.robinhood.com | Blockscout-style; confirm “Verify & publish” UI |
| Arbitrum Sepolia | https://sepolia.arbiscan.io | Standard Etherscan-compatible verify |

RPC reminders:

- RH: `https://rpc.testnet.chain.robinhood.com`
- Arb Sepolia: `https://sepolia-rollup.arbitrum.io/rpc`

## Hardhat verify (Arbitrum Sepolia)

Add to `hardhat.config.ts` when ready (keep keys in `.env`, never commit):

```ts
import "@nomicfoundation/hardhat-verify";

// in config:
etherscan: {
  apiKey: {
    arbitrumSepolia: process.env.ARBISCAN_API_KEY || "",
  },
},
```

Then:

```bash
npx hardhat verify --network arbitrumSepolia <ADDRESS> <constructor args…>
```

Constructor args match `scripts/deploy.ts` order (owner / registry / sibling module addresses / USDG / etc.). Prefer copying the exact deploy log.

Install if missing: `npm i -D @nomicfoundation/hardhat-verify` (toolbox may already pull it).

## Robinhood Blockscout verify

If the Hardhat plugin does not list chain `46630`, use Blockscout’s API:

1. Open the contract page → **Verify & Publish**.
2. Or `curl` / `cast` against the explorer verify endpoint (path varies by Blockscout version), typically:

```bash
# Example shape — confirm path in explorer docs /api-docs
curl -X POST "https://explorer.testnet.chain.robinhood.com/api" \
  -F "module=contract" \
  -F "action=verifysourcecode" \
  -F "contractaddress=0x..." \
  -F "sourceCode=@flattened.sol" \
  -F "codeformat=solidity-single-file" \
  -F "contractname=CustodianRegistry" \
  -F "compilerversion=v0.8.24+commit...." \
  -F "optimizationUsed=1" \
  -F "runs=200"
```

Flatten with:

```bash
npx hardhat flatten src/CustodianRegistry.sol > flattened-registry.sol
```

Match optimizer (`runs: 200`) and `viaIR: true` from `hardhat.config.ts` — Blockscout must accept the same settings or bytecode will not match.

## After verify

- Update SUBMISSION.md table with links.
- Keep `deployments/*.json` committed (addresses only — no keys).
- Record tx hashes for `commitEpoch` / sample / dispute in the demo video description.
