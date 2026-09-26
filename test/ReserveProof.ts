import { expect } from "chai";
import { ethers } from "hardhat";
import { buildSortedTree } from "./helpers/merkle";
import {
  allocationCommitment,
  commitAndSample,
  deployFixture,
  signEpochCommitment,
  twoLeaves,
} from "./helpers/fixture";

describe("ReserveProof oracle basics", function () {
  it("is solvent when samples + live cover allocation", async function () {
    const f = await deployFixture();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { proofs, asset } = await commitAndSample(f, leaves);

    const [ok, eid] = await f.oracle.isSolvent(f.custodianId, asset);
    expect(ok).to.equal(true);
    expect(eid).to.equal(1n);

    const proof = proofs.get(f.userA.address.toLowerCase())!;
    expect(proof.length).to.be.greaterThan(0);
  });

  it("fails closed when live reserves drained", async function () {
    const f = await deployFixture();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { asset } = await commitAndSample(f, leaves);

    await f.stock
      .connect(f.wallet1)
      .transfer(f.operator.address, await f.stock.balanceOf(f.wallet1.address));

    const status = await f.oracle.status(f.custodianId, asset);
    expect(status.ok).to.equal(false);
    expect(status.reason).to.equal(6); // LIVE_SHORT
  });

  it("gated payout reverts while insolvent", async function () {
    const f = await deployFixture();
    const asset = await f.stock.getAddress();
    const Gated = await ethers.getContractFactory("GatedPayout");
    const gated = await Gated.deploy(await f.oracle.getAddress(), f.custodianId, asset);

    await f.stock.mint(f.userA.address, ethers.parseEther("10"));
    await f.stock.connect(f.userA).approve(await gated.getAddress(), ethers.parseEther("10"));
    await gated.connect(f.userA).deposit(ethers.parseEther("10"));
    await expect(
      gated.connect(f.userA).payout(f.userB.address, ethers.parseEther("1"))
    ).to.be.revertedWithCustomError(gated, "Insolvent");
  });

  it("gated lend withdraw reverts while insolvent", async function () {
    const f = await deployFixture();
    const asset = await f.stock.getAddress();
    const Gated = await ethers.getContractFactory("GatedLendWithdraw");
    const gated = await Gated.deploy(await f.oracle.getAddress(), f.custodianId, asset);

    await f.stock.mint(f.userA.address, ethers.parseEther("10"));
    await f.stock.connect(f.userA).approve(await gated.getAddress(), ethers.parseEther("10"));
    await gated.connect(f.userA).deposit(ethers.parseEther("10"));
    await expect(
      gated.connect(f.userA).withdraw(ethers.parseEther("1"))
    ).to.be.revertedWithCustomError(gated, "Insolvent");
  });

  it("multiplier drift fails closed", async function () {
    const f = await deployFixture();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { asset } = await commitAndSample(f, leaves);

    await f.stock.setUIMultiplierNow(ethers.parseEther("1.05"));
    const status = await f.oracle.status(f.custodianId, asset);
    expect(status.ok).to.equal(false);
    expect(status.reason).to.equal(7); // MULTIPLIER_DRIFT
  });

  it("fails closed when stale", async function () {
    const f = await deployFixture({ maxOracleAge: 3600 });
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { asset } = await commitAndSample(f, leaves);

    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);

    const status = await f.oracle.status(f.custodianId, asset);
    expect(status.ok).to.equal(false);
    expect(status.reason).to.equal(2); // STALE
  });

  it("fails closed when under-sampled", async function () {
    const f = await deployFixture({ minSamples: 3 });
    const asset = await f.stock.getAddress();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { root, total, leafCount } = buildSortedTree(f.custodianId, asset, 1, leaves);
    const allocCmt = allocationCommitment([f.chainId], [total]);
    const sig = await signEpochCommitment(
      f.operator,
      f.custodianId,
      asset,
      1,
      root,
      total,
      allocCmt,
      leafCount
    );

    await f.ledger
      .connect(f.operator)
      .commitEpoch(
        f.custodianId,
        asset,
        1,
        root,
        total,
        [f.chainId],
        [total],
        ethers.parseEther("1"),
        0,
        leafCount,
        sig
      );
    await f.sampler.connect(f.operator).setSampleWallets(f.custodianId, asset, [f.wallet1.address]);
    await f.sampler.connect(f.operator).recordSample(f.custodianId, asset);
    await ethers.provider.send("evm_increaseTime", [2]);
    await ethers.provider.send("evm_mine", []);
    await f.sampler.connect(f.operator).recordSample(f.custodianId, asset);

    const status = await f.oracle.status(f.custodianId, asset);
    expect(status.ok).to.equal(false);
    expect(status.reason).to.equal(4); // INSUFFICIENT_SAMPLES
  });
});
