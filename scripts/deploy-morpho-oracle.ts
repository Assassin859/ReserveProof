/**
 * Deploy a Morpho Blue oracle for the demo custodian's mTSLA that stops pricing while the proof fails:
 * FixedPriceMorphoOracle (the vault's demo price, in Morpho's 1e36 scale) wrapped by
 * SolvencyGatedMorphoOracle. Neither testnet has Morpho Blue, so this proves the wrapper live; on a
 * chain with Morpho, pass BASE_ORACLE=<existing market oracle> and ASSET=<collateral> instead.
 *
 *   npm run morpho:deploy:rh      # or :arb
 * Env: BASE_ORACLE (skip the fixed oracle), ASSET (default the deployment's MockStockToken)
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

  let base = process.env.BASE_ORACLE || "";
  if (!base) {
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

  const gated = await (await ethers.getContractFactory("SolvencyGatedMorphoOracle")).deploy(
    base,
    c.SolvencyOracle,
    dep.custodianId,
    asset
  );
  await gated.waitForDeployment();
  c.SolvencyGatedMorphoOracle = await gated.getAddress();
  dep.morpho = { ...(dep.morpho ?? {}), baseOracle: base, asset };
  fs.writeFileSync(depPath, JSON.stringify(dep, null, 2));
  console.log(`SolvencyGatedMorphoOracle: ${c.SolvencyGatedMorphoOracle}`);

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
