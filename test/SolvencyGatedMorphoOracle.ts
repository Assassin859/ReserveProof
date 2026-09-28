import { expect } from "chai";
import { ethers } from "hardhat";
import { commitAndSample, deployFixture, twoLeaves, type Fixture } from "./helpers/fixture";

// 250 USDG (6 dp) per mTSLA (18 dp), in Morpho's 1e36 scale: 250 * 1e36 * 1e6 / 1e18.
const MORPHO_PRICE = 250n * 10n ** 24n;

async function gatedFixture(opts?: { publish?: boolean }) {
  const f = await deployFixture();
  if (opts?.publish ?? true) {
    await commitAndSample(f, twoLeaves(f.userA.address, f.userB.address));
  }
  const base = await (await ethers.getContractFactory("FixedPriceMorphoOracle")).deploy(MORPHO_PRICE);
  const gated = await (await ethers.getContractFactory("SolvencyGatedMorphoOracle")).deploy(
    await base.getAddress(),
    await f.oracle.getAddress(),
    f.custodianId,
    await f.stock.getAddress()
  );
  return { f, base, gated };
}

async function drain(f: Fixture) {
  await f.stock
    .connect(f.wallet1)
    .transfer(f.operator.address, await f.stock.balanceOf(f.wallet1.address));
}

describe("SolvencyGatedMorphoOracle", function () {
  it("forwards the base Morpho price while the custodian is solvent", async function () {
    const { gated } = await gatedFixture();
    expect(await gated.price()).to.equal(MORPHO_PRICE);
  });

  it("reverts with LIVE_SHORT instead of returning a price when reserves are drained", async function () {
    const { f, gated } = await gatedFixture();
    await drain(f);
    await expect(gated.price()).to.be.revertedWithCustomError(gated, "Insolvent").withArgs(6);
  });

  it("reverts with NO_EPOCH before anything is published", async function () {
    const { gated } = await gatedFixture({ publish: false });
    await expect(gated.price()).to.be.revertedWithCustomError(gated, "Insolvent").withArgs(1);
  });

  it("goes STALE after maxOracleAge and resumes pricing with a fresh epoch", async function () {
    const { f, gated } = await gatedFixture();
    await ethers.provider.send("evm_increaseTime", [8 * 24 * 3600]);
    await ethers.provider.send("evm_mine", []);
    await expect(gated.price()).to.be.revertedWithCustomError(gated, "Insolvent").withArgs(2);
    await commitAndSample(f, twoLeaves(f.userA.address, f.userB.address), 2);
    expect(await gated.price()).to.equal(MORPHO_PRICE);
  });

  it("exposes its wiring for integrators to audit", async function () {
    const { f, base, gated } = await gatedFixture();
    expect(await gated.baseOracle()).to.equal(await base.getAddress());
    expect(await gated.solvencyOracle()).to.equal(await f.oracle.getAddress());
    expect(await gated.custodianId()).to.equal(f.custodianId);
    expect(await gated.asset()).to.equal(await f.stock.getAddress());
  });

  it("rejects zero addresses and a zero fixed price", async function () {
    const { f, base } = await gatedFixture({ publish: false });
    const Gated = await ethers.getContractFactory("SolvencyGatedMorphoOracle");
    const oracle = await f.oracle.getAddress();
    const stock = await f.stock.getAddress();
    await expect(Gated.deploy(ethers.ZeroAddress, oracle, f.custodianId, stock)).to.be.revertedWithCustomError(
      Gated,
      "ZeroAddress"
    );
    await expect(
      Gated.deploy(await base.getAddress(), oracle, f.custodianId, ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(Gated, "ZeroAddress");
    await expect(
      Gated.deploy(await base.getAddress(), ethers.ZeroAddress, f.custodianId, stock)
    ).to.be.revertedWithCustomError(Gated, "ZeroOracle");
    const Fixed = await ethers.getContractFactory("FixedPriceMorphoOracle");
    await expect(Fixed.deploy(0)).to.be.revertedWithCustomError(Fixed, "ZeroPrice");
  });
});
