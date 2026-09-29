/**
 * Deploy the GuardedLendingVault example next to an existing ReserveProof deployment.
 *
 * The deployer becomes the demo borrower: it mints mTSLA to itself (it owns MockStockToken), posts it
 * as collateral, and supplies up to VAULT_SEED_USDG of its USDG as lender liquidity, so the web
 * simulator can show a real `borrow` flipping from allowed to `Insolvent(reason)`. When liquidity
 * allows, it also borrows VAULT_DEMO_DEBT_USDG so collateral withdrawal (gated only while in debt)
 * has something to show too.
 *
 * With REDEPLOY=1 the deployer's supply and collateral are first pulled out of the old vault.
 * VAULT_LOAN_TOKEN=new deploys a MockUSDG owned by the deployer and mints the seed, for chains where
 * the deployment's USDG isn't ours to mint; VAULT_LOAN_TOKEN=<address> uses that token. Either is
 * stored as contracts.VaultLoanToken; by default the vault lends VaultLoanToken, else USDG.
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
const DEMO_DEBT = BigInt(Math.round(Number(process.env.VAULT_DEMO_DEBT_USDG || "1") * 1e6));

async function drainOldVault(address: string, who: string) {
  const old = await ethers.getContractAt("GuardedLendingVault", address);
  const debt = await old.debtOf(who);
  if (debt > 0n) {
    const usdg = await ethers.getContractAt("MockUSDG", await old.loanToken());
    await (await usdg.approve(address, debt)).wait();
    await (await old.repay(debt)).wait();
    console.log(`Old vault: repaid ${Number(debt) / 1e6} USDG`);
  }
  const supplied = await old.supplied(who);
  const liquid = await old.availableLiquidity();
  const out = supplied < liquid ? supplied : liquid;
  if (out > 0n) {
    await (await old.withdrawSupply(out)).wait();
    console.log(`Old vault: withdrew ${Number(out) / 1e6} USDG supply`);
  }
  const coll = await old.collateralOf(who);
  if (coll > 0n) {
    await (await old.withdrawCollateral(coll)).wait();
    console.log(`Old vault: withdrew ${ethers.formatEther(coll)} mTSLA collateral`);
  }
}

async function main() {
  const network = hre.network.name;
  const depPath = path.join(__dirname, "..", "deployments", `${network}.json`);
  const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
  const c = dep.contracts;
  const [deployer] = await ethers.getSigners();

  let vaultAddr: string = c.GuardedLendingVault;
  let loanToken: string = c.VaultLoanToken || c.USDG;
  if (vaultAddr && process.env.REDEPLOY !== "1") {
    console.log(`GuardedLendingVault already at ${vaultAddr} (REDEPLOY=1 to replace)`);
    loanToken = await (await ethers.getContractAt("GuardedLendingVault", vaultAddr)).loanToken();
  } else {
    if (vaultAddr) await drainOldVault(vaultAddr, deployer.address);
    const wanted = process.env.VAULT_LOAN_TOKEN;
    if (wanted === "new") {
      const mock = await (await ethers.getContractFactory("MockUSDG")).deploy();
      await mock.waitForDeployment();
      loanToken = await mock.getAddress();
      await (await mock.mint(deployer.address, SEED + 1_000_000n)).wait();
      c.VaultLoanToken = loanToken;
      console.log(`Vault loan token: MockUSDG ${loanToken} (deployer-owned, minted ${Number(SEED + 1_000_000n) / 1e6})`);
    } else if (wanted) {
      loanToken = ethers.getAddress(wanted);
      c.VaultLoanToken = loanToken;
    }
    const Vault = await ethers.getContractFactory("GuardedLendingVault");
    const vault = await Vault.deploy(c.SolvencyOracle, dep.custodianId, c.MockStockToken, loanToken, PRICE, LTV_BPS);
    await vault.waitForDeployment();
    vaultAddr = await vault.getAddress();
    console.log(`GuardedLendingVault: ${vaultAddr}`);
  }
  const vault = await ethers.getContractAt("GuardedLendingVault", vaultAddr);
  const stock = await ethers.getContractAt("MockStockToken", c.MockStockToken);
  const usdg = await ethers.getContractAt("MockUSDG", loanToken);

  if ((await vault.collateralOf(deployer.address)) < COLLATERAL) {
    const held = await stock.balanceOf(deployer.address);
    if (held < COLLATERAL) await (await stock.mint(deployer.address, COLLATERAL - held)).wait();
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

  // Keep at least 1 USDG liquid after the demo debt so the simulator's borrow probe still runs.
  const liquidNow = await vault.availableLiquidity();
  if (DEMO_DEBT > 0n && (await vault.debtOf(deployer.address)) === 0n && liquidNow >= DEMO_DEBT + 1_000_000n) {
    await (await vault.borrow(DEMO_DEBT)).wait();
    console.log(`Demo borrower owes ${Number(DEMO_DEBT) / 1e6} USDG`);
  } else if ((await vault.debtOf(deployer.address)) === 0n) {
    console.log("Demo borrower has no debt: collateral withdrawal stays open under insolvency (debt-free path)");
  }

  const [ok, , , reason] = await ethers
    .getContractAt("SolvencyOracle", c.SolvencyOracle)
    .then((o) => o.status(dep.custodianId, c.MockStockToken));
  console.log(
    `Liquidity ${Number(await vault.availableLiquidity()) / 1e6} USDG · maxBorrow ${
      Number(await vault.maxBorrow(deployer.address)) / 1e6
    } USDG · debt ${Number(await vault.debtOf(deployer.address)) / 1e6} USDG · oracle ok=${ok} reason=${reason}`
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
