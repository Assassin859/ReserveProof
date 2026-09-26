# Deployments

JSON address books written by `scripts/deploy.ts`.

| File | Network |
|---|---|
| `hardhat.json` | Local Hardhat (ephemeral) |
| `robinhoodTestnet.json` | Robinhood Chain testnet `46630` |
| `arbitrumSepolia.json` | Arbitrum Sepolia `421614` |

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

Each run registers custodian `kopi`, configures MockStockToken + USDG, and links ExitRight into SolvencyOracle.
