/** Public RPC endpoints, shared by the browser (wagmi) and server routes (/api/risk, /api/radar). */
export const RPC_URLS = {
  robinhoodTestnet: process.env.NEXT_PUBLIC_RH_RPC || "https://rpc.testnet.chain.robinhood.com",
  arbitrumSepolia: process.env.NEXT_PUBLIC_ARB_RPC || "https://sepolia-rollup.arbitrum.io/rpc",
} as const;

export const MAINNET_RPC_URL = process.env.NEXT_PUBLIC_RH_MAINNET_RPC || "https://rpc.mainnet.chain.robinhood.com";
