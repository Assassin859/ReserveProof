/**
 * Copy compiled ABIs, testnet deployment books, liability books and the ExitRight record into
 * packages/web so the UI can be built and hosted without reading the repo root at runtime.
 */
import * as fs from "fs";
import * as path from "path";
import { BOOKS, readBook, type AssetKind, type BookLeaf } from "./books";
import { countTests } from "./test-count";

const CONTRACTS = [
  "AssetConfig",
  "CustodianRegistry",
  "DisputeModule",
  "ExitRight",
  "GatedLendWithdraw",
  "GatedPayout",
  "GuardedLendingVault",
  "LiabilityLedger",
  "MockStockToken",
  "MockUSDG",
  "ReserveSampler",
  "SolvencyGatedMorphoOracle",
  "SolvencyOracle",
];

const TESTNETS = ["robinhoodTestnet", "arbitrumSepolia"];

const root = path.join(__dirname, "..");
const artifactsDir = path.join(root, "artifacts", "src");
const webSrc = path.join(root, "packages", "web", "src");
const abiOut = path.join(webSrc, "abi");
const depOut = path.join(webSrc, "deployments");

function findArtifact(dir: string, name: string): string | undefined {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findArtifact(full, name);
      if (hit) return hit;
    } else if (entry.name === `${name}.json`) {
      return full;
    }
  }
  return undefined;
}

for (const name of CONTRACTS) {
  const artifact = findArtifact(artifactsDir, name);
  if (!artifact) throw new Error(`No artifact for ${name} — run npm run build first`);
  const { abi } = JSON.parse(fs.readFileSync(artifact, "utf8"));
  fs.writeFileSync(path.join(abiOut, `${name}.json`), JSON.stringify({ abi }));
  console.log(`abi ${name}: ${abi.length} entries`);
}

fs.mkdirSync(depOut, { recursive: true });
for (const network of TESTNETS) {
  const src = path.join(root, "deployments", `${network}.json`);
  if (!fs.existsSync(src)) {
    console.log(`skip ${network}: no deployments/${network}.json`);
    continue;
  }
  fs.copyFileSync(src, path.join(depOut, `${network}.json`));
  console.log(`deployment ${network}`);
  const staleProof = path.join(depOut, `${network}.proof.json`);
  if (fs.existsSync(staleProof)) fs.rmSync(staleProof);
}

// The mainnet slot is always written (null until deployed) so the web build can import it unconditionally.
const mainnetSrc = path.join(root, "deployments", "robinhoodMainnet.json");
const mainnetWallets = path.join(root, "deployments", "wallets.mainnet.local.json");
const mainnetOut = path.join(depOut, "robinhoodMainnet.json");
const previousMainnet = fs.existsSync(mainnetOut) ? JSON.parse(fs.readFileSync(mainnetOut, "utf8")) : null;
let mainnet: Record<string, unknown> | null = null;
if (fs.existsSync(mainnetSrc)) {
  mainnet = JSON.parse(fs.readFileSync(mainnetSrc, "utf8"));
  if (mainnet && !mainnet.demoUser) {
    mainnet.demoUser = fs.existsSync(mainnetWallets)
      ? JSON.parse(fs.readFileSync(mainnetWallets, "utf8")).demoUser.address
      : previousMainnet?.demoUser ?? null;
  }
}
fs.writeFileSync(mainnetOut, JSON.stringify(mainnet, null, 2) + "\n");
console.log(mainnet ? "deployment robinhoodMainnet" : "robinhoodMainnet: not deployed (null slot)");

const tests = countTests();
const marketFile = path.join(root, "docs", "market-size.json");
const market = fs.existsSync(marketFile) ? JSON.parse(fs.readFileSync(marketFile, "utf8")) : null;
const stats = {
  tests: {
    total: tests.total,
    hardhat: tests.hardhat,
    foundryFuzz: tests.fuzz,
    foundryUnit: tests.unit - tests.hardhat,
    invariants: tests.invariant,
  },
  market: market && {
    block: market.block,
    timestamp: market.timestamp,
    usdgSupply: market.usdg.totalSupply,
    stockTokens: market.stockTokens.count,
    stockSupplyUsd: market.stockTokens.totalSupplyUsd,
    morphoStockMarkets: market.morpho.stockCollateralMarkets,
    usdgSuppliedAgainstStocks: market.morpho.usdgSuppliedAgainstStocks,
    usdgBorrowedAgainstStocks: market.morpho.usdgBorrowedAgainstStocks,
    oracles: market.morpho.oracles
      ? {
          distinct: market.morpho.oracles.distinct,
          priceFeedOnly: market.morpho.oracles.priceFeedOnly,
          unclassified: market.morpho.oracles.unclassified,
          reserveProofFeedsFound: market.morpho.oracles.reserveProofFeedsFound,
        }
      : null,
  },
};
fs.writeFileSync(path.join(depOut, "site-stats.json"), JSON.stringify(stats, null, 2) + "\n");
console.log(`site-stats: ${stats.tests.total} tests${market ? `, market block ${market.block}` : ""}`);

type NetBooks = {
  demoUser: string | null;
  liabilities: Partial<Record<AssetKind, BookLeaf[]>>;
  exitright: unknown | null;
};

const walletsFile = path.join(root, "deployments", "wallets.local.json");
const booksFile = path.join(depOut, "books.json");
const previous: Record<string, NetBooks> = fs.existsSync(booksFile)
  ? JSON.parse(fs.readFileSync(booksFile, "utf8"))
  : {};
const demoUser: string | null = fs.existsSync(walletsFile)
  ? JSON.parse(fs.readFileSync(walletsFile, "utf8")).demoUser.address
  : null;

const books: Record<string, NetBooks> = {};
for (const [network, assets] of Object.entries(BOOKS)) {
  const liabilities: NetBooks["liabilities"] = {};
  for (const [kind, csv] of Object.entries(assets) as [AssetKind, string][]) {
    if (!fs.existsSync(csv)) {
      console.log(`skip ${network}/${kind}: no ${csv}`);
      continue;
    }
    liabilities[kind] = readBook(csv);
  }
  if (Object.keys(liabilities).length === 0 && !previous[network]) continue;
  const exitrightFile = path.join(root, "deployments", `${network}.exitright.json`);
  books[network] = {
    demoUser: network === "localhost" ? null : demoUser ?? previous[network]?.demoUser ?? null,
    liabilities,
    exitright: fs.existsSync(exitrightFile)
      ? JSON.parse(fs.readFileSync(exitrightFile, "utf8"))
      : previous[network]?.exitright ?? null,
  };
  console.log(
    `books ${network}: ${Object.keys(liabilities).join(",")}${books[network].exitright ? " + exitright" : ""}`
  );
}
fs.writeFileSync(booksFile, JSON.stringify(books, null, 2) + "\n");
