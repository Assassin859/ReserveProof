import { defineChain } from "viem";
import mainnetJson from "../deployments/robinhoodMainnet.json";
import statsJson from "../deployments/site-stats.json";
import { MAINNET_RPC_URL } from "./rpc";
import type { Deployment, SiteStats } from "./types";

/** Robinhood Chain mainnet (4663). Read-only: the site never asks a wallet to switch here. */
export const robinhoodMainnet = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [MAINNET_RPC_URL] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
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
