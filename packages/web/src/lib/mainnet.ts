import { defineChain } from "viem";
import mainnetJson from "../deployments/robinhoodMainnet.json";
import statsJson from "../deployments/site-stats.json";
import type { Deployment, SiteStats } from "./types";

/** Robinhood Chain mainnet (4663). Read-only: the site never asks a wallet to switch here. */
export const robinhoodMainnet = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.NEXT_PUBLIC_RH_MAINNET_RPC || "https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
});

export const MAINNET_EXPLORER = "https://robinhoodchain.blockscout.com";

/** null until `npm run deploy:rhmain` has run and `npm run web:sync` copied the result. */
export const MAINNET = mainnetJson as unknown as Deployment | null;

export const SITE_STATS = statsJson as SiteStats;

/**
 * Past custodian failures, shown under the market numbers. Left empty on purpose: only add entries
 * with a verified figure and a source link.
 */
export const FAILURES: { name: string; figure: string; source: string }[] = [];
