/**
 * Build CLI merkle outputs for the localhost MockStockToken asset.
 * Usage: npx ts-node scripts/demo-cli-build.ts
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const depPath = path.resolve(
  process.env.DEPLOYMENT || "deployments/localhost.json"
);
if (!fs.existsSync(depPath)) {
  console.error(`Missing ${depPath} — run npm run demo:deploy first`);
  process.exit(1);
}
const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
const asset = dep.contracts.MockStockToken;
const epoch = process.env.EPOCH || "1";
const out = process.env.OUT || "./out";
const csv = process.env.CSV || "packages/cli/examples/liabilities.csv";

const args = [
  "packages/cli/src/index.ts",
  "build",
  "--csv",
  csv,
  "--custodian",
  dep.custodianName || "kopi",
  "--asset",
  asset,
  "--epoch",
  epoch,
  "--out",
  out,
];

console.log(`Building tree for asset ${asset} epoch ${epoch}`);
const r = spawnSync("npx", ["ts-node", ...args], { stdio: "inherit", shell: true });
process.exit(r.status ?? 1);
