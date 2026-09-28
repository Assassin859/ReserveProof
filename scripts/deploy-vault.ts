/**
 * Deploy the GuardedLendingVault example next to an existing ReserveProof deployment.
 *
 * The deployer becomes the demo borrower: it mints mTSLA to itself (it owns MockStockToken), posts it
 * as collateral, and supplies up to VAULT_SEED_USDG of its USDG as lender liquidity, so the web
 * simulator can show a real `borrow` flipping from allowed to `Insolvent(reason)`.
 *
 *   npx hardhat run scripts/deploy-vault.ts --network robinhoodTestnet
 */
import hre from "hardhat";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const PRICE = BigInt(process.env.VAULT_PRICE_USDG || "250") * 1_000_000n;
const LTV_BPS = Number(process.env.VAULT_LTV_BPS || "5000");
const COLLATERAL = ethers.parseEther(process.env.VAULT_COLLATERAL || "10");
const SEED = BigInt(Math.round(Number(process.env.VAULT_SEED_USDG || "5") * 1e6));

async function main() {
  const network = hre.network.name;
  const depPath = path.join(__dirname, "..", "deployments", `${network}.json`);
  const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
  const c = dep.contracts;
  const [deployer] = await ethers.getSigners();

  let vaultAddr: string = c.GuardedLendingVault;
  if (vaultAddr && process.env.REDEPLOY !== "1") {
    console.log(`GuardedLendingVault already at ${vaultAddr} (REDEPLOY=1 to replace)`);
  } else {
    const Vault = await ethers.getContractFactory("GuardedLendingVault");
    const vault = await Vault.deploy(c.SolvencyOracle, dep.custodianId, c.MockStockToken, c.USDG, PRICE, LTV_BPS);
    await vault.waitForDeployment();
    vaultAddr = await vault.getAddress();
    console.log(`GuardedLendingVault: ${vaultAddr}`);
  }
  const vault = await ethers.getContractAt("GuardedLendingVault", vaultAddr);
  const stock = await ethers.getContractAt("MockStockToken", c.MockStockToken);
  const usdg = await ethers.getContractAt("MockUSDG", c.USDG);

  if ((await vault.collateralOf(deployer.address)) < COLLATERAL) {
    await (await stock.mint(deployer.address, COLLATERAL)).wait();
    await (await stock.approve(vaultAddr, COLLATERAL)).wait();
    await (await vault.depositCollateral(COLLATERAL)).wait();
    console.log(`Demo borrower ${deployer.address} posted ${ethers.formatEther(COLLATERAL)} mTSLA`);
  }

  const balance = await usdg.balanceOf(deployer.address);
  const liquidity = await vault.availableLiquidity();
  const seed = liquidity >= SEED ? 0n : balance < SEED - liquidity ? balance : SEED - liquidity;
  if (seed > 0n) {
    await (await usdg.approve(vaultAddr, seed)).wait();
    await (await vault.supply(seed)).wait();
    console.log(`Supplied ${Number(seed) / 1e6} USDG`);
  } else if (liquidity === 0n) {
    console.log("WARNING: deployer has no USDG, vault has no liquidity (borrow probes will show InsufficientLiquidity)");
  }

  const [ok, , , reason] = await ethers
    .getContractAt("SolvencyOracle", c.SolvencyOracle)
    .then((o) => o.status(dep.custodianId, c.MockStockToken));
  console.log(
    `Liquidity ${Number(await vault.availableLiquidity()) / 1e6} USDG · maxBorrow ${
      Number(await vault.maxBorrow(deployer.address)) / 1e6
    } USDG · oracle ok=${ok} reason=${reason}`
  );

  dep.contracts.GuardedLendingVault = vaultAddr;
  dep.vault = {
    demoBorrower: deployer.address,
    collateralPrice: PRICE.toString(),
    ltvBps: LTV_BPS,
  };
  fs.writeFileSync(depPath, JSON.stringify(dep, null, 2));
  console.log(`Updated ${depPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
