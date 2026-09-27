/**
 * Print SolvencyOracle status for the deployment's mock stock and USDG assets, plus any
 * unsettled ExitRight claims (a claim left past its deadline can be slashed, which sets
 * EXIT_DEFAULT on that asset permanently).
 * Usage: npx hardhat run scripts/status.ts --network <net>
 * Env: DEPLOYMENT (default deployments/<network>.json)
 */
import hre from "hardhat";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { BOOKS } from "./books";

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
  const net = hre.network.name;
  const depPath = path.resolve(process.env.DEPLOYMENT || `deployments/${net}.json`);
  const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
  const oracle = await ethers.getContractAt("SolvencyOracle", dep.contracts.SolvencyOracle);
  const ledger = await ethers.getContractAt("LiabilityLedger", dep.contracts.LiabilityLedger);
  const books = BOOKS[net] ?? {};
  const assets = [
    ["mTSLA", dep.contracts.MockStockToken, "stock"],
    ["USDG", dep.contracts.USDG, "usdg"],
  ] as const;

  for (const [label, asset, kind] of assets) {
    const latest = await ledger.latestEpochId(dep.custodianId, asset);
    const s = await oracle.status(dep.custodianId, asset);
    const reason = Number(s.reason);
    const note = books[kind] ? "" : " (no book on this network)";
    console.log(`${net} ${label}: epoch=${latest} ok=${s.ok} reason=${reason} (${REASONS[reason] ?? "?"})${note}`);
  }

  if (!dep.contracts.ExitRight) return;
  const exit = await ethers.getContractAt("ExitRight", dep.contracts.ExitRight);
  const labelOf = (a: string) =>
    assets.find(([, addr]) => addr.toLowerCase() === a.toLowerCase())?.[0] ?? a;
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const count = await exit.nextClaimId();
  const pending: string[] = [];
  for (let id = 0n; id < count; id++) {
    const c = await exit.claims(id);
    if (c.custodianId !== dep.custodianId || !c.open || c.settled || c.slashed) continue;
    const left = c.deadline - now;
    const when = new Date(Number(c.deadline) * 1000).toISOString();
    pending.push(
      `  #${id} ${labelOf(c.asset)} user=${c.user} deadline=${when} ` +
        (left > 0n ? `(${(Number(left) / 3600).toFixed(1)}h left)` : "(PAST DEADLINE, slashable)")
    );
  }
  console.log(`${net} ExitRight: ${count} claims, ${pending.length} unsettled`);
  for (const line of pending) console.log(line);
  for (const [label, asset] of assets) {
    if (await exit.exitDefault(dep.custodianId, asset)) console.log(`  ${label}: exitDefault SET (permanent)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
