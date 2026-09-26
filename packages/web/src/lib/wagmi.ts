"use client";

import { http, createConfig } from "wagmi";
import { hardhat, arbitrumSepolia } from "wagmi/chains";
import { injected } from "@wagmi/core";
import { defineChain } from "viem";

export const localhostChain = {
  ...hardhat,
  name: "Localhost",
  rpcUrls: {
    default: { http: ["http://127.0.0.1:8545"] },
  },
} as const;

/** Robinhood Chain testnet (46630). */
export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Testnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: {
      name: "Robinhood Explorer",
      url: "https://explorer.testnet.chain.robinhood.com",
    },
  },
});

const rpcLocal = process.env.NEXT_PUBLIC_RPC_URL || "http://127.0.0.1:8545";
const defaultChainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID || "31337");

const chains =
  defaultChainId === 46630
    ? ([robinhoodTestnet, arbitrumSepolia, localhostChain] as const)
    : defaultChainId === 421614
      ? ([arbitrumSepolia, robinhoodTestnet, localhostChain] as const)
      : ([localhostChain, robinhoodTestnet, arbitrumSepolia] as const);

export const config = createConfig({
  chains,
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [localhostChain.id]: http(rpcLocal),
    [robinhoodTestnet.id]: http(
      process.env.NEXT_PUBLIC_RH_RPC || "https://rpc.testnet.chain.robinhood.com"
    ),
    [arbitrumSepolia.id]: http(
      process.env.NEXT_PUBLIC_ARB_RPC || "https://sepolia-rollup.arbitrum.io/rpc"
    ),
  },
  ssr: true,
  multiInjectedProviderDiscovery: false,
});
