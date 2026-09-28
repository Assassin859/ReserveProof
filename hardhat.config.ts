import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY || "";
const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";
// Mainnet uses its own key (scripts/make-mainnet-wallets.ts), never the testnet one.
const MAINNET_KEY = process.env.MAINNET_PRIVATE_KEY || "";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    robinhoodTestnet: {
      url: process.env.ROBINHOOD_RPC || "https://rpc.testnet.chain.robinhood.com",
      chainId: 46630,
      accounts,
    },
    arbitrumSepolia: {
      url: process.env.ARB_SEPOLIA_RPC || "https://sepolia-rollup.arbitrum.io/rpc",
      chainId: 421614,
      accounts,
    },
    robinhoodMainnet: {
      url: process.env.ROBINHOOD_MAINNET_RPC || "https://rpc.mainnet.chain.robinhood.com",
      chainId: 4663,
      accounts: MAINNET_KEY ? [MAINNET_KEY] : [],
    },
  },
  etherscan: {
    apiKey: {
      // Blockscout ignores the key but hardhat-verify requires a non-empty value.
      robinhoodTestnet: "blockscout",
      robinhoodMainnet: "blockscout",
      arbitrumSepolia: ETHERSCAN_API_KEY || "blockscout",
    },
    customChains: [
      {
        // Arbiscan via Etherscan v2 (per-network keys otherwise hit the retired v1 API);
        // falls back to keyless Blockscout when no Etherscan key is configured.
        network: "arbitrumSepolia",
        chainId: 421614,
        urls: ETHERSCAN_API_KEY
          ? {
              apiURL: "https://api.etherscan.io/v2/api?chainid=421614",
              browserURL: "https://sepolia.arbiscan.io",
            }
          : {
              apiURL: "https://arbitrum-sepolia.blockscout.com/api",
              browserURL: "https://arbitrum-sepolia.blockscout.com",
            },
      },
      {
        network: "robinhoodTestnet",
        chainId: 46630,
        urls: {
          apiURL: "https://explorer.testnet.chain.robinhood.com/api",
          browserURL: "https://explorer.testnet.chain.robinhood.com",
        },
      },
      {
        network: "robinhoodMainnet",
        chainId: 4663,
        urls: {
          apiURL: "https://robinhoodchain.blockscout.com/api",
          browserURL: "https://robinhoodchain.blockscout.com",
        },
      },
    ],
  },
  sourcify: {
    enabled: process.env.SOURCIFY === "1",
  },
};

export default config;
