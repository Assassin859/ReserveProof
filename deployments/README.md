# Deployments

JSON address books written by `scripts/deploy.ts`.

| File | Network |
|---|---|
| `hardhat.json` | In-process Hardhat (ephemeral) |
| `localhost.json` | `npx hardhat node` / `npm run demo:deploy` |
| `robinhoodTestnet.json` | Robinhood Chain testnet `46630` |
| `arbitrumSepolia.json` | Arbitrum Sepolia `421614` |

Each deploy also registers a reserve wallet, mints mock stock reserves, configures MockStockToken + USDG, links ExitRight, and deploys `GatedPayout` / `GatedLendWithdraw` for the demo asset.
## How to deploy

1. Copy `.env.example` → `.env`
2. Set `DEPLOYER_PRIVATE_KEY` to a key that has testnet ETH on the target chain(s)
3. Fund the address:
   - Robinhood: https://faucet.testnet.chain.robinhood.com/
   - Arbitrum Sepolia: https://faucets.chain.link/arbitrum-sepolia or https://www.alchemy.com/faucets/arbitrum-sepolia
4. Run:

```bash
npm run deploy:rh    # Robinhood testnet — uses official USDG 0x7E95…802F
npm run deploy:arb   # Arbitrum Sepolia — uses official USDG 0xFFC9…0892
```

Each run registers custodian `kopi`, a signed exclusive reserve wallet, configures MockStockToken + USDG, links ExitRight into SolvencyOracle, and deploys gated composers.
