/**
 * Round-2 security regression PoCs.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { buildSortedTree, type Leaf } from "./helpers/merkle";
import {
  commitAndSample,
  deployFixture,
  signBalanceStatement,
  twoLeaves,
} from "./helpers/fixture";

describe("zz_poc_review — round 2", function () {
  it("rejects fake allocation chain ids (e.g. 999999)", async function () {
    const f = await deployFixture();
    const asset = await f.stock.getAddress();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { root, total } = buildSortedTree(f.custodianId, asset, 1, leaves);

    await expect(
      f.ledger.connect(f.operator).commitEpoch(
        f.custodianId,
        asset,
        1,
        root,
        total,
        [f.chainId, 999999],
        [1n, total - 1n],
        ethers.parseEther("1"),
        0
      )
    ).to.be.revertedWithCustomError(f.ledger, "BadAllocation");
  });

  it("accepts dual-chain allocation when both chains are allowlisted", async function () {
    const peer = 421614;
    const f = await deployFixture({ allocationChains: [31337, peer] });
    const asset = await f.stock.getAddress();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { root, total } = buildSortedTree(f.custodianId, asset, 1, leaves);
    const half = total / 2n;
    await f.ledger.connect(f.operator).commitEpoch(
      f.custodianId,
      asset,
      1,
      root,
      total,
      [f.chainId, peer],
      [half, total - half],
      ethers.parseEther("1"),
      0
    );
    const ep = await f.ledger.getEpoch(f.custodianId, asset, 1);
    expect(ep.allocation).to.equal(half);
  });

  it("rejects one-sided omission against an in-tree user", async function () {
    const f = await deployFixture();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { proofs, asset } = await commitAndSample(f, leaves);
    const sorted = [...leaves].sort((a, b) =>
      a.user.toLowerCase() < b.user.toLowerCase() ? -1 : 1
    );
    const victim = sorted[1].user;
    const left = sorted[0];
    const stated = ethers.parseEther("50");
    const sig = await signBalanceStatement(
      f.disputes,
      f.operator,
      f.custodianId,
      asset,
      1,
      victim,
      stated
    );
    const leftProof = proofs.get(left.user.toLowerCase())!;
    await expect(
      f.disputes.openOmissionDispute(
        f.custodianId,
        asset,
        1,
        victim,
        stated,
        sig,
        left.user,
        left.amount,
        leftProof,
        ethers.ZeroAddress,
        0n,
        []
      )
    ).to.be.revertedWithCustomError(f.disputes, "BadBounds");
  });

  it("accepts real omission between indices 1 and 2 in a 4-leaf tree", async function () {
    const f = await deployFixture();
    const addrs = [f.userA.address, f.userB.address, f.userC.address, f.userD.address].sort((a, b) =>
      a.toLowerCase() < b.toLowerCase() ? -1 : 1
    );
    const leaves: Leaf[] = addrs.map((u, i) => ({
      user: u,
      amount: ethers.parseEther(String(100 * (i + 1))),
    }));
    const { proofs, asset } = await commitAndSample(f, leaves);

    const left = leaves[1];
    const right = leaves[2];
    let omitted = "";
    for (let i = 0; i < 200; i++) {
      const w = ethers.Wallet.createRandom().address;
      if (left.user.toLowerCase() < w.toLowerCase() && w.toLowerCase() < right.user.toLowerCase()) {
        omitted = w;
        break;
      }
    }
    expect(omitted, "could not find address between leaf 1 and 2").to.not.equal("");

    const stated = ethers.parseEther("50");
    const sig = await signBalanceStatement(
      f.disputes,
      f.operator,
      f.custodianId,
      asset,
      1,
      omitted,
      stated
    );
    const leftProof = proofs.get(left.user.toLowerCase())!;
    const rightProof = proofs.get(right.user.toLowerCase())!;

    await f.disputes.openOmissionDispute(
      f.custodianId,
      asset,
      1,
      omitted,
      stated,
      sig,
      left.user,
      left.amount,
      leftProof,
      right.user,
      right.amount,
      rightProof
    );
    expect(await f.disputes.isDisputed(f.custodianId, asset)).to.equal(true);
  });

  it("maxOracleAge cannot start at 0; updates cannot lengthen age", async function () {
    const f = await deployFixture();
    const asset = await f.stock.getAddress();

    const Token = await ethers.getContractFactory("MockStockToken");
    const t2 = await Token.deploy("X", "X");
    await expect(
      f.assetConfig.connect(f.operator).setAssetConfig(
        f.custodianId,
        await t2.getAddress(),
        await t2.getAddress(),
        f.chainId,
        true,
        0,
        10300,
        0,
        2,
        1,
        [f.chainId]
      )
    ).to.be.revertedWithCustomError(f.assetConfig, "BadParams");

    await expect(
      f.assetConfig.connect(f.owner).setAssetConfig(
        f.custodianId,
        asset,
        asset,
        f.chainId,
        true,
        0,
        10300,
        14 * 24 * 3600,
        2,
        1,
        []
      )
    ).to.be.revertedWithCustomError(f.assetConfig, "PolicyWeakened");

    await f.assetConfig.connect(f.owner).setAssetConfig(
      f.custodianId,
      asset,
      asset,
      f.chainId,
      true,
      0,
      10300,
      3600,
      2,
      1,
      []
    );
    const cfg = await f.assetConfig.getConfig(f.custodianId, asset);
    expect(cfg.maxOracleAge).to.equal(3600n);
  });

  it("setBondConfig reverts when maxBondPerClaim > bondBalance", async function () {
    const f = await deployFixture();
    await expect(
      f.exitRight.connect(f.operator).setBondConfig(f.custodianId, 3600, 1_000_000n, 10_000_000n)
    ).to.be.revertedWithCustomError(f.exitRight, "BadConfig");

    await f.usdg.connect(f.operator).approve(await f.exitRight.getAddress(), 5_000_000n);
    await f.exitRight.connect(f.operator).postBond(f.custodianId, 5_000_000n);
    await f.exitRight.connect(f.operator).setBondConfig(f.custodianId, 3600, 1_000_000n, 10_000_000n);
  });

  it("slash cannot drain another custodian's bond", async function () {
    const f = await deployFixture();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { proofs, asset } = await commitAndSample(f, leaves);

    const victimId = ethers.id("victim");
    await f.registry.registerCustodian(victimId, f.owner.address, 3600);
    await f.usdg.mint(f.owner.address, 5_000_000n);
    await f.usdg.connect(f.owner).approve(await f.exitRight.getAddress(), 5_000_000n);
    await f.exitRight.connect(f.owner).postBond(victimId, 5_000_000n);
    await f.exitRight.connect(f.owner).setBondConfig(victimId, 3600, 1_000_000n, 10_000_000n);

    await f.usdg.connect(f.operator).approve(await f.exitRight.getAddress(), 5_000_000n);
    await f.exitRight.connect(f.operator).postBond(f.custodianId, 5_000_000n);
    await f.exitRight.connect(f.operator).setBondConfig(f.custodianId, 3600, 1_000_000n, 10_000_000n);

    const proof = proofs.get(f.userA.address.toLowerCase())!;
    await f.exitRight.connect(f.userA).openClaim(f.custodianId, asset, ethers.parseEther("100"), proof);
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);

    const victimBondBefore = await f.exitRight.bondBalance(victimId);
    await f.exitRight.slash(0n);
    expect(await f.exitRight.bondBalance(victimId)).to.equal(victimBondBefore);
  });

  it("duplicate sample wallets rejected", async function () {
    const f = await deployFixture();
    const asset = await f.stock.getAddress();
    await expect(
      f.sampler
        .connect(f.operator)
        .setSampleWallets(f.custodianId, asset, [f.wallet1.address, f.wallet1.address])
    ).to.be.revertedWithCustomError(f.sampler, "UnsortedWallets");
  });

  it("finalizeWalletRemoval requires initiate", async function () {
    const f = await deployFixture();
    await expect(
      f.registry.connect(f.operator).finalizeWalletRemoval(f.custodianId, f.chainId, f.wallet1.address)
    ).to.be.revertedWithCustomError(f.registry, "RemovalNotReady");
  });

  it("setExitRight is owner-only", async function () {
    const f = await deployFixture();
    await expect(f.oracle.connect(f.userA).setExitRight(f.userA.address)).to.be.revertedWithCustomError(
      f.oracle,
      "OwnableUnauthorizedAccount"
    );
  });
});
