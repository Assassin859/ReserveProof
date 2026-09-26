/**
 * Round-3 security regression: owner allowlist, allocation commitment, leafCount.
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

describe("zz_poc_review — allowlist / commitment / leafCount", function () {
  it("operator cannot seed fake chain into allowlist on first config", async function () {
    const f = await deployFixture();
    const Token = await ethers.getContractFactory("MockStockToken");
    const t2 = await Token.deploy("Y", "Y");
    await expect(
      f.assetConfig.connect(f.operator).setAssetConfig(
        f.custodianId,
        await t2.getAddress(),
        await t2.getAddress(),
        f.chainId,
        true,
        0,
        10300,
        3600,
        2,
        1,
        [f.chainId, 999999]
      )
    ).to.be.revertedWithCustomError(f.assetConfig, "NotOperator");
  });

  it("rejects allocation vector that omits an allowlisted chain or uses wrong order", async function () {
    const peer = 421614;
    const f = await deployFixture({ allocationChains: [31337, peer] });
    const asset = await f.stock.getAddress();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { root, total } = buildSortedTree(f.custodianId, asset, 1, leaves);

    // Subset only — missing peer
    await expect(
      f.ledger.connect(f.operator).commitEpoch(
        f.custodianId,
        asset,
        1,
        root,
        total,
        [f.chainId],
        [total],
        ethers.parseEther("1"),
        0,
        2
      )
    ).to.be.revertedWithCustomError(f.ledger, "BadAllocation");

    // Wrong order
    await expect(
      f.ledger.connect(f.operator).commitEpoch(
        f.custodianId,
        asset,
        1,
        root,
        total,
        [peer, f.chainId],
        [total / 2n, total - total / 2n],
        ethers.parseEther("1"),
        0,
        2
      )
    ).to.be.revertedWithCustomError(f.ledger, "BadAllocation");
  });

  it("stores allocationCommitment identical for the same vector", async function () {
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
      0,
      2
    );
    const ep = await f.ledger.getEpoch(f.custodianId, asset, 1);
    const expected = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint64[]", "uint256[]"],
        [
          [f.chainId, peer],
          [half, total - half],
        ]
      )
    );
    expect(ep.allocationCommitment).to.equal(expected);
    expect(ep.leafCount).to.equal(2n);
  });

  it("rejects non power-of-two leafCount", async function () {
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
        [f.chainId],
        [total],
        ethers.parseEther("1"),
        0,
        3
      )
    ).to.be.revertedWithCustomError(f.ledger, "BadLeafCount");
  });

  it("lopsided proofs fail omission when epoch leafCount is 4", async function () {
    const f = await deployFixture();
    const asset = await f.stock.getAddress();
    // Build a balanced 4-leaf tree for a valid root+total, then commit leafCount=4.
    const addrs = [f.userA.address, f.userB.address, f.userC.address, f.userD.address].sort((a, b) =>
      a.toLowerCase() < b.toLowerCase() ? -1 : 1
    );
    const leaves: Leaf[] = addrs.map((u, i) => ({
      user: u,
      amount: ethers.parseEther(String((i + 1) * 10)),
    }));
    const { root, total, proofs } = buildSortedTree(f.custodianId, asset, 1, leaves);
    await f.ledger.connect(f.operator).commitEpoch(
      f.custodianId,
      asset,
      1,
      root,
      total,
      [f.chainId],
      [total],
      ethers.parseEther("1"),
      0,
      4
    );

    // Short (depth-1) "lopsided" proof — wrong length vs leafCount=4 (depth 2)
    const shortProof = [
      {
        hash: proofs.get(leaves[0].user.toLowerCase())![0].hash,
        sum: proofs.get(leaves[0].user.toLowerCase())![0].sum,
        isLeft: false,
      },
    ];

    const omitted = ethers.Wallet.createRandom().address;
    // Ensure omitted sorts left of all for left-edge attempt with short proof
    const stated = ethers.parseEther("1");
    const sig = await signBalanceStatement(
      f.disputes,
      f.operator,
      f.custodianId,
      asset,
      1,
      omitted,
      stated
    );

    // Middle omission with mismatched depth on one side
    const left = leaves[1];
    const right = leaves[2];
    let mid = "";
    for (let i = 0; i < 300; i++) {
      const w = ethers.Wallet.createRandom().address;
      if (left.user.toLowerCase() < w.toLowerCase() && w.toLowerCase() < right.user.toLowerCase()) {
        mid = w;
        break;
      }
    }
    expect(mid).to.not.equal("");
    const midSig = await signBalanceStatement(
      f.disputes,
      f.operator,
      f.custodianId,
      asset,
      1,
      mid,
      stated
    );

    await expect(
      f.disputes.openOmissionDispute(
        f.custodianId,
        asset,
        1,
        mid,
        stated,
        midSig,
        left.user,
        left.amount,
        shortProof,
        right.user,
        right.amount,
        proofs.get(right.user.toLowerCase())!
      )
    ).to.be.reverted; // BadProof or BadBounds

    // Balanced middle omission still works
    await f.disputes.openOmissionDispute(
      f.custodianId,
      asset,
      1,
      mid,
      stated,
      midSig,
      left.user,
      left.amount,
      proofs.get(left.user.toLowerCase())!,
      right.user,
      right.amount,
      proofs.get(right.user.toLowerCase())!
    );
    expect(await f.disputes.isDisputed(f.custodianId, asset)).to.equal(true);
  });

  it("maxBondTotalInFlight must be at least 2x per-claim", async function () {
    const f = await deployFixture();
    await f.usdg.connect(f.operator).approve(await f.exitRight.getAddress(), 5_000_000n);
    await f.exitRight.connect(f.operator).postBond(f.custodianId, 5_000_000n);
    await expect(
      f.exitRight.connect(f.operator).setBondConfig(f.custodianId, 3600, 1_000_000n, 1_000_000n)
    ).to.be.revertedWithCustomError(f.exitRight, "BadConfig");
    await f.exitRight.connect(f.operator).setBondConfig(f.custodianId, 3600, 1_000_000n, 2_000_000n);
  });

  it("rejects one-sided omission against in-tree user", async function () {
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
        proofs.get(left.user.toLowerCase())!,
        ethers.ZeroAddress,
        0n,
        []
      )
    ).to.be.revertedWithCustomError(f.disputes, "BadBounds");
  });
});
