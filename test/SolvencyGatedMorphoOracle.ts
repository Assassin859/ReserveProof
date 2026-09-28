import { expect } from "chai";
import { ethers } from "hardhat";
import { commitAndSample, deployFixture, twoLeaves, type Fixture } from "./helpers/fixture";

// 250 USDG (6 dp) per mTSLA (18 dp), in Morpho's 1e36 scale: 250 * 1e36 * 1e6 / 1e18.
const MORPHO_PRICE = 250n * 10n ** 24n;
const MAX_FREEZE = 72 * 3600;
// LIVE_SHORT (6) | UNDERCOLLATERALIZED (5) | DISPUTED (3) | EXIT_DEFAULT (8)
const DEFAULT_MASK = (1 << 6) | (1 << 5) | (1 << 3) | (1 << 8);

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
    await f.stock.getAddress(),
    DEFAULT_MASK,
    MAX_FREEZE
  );
  return { f, base, gated };
}

async function drain(f: Fixture) {
  await f.stock
    .connect(f.wallet1)
    .transfer(f.operator.address, await f.stock.balanceOf(f.wallet1.address));
}

async function advance(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
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

  it("keeps pricing before the first epoch (NO_EPOCH is not evidence of a shortfall)", async function () {
    const { gated } = await gatedFixture({ publish: false });
    expect(await gated.price()).to.equal(MORPHO_PRICE);
  });

  it("keeps pricing when the proof goes STALE, so underwater loans stay liquidatable", async function () {
    const { f, gated } = await gatedFixture();
    await advance(8 * 24 * 3600);
    expect((await f.oracle.status(f.custodianId, await f.stock.getAddress())).reason).to.equal(2);
    expect(await gated.price()).to.equal(MORPHO_PRICE);
  });

  it("freezes for at most maxFreeze after a poke, then prices again", async function () {
    const { f, gated } = await gatedFixture();
    await drain(f);
    await expect(gated.poke()).to.emit(gated, "FreezeStarted");
    await advance(MAX_FREEZE - 10);
    await expect(gated.price()).to.be.revertedWithCustomError(gated, "Insolvent").withArgs(6);
    await advance(10);
    expect(await gated.price()).to.equal(MORPHO_PRICE);
  });

  it("exposes its wiring and policy for integrators to audit", async function () {
    const { f, base, gated } = await gatedFixture();
    expect(await gated.baseOracle()).to.equal(await base.getAddress());
    expect(await gated.solvencyOracle()).to.equal(await f.oracle.getAddress());
    expect(await gated.custodianId()).to.equal(f.custodianId);
    expect(await gated.asset()).to.equal(await f.stock.getAddress());
    expect(await gated.blockingReasons()).to.equal(await gated.DEFAULT_BLOCKING_REASONS());
    expect(await gated.maxFreeze()).to.equal(MAX_FREEZE);
    expect(await gated.blocks(6)).to.equal(true);
    expect(await gated.blocks(2)).to.equal(false);
  });

  it("rejects zero addresses, a zero freeze cap and a zero fixed price", async function () {
    const { f, base } = await gatedFixture({ publish: false });
    const Gated = await ethers.getContractFactory("SolvencyGatedMorphoOracle");
    const oracle = await f.oracle.getAddress();
    const stock = await f.stock.getAddress();
    const baseAddr = await base.getAddress();
    await expect(
      Gated.deploy(ethers.ZeroAddress, oracle, f.custodianId, stock, DEFAULT_MASK, MAX_FREEZE)
    ).to.be.revertedWithCustomError(Gated, "ZeroAddress");
    await expect(
      Gated.deploy(baseAddr, oracle, f.custodianId, ethers.ZeroAddress, DEFAULT_MASK, MAX_FREEZE)
    ).to.be.revertedWithCustomError(Gated, "ZeroAddress");
    await expect(
      Gated.deploy(baseAddr, ethers.ZeroAddress, f.custodianId, stock, DEFAULT_MASK, MAX_FREEZE)
    ).to.be.revertedWithCustomError(Gated, "ZeroOracle");
    await expect(Gated.deploy(baseAddr, oracle, f.custodianId, stock, DEFAULT_MASK, 0)).to.be.revertedWithCustomError(
      Gated,
      "ZeroMaxFreeze"
    );
    const Fixed = await ethers.getContractFactory("FixedPriceMorphoOracle");
    await expect(Fixed.deploy(0)).to.be.revertedWithCustomError(Fixed, "ZeroPrice");
  });
});
