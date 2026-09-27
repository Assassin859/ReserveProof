import robinhoodTestnet from "../deployments/robinhoodTestnet.json";
import arbitrumSepolia from "../deployments/arbitrumSepolia.json";
import robinhoodProof from "../deployments/robinhoodTestnet.proof.json";
import arbitrumProof from "../deployments/arbitrumSepolia.proof.json";
import type { Deployment } from "./types";

export type NetworkKey = "robinhoodTestnet" | "arbitrumSepolia" | "localhost";

export type NetworkInfo = {
  key: NetworkKey;
  label: string;
  explorer?: string;
  /** Bundled at build time; localhost is loaded from /api/deployment instead. */
  deployment?: Deployment;
  sampleProof?: unknown;
};

export const NETWORKS: Record<NetworkKey, NetworkInfo> = {
  robinhoodTestnet: {
    key: "robinhoodTestnet",
    label: "Robinhood testnet",
    explorer: "https://explorer.testnet.chain.robinhood.com",
    deployment: robinhoodTestnet as Deployment,
    sampleProof: robinhoodProof,
  },
  arbitrumSepolia: {
    key: "arbitrumSepolia",
    label: "Arbitrum Sepolia",
    explorer: "https://sepolia.arbiscan.io",
    deployment: arbitrumSepolia as Deployment,
    sampleProof: arbitrumProof,
  },
  localhost: {
    key: "localhost",
    label: "Local Hardhat",
  },
};

export const NETWORK_KEYS = Object.keys(NETWORKS) as NetworkKey[];

export function defaultNetwork(): NetworkKey {
  const env = process.env.NEXT_PUBLIC_DEFAULT_NETWORK as NetworkKey | undefined;
  return env && env in NETWORKS ? env : "robinhoodTestnet";
}
