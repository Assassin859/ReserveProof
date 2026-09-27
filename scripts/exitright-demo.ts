/**
 * Live ExitRight round-trip: the private demo user opens a claim with its mTSLA leaf proof,
 * then the operator mints, approves and settles it in the same run (so no default can occur).
 *
 * Usage: npx hardhat run scripts/exitright-demo.ts --network robinhoodTestnet
 * Env:
 *   DEPLOYMENT   (default deployments/<network>.json)
 *   PROOF        (default out/<network>/stock/proofs/<demoUser>.json)
 *   GAS_FUNDING  ETH sent to the demo user if its balance is below this (default 0.0002)
 * Writes deployments/<network>.exitright.json.
 */
import hre from "hardhat";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const net = hre.network.name;
  const depPath = path.resolve(process.env.DEPLOYMENT || `deployments/${net}.json`);
  const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
  const wallets = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "wallets.local.json"), "utf8")
  );
  const [operator] = await ethers.getSigners();
  const demoUser = new ethers.Wallet(wallets.demoUser.privateKey, ethers.provider);
  const custodianId = dep.custodianId as string;
  const asset = dep.contracts.MockStockToken as string;

  const proofPath = path.resolve(
    process.env.PROOF || `out/${net}/stock/proofs/${demoUser.address}.json`
  );
  const proofDoc = JSON.parse(fs.readFileSync(proofPath, "utf8"));
  const amount = BigInt(proofDoc.amount);
  const siblings = proofDoc.proof.map((p: { hash: string; sum: string; isLeft: boolean }) => ({
    hash: p.hash,
    sum: BigInt(p.sum),
    isLeft: p.isLeft,
  }));

  const exitRight = await ethers.getContractAt("ExitRight", dep.contracts.ExitRight);
  const stock = await ethers.getContractAt("MockStockToken", asset);
  const ledger = await ethers.getContractAt("LiabilityLedger", dep.contracts.LiabilityLedger);
  const epochId = await ledger.latestEpochId(custodianId, asset);

  console.log(`Demo user: ${demoUser.address}`);
  console.log(`Claim: ${ethers.formatEther(amount)} mTSLA at epoch ${epochId}`);

  const fee = await ethers.provider.getFeeData();
  const maxFee = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  // openClaim with a depth-2 proof uses ~200k gas; budget 2x at the current max fee.
  let minGas = ethers.parseEther(process.env.GAS_FUNDING || "0.0002");
  if (400_000n * maxFee > minGas) minGas = 400_000n * maxFee;
  let fundTxHash: string | null = null;
  const demoBal = await ethers.provider.getBalance(demoUser.address);
  if (demoBal < minGas) {
    const fundTx = await operator.sendTransaction({ to: demoUser.address, value: minGas - demoBal });
    await fundTx.wait();
    fundTxHash = fundTx.hash;
    console.log(`gas funding: ${fundTx.hash}`);
  }

  const claimId = await exitRight.nextClaimId();
  const openTx = await exitRight.connect(demoUser).openClaim(custodianId, asset, amount, siblings);
  await openTx.wait();
  console.log(`openClaim #${claimId}: ${openTx.hash}`);

  const opBal = await stock.balanceOf(operator.address);
  let mintTxHash: string | null = null;
  if (opBal < amount) {
    const mintTx = await stock.mint(operator.address, amount - opBal);
    await mintTx.wait();
    mintTxHash = mintTx.hash;
    console.log(`mint: ${mintTx.hash}`);
  }
  const approveTx = await stock.approve(await exitRight.getAddress(), amount);
  await approveTx.wait();
  console.log(`approve: ${approveTx.hash}`);
  const settleTx = await exitRight.settle(custodianId, claimId);
  await settleTx.wait();
  console.log(`settle: ${settleTx.hash}`);

  const claim = await exitRight.claims(claimId);
  const record = {
    network: net,
    chainId: dep.chainId,
    exitRight: dep.contracts.ExitRight,
    custodianId,
    asset,
    user: demoUser.address,
    claimId: Number(claimId),
    epochId: Number(epochId),
    amount: amount.toString(),
    settled: claim.settled,
    txs: {
      fund: fundTxHash,
      openClaim: openTx.hash,
      mint: mintTxHash,
      approve: approveTx.hash,
      settle: settleTx.hash,
    },
    recordedAt: new Date().toISOString(),
  };
  const outFile = path.join(__dirname, "..", "deployments", `${net}.exitright.json`);
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
  console.log(`Wrote ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
