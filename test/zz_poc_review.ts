/**
 * Regression PoCs for the security review findings.
 * Each test asserts the FIXED behavior (attack path must revert / fail-closed).
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { buildSortedTree } from "./helpers/merkle";
import {
  commitAndSample,
  deployFixture,
  signBalanceStatement,
  twoLeaves,
} from "./helpers/fixture";

describe("zz_poc_review — security fixes", function () {
  it("1. slash cannot drain another custodian's bond", async function () {
    const f = await deployFixture();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { proofs, asset } = await commitAndSample(f, leaves);

    // Victim custodian with bond
    const victimId = ethers.id("victim");
    await f.registry.registerCustodian(victimId, f.owner.address, 3600);
    await f.exitRight.connect(f.owner).setBondConfig(victimId, 3600, 1_000_000n, 10_000_000n);
    await f.usdg.mint(f.owner.address, 5_000_000n);
    await f.usdg.connect(f.owner).approve(await f.exitRight.getAddress(), 5_000_000n);
    await f.exitRight.connect(f.owner).postBond(victimId, 5_000_000n);

    // Attacker custodian (kopi) opens a claim then tries slash with victim id (old API).
    await f.exitRight.connect(f.operator).setBondConfig(f.custodianId, 3600, 1_000_000n, 10_000_000n);
    await f.usdg.connect(f.operator).approve(await f.exitRight.getAddress(), 5_000_000n);
    await f.usdg.mint(f.operator.address, 5_000_000n);
    await f.exitRight.connect(f.operator).postBond(f.custodianId, 5_000_000n);

    const amount = ethers.parseEther("100");
    const proof = proofs.get(f.userA.address.toLowerCase())!;
    await f.exitRight.connect(f.userA).openClaim(f.custodianId, asset, amount, proof);

    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);

    const victimBondBefore = await f.exitRight.bondBalance(victimId);
    await f.exitRight.slash(0n); // claim belongs to kopi
    expect(await f.exitRight.bondBalance(victimId)).to.equal(victimBondBefore);
    expect(await f.exitRight.hasExitDefault(f.custodianId, asset)).to.equal(true);
    expect(await f.exitRight.hasExitDefault(victimId, asset)).to.equal(false);
  });

  it("2. duplicate sample wallets rejected (strictly increasing)", async function () {
    const f = await deployFixture();
    const asset = await f.stock.getAddress();
    await expect(
      f.sampler
        .connect(f.operator)
        .setSampleWallets(f.custodianId, asset, [f.wallet1.address, f.wallet1.address])
    ).to.be.revertedWithCustomError(f.sampler, "UnsortedWallets");
  });

  it("3. allocation vector must sum to totalLiability (no 1-wei freeload)", async function () {
    const f = await deployFixture();
    const asset = await f.stock.getAddress();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { root, total } = buildSortedTree(f.custodianId, asset, 1, leaves);

    await expect(
      f.ledger
        .connect(f.operator)
        .commitEpoch(
          f.custodianId,
          asset,
          1,
          root,
          total,
          [f.chainId],
          [1n], // 1 wei of total
          ethers.parseEther("1"),
          0
        )
    ).to.be.revertedWithCustomError(f.ledger, "BadAllocation");

    // Dual-chain style: must include local chain and sum to total
    await f.ledger
      .connect(f.operator)
      .commitEpoch(
        f.custodianId,
        asset,
        1,
        root,
        total,
        [f.chainId, 421614],
        [total / 2n, total - total / 2n],
        ethers.parseEther("1"),
        0
      );
    const ep = await f.ledger.getEpoch(f.custodianId, asset, 1);
    expect(ep.allocation).to.equal(total / 2n);
  });

  it("4. setExitRight is owner-only and one-shot", async function () {
    const f = await deployFixture();
    await expect(
      f.oracle.connect(f.userA).setExitRight(f.userA.address)
    ).to.be.revertedWithCustomError(f.oracle, "OwnableUnauthorizedAccount");
    await expect(f.oracle.setExitRight(await f.exitRight.getAddress())).to.be.revertedWithCustomError(
      f.oracle,
      "ExitRightAlreadySet"
    );
  });

  it("5. operator cannot weaken asset config after first set", async function () {
    const f = await deployFixture();
    const asset = await f.stock.getAddress();
    await expect(
      f.assetConfig.connect(f.operator).setAssetConfig(
        f.custodianId,
        asset,
        asset,
        f.chainId,
        true,
        0,
        10300,
        0, // try disable staleness
        2,
        1
      )
    ).to.be.revertedWithCustomError(f.assetConfig, "NotOperator");

    // Owner cannot set maxOracleAge to 0 once enabled
    await expect(
      f.assetConfig.connect(f.owner).setAssetConfig(
        f.custodianId,
        asset,
        asset,
        f.chainId,
        true,
        0,
        10300,
        0,
        2,
        1
      )
    ).to.be.revertedWithCustomError(f.assetConfig, "PolicyWeakened");
  });

  it("6. finalizeWalletRemoval requires initiate (readyAt != 0)", async function () {
    const f = await deployFixture();
    await expect(
      f.registry.connect(f.operator).finalizeWalletRemoval(f.custodianId, f.chainId, f.wallet1.address)
    ).to.be.revertedWithCustomError(f.registry, "RemovalNotReady");
  });

  it("7. removed wallets stop counting toward live reserves", async function () {
    const f = await deployFixture({ minSamples: 1, maxOracleAge: 7 * 24 * 3600 });
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { asset } = await commitAndSample(f, leaves);

    const before = await f.sampler.liveReserves(f.custodianId, asset);
    expect(before).to.be.gt(0n);

    await f.registry.connect(f.operator).initiateWalletRemoval(f.custodianId, f.chainId, f.wallet1.address);
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
    await f.registry.connect(f.operator).finalizeWalletRemoval(f.custodianId, f.chainId, f.wallet1.address);

    const after = await f.sampler.liveReserves(f.custodianId, asset);
    expect(after).to.equal(0n);
  });

  it("8. same signed statement cannot reopen dispute after clear", async function () {
    const f = await deployFixture();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { proofs, asset } = await commitAndSample(f, leaves);
    const proved = ethers.parseEther("100");
    const stated = ethers.parseEther("150");
    const proof = proofs.get(f.userA.address.toLowerCase())!;
    const sig = await signBalanceStatement(
      f.disputes,
      f.operator,
      f.custodianId,
      asset,
      1,
      f.userA.address,
      stated
    );

    await f.disputes.openMismatchDispute(
      f.custodianId,
      asset,
      1,
      f.userA.address,
      proved,
      stated,
      sig,
      proof
    );

    // Matching epoch must be NEWER than disputed epoch
    const leaves2 = twoLeaves(f.userA.address, f.userB.address, "150", "200");
    const built = buildSortedTree(f.custodianId, asset, 2, leaves2);
    await f.ledger
      .connect(f.operator)
      .commitEpoch(
        f.custodianId,
        asset,
        2,
        built.root,
        built.total,
        [f.chainId],
        [built.total],
        ethers.parseEther("1"),
        0
      );
    // Mint enough + resample for epoch 2 not required for markMatching
    const matchProof = built.proofs.get(f.userA.address.toLowerCase())!;
    await f.disputes
      .connect(f.operator)
      .markMatchingEpoch(f.custodianId, asset, 2, matchProof);

    await expect(
      f.disputes.connect(f.operator).markMatchingEpoch(f.custodianId, asset, 1, proof)
    ).to.be.revertedWithCustomError(f.disputes, "NotNewerEpoch");

    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
    await f.disputes.clearDispute(f.custodianId, asset);

    await expect(
      f.disputes.openMismatchDispute(
        f.custodianId,
        asset,
        1,
        f.userA.address,
        proved,
        stated,
        sig,
        proof
      )
    ).to.be.revertedWithCustomError(f.disputes, "StatementUsed");
  });

  it("9. bondReserved is frozen — zeroing maxBondPerClaim after open fails while in flight", async function () {
    const f = await deployFixture();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { proofs, asset } = await commitAndSample(f, leaves);

    await f.exitRight.connect(f.operator).setBondConfig(f.custodianId, 3600, 1_000_000n, 10_000_000n);
    await f.usdg.mint(f.operator.address, 5_000_000n);
    await f.usdg.connect(f.operator).approve(await f.exitRight.getAddress(), 5_000_000n);
    await f.exitRight.connect(f.operator).postBond(f.custodianId, 5_000_000n);

    const amount = ethers.parseEther("100");
    const proof = proofs.get(f.userA.address.toLowerCase())!;
    await f.exitRight.connect(f.userA).openClaim(f.custodianId, asset, amount, proof);

    await expect(
      f.exitRight.connect(f.operator).setBondConfig(f.custodianId, 3600, 1n, 10_000_000n)
    ).to.be.revertedWithCustomError(f.exitRight, "BadConfig");

    const claim = await f.exitRight.claims(0n);
    expect(claim.bondReserved).to.equal(1_000_000n);

    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
    const before = await f.usdg.balanceOf(f.userA.address);
    await f.exitRight.slash(0n);
    expect(await f.usdg.balanceOf(f.userA.address)).to.equal(before + 1_000_000n);
  });
});
