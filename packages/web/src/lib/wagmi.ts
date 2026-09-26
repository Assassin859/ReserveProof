"use client";

import { http, createConfig } from "wagmi";
import { hardhat } from "wagmi/chains";
import { injected } from "@wagmi/core";

export const localhostChain = {
  ...hardhat,
  name: "Localhost",
  rpcUrls: {
    default: { http: ["http://127.0.0.1:8545"] },
  },
} as const;

export const config = createConfig({
  chains: [localhostChain],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [localhostChain.id]: http("http://127.0.0.1:8545"),
  },
  ssr: true,
  multiInjectedProviderDiscovery: false,
});
