# ReserveProof

Open-source proof of reserves and proof of exit for custodians of **USDG** and **Robinhood Stock Tokens**.

- On-chain reserve reads (multi-sample + live balance)
- Merkle-sum liabilities with user inclusion / omission proofs
- Fail-closed `isSolvent(custodianId, asset)` that payouts and lending can `require`
- **ExitRight** — bonded withdrawal with on-chain `settle`

See [docs/technical-spec.md](docs/technical-spec.md) for the full design.

## Stack

- Solidity 0.8.24
- Hardhat (compile / test) — Foundry layout also present; `forge` may be blocked by Windows Application Control on some machines
- OpenZeppelin Contracts

## Quick start

```bash
npm install
npx hardhat test
```

## Networks (test)

| Chain | ID | Notes |
|---|---|---|
| Robinhood Chain testnet | 46630 | RPC `https://rpc.testnet.chain.robinhood.com` |
| Arbitrum Sepolia | 421614 | Dual-chain USDG allocations |

## License

MIT
