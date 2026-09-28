import robinhoodTestnet from "../deployments/robinhoodTestnet.json";
import arbitrumSepolia from "../deployments/arbitrumSepolia.json";
import booksJson from "../deployments/books.json";
import type { Deployment } from "./types";

export type NetworkKey = "robinhoodTestnet" | "arbitrumSepolia" | "localhost";
export type AssetKind = "stock" | "usdg" | "tsla";

export type BookLeaf = { user: string; amount: string };

export type ExitRightRecord = {
  network: string;
  chainId: number;
  exitRight: string;
  user: string;
  claimId: number;
  epochId: number;
  amount: string;
  settled: boolean;
  txs: Record<string, string | null>;
  recordedAt: string;
};

export type NetworkBooks = {
  demoUser: string | null;
  liabilities: Partial<Record<AssetKind, BookLeaf[]>>;
  exitright: ExitRightRecord | null;
};

export type NetworkInfo = {
  key: NetworkKey;
  label: string;
  explorer?: string;
  /** Bundled at build time; localhost is loaded from /api/deployment instead. */
  deployment?: Deployment;
  books: NetworkBooks;
};

const books = booksJson as unknown as Record<NetworkKey, NetworkBooks>;
const emptyBooks: NetworkBooks = { demoUser: null, liabilities: {}, exitright: null };

export const NETWORKS: Record<NetworkKey, NetworkInfo> = {
  robinhoodTestnet: {
    key: "robinhoodTestnet",
    label: "Robinhood testnet",
    explorer: "https://explorer.testnet.chain.robinhood.com",
    deployment: robinhoodTestnet as Deployment,
    books: books.robinhoodTestnet ?? emptyBooks,
  },
  arbitrumSepolia: {
    key: "arbitrumSepolia",
    label: "Arbitrum Sepolia",
    explorer: "https://sepolia.arbiscan.io",
    deployment: arbitrumSepolia as Deployment,
    books: books.arbitrumSepolia ?? emptyBooks,
  },
  localhost: {
    key: "localhost",
    label: "Local Hardhat",
    books: books.localhost ?? emptyBooks,
  },
};

/** The local Hardhat network is only offered in `next dev` (see .env.development). */
export const LOCAL_ENABLED = process.env.NEXT_PUBLIC_ENABLE_LOCAL === "1";

export const NETWORK_KEYS = (Object.keys(NETWORKS) as NetworkKey[]).filter(
  (k) => k !== "localhost" || LOCAL_ENABLED
);

export const GITHUB_URL = "https://github.com/Assassin859/ReserveProof";
export const DEMO_VIDEO_URL = process.env.NEXT_PUBLIC_DEMO_VIDEO_URL || "";

export const ASSET_META: Record<AssetKind, { label: string; decimals: number }> = {
  stock: { label: "mTSLA", decimals: 18 },
  usdg: { label: "USDG", decimals: 6 },
  tsla: { label: "TSLA", decimals: 18 },
};

export function defaultNetwork(): NetworkKey {
  const env = process.env.NEXT_PUBLIC_DEFAULT_NETWORK as NetworkKey | undefined;
  return env && NETWORK_KEYS.includes(env) ? env : "robinhoodTestnet";
}
