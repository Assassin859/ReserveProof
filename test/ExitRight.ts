import { expect } from "chai";
import { ethers } from "hardhat";
import { commitAndSample, deployFixture, twoLeaves } from "./helpers/fixture";

describe("ExitRight", function () {
  async function solventWithBond() {
    const f = await deployFixture();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { proofs, asset } = await commitAndSample(f, leaves);

    // postBond before setBondConfig (cap must be <= balance)
    await f.usdg.connect(f.operator).approve(await f.exitRight.getAddress(), 10_000_000n);
    await f.exitRight.connect(f.operator).postBond(f.custodianId, 5_000_000n);
    await f.exitRight.connect(f.operator).setBondConfig(
      f.custodianId,
      3600,
      1_000_000n,
      10_000_000n
    );

    await f.stock.mint(f.operator.address, ethers.parseEther("1000"));

    return { f, proofs, asset };
  }

  it("settle pays same token and keeps solvent", async function () {
    const { f, proofs, asset } = await solventWithBond();
    const amount = ethers.parseEther("100");
    const proof = proofs.get(f.userA.address.toLowerCase())!;

    const before = await f.stock.balanceOf(f.userA.address);
    await f.exitRight.connect(f.userA).openClaim(f.custodianId, asset, amount, proof);
    const claimId = 0n;

    await f.stock.connect(f.operator).approve(await f.exitRight.getAddress(), amount);
    await f.exitRight.connect(f.operator).settle(f.custodianId, claimId);

    expect(await f.stock.balanceOf(f.userA.address)).to.equal(before + amount);
    expect(await f.exitRight.hasExitDefault(f.custodianId, asset)).to.equal(false);
    const [ok] = await f.oracle.isSolvent(f.custodianId, asset);
    expect(ok).to.equal(true);
  });

  it("slash after deadline sets exit default and insolvency", async function () {
    const { f, proofs, asset } = await solventWithBond();
    const amount = ethers.parseEther("100");
    const proof = proofs.get(f.userA.address.toLowerCase())!;

    await f.exitRight.connect(f.userA).openClaim(f.custodianId, asset, amount, proof);
    const claimId = 0n;

    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);

    const bondBefore = await f.usdg.balanceOf(f.userA.address);
    await f.exitRight.slash(claimId);

    expect(await f.exitRight.hasExitDefault(f.custodianId, asset)).to.equal(true);
    expect(await f.usdg.balanceOf(f.userA.address)).to.equal(bondBefore + 1_000_000n);

    const status = await f.oracle.status(f.custodianId, asset);
    expect(status.ok).to.equal(false);
    expect(status.reason).to.equal(8); // EXIT_DEFAULT
  });

  it("rejects double claim for same user and epoch", async function () {
    const { f, proofs, asset } = await solventWithBond();
    const amount = ethers.parseEther("100");
    const proof = proofs.get(f.userA.address.toLowerCase())!;

    await f.exitRight.connect(f.userA).openClaim(f.custodianId, asset, amount, proof);
    await expect(
      f.exitRight.connect(f.userA).openClaim(f.custodianId, asset, amount, proof)
    ).to.be.revertedWithCustomError(f.exitRight, "AlreadyClaimed");
  });
});
