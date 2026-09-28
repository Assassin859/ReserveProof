import { expect } from "chai";
import { ethers } from "hardhat";
import { commitAndSample, deployFixture, twoLeaves, type Fixture } from "./helpers/fixture";

const PRICE = 250_000_000n; // 250 USDG per whole mTSLA
const LTV_BPS = 5000;
const USDG = (n: number) => BigInt(n) * 1_000_000n;
const TSLA = (n: string) => ethers.parseEther(n);

async function vaultFixture(opts?: { publish?: boolean }) {
  const f = await deployFixture();
  if (opts?.publish ?? true) {
    await commitAndSample(f, twoLeaves(f.userA.address, f.userB.address));
  }
  const Vault = await ethers.getContractFactory("GuardedLendingVault");
  const vault = await Vault.deploy(
    await f.oracle.getAddress(),
    f.custodianId,
    await f.stock.getAddress(),
    await f.usdg.getAddress(),
    PRICE,
    LTV_BPS
  );
  const vaultAddr = await vault.getAddress();

  const lender = f.operator;
  await f.usdg.connect(lender).approve(vaultAddr, ethers.MaxUint256);
  await vault.connect(lender).supply(USDG(10_000));

  const borrower = f.userC;
  await f.stock.mint(borrower.address, TSLA("10"));
  await f.stock.connect(borrower).approve(vaultAddr, ethers.MaxUint256);
  await f.usdg.connect(borrower).approve(vaultAddr, ethers.MaxUint256);
  await vault.connect(borrower).depositCollateral(TSLA("10"));

  return { f, vault, lender, borrower };
}

async function drain(f: Fixture) {
  await f.stock
    .connect(f.wallet1)
    .transfer(f.operator.address, await f.stock.balanceOf(f.wallet1.address));
}

describe("GuardedLendingVault (SolvencyGuard)", function () {
  it("borrows up to LTV, repays and withdraws collateral while solvent", async function () {
    const { f, vault, borrower } = await vaultFixture();
    // 10 mTSLA × 250 USDG × 50% = 1,250 USDG
    expect(await vault.maxBorrow(borrower.address)).to.equal(USDG(1250));

    await vault.connect(borrower).borrow(USDG(1000));
    expect(await vault.debtOf(borrower.address)).to.equal(USDG(1000));
    expect(await vault.availableLiquidity()).to.equal(USDG(9000));

    await vault.connect(borrower).repay(USDG(5000)); // capped at outstanding debt
    expect(await vault.debtOf(borrower.address)).to.equal(0n);
    expect(await vault.availableLiquidity()).to.equal(USDG(10_000));

    await vault.connect(borrower).withdrawCollateral(TSLA("10"));
    expect(await f.stock.balanceOf(borrower.address)).to.equal(TSLA("10"));
  });

  it("enforces LTV and liquidity", async function () {
    const { vault, borrower } = await vaultFixture();
    await expect(vault.connect(borrower).borrow(USDG(1251)))
      .to.be.revertedWithCustomError(vault, "ExceedsLtv")
      .withArgs(USDG(1250), USDG(1251));

    await vault.connect(borrower).borrow(USDG(1250));
    await expect(vault.connect(borrower).withdrawCollateral(TSLA("1")))
      .to.be.revertedWithCustomError(vault, "ExceedsLtv");
  });

  it("caps borrowing at available liquidity", async function () {
    const { f, vault, borrower } = await vaultFixture();
    await f.stock.mint(borrower.address, TSLA("1000"));
    await vault.connect(borrower).depositCollateral(TSLA("1000"));
    await expect(vault.connect(borrower).borrow(USDG(10_001)))
      .to.be.revertedWithCustomError(vault, "InsufficientLiquidity")
      .withArgs(USDG(10_000), USDG(10_001));
  });

  it("blocks borrow and collateral withdrawal with the oracle reason when reserves are drained", async function () {
    const { f, vault, borrower } = await vaultFixture();
    await vault.connect(borrower).borrow(USDG(500));
    await drain(f);

    await expect(vault.connect(borrower).borrow(USDG(1)))
      .to.be.revertedWithCustomError(vault, "Insolvent")
      .withArgs(6); // LIVE_SHORT
    await expect(vault.connect(borrower).withdrawCollateral(TSLA("1")))
      .to.be.revertedWithCustomError(vault, "Insolvent")
      .withArgs(6);
  });

  it("never gates repay, adding collateral or lender withdrawals", async function () {
    const { f, vault, lender, borrower } = await vaultFixture();
    await vault.connect(borrower).borrow(USDG(500));
    await drain(f);

    await expect(vault.connect(borrower).repay(USDG(500)))
      .to.emit(vault, "Repaid")
      .withArgs(borrower.address, USDG(500));
    expect(await vault.debtOf(borrower.address)).to.equal(0n);

    await f.stock.mint(borrower.address, TSLA("1"));
    await expect(vault.connect(borrower).depositCollateral(TSLA("1"))).to.emit(
      vault,
      "CollateralDeposited"
    );

    await expect(vault.connect(lender).withdrawSupply(USDG(10_000))).to.emit(
      vault,
      "SupplyWithdrawn"
    );
  });

  it("lets a debt-free borrower withdraw collateral while insolvent, including 30 days later", async function () {
    const { f, vault, borrower } = await vaultFixture();
    await drain(f);
    await expect(vault.connect(borrower).borrow(USDG(1)))
      .to.be.revertedWithCustomError(vault, "Insolvent")
      .withArgs(6); // LIVE_SHORT
    await expect(vault.connect(borrower).withdrawCollateral(TSLA("4"))).to.emit(vault, "CollateralWithdrawn");

    await ethers.provider.send("evm_increaseTime", [30 * 24 * 3600]);
    await ethers.provider.send("evm_mine", []);
    const [ok] = await f.oracle.status(f.custodianId, await f.stock.getAddress());
    expect(ok).to.equal(false);
    await expect(vault.connect(borrower).withdrawCollateral(TSLA("6"))).to.emit(vault, "CollateralWithdrawn");
    expect(await vault.collateralOf(borrower.address)).to.equal(0n);
    expect(await f.stock.balanceOf(borrower.address)).to.equal(TSLA("10"));
  });

  it("de-risks while insolvent: blocked with debt, repay, then withdraw", async function () {
    const { f, vault, borrower } = await vaultFixture();
    await vault.connect(borrower).borrow(USDG(500));
    await drain(f);

    await expect(vault.connect(borrower).withdrawCollateral(TSLA("1")))
      .to.be.revertedWithCustomError(vault, "Insolvent")
      .withArgs(6);
    await vault.connect(borrower).repay(USDG(500));
    await expect(vault.connect(borrower).withdrawCollateral(TSLA("10")))
      .to.emit(vault, "CollateralWithdrawn")
      .withArgs(borrower.address, TSLA("10"));
  });

  it("fails closed before any epoch is published", async function () {
    const { vault, borrower } = await vaultFixture({ publish: false });
    await expect(vault.connect(borrower).borrow(USDG(1)))
      .to.be.revertedWithCustomError(vault, "Insolvent")
      .withArgs(1); // NO_EPOCH
  });

  it("fails closed when the proof goes stale and recovers with a fresh epoch", async function () {
    const { f, vault, borrower } = await vaultFixture();
    await ethers.provider.send("evm_increaseTime", [8 * 24 * 3600]);
    await ethers.provider.send("evm_mine", []);
    await expect(vault.connect(borrower).borrow(USDG(1)))
      .to.be.revertedWithCustomError(vault, "Insolvent")
      .withArgs(2); // STALE

    await commitAndSample(f, twoLeaves(f.userA.address, f.userB.address), 2);
    await expect(vault.connect(borrower).borrow(USDG(1))).to.emit(vault, "Borrowed");
  });

  it("rejects bad configuration", async function () {
    const f = await deployFixture();
    const Vault = await ethers.getContractFactory("GuardedLendingVault");
    const oracle = await f.oracle.getAddress();
    const stock = await f.stock.getAddress();
    const usdg = await f.usdg.getAddress();
    await expect(
      Vault.deploy(ethers.ZeroAddress, f.custodianId, stock, usdg, PRICE, LTV_BPS)
    ).to.be.revertedWithCustomError(Vault, "ZeroOracle");
    await expect(
      Vault.deploy(oracle, f.custodianId, stock, stock, PRICE, LTV_BPS)
    ).to.be.revertedWithCustomError(Vault, "BadConfig");
    await expect(
      Vault.deploy(oracle, f.custodianId, stock, usdg, PRICE, 10_000)
    ).to.be.revertedWithCustomError(Vault, "BadConfig");
    await expect(
      Vault.deploy(oracle, f.custodianId, stock, usdg, 0, LTV_BPS)
    ).to.be.revertedWithCustomError(Vault, "BadConfig");
  });
});
