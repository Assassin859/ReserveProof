/**
 * Post the operator's USDG bond to ExitRight and configure claim caps.
 *
 * Usage: npx hardhat run scripts/exitright-setup.ts --network robinhoodTestnet
 * Env:
 *   DEPLOYMENT      (default deployments/<network>.json)
 *   BOND            total bond in USDG units (default 60)
 *   PER_CLAIM       bond reserved per claim (default 10)
 *   IN_FLIGHT       max bond reserved across open claims (default 30, must be >= 3 x PER_CLAIM)
 *   PAYOUT_DELAY    seconds the operator has to settle a claim (default 3 days)
 */
import hre from "hardhat";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const depPath = path.resolve(process.env.DEPLOYMENT || `deployments/${hre.network.name}.json`);
  const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
  const [operator] = await ethers.getSigners();
  const custodianId = dep.custodianId as string;

  const usdg = await ethers.getContractAt(
    "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata",
    dep.contracts.USDG
  );
  const exitRight = await ethers.getContractAt("ExitRight", dep.contracts.ExitRight);
  const decimals = Number(await usdg.decimals());
  const units = (v: string) => ethers.parseUnits(v, decimals);

  const bondTarget = units(process.env.BOND || "60");
  const perClaim = units(process.env.PER_CLAIM || "10");
  const inFlight = units(process.env.IN_FLIGHT || "30");
  const payoutDelay = BigInt(process.env.PAYOUT_DELAY || String(3 * 24 * 3600));

  const current = await exitRight.bondBalance(custodianId);
  console.log(`Operator: ${operator.address}`);
  console.log(`Bond balance: ${ethers.formatUnits(current, decimals)} USDG (target ${ethers.formatUnits(bondTarget, decimals)})`);

  if (current < bondTarget) {
    const need = bondTarget - current;
    const bal = await usdg.balanceOf(operator.address);
    if (bal < need) {
      throw new Error(
        `Operator holds ${ethers.formatUnits(bal, decimals)} USDG, needs ${ethers.formatUnits(need, decimals)} — use the Paxos faucet`
      );
    }
    const approveTx = await usdg.approve(await exitRight.getAddress(), need);
    await approveTx.wait();
    console.log(`approve: ${approveTx.hash}`);
    const bondTx = await exitRight.postBond(custodianId, need);
    await bondTx.wait();
    console.log(`postBond(${ethers.formatUnits(need, decimals)}): ${bondTx.hash}`);
  }

  const cfg = await exitRight.bondConfigs(custodianId);
  if (
    cfg.set &&
    cfg.maxPayoutDelay === payoutDelay &&
    cfg.maxBondPerClaim === perClaim &&
    cfg.maxBondTotalInFlight === inFlight
  ) {
    console.log("Bond config already set");
  } else {
    const cfgTx = await exitRight.setBondConfig(custodianId, payoutDelay, perClaim, inFlight);
    await cfgTx.wait();
    console.log(`setBondConfig: ${cfgTx.hash}`);
  }

  const after = await exitRight.bondConfigs(custodianId);
  console.log(
    `Config: bond=${ethers.formatUnits(after.bondAmount, decimals)} perClaim=${ethers.formatUnits(after.maxBondPerClaim, decimals)} ` +
      `inFlight=${ethers.formatUnits(after.maxBondTotalInFlight, decimals)} delay=${after.maxPayoutDelay}s`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
