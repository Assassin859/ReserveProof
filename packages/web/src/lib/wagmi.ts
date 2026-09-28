"use client";

import { http, createConfig, type Transport } from "wagmi";
import { arbitrumSepolia } from "wagmi/chains";
import { injected } from "@wagmi/core";
import { defineChain, type Chain } from "viem";

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

// Hosted builds must never touch a local node: browsers may prompt visitors for local-network access.
// The local chain exists only when .env.development (next dev) sets both variables; its RPC URL lives
// there, not in source, so production bundles contain no local address at all.
const localRpc = process.env.NEXT_PUBLIC_ENABLE_LOCAL === "1" ? process.env.NEXT_PUBLIC_RPC_URL : undefined;

const chains: Chain[] = [robinhoodTestnet, arbitrumSepolia];
const transports: Record<number, Transport> = {
  [robinhoodTestnet.id]: http(process.env.NEXT_PUBLIC_RH_RPC || "https://rpc.testnet.chain.robinhood.com"),
  [arbitrumSepolia.id]: http(process.env.NEXT_PUBLIC_ARB_RPC || "https://sepolia-rollup.arbitrum.io/rpc"),
};
if (localRpc) {
  const local = defineChain({
    id: 31337,
    name: "Localhost",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [localRpc] } },
  });
  chains.push(local);
  transports[local.id] = http(localRpc);
}

export const config = createConfig({
  chains: chains as unknown as readonly [Chain, ...Chain[]],
  connectors: [injected({ shimDisconnect: true })],
  transports,
  ssr: true,
  multiInjectedProviderDiscovery: false,
});
