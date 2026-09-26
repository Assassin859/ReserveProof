import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || process.env.PRIVATE_KEY || "";
const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];

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
  },
};

export default config;
