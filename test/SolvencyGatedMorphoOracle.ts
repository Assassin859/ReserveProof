import { expect } from "chai";
import { ethers } from "hardhat";
import { commitAndSample, deployFixture, twoLeaves, type Fixture } from "./helpers/fixture";

// 250 USDG (6 dp) per mTSLA (18 dp), in Morpho's 1e36 scale: 250 * 1e36 * 1e6 / 1e18.
const MORPHO_PRICE = 250n * 10n ** 24n;
const MAX_FREEZE = 72 * 3600;
const POKE_GAP = 6 * 3600;
const POST_CAP_BPS = 5000;

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
    MAX_FREEZE,
    POKE_GAP,
    POST_CAP_BPS
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

  it("blocks before the first epoch (NO_EPOCH)", async function () {
    const { gated } = await gatedFixture({ publish: false });
    await expect(gated.price()).to.be.revertedWithCustomError(gated, "Insolvent").withArgs(1);
  });

  it("blocks a drain hidden behind STALE (status reports only the first failing check)", async function () {
    const { f, gated } = await gatedFixture();
    await advance(8 * 24 * 3600);
    await drain(f);
    expect((await f.oracle.status(f.custodianId, await f.stock.getAddress())).reason).to.equal(2);
    await expect(gated.price()).to.be.revertedWithCustomError(gated, "Insolvent").withArgs(2);
  });

  it("after a continuously poked incident lasts maxFreeze, prices at the post-cap discount", async function () {
    const { f, gated } = await gatedFixture();
    await drain(f);
    await expect(gated.poke()).to.emit(gated, "FreezeStarted");
    for (let t = 5 * 3600; t < MAX_FREEZE; t += 5 * 3600) {
      await advance(5 * 3600);
      await expect(gated.poke()).to.emit(gated, "FreezeExtended");
    }
    const [, startedAt, capEndsAt] = await gated.freezeState();
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    await advance(Number(capEndsAt - now) - 5);
    await expect(gated.price()).to.be.revertedWithCustomError(gated, "Insolvent").withArgs(6);
    await advance(5);
    expect(await gated.price()).to.equal((MORPHO_PRICE * BigInt(POST_CAP_BPS)) / 10_000n);
    expect(await gated.freezeStartedAt()).to.equal(startedAt);
  });

  it("voids a clock nobody poked within maxPokeGap, so the next failing poke starts a new incident", async function () {
    const { f, gated } = await gatedFixture();
    await drain(f);
    await gated.poke();
    const first = await gated.freezeStartedAt();
    await advance(MAX_FREEZE);
    expect((await gated.freezeState())[0]).to.equal(false);
    await expect(gated.price()).to.be.revertedWithCustomError(gated, "Insolvent").withArgs(6);
    await expect(gated.poke()).to.emit(gated, "FreezeStarted");
    expect(await gated.freezeStartedAt()).to.be.greaterThan(first);
  });

  it("exposes its wiring and policy for integrators to audit", async function () {
    const { f, base, gated } = await gatedFixture();
    expect(await gated.baseOracle()).to.equal(await base.getAddress());
    expect(await gated.solvencyOracle()).to.equal(await f.oracle.getAddress());
    expect(await gated.custodianId()).to.equal(f.custodianId);
    expect(await gated.asset()).to.equal(await f.stock.getAddress());
    expect(await gated.maxFreeze()).to.equal(MAX_FREEZE);
    expect(await gated.maxPokeGap()).to.equal(POKE_GAP);
    expect(await gated.postCapBps()).to.equal(POST_CAP_BPS);
  });

  it("rejects zero addresses, bad freeze parameters and a zero fixed price", async function () {
    const { f, base } = await gatedFixture({ publish: false });
    const Gated = await ethers.getContractFactory("SolvencyGatedMorphoOracle");
    const oracle = await f.oracle.getAddress();
    const stock = await f.stock.getAddress();
    const baseAddr = await base.getAddress();
    const cid = f.custodianId;
    await expect(
      Gated.deploy(ethers.ZeroAddress, oracle, cid, stock, MAX_FREEZE, POKE_GAP, POST_CAP_BPS)
    ).to.be.revertedWithCustomError(Gated, "ZeroAddress");
    await expect(
      Gated.deploy(baseAddr, oracle, cid, ethers.ZeroAddress, MAX_FREEZE, POKE_GAP, POST_CAP_BPS)
    ).to.be.revertedWithCustomError(Gated, "ZeroAddress");
    await expect(
      Gated.deploy(baseAddr, ethers.ZeroAddress, cid, stock, MAX_FREEZE, POKE_GAP, POST_CAP_BPS)
    ).to.be.revertedWithCustomError(Gated, "ZeroOracle");
    await expect(Gated.deploy(baseAddr, oracle, cid, stock, 0, POKE_GAP, POST_CAP_BPS)).to.be.revertedWithCustomError(
      Gated,
      "ZeroMaxFreeze"
    );
    await expect(
      Gated.deploy(baseAddr, oracle, cid, stock, MAX_FREEZE, MAX_FREEZE, POST_CAP_BPS)
    ).to.be.revertedWithCustomError(Gated, "BadPokeGap");
    await expect(Gated.deploy(baseAddr, oracle, cid, stock, MAX_FREEZE, POKE_GAP, 0)).to.be.revertedWithCustomError(
      Gated,
      "BadPostCapBps"
    );
    const Fixed = await ethers.getContractFactory("FixedPriceMorphoOracle");
    await expect(Fixed.deploy(0)).to.be.revertedWithCustomError(Fixed, "ZeroPrice");
  });
});
