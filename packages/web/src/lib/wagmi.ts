"use client";

import { http, createConfig, type Transport } from "wagmi";
import { hardhat, arbitrumSepolia } from "wagmi/chains";
import { injected } from "@wagmi/core";
import { defineChain, type Chain } from "viem";

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

// Hosted builds must never touch 127.0.0.1: browsers may prompt visitors for local-network access.
const localEnabled = process.env.NEXT_PUBLIC_ENABLE_LOCAL === "1";

const chains = (
  localEnabled ? [robinhoodTestnet, arbitrumSepolia, localhostChain] : [robinhoodTestnet, arbitrumSepolia]
) as unknown as readonly [Chain, ...Chain[]];

const transports: Record<number, Transport> = {
  [robinhoodTestnet.id]: http(process.env.NEXT_PUBLIC_RH_RPC || "https://rpc.testnet.chain.robinhood.com"),
  [arbitrumSepolia.id]: http(process.env.NEXT_PUBLIC_ARB_RPC || "https://sepolia-rollup.arbitrum.io/rpc"),
};
if (localEnabled) {
  transports[localhostChain.id] = http(process.env.NEXT_PUBLIC_RPC_URL || "http://127.0.0.1:8545");
}

export const config = createConfig({
  chains,
  connectors: [injected({ shimDisconnect: true })],
  transports,
  ssr: true,
  multiInjectedProviderDiscovery: false,
});
