/**
 * Publish a Merkle root from CLI output (`out/root.json`) via LiabilityLedger.commitEpoch.
 *
 * Env:
 *   ROOT_JSON, DEPLOYMENT, UNIT_MODE
 *   ALLOCATIONS=comma-separated amounts matching allowlist order (optional;
 *               default puts full total on home chain and 0 is invalid — equal split)
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
  const assetConfig = await ethers.getContractAt("AssetConfig", dep.contracts.AssetConfig);
  const stock = await ethers.getContractAt("MockStockToken", dep.contracts.MockStockToken);

  const custodianId = rootDoc.custodianId as string;
  const asset = rootDoc.asset as string;
  const epochId = Number(rootDoc.epochId);
  const liabilityRoot = rootDoc.root as string;
  const totalLiability = BigInt(rootDoc.total);
  const leafCount = Number(rootDoc.leafCount ?? rootDoc.sorted?.length ?? 0);
  const unitMode = Number(process.env.UNIT_MODE || "0");

  const rawChains: bigint[] = [...(await assetConfig.getAllocationChains(custodianId, asset))];
  if (rawChains.length === 0) throw new Error("No allocation allowlist set");
  const chains = rawChains.map((c) => Number(c));

  let allocations: bigint[];
  if (process.env.ALLOCATIONS) {
    allocations = process.env.ALLOCATIONS.split(",").map((s) => BigInt(s.trim()));
  } else {
    const n = chains.length;
    const base = totalLiability / BigInt(n);
    allocations = [];
    let sum = 0n;
    for (let i = 0; i < n; i++) {
      const a = i === n - 1 ? totalLiability - sum : base;
      allocations.push(a);
      sum += a;
    }
  }

  let multiplier = 0n;
  try {
    multiplier = await stock.uiMultiplier();
  } catch {
    multiplier = ethers.parseEther("1");
  }

  console.log(`Network: ${hre.network.name}`);
  console.log(`Chains: ${chains.map(String).join(",")}`);
  console.log(`Allocations: ${allocations.map(String).join(",")}`);
  console.log(`LeafCount: ${leafCount}`);

  const tx = await ledger.commitEpoch(
    custodianId,
    asset,
    epochId,
    liabilityRoot,
    totalLiability,
    chains,
    allocations,
    multiplier,
    unitMode,
    leafCount
  );
  await tx.wait();
  console.log(`commitEpoch tx: ${tx.hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
