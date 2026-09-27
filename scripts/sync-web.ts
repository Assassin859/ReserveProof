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

const root = path.join(__dirname, "..");
const artifactsDir = path.join(root, "artifacts", "src");
const outDir = path.join(root, "packages", "web", "src", "abi");

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
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ abi }));
  console.log(`${name}: ${abi.length} entries`);
}
