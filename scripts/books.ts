/**
 * Liability books (CSV per network and asset) published by the operator.
 * Shared by ops-cycle (what to publish) and sync-web (what the UI rebuilds trees from).
 */
import * as fs from "fs";
import * as path from "path";

export type AssetKind = "stock" | "usdg";
export type BookLeaf = { user: string; amount: string };

const EXAMPLES = path.join(__dirname, "..", "packages", "cli", "examples");

export const BOOKS: Record<string, Partial<Record<AssetKind, string>>> = {
  robinhoodTestnet: {
    stock: path.join(EXAMPLES, "testnet-stock.csv"),
    usdg: path.join(EXAMPLES, "testnet-usdg.csv"),
  },
  // USDG leaves bind Robinhood's USDG address, so Arbitrum only publishes the stock book.
  arbitrumSepolia: {
    stock: path.join(EXAMPLES, "testnet-stock.csv"),
  },
  localhost: {
    stock: path.join(EXAMPLES, "liabilities.csv"),
  },
};

export function readBook(csvPath: string): BookLeaf[] {
  const lines = fs
    .readFileSync(csvPath, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const start = lines[0]?.toLowerCase().includes("user") ? 1 : 0;
  return lines.slice(start).map((l) => {
    const [user, amount] = l.split(",").map((s) => s.trim());
    return { user, amount };
  });
}
