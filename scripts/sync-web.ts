/**
 * Copy compiled ABIs, testnet deployment books, liability books and the ExitRight record into
 * packages/web so the UI can be built and hosted without reading the repo root at runtime.
 */
import * as fs from "fs";
import * as path from "path";
import { BOOKS, readBook, type AssetKind, type BookLeaf } from "./books";

const CONTRACTS = [
  "AssetConfig",
  "CustodianRegistry",
  "DisputeModule",
  "ExitRight",
  "GatedLendWithdraw",
  "GatedPayout",
  "LiabilityLedger",
  "MockStockToken",
  "MockUSDG",
  "ReserveSampler",
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
    liabilities[kind] = readBook(csv);
  }
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
