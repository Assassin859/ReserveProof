/**
 * Deploy a Morpho Blue oracle for the demo custodian's mTSLA that stops pricing while there is
 * evidence of a shortfall, for at most MAX_FREEZE_HOURS after a poke: FixedPriceMorphoOracle (the
 * vault's demo price, in Morpho's 1e36 scale) wrapped by SolvencyGatedMorphoOracle. Neither testnet
 * has Morpho Blue, so this proves the wrapper live; on a chain with Morpho, pass
 * BASE_ORACLE=<existing market oracle> and ASSET=<collateral> instead.
 *
 *   npm run morpho:deploy:rh      # or :arb
 * Env: BASE_ORACLE (default: the deployment's FixedPriceMorphoOracle, deployed if missing),
 *      ASSET (default the deployment's MockStockToken), MAX_FREEZE_HOURS (default 72),
 *      BLOCKING_REASONS (bitmask, default the contract's DEFAULT_BLOCKING_REASONS)
 */
import hre from "hardhat";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const net = hre.network.name;
  const depPath = path.join(__dirname, "..", "deployments", `${net}.json`);
  const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
  const c = dep.contracts;
  const asset = process.env.ASSET || c.MockStockToken;
  if (!asset) throw new Error("no ASSET and no MockStockToken in the deployment");

  let base = process.env.BASE_ORACLE || c.FixedPriceMorphoOracle || "";
  if (base) {
    console.log(`Base oracle: ${base} (reused)`);
  } else {
    // Vault price is loan units per 1e18 collateral units; Morpho wants loan units per collateral unit * 1e36.
    const vaultPrice = BigInt(dep.vault?.collateralPrice ?? "250000000");
    const morphoPrice = vaultPrice * 10n ** 18n;
    const fixed = await (await ethers.getContractFactory("FixedPriceMorphoOracle")).deploy(morphoPrice);
    await fixed.waitForDeployment();
    base = await fixed.getAddress();
    c.FixedPriceMorphoOracle = base;
    dep.morpho = { ...(dep.morpho ?? {}), basePrice: morphoPrice.toString() };
    console.log(`FixedPriceMorphoOracle: ${base} (price ${morphoPrice})`);
  }

  const Gated = await ethers.getContractFactory("SolvencyGatedMorphoOracle");
  const maxFreeze = Math.round(Number(process.env.MAX_FREEZE_HOURS || "72") * 3600);
  let mask = process.env.BLOCKING_REASONS ? Number(process.env.BLOCKING_REASONS) : undefined;
  if (mask === undefined) {
    // DEFAULT_BLOCKING_REASONS: LIVE_SHORT | UNDERCOLLATERALIZED | DISPUTED | EXIT_DEFAULT
    mask = (1 << 6) | (1 << 5) | (1 << 3) | (1 << 8);
  }

  const gated = await Gated.deploy(base, c.SolvencyOracle, dep.custodianId, asset, mask, maxFreeze);
  await gated.waitForDeployment();
  if (Number(await gated.blockingReasons()) !== Number(await gated.DEFAULT_BLOCKING_REASONS()) && !process.env.BLOCKING_REASONS) {
    throw new Error("script default mask drifted from the contract's DEFAULT_BLOCKING_REASONS");
  }
  c.SolvencyGatedMorphoOracle = await gated.getAddress();
  dep.morpho = { ...(dep.morpho ?? {}), baseOracle: base, asset, blockingReasons: mask, maxFreeze };
  fs.writeFileSync(depPath, JSON.stringify(dep, null, 2));
  console.log(`SolvencyGatedMorphoOracle: ${c.SolvencyGatedMorphoOracle} (mask ${mask}, maxFreeze ${maxFreeze}s)`);

  try {
    console.log(`price() = ${await gated.price()}`);
  } catch (e) {
    console.log(`price() reverted: ${(e as Error).message.split("\n")[0]}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
