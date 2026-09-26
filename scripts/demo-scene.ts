/**
 * Prepare localhost state for Kopi demo scenes 4–7.
 *
 * Usage:
 *   npx hardhat run scripts/demo-scene.ts --network localhost
 *   SCENE=4|5|6|7 npx hardhat run scripts/demo-scene.ts --network localhost
 *
 * Prerequisites: deploy + cli:build (asset must match MockStockToken) + ops:publish + ops:sample
 */
import hre from "hardhat";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { buildSortedTree, type Leaf } from "../test/helpers/merkle";

function loadJson(p: string) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function main() {
  if (hre.network.name !== "hardhat" && hre.network.name !== "localhost") {
    throw new Error("demo-scene is for localhost/hardhat only");
  }

  const scene = Number(process.env.SCENE || "4");
  const depPath = path.resolve(
    process.env.DEPLOYMENT || `deployments/${hre.network.name}.json`
  );
  const rootPath = path.resolve(process.env.ROOT_JSON || "out/root.json");
  const dep = loadJson(depPath);
  const [operator, reserveWallet, userA] = await ethers.getSigners();

  const custodianId = dep.custodianId as string;
  const asset = dep.contracts.MockStockToken as string;
  const oracle = await ethers.getContractAt("SolvencyOracle", dep.contracts.SolvencyOracle);
  const stock = await ethers.getContractAt("MockStockToken", asset);
  const registry = await ethers.getContractAt("CustodianRegistry", dep.contracts.CustodianRegistry);
  const gated = await ethers.getContractAt("GatedPayout", dep.contracts.GatedPayout);
  const disputes = await ethers.getContractAt("DisputeModule", dep.contracts.DisputeModule);
  const ledger = await ethers.getContractAt("LiabilityLedger", dep.contracts.LiabilityLedger);

  console.log(`Preparing scene ${scene}`);

  if (scene === 4) {
    // Drain reserve wallet so live reserves fall below coverage floor
    const bal = await stock.balanceOf(reserveWallet.address);
    if (bal > 0n) {
      await (await stock.connect(reserveWallet).transfer(operator.address, bal)).wait();
      console.log(`Drained ${bal.toString()} from reserve wallet → LIVE_SHORT / UNDERCOLLATERALIZED`);
    }
    const status = await oracle.status(custodianId, asset);
    console.log(`isSolvent ok=${status.ok} reason=${status.reason}`);

    // Attempt gated payout (expect revert)
    try {
      await gated.payout.staticCall(userA.address, 1n);
      console.log("WARN: payout did not revert");
    } catch {
      console.log("GatedPayout.payout correctly blocked (Insolvent)");
    }
  } else if (scene === 5) {
    await (await stock.setUIMultiplierNow(ethers.parseEther("1.05"))).wait();
    const status = await oracle.status(custodianId, asset);
    console.log(`Multiplier drifted → ok=${status.ok} reason=${status.reason} (expect 7 MULTIPLIER_DRIFT)`);
  } else if (scene === 6) {
    const seconds = Number(process.env.SECONDS || String(7 * 24 * 3600 + 1));
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
    const status = await oracle.status(custodianId, asset);
    console.log(`Warped +${seconds}s → ok=${status.ok} reason=${status.reason} (expect 2 STALE)`);
  } else if (scene === 7) {
    if (!fs.existsSync(rootPath)) throw new Error(`Missing ${rootPath}`);
    const rootDoc = loadJson(rootPath);
    const epochId = Number(rootDoc.epochId);
    const leaves: Leaf[] = rootDoc.sorted.map((l: { user: string; amount: string }) => ({
      user: l.user,
      amount: BigInt(l.amount),
    }));
    const { proofs } = buildSortedTree(custodianId, asset, epochId, leaves);
    const user = leaves[0].user;
    const provedAmount = leaves[0].amount;
    const statedAmount = provedAmount + 1n;
    const proofNodes = proofs.get(user.toLowerCase())!;

    const network = await ethers.provider.getNetwork();
    const domain = {
      name: "ReserveProof",
      version: "1",
      chainId: Number(network.chainId),
      verifyingContract: await disputes.getAddress(),
    };
    const types = {
      BalanceStatement: [
        { name: "custodianId", type: "bytes32" },
        { name: "asset", type: "address" },
        { name: "epochId", type: "uint64" },
        { name: "user", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    };
    const value = { custodianId, asset, epochId, user, amount: statedAmount };
    const sig = await operator.signTypedData(domain, types, value);

    const siblings = proofNodes.map((p) => ({
      hash: p.hash,
      sum: p.sum,
      isLeft: p.isLeft,
    }));

    await (
      await disputes.openMismatchDispute(
        custodianId,
        asset,
        epochId,
        user,
        provedAmount,
        statedAmount,
        sig,
        siblings
      )
    ).wait();

    const status = await oracle.status(custodianId, asset);
    console.log(`Dispute opened → ok=${status.ok} reason=${status.reason} (expect 3 DISPUTED)`);
  } else if (scene === 1) {
    // Show WalletTaken on duplicate add
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const msgHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "uint64", "address", "address"],
        [custodianId, chainId, reserveWallet.address, await registry.getAddress()]
      )
    );
    const sig = await reserveWallet.signMessage(ethers.getBytes(msgHash));
    try {
      await registry.addReserveWallet.staticCall(custodianId, chainId, reserveWallet.address, sig);
      console.log("WARN: duplicate add did not revert");
    } catch (e: unknown) {
      console.log(`Duplicate reserve wallet rejected: ${(e as Error).message?.slice(0, 80) || "WalletTaken"}`);
    }
  } else {
    throw new Error(`Unknown SCENE=${scene} (use 1,4,5,6,7)`);
  }

  void ledger;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
