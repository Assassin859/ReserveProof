/**
 * Copy compiled ABIs, testnet deployment books, and a sample inclusion proof into packages/web
 * so the UI can be built and hosted without reading the repo root at runtime.
 */
import * as fs from "fs";
import * as path from "path";

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

  const proofsDir = path.join(root, "out", network, "proofs");
  if (fs.existsSync(proofsDir)) {
    const first = fs.readdirSync(proofsDir).sort()[0];
    if (first) {
      fs.copyFileSync(path.join(proofsDir, first), path.join(depOut, `${network}.proof.json`));
      console.log(`sample proof ${network}: ${first}`);
    }
  }
}
