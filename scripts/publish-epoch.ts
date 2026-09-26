/**
 * Publish a Merkle root from CLI output (`out/root.json`) via LiabilityLedger.commitEpoch.
 *
 * Usage:
 *   npx hardhat run scripts/publish-epoch.ts --network localhost
 *
 * Env / flags via process.env:
 *   ROOT_JSON=./out/root.json
 *   DEPLOYMENT=./deployments/localhost.json
 *   ALLOCATION=  (optional; defaults to total liability)
 *   UNIT_MODE=0  (RAW default)
 */
import hre from "hardhat";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

function loadJson(p: string) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function main() {
  const rootPath = path.resolve(process.env.ROOT_JSON || "out/root.json");
  const depPath = path.resolve(
    process.env.DEPLOYMENT || `deployments/${hre.network.name}.json`
  );

  if (!fs.existsSync(rootPath)) {
    throw new Error(`Missing ${rootPath} — run npm run cli:build first`);
  }
  if (!fs.existsSync(depPath)) {
    throw new Error(`Missing ${depPath} — run deploy on this network first`);
  }

  const rootDoc = loadJson(rootPath);
  const dep = loadJson(depPath);
  const [operator] = await ethers.getSigners();

  const ledger = await ethers.getContractAt("LiabilityLedger", dep.contracts.LiabilityLedger);
  const stock = await ethers.getContractAt("MockStockToken", dep.contracts.MockStockToken);

  const custodianId = rootDoc.custodianId as string;
  const asset = rootDoc.asset as string;
  const epochId = Number(rootDoc.epochId);
  const liabilityRoot = rootDoc.root as string;
  const totalLiability = BigInt(rootDoc.total);
  const allocation = process.env.ALLOCATION
    ? BigInt(process.env.ALLOCATION)
    : totalLiability;
  const unitMode = Number(process.env.UNIT_MODE || "0");

  let multiplier = 0n;
  try {
    multiplier = await stock.uiMultiplier();
  } catch {
    multiplier = ethers.parseEther("1");
  }

  console.log(`Network: ${hre.network.name}`);
  console.log(`Operator: ${operator.address}`);
  console.log(`Custodian: ${custodianId}`);
  console.log(`Asset: ${asset}`);
  console.log(`Epoch: ${epochId}`);
  console.log(`Root: ${liabilityRoot}`);
  console.log(`Total: ${totalLiability.toString()}`);
  console.log(`Allocation: ${allocation.toString()}`);
  console.log(`Multiplier snapshot: ${multiplier.toString()}`);

  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const tx = await ledger.commitEpoch(
    custodianId,
    asset,
    epochId,
    liabilityRoot,
    totalLiability,
    [chainId],
    [allocation],
    multiplier,
    unitMode
  );
  await tx.wait();
  console.log(`commitEpoch tx: ${tx.hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
