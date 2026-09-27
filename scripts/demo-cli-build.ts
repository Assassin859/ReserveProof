/**
 * Build CLI merkle outputs for a deployment's mock stock or USDG asset.
 * Usage: npx ts-node scripts/demo-cli-build.ts
 * Env: DEPLOYMENT (default deployments/localhost.json), ASSET=stock|usdg, CSV, EPOCH, OUT
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
const assetKind = (process.env.ASSET || "stock").toLowerCase();
if (assetKind !== "stock" && assetKind !== "usdg") {
  console.error(`ASSET must be "stock" or "usdg" (got "${assetKind}")`);
  process.exit(1);
}
const asset = assetKind === "usdg" ? dep.contracts.USDG : dep.contracts.MockStockToken;
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

console.log(`Building ${assetKind} tree for asset ${asset} epoch ${epoch} from ${csv}`);
const r = spawnSync("npx", ["ts-node", ...args], { stdio: "inherit", shell: true });
process.exit(r.status ?? 1);
