/** Public RPC endpoints, shared by the browser (wagmi) and server routes (/api/risk). */
export const RPC_URLS = {
  robinhoodTestnet: process.env.NEXT_PUBLIC_RH_RPC || "https://rpc.testnet.chain.robinhood.com",
  arbitrumSepolia: process.env.NEXT_PUBLIC_ARB_RPC || "https://sepolia-rollup.arbitrum.io/rpc",
} as const;
