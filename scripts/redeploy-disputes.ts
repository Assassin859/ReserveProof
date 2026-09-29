/**
 * Replace the dispute layer of an existing deployment (SETTLE-1 fix) without touching the proof data.
 *
 * SolvencyOracle holds DisputeModule as an immutable, and GatedPayout / GatedLendWithdraw hold the
 * oracle, so all four are redeployed. CustodianRegistry, AssetConfig, LiabilityLedger, ReserveSampler,
 * ExitRight and the tokens are kept: epochs and samples stay valid, so the new oracle reads the same
 * status immediately. Dispute parameters are copied from the old module on-chain. The replaced
 * addresses are kept under `previous` in the deployment file.
 *
 * Follow with: REDEPLOY=1 deploy-vault.ts, deploy-morpho-oracle.ts, verify, ops-cycle, web:sync.
 *
 *   npx hardhat run scripts/redeploy-disputes.ts --network robinhoodTestnet
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
  const [deployer] = await ethers.getSigners();
  console.log(`Network ${net} · deployer ${deployer.address}`);
  console.log(`Balance ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);

  const old = await ethers.getContractAt("DisputeModule", c.DisputeModule);
  const bondToken = await old.bondToken();
  const bond = await old.challengeBond();
  const timelock = await old.clearTimelock();
  const window = await old.challengeWindow();
  console.log(`Old DisputeModule ${c.DisputeModule}: bond ${bond}, timelock ${timelock}s, window ${window}s`);

  const previous = {
    replacedAt: new Date().toISOString(),
    reason: "SETTLE-1: bounded, resumable equivocation settlement",
    DisputeModule: c.DisputeModule,
    SolvencyOracle: c.SolvencyOracle,
    GatedPayout: c.GatedPayout,
    GatedLendWithdraw: c.GatedLendWithdraw,
    GuardedLendingVault: c.GuardedLendingVault,
    SolvencyGatedMorphoOracle: c.SolvencyGatedMorphoOracle,
  };

  const disputes = await (await ethers.getContractFactory("DisputeModule")).deploy(
    c.CustodianRegistry,
    c.LiabilityLedger,
    bondToken,
    bond,
    timelock,
    window
  );
  await disputes.waitForDeployment();
  const disputesAddr = await disputes.getAddress();
  console.log(`DisputeModule: ${disputesAddr}`);

  const oracle = await (await ethers.getContractFactory("SolvencyOracle")).deploy(
    c.CustodianRegistry,
    c.AssetConfig,
    c.LiabilityLedger,
    c.ReserveSampler,
    disputesAddr,
    deployer.address
  );
  await oracle.waitForDeployment();
  const oracleAddr = await oracle.getAddress();
  console.log(`SolvencyOracle: ${oracleAddr}`);
  await (await oracle.setExitRight(c.ExitRight)).wait();
  console.log(`Oracle <- ExitRight ${c.ExitRight} linked`);

  const payout = await (await ethers.getContractFactory("GatedPayout")).deploy(
    oracleAddr,
    dep.custodianId,
    c.MockStockToken
  );
  await payout.waitForDeployment();
  console.log(`GatedPayout: ${await payout.getAddress()}`);

  const lend = await (await ethers.getContractFactory("GatedLendWithdraw")).deploy(
    oracleAddr,
    dep.custodianId,
    c.MockStockToken
  );
  await lend.waitForDeployment();
  console.log(`GatedLendWithdraw: ${await lend.getAddress()}`);

  c.DisputeModule = disputesAddr;
  c.SolvencyOracle = oracleAddr;
  c.GatedPayout = await payout.getAddress();
  c.GatedLendWithdraw = await lend.getAddress();
  dep.previous = previous;
  fs.writeFileSync(depPath, JSON.stringify(dep, null, 2));
  console.log(`Wrote ${depPath}`);

  const assets: [string, string | undefined][] = [
    ["mTSLA", c.MockStockToken],
    ["USDG", c.USDG],
    ["TSLA", c.TSLA],
  ];
  for (const [label, asset] of assets) {
    if (!asset) continue;
    const s = await oracle.status(dep.custodianId, asset);
    console.log(`${label}: ok=${s.ok} reason=${s.reason}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
