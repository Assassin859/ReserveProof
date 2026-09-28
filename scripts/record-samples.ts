/**
 * Set sample wallets and record N reserve samples with minSampleGap sleeps.
 *
 * Usage:
 *   npx hardhat run scripts/record-samples.ts --network localhost
 *
 * Env:
 *   DEPLOYMENT=./deployments/localhost.json
 *   ASSET=stock|usdg|tsla|<address>  (default stock)
 *   SAMPLES=2
 *   WALLET=  (optional; defaults to deployment.reserveWallet)
 */
import hre from "hardhat";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { assetAddress, type AssetKind } from "./books";

export async function recordSamples(opts: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dep: any;
  asset: string;
  wallet?: string;
  samples?: number;
}): Promise<string[]> {
  const { dep, asset } = opts;
  const custodianId = dep.custodianId as string;
  const wallet = opts.wallet || (dep.reserveWallet as string);
  const samples = opts.samples ?? 2;

  const sampler = await ethers.getContractAt("ReserveSampler", dep.contracts.ReserveSampler);
  const assetConfig = await ethers.getContractAt("AssetConfig", dep.contracts.AssetConfig);
  const cfg = await assetConfig.getConfig(custodianId, asset);
  const gap = Number(cfg.minSampleGap);

  console.log(`setSampleWallets → [${wallet}]`);
  await (await sampler.setSampleWallets(custodianId, asset, [wallet])).wait();

  const hashes: string[] = [];
  for (let i = 0; i < samples; i++) {
    if (i > 0) {
      console.log(`waiting ${gap + 1}s for minSampleGap…`);
      if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
        await ethers.provider.send("evm_increaseTime", [gap + 1]);
        await ethers.provider.send("evm_mine", []);
      } else {
        await new Promise((r) => setTimeout(r, (gap + 1) * 1000));
      }
    }
    const tx = await sampler.recordSample(custodianId, asset);
    await tx.wait();
    hashes.push(tx.hash);
    console.log(`recordSample #${i + 1}: ${tx.hash}`);
  }

  const ledger = await ethers.getContractAt("LiabilityLedger", dep.contracts.LiabilityLedger);
  const epochId = await ledger.latestEpochId(custodianId, asset);
  const count = await sampler.sampleCount(custodianId, asset, epochId);
  console.log(`epoch ${epochId} sampleCount=${count}`);
  return hashes;
}

async function main() {
  const depPath = path.resolve(process.env.DEPLOYMENT || `deployments/${hre.network.name}.json`);
  if (!fs.existsSync(depPath)) {
    throw new Error(`Missing ${depPath}`);
  }
  const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
  const assetEnv = (process.env.ASSET || "stock").toLowerCase();
  const asset = (assetAddress(dep, assetEnv as AssetKind) ?? process.env.ASSET) as string;
  await recordSamples({
    dep,
    asset,
    wallet: process.env.WALLET,
    samples: Number(process.env.SAMPLES || "2"),
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
