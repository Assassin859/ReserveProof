/**
 * Print SolvencyOracle status for the deployment's mock stock and USDG assets.
 * Usage: npx hardhat run scripts/status.ts --network <net>
 * Env: DEPLOYMENT (default deployments/<network>.json)
 */
import hre from "hardhat";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const REASONS: Record<number, string> = {
  0: "OK",
  1: "NO_EPOCH",
  2: "STALE",
  3: "DISPUTED",
  4: "INSUFFICIENT_SAMPLES",
  5: "UNDERCOLLATERALIZED",
  6: "LIVE_SHORT",
  7: "MULTIPLIER_DRIFT",
  8: "EXIT_DEFAULT",
  9: "INACTIVE",
};

async function main() {
  const depPath = path.resolve(process.env.DEPLOYMENT || `deployments/${hre.network.name}.json`);
  const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
  const oracle = await ethers.getContractAt("SolvencyOracle", dep.contracts.SolvencyOracle);
  const ledger = await ethers.getContractAt("LiabilityLedger", dep.contracts.LiabilityLedger);
  for (const [label, asset] of [
    ["mTSLA", dep.contracts.MockStockToken],
    ["USDG", dep.contracts.USDG],
  ] as const) {
    const latest = await ledger.latestEpochId(dep.custodianId, asset);
    const s = await oracle.status(dep.custodianId, asset);
    const reason = Number(s.reason);
    console.log(
      `${hre.network.name} ${label}: epoch=${latest} ok=${s.ok} reason=${reason} (${REASONS[reason] ?? "?"})`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
