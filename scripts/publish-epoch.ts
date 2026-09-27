/**
 * Publish a Merkle root from CLI output (`out/root.json`) via LiabilityLedger.commitEpoch.
 *
 * Env:
 *   ROOT_JSON, DEPLOYMENT, UNIT_MODE
 *   ALLOCATIONS=comma-separated amounts matching allowlist order
 *     - required when allowlist length > 1
 *     - if unset and allowlist length is 1, puts full total on home chain
 *   DEPLOYMENT_SALT / ASSET_ID — optional overrides; prefer deployment JSON
 */
import hre from "hardhat";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

function loadJson(p: string) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const EPOCH_COMMITMENT_TYPES = {
  EpochCommitment: [
    { name: "custodianId", type: "bytes32" },
    { name: "assetId", type: "bytes32" },
    { name: "epochId", type: "uint64" },
    { name: "liabilityRoot", type: "bytes32" },
    { name: "totalLiability", type: "uint256" },
    { name: "allocationCommitment", type: "bytes32" },
    { name: "leafCount", type: "uint32" },
  ],
};

export type RootDoc = {
  custodianId: string;
  asset: string;
  epochId: number;
  root: string;
  total: string;
  leafCount?: number;
  sorted?: unknown[];
};

export async function publishEpoch(opts: {
  rootDoc: RootDoc;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dep: any;
  allocations?: bigint[];
  unitMode?: number;
}): Promise<string> {
  const { rootDoc, dep } = opts;
  const [operator] = await ethers.getSigners();

  const ledger = await ethers.getContractAt("LiabilityLedger", dep.contracts.LiabilityLedger);
  const assetConfig = await ethers.getContractAt("AssetConfig", dep.contracts.AssetConfig);

  const custodianId = rootDoc.custodianId;
  const asset = rootDoc.asset;
  const epochId = Number(rootDoc.epochId);
  const liabilityRoot = rootDoc.root;
  const totalLiability = BigInt(rootDoc.total);
  const leafCount = Number(rootDoc.leafCount ?? rootDoc.sorted?.length ?? 0);
  const unitMode = opts.unitMode ?? 0;

  const cfg = await assetConfig.getConfig(custodianId, asset);
  const assetId = (cfg.assetId as string) || dep.assetIds?.stock || ethers.id("TSLA");
  const deploymentSalt =
    (await ledger.deploymentSalt()) ||
    dep.deploymentSalt ||
    ethers.id(process.env.DEPLOYMENT_SALT || "ReserveProof.v1");

  const rawChains: bigint[] = [...(await assetConfig.getAllocationChains(custodianId, asset))];
  if (rawChains.length === 0) throw new Error("No allocation allowlist set");
  const chains = rawChains.map((c) => Number(c));

  let allocations: bigint[];
  if (opts.allocations) {
    allocations = opts.allocations;
  } else if (chains.length === 1) {
    allocations = [totalLiability];
  } else {
    throw new Error(
      `ALLOCATIONS required for multi-chain allowlist (${chains.length} chains). ` +
        `Example: ALLOCATIONS=${chains.map(() => "…").join(",")}`
    );
  }
  if (allocations.length !== chains.length) {
    throw new Error(`ALLOCATIONS length ${allocations.length} != allowlist ${chains.length}`);
  }

  const allocCommitment = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["uint64[]", "uint256[]"], [chains, allocations])
  );

  const domain = {
    name: "ReserveProof",
    version: "1",
    chainId: 0,
    verifyingContract: ethers.ZeroAddress,
    salt: deploymentSalt,
  };

  const commitmentSig = await operator.signTypedData(domain, EPOCH_COMMITMENT_TYPES, {
    custodianId,
    assetId,
    epochId,
    liabilityRoot,
    totalLiability,
    allocationCommitment: allocCommitment,
    leafCount,
  });

  let multiplier = 0n;
  if (cfg.isStockToken) {
    const stock = await ethers.getContractAt("MockStockToken", cfg.token);
    try {
      multiplier = await stock.uiMultiplier();
    } catch {
      multiplier = ethers.parseEther("1");
    }
  }

  console.log(`Network: ${hre.network.name}`);
  console.log(`Asset: ${asset} epoch ${epochId}`);
  console.log(`AssetId: ${assetId}`);
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
    leafCount,
    commitmentSig
  );
  await tx.wait();
  console.log(`commitEpoch tx: ${tx.hash}`);
  return tx.hash;
}

async function main() {
  const rootPath = path.resolve(process.env.ROOT_JSON || "out/root.json");
  const depPath = path.resolve(process.env.DEPLOYMENT || `deployments/${hre.network.name}.json`);
  if (!fs.existsSync(rootPath)) {
    throw new Error(`Missing ${rootPath} — run npm run cli:build first`);
  }
  if (!fs.existsSync(depPath)) {
    throw new Error(`Missing ${depPath} — run deploy on this network first`);
  }
  await publishEpoch({
    rootDoc: loadJson(rootPath),
    dep: loadJson(depPath),
    allocations: process.env.ALLOCATIONS
      ? process.env.ALLOCATIONS.split(",").map((s) => BigInt(s.trim()))
      : undefined,
    unitMode: Number(process.env.UNIT_MODE || "0"),
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
