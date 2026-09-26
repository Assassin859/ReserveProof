/**
 * Challenge grief / per-user slots / owner assetId / overdue insolvency.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import {
  buildSortedTree,
  leafHash,
  neighboursFor,
  nodeHash,
  type Leaf,
  type ProofNode,
} from "./helpers/merkle";
import {
  allocationCommitment,
  approveChallengeBond,
  CHALLENGE_BOND,
  CHALLENGE_WINDOW,
  commitAndSample,
  commitSigned,
  deployFixture,
  signBalanceStatement,
  signEpochCommitment,
  TEST_ASSET_ID,
  twoLeaves,
} from "./helpers/fixture";

function buildLopsidedTree(
  custodianId: string,
  asset: string,
  epochId: number,
  leaves: Leaf[]
): { root: string; total: bigint; proofs: Map<string, ProofNode[]>; leafCount: number } {
  const leafCount = leaves.length;
  const sorted = [...leaves].sort((a, b) =>
    a.user.toLowerCase() < b.user.toLowerCase() ? -1 : 1
  );
  const hashed = sorted.map((l) => ({
    user: l.user,
    amount: l.amount,
    hash: leafHash(custodianId, asset, epochId, leafCount, l.user, l.amount),
  }));

  const n01 = {
    hash: nodeHash(hashed[0].hash, hashed[0].amount, hashed[1].hash, hashed[1].amount),
    sum: hashed[0].amount + hashed[1].amount,
  };
  const n012 = {
    hash: nodeHash(n01.hash, n01.sum, hashed[2].hash, hashed[2].amount),
    sum: n01.sum + hashed[2].amount,
  };
  const rootNode = {
    hash: nodeHash(n012.hash, n012.sum, hashed[3].hash, hashed[3].amount),
    sum: n012.sum + hashed[3].amount,
  };

  const proofs = new Map<string, ProofNode[]>();
  proofs.set(hashed[3].user.toLowerCase(), [{ hash: n012.hash, sum: n012.sum, isLeft: true }]);
  proofs.set(hashed[2].user.toLowerCase(), [
    { hash: n01.hash, sum: n01.sum, isLeft: true },
    { hash: hashed[3].hash, sum: hashed[3].amount, isLeft: false },
  ]);
  proofs.set(hashed[0].user.toLowerCase(), [
    { hash: hashed[1].hash, sum: hashed[1].amount, isLeft: false },
    { hash: hashed[2].hash, sum: hashed[2].amount, isLeft: false },
    { hash: hashed[3].hash, sum: hashed[3].amount, isLeft: false },
  ]);
  proofs.set(hashed[1].user.toLowerCase(), [
    { hash: hashed[0].hash, sum: hashed[0].amount, isLeft: true },
    { hash: hashed[2].hash, sum: hashed[2].amount, isLeft: false },
    { hash: hashed[3].hash, sum: hashed[3].amount, isLeft: false },
  ]);
  return { root: rootNode.hash, total: rootNode.sum, proofs, leafCount };
}

function buildFakeSlotTree(
  custodianId: string,
  asset: string,
  epochId: number,
  realLeaves: Leaf[]
): {
  root: string;
  total: bigint;
  proofs: Map<string, ProofNode[]>;
  leafCount: number;
  sortedReal: Leaf[];
} {
  const leafCount = 4;
  const sortedReal = [...realLeaves].sort((a, b) =>
    a.user.toLowerCase() < b.user.toLowerCase() ? -1 : 1
  );
  const dummyHash = ethers.id("fake-slot");
  const dummySum = 1n;
  const real = sortedReal.map((l) => ({
    user: l.user,
    amount: l.amount,
    hash: leafHash(custodianId, asset, epochId, leafCount, l.user, l.amount),
  }));
  const n01 = {
    hash: nodeHash(dummyHash, dummySum, real[0].hash, real[0].amount),
    sum: dummySum + real[0].amount,
  };
  const n23 = {
    hash: nodeHash(real[1].hash, real[1].amount, real[2].hash, real[2].amount),
    sum: real[1].amount + real[2].amount,
  };
  const rootNode = {
    hash: nodeHash(n01.hash, n01.sum, n23.hash, n23.sum),
    sum: n01.sum + n23.sum,
  };
  const proofs = new Map<string, ProofNode[]>();
  proofs.set(real[0].user.toLowerCase(), [
    { hash: dummyHash, sum: dummySum, isLeft: true },
    { hash: n23.hash, sum: n23.sum, isLeft: false },
  ]);
  proofs.set(real[1].user.toLowerCase(), [
    { hash: real[2].hash, sum: real[2].amount, isLeft: false },
    { hash: n01.hash, sum: n01.sum, isLeft: true },
  ]);
  proofs.set(real[2].user.toLowerCase(), [
    { hash: real[1].hash, sum: real[1].amount, isLeft: true },
    { hash: n01.hash, sum: n01.sum, isLeft: true },
  ]);
  return { root: rootNode.hash, total: rootNode.sum, proofs, leafCount, sortedReal };
}

describe("zz_poc_review — challenge grief / assetId / overdue", function () {
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
        TEST_ASSET_ID,
        [f.chainId, 999999]
      )
    ).to.be.revertedWithCustomError(f.assetConfig, "NotOperator");
  });

  it("operator cannot choose assetId when allowlist already set", async function () {
    const f = await deployFixture();
    const Token = await ethers.getContractFactory("MockStockToken");
    const t2 = await Token.deploy("Z", "Z");
    const asset2 = await t2.getAddress();
    const otherId = ethers.id("OTHER");
    await f.assetConfig
      .connect(f.owner)
      .setAllocationChains(f.custodianId, asset2, f.chainId, TEST_ASSET_ID, [f.chainId]);

    // Operator configures token but stored assetId wins (OTHER ignored)
    await f.assetConfig.connect(f.operator).setAssetConfig(
      f.custodianId,
      asset2,
      asset2,
      f.chainId,
      true,
      0,
      10300,
      7 * 24 * 3600,
      2,
      1,
      otherId,
      []
    );
    const cfg = await f.assetConfig.getConfig(f.custodianId, asset2);
    expect(cfg.assetId).to.equal(TEST_ASSET_ID);
  });

  it("garbage root → user challenge → expire → disputed", async function () {
    const f = await deployFixture();
    const asset = await f.stock.getAddress();
    const garbageRoot = ethers.id("garbage");
    const total = ethers.parseEther("300");
    await commitSigned(f, asset, 1, garbageRoot, total, [f.chainId], [total], 2);
    await f.sampler.connect(f.operator).setSampleWallets(f.custodianId, asset, [f.wallet1.address]);
    await f.sampler.connect(f.operator).recordSample(f.custodianId, asset);
    await ethers.provider.send("evm_increaseTime", [2]);
    await ethers.provider.send("evm_mine", []);
    await f.sampler.connect(f.operator).recordSample(f.custodianId, asset);

    const stated = ethers.parseEther("100");
    const sig = await signBalanceStatement(
      f.disputes,
      f.operator,
      f.custodianId,
      asset,
      1,
      f.userA.address,
      stated
    );
    await approveChallengeBond(f, f.userA);
    await f.disputes
      .connect(f.userA)
      .challengeInclusion(f.custodianId, asset, 1, f.userA.address, stated, sig);

    await ethers.provider.send("evm_increaseTime", [CHALLENGE_WINDOW + 1]);
    await ethers.provider.send("evm_mine", []);
    await f.disputes.expireChallenge(f.custodianId, asset, f.userA.address);

    expect(await f.disputes.isDisputed(f.custodianId, asset)).to.equal(true);
    const [ok] = await f.oracle.isSolvent(f.custodianId, asset);
    expect(ok).to.equal(false);
  });

  it("wrong leafCount → challenge expire → disputed", async function () {
    const f = await deployFixture();
    const asset = await f.stock.getAddress();
    const leaves: Leaf[] = [
      { user: f.userA.address, amount: ethers.parseEther("10") },
      { user: f.userB.address, amount: ethers.parseEther("20") },
      { user: f.userC.address, amount: ethers.parseEther("30") },
      { user: f.userD.address, amount: ethers.parseEther("40") },
    ];
    const { root, total } = buildSortedTree(f.custodianId, asset, 1, leaves);
    await commitSigned(f, asset, 1, root, total, [f.chainId], [total], 2);

    const stated = leaves[0].amount;
    const sig = await signBalanceStatement(
      f.disputes,
      f.operator,
      f.custodianId,
      asset,
      1,
      leaves[0].user,
      stated
    );
    await approveChallengeBond(f, f.userA);
    await f.disputes
      .connect(f.userA)
      .challengeInclusion(f.custodianId, asset, 1, leaves[0].user, stated, sig);
    await ethers.provider.send("evm_increaseTime", [CHALLENGE_WINDOW + 1]);
    await ethers.provider.send("evm_mine", []);
    await f.disputes.expireChallenge(f.custodianId, asset, leaves[0].user);
    expect(await f.disputes.isDisputed(f.custodianId, asset)).to.equal(true);
  });

  it("omitted user challenge keeps statement; omission dispute still works", async function () {
    const f = await deployFixture();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { proofs, asset } = await commitAndSample(f, leaves);
    const sorted = [...leaves].sort((a, b) =>
      a.user.toLowerCase() < b.user.toLowerCase() ? -1 : 1
    );
    const omitted = f.userC.address;
    const stated = ethers.parseEther("50");
    const n = neighboursFor(sorted, omitted);
    const sig = await signBalanceStatement(
      f.disputes,
      f.operator,
      f.custodianId,
      asset,
      1,
      omitted,
      stated
    );

    // Operator cannot open challenge for omitted user
    await expect(
      f.disputes
        .connect(f.operator)
        .challengeInclusion(f.custodianId, asset, 1, omitted, stated, sig)
    ).to.be.revertedWithCustomError(f.disputes, "NotUser");

    await approveChallengeBond(f, f.userC);
    await f.disputes
      .connect(f.userC)
      .challengeInclusion(f.custodianId, asset, 1, omitted, stated, sig);

    // No answerOmission — statement still usable for omission dispute
    expect(f.disputes.interface.fragments.some((f) => "name" in f && f.name === "answerOmission")).to.equal(
      false
    );

    const leftProof = n.leftUser != null ? proofs.get(n.leftUser.toLowerCase())! : [];
    const rightProof = n.rightUser != null ? proofs.get(n.rightUser.toLowerCase())! : [];
    await f.disputes.openOmissionDispute(
      f.custodianId,
      asset,
      1,
      omitted,
      stated,
      sig,
      n.leftUser ?? ethers.ZeroAddress,
      n.leftAmount ?? 0n,
      leftProof,
      n.rightUser ?? ethers.ZeroAddress,
      n.rightAmount ?? 0n,
      rightProof
    );
    expect(await f.disputes.isDisputed(f.custodianId, asset)).to.equal(true);
  });

  it("challenge for user A does not block mismatch for user B", async function () {
    const f = await deployFixture();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { proofs, asset } = await commitAndSample(f, leaves);

    const sigA = await signBalanceStatement(
      f.disputes,
      f.operator,
      f.custodianId,
      asset,
      1,
      f.userA.address,
      leaves[0].amount
    );
    await approveChallengeBond(f, f.userA);
    await f.disputes
      .connect(f.userA)
      .challengeInclusion(f.custodianId, asset, 1, f.userA.address, leaves[0].amount, sigA);

    const statedB = leaves[1].amount + 1n;
    const sigB = await signBalanceStatement(
      f.disputes,
      f.operator,
      f.custodianId,
      asset,
      1,
      f.userB.address,
      statedB
    );
    await f.disputes.openMismatchDispute(
      f.custodianId,
      asset,
      1,
      f.userB.address,
      leaves[1].amount,
      statedB,
      sigB,
      proofs.get(f.userB.address.toLowerCase())!
    );
    expect(await f.disputes.isDisputed(f.custodianId, asset)).to.equal(true);
  });

  it("overdue challenge fails closed before expireChallenge", async function () {
    const f = await deployFixture();
    const asset = await f.stock.getAddress();
    const garbageRoot = ethers.id("garbage2");
    const total = ethers.parseEther("300");
    await commitSigned(f, asset, 1, garbageRoot, total, [f.chainId], [total], 2);
    await f.sampler.connect(f.operator).setSampleWallets(f.custodianId, asset, [f.wallet1.address]);
    await f.sampler.connect(f.operator).recordSample(f.custodianId, asset);
    await ethers.provider.send("evm_increaseTime", [2]);
    await ethers.provider.send("evm_mine", []);
    await f.sampler.connect(f.operator).recordSample(f.custodianId, asset);

    const stated = ethers.parseEther("100");
    const sig = await signBalanceStatement(
      f.disputes,
      f.operator,
      f.custodianId,
      asset,
      1,
      f.userA.address,
      stated
    );
    await approveChallengeBond(f, f.userA);
    await f.disputes
      .connect(f.userA)
      .challengeInclusion(f.custodianId, asset, 1, f.userA.address, stated, sig);

    await ethers.provider.send("evm_increaseTime", [CHALLENGE_WINDOW + 1]);
    await ethers.provider.send("evm_mine", []);

    expect(await f.disputes.hasOverdueChallenge(f.custodianId, asset)).to.equal(true);
    const status = await f.oracle.status(f.custodianId, asset);
    expect(status.ok).to.equal(false);
    expect(status.reason).to.equal(3); // DISPUTED
    expect(await f.disputes.isDisputed(f.custodianId, asset)).to.equal(false);
  });

  it("honest tree → answerInclusion clears challenge; solvent remains", async function () {
    const f = await deployFixture();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { proofs, asset } = await commitAndSample(f, leaves);
    const amount = leaves[0].amount;
    const sig = await signBalanceStatement(
      f.disputes,
      f.operator,
      f.custodianId,
      asset,
      1,
      leaves[0].user,
      amount
    );
    await approveChallengeBond(f, f.userA);
    await f.disputes
      .connect(f.userA)
      .challengeInclusion(f.custodianId, asset, 1, leaves[0].user, amount, sig);
    await f.disputes
      .connect(f.operator)
      .answerInclusion(
        f.custodianId,
        asset,
        leaves[0].user,
        proofs.get(leaves[0].user.toLowerCase())!
      );

    const ch = await f.disputes.challenges(f.custodianId, asset, leaves[0].user);
    expect(ch.open).to.equal(false);
    expect(await f.disputes.openChallengeCount(f.custodianId, asset)).to.equal(0n);
    await f.disputes.connect(f.userA).withdrawChallengeBond();
    const [ok] = await f.oracle.isSolvent(f.custodianId, asset);
    expect(ok).to.equal(true);
  });

  it("fake index-0 slot → challenge overdue insolvent", async function () {
    const f = await deployFixture();
    const asset = await f.stock.getAddress();
    const realLeaves: Leaf[] = [
      { user: f.userB.address, amount: ethers.parseEther("20") },
      { user: f.userC.address, amount: ethers.parseEther("30") },
      { user: f.userD.address, amount: ethers.parseEther("40") },
    ];
    const { root, total, leafCount, sortedReal } = buildFakeSlotTree(
      f.custodianId,
      asset,
      1,
      realLeaves
    );
    await commitSigned(f, asset, 1, root, total, [f.chainId], [total], leafCount);

    let victim = "";
    let victimSigner = f.userA;
    for (let i = 0; i < 500; i++) {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);
      if (w.address.toLowerCase() < sortedReal[0].user.toLowerCase()) {
        victim = w.address;
        // Fund and use userA to challenge only if victim == userA — need msg.sender == user.
        // Use a funded impersonation: connect as wallet after sending ETH from operator.
        await f.operator.sendTransaction({ to: w.address, value: ethers.parseEther("1") });
        victimSigner = w as typeof f.userA;
        await f.usdg.mint(w.address, CHALLENGE_BOND * 2n);
        break;
      }
    }
    expect(victim).to.not.equal("");

    const stated = ethers.parseEther("5");
    const sig = await signBalanceStatement(
      f.disputes,
      f.operator,
      f.custodianId,
      asset,
      1,
      victim,
      stated
    );
    await f.usdg.connect(victimSigner).approve(await f.disputes.getAddress(), CHALLENGE_BOND);
    await f.disputes
      .connect(victimSigner)
      .challengeInclusion(f.custodianId, asset, 1, victim, stated, sig);

    await ethers.provider.send("evm_increaseTime", [CHALLENGE_WINDOW + 1]);
    await ethers.provider.send("evm_mine", []);
    const [ok] = await f.oracle.isSolvent(f.custodianId, asset);
    expect(ok).to.equal(false);
  });

  it("malformed evidence burned after clear", async function () {
    const f = await deployFixture();
    const asset = await f.stock.getAddress();
    const leaves: Leaf[] = [
      { user: f.userA.address, amount: ethers.parseEther("10") },
      { user: f.userB.address, amount: ethers.parseEther("20") },
      { user: f.userC.address, amount: ethers.parseEther("30") },
      { user: f.userD.address, amount: ethers.parseEther("40") },
    ];
    const { root, total, proofs, leafCount } = buildLopsidedTree(f.custodianId, asset, 1, leaves);
    await commitSigned(f, asset, 1, root, total, [f.chainId], [total], leafCount);

    const sorted = [...leaves].sort((a, b) =>
      a.user.toLowerCase() < b.user.toLowerCase() ? -1 : 1
    );
    const shortLeaf = sorted[3];
    const shortProof = proofs.get(shortLeaf.user.toLowerCase())!;

    await f.disputes.openMalformedTreeDispute(
      f.custodianId,
      asset,
      1,
      shortLeaf.user,
      shortLeaf.amount,
      shortProof
    );

    const tree2 = buildSortedTree(f.custodianId, asset, 2, leaves);
    await commitSigned(f, asset, 2, tree2.root, tree2.total, [f.chainId], [tree2.total], tree2.leafCount);
    await f.disputes
      .connect(f.operator)
      .markMatchingEpoch(
        f.custodianId,
        asset,
        shortLeaf.user,
        2,
        tree2.proofs.get(shortLeaf.user.toLowerCase())!
      );
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
    await f.disputes.clearDispute(f.custodianId, asset, shortLeaf.user);

    await expect(
      f.disputes.openMalformedTreeDispute(
        f.custodianId,
        asset,
        1,
        shortLeaf.user,
        shortLeaf.amount,
        shortProof
      )
    ).to.be.revertedWithCustomError(f.disputes, "EvidenceUsed");
  });

  it("equivocation is permanent", async function () {
    const f = await deployFixture();
    const asset = await f.stock.getAddress();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { root, total, leafCount } = buildSortedTree(f.custodianId, asset, 1, leaves);
    await commitSigned(f, asset, 1, root, total, [f.chainId], [total], leafCount);

    const otherRoot = ethers.id("other-root");
    const otherTotal = total + 1n;
    const otherAlloc = allocationCommitment([f.chainId], [otherTotal]);
    const otherSig = await signEpochCommitment(
      f.operator,
      f.deploymentSalt,
      f.custodianId,
      f.assetId,
      1,
      otherRoot,
      otherTotal,
      otherAlloc,
      leafCount
    );

    await f.disputes.openEquivocationDispute(
      f.custodianId,
      asset,
      1,
      otherRoot,
      otherTotal,
      otherAlloc,
      leafCount,
      otherSig
    );
    expect(await f.disputes.isDisputed(f.custodianId, asset)).to.equal(true);
    expect(await f.disputes.equivocationPermanent(f.custodianId, asset)).to.equal(true);

    await expect(
      f.disputes
        .connect(f.operator)
        .markMatchingEpoch(f.custodianId, asset, f.userA.address, 2, [])
    ).to.be.revertedWithCustomError(f.disputes, "NoDispute");
    await expect(
      f.disputes.clearDispute(f.custodianId, asset, f.userA.address)
    ).to.be.revertedWithCustomError(f.disputes, "NoDispute");
  });

  it("EpochCommitment works across different local asset addresses with same owner assetId", async function () {
    const f = await deployFixture();
    const assetA = await f.stock.getAddress();
    const Token = await ethers.getContractFactory("MockStockToken");
    const stockB = await Token.deploy("Mock TSLA B", "mTSLAb");
    const assetB = await stockB.getAddress();
    await f.assetConfig
      .connect(f.owner)
      .setAllocationChains(f.custodianId, assetB, f.chainId, f.assetId, [f.chainId]);
    await f.assetConfig.connect(f.operator).setAssetConfig(
      f.custodianId,
      assetB,
      assetB,
      f.chainId,
      true,
      0,
      10300,
      7 * 24 * 3600,
      2,
      1,
      ethers.ZeroHash,
      []
    );

    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const treeA = buildSortedTree(f.custodianId, assetA, 1, leaves);
    const treeB = buildSortedTree(f.custodianId, assetB, 1, leaves);
    await commitSigned(f, assetA, 1, treeA.root, treeA.total, [f.chainId], [treeA.total], treeA.leafCount);

    const otherAlloc = allocationCommitment([f.chainId], [treeB.total]);
    const otherSig = await signEpochCommitment(
      f.operator,
      f.deploymentSalt,
      f.custodianId,
      f.assetId,
      1,
      treeB.root,
      treeB.total,
      otherAlloc,
      treeB.leafCount
    );
    await f.disputes.openEquivocationDispute(
      f.custodianId,
      assetA,
      1,
      treeB.root,
      treeB.total,
      otherAlloc,
      treeB.leafCount,
      otherSig
    );
    expect(await f.disputes.isDisputed(f.custodianId, assetA)).to.equal(true);
  });

  it("maxBondTotalInFlight must be at least 3x per-claim", async function () {
    const f = await deployFixture();
    await f.usdg.connect(f.operator).approve(await f.exitRight.getAddress(), 5_000_000n);
    await f.exitRight.connect(f.operator).postBond(f.custodianId, 5_000_000n);
    await expect(
      f.exitRight.connect(f.operator).setBondConfig(f.custodianId, 3600, 1_000_000n, 2_000_000n)
    ).to.be.revertedWithCustomError(f.exitRight, "BadConfig");
    await f.exitRight.connect(f.operator).setBondConfig(f.custodianId, 3600, 1_000_000n, 3_000_000n);
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

  it("answer burns statement — cannot re-challenge with same statement", async function () {
    const f = await deployFixture();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { proofs, asset } = await commitAndSample(f, leaves);
    const amount = leaves[0].amount;
    const sig = await signBalanceStatement(
      f.disputes,
      f.operator,
      f.custodianId,
      asset,
      1,
      f.userA.address,
      amount
    );
    await approveChallengeBond(f, f.userA);
    const before = await f.usdg.balanceOf(f.userA.address);
    await f.disputes
      .connect(f.userA)
      .challengeInclusion(f.custodianId, asset, 1, f.userA.address, amount, sig);
    expect(await f.usdg.balanceOf(f.userA.address)).to.equal(before - CHALLENGE_BOND);

    await f.disputes
      .connect(f.operator)
      .answerInclusion(f.custodianId, asset, f.userA.address, proofs.get(f.userA.address.toLowerCase())!);
    expect(await f.disputes.challengeRefunds(f.userA.address)).to.equal(CHALLENGE_BOND);
    await f.disputes.connect(f.userA).withdrawChallengeBond();
    expect(await f.usdg.balanceOf(f.userA.address)).to.equal(before);
    expect(await f.disputes.openChallengeCount(f.custodianId, asset)).to.equal(0n);

    await approveChallengeBond(f, f.userA);
    await expect(
      f.disputes
        .connect(f.userA)
        .challengeInclusion(f.custodianId, asset, 1, f.userA.address, amount, sig)
    ).to.be.revertedWithCustomError(f.disputes, "StatementUsed");
  });

  it("challenge without USDG allowance reverts; bond refunded on expire via withdraw", async function () {
    const f = await deployFixture();
    const asset = await f.stock.getAddress();
    const garbageRoot = ethers.id("garbage-bond");
    const total = ethers.parseEther("300");
    await commitSigned(f, asset, 1, garbageRoot, total, [f.chainId], [total], 2);

    const stated = ethers.parseEther("100");
    const sig = await signBalanceStatement(
      f.disputes,
      f.operator,
      f.custodianId,
      asset,
      1,
      f.userA.address,
      stated
    );
    await expect(
      f.disputes
        .connect(f.userA)
        .challengeInclusion(f.custodianId, asset, 1, f.userA.address, stated, sig)
    ).to.be.reverted;

    await approveChallengeBond(f, f.userA);
    const before = await f.usdg.balanceOf(f.userA.address);
    await f.disputes
      .connect(f.userA)
      .challengeInclusion(f.custodianId, asset, 1, f.userA.address, stated, sig);
    await ethers.provider.send("evm_increaseTime", [CHALLENGE_WINDOW + 1]);
    await ethers.provider.send("evm_mine", []);
    await f.disputes.expireChallenge(f.custodianId, asset, f.userA.address);
    expect(await f.disputes.challengeRefunds(f.userA.address)).to.equal(CHALLENGE_BOND);
    await f.disputes.connect(f.userA).withdrawChallengeBond();
    expect(await f.usdg.balanceOf(f.userA.address)).to.equal(before);
    expect(await f.disputes.openChallengeCount(f.custodianId, asset)).to.equal(0n);
  });

  it("open index shrinks on answer; FIFO head advances", async function () {
    const f = await deployFixture();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { proofs, asset } = await commitAndSample(f, leaves);

    const amount = leaves[0].amount;
    const sigA = await signBalanceStatement(
      f.disputes,
      f.operator,
      f.custodianId,
      asset,
      1,
      f.userA.address,
      amount
    );
    const sigB = await signBalanceStatement(
      f.disputes,
      f.operator,
      f.custodianId,
      asset,
      1,
      f.userB.address,
      leaves[1].amount
    );
    await approveChallengeBond(f, f.userA);
    await approveChallengeBond(f, f.userB);
    await f.disputes
      .connect(f.userA)
      .challengeInclusion(f.custodianId, asset, 1, f.userA.address, amount, sigA);
    await f.disputes
      .connect(f.userB)
      .challengeInclusion(f.custodianId, asset, 1, f.userB.address, leaves[1].amount, sigB);
    expect(await f.disputes.openChallengeCount(f.custodianId, asset)).to.equal(2n);
    expect(await f.disputes.challengeHead(f.custodianId, asset)).to.equal(0n);

    await f.disputes
      .connect(f.operator)
      .answerInclusion(f.custodianId, asset, f.userA.address, proofs.get(f.userA.address.toLowerCase())!);
    expect(await f.disputes.openChallengeCount(f.custodianId, asset)).to.equal(1n);
    expect(await f.disputes.challengeHead(f.custodianId, asset)).to.equal(1n);

    await f.disputes
      .connect(f.operator)
      .answerInclusion(f.custodianId, asset, f.userB.address, proofs.get(f.userB.address.toLowerCase())!);
    expect(await f.disputes.openChallengeCount(f.custodianId, asset)).to.equal(0n);
    expect(await f.disputes.challengeHead(f.custodianId, asset)).to.equal(2n);

    const status = await f.oracle.status(f.custodianId, asset);
    expect(status.ok).to.equal(true);
  });

  it("no challenge cap — more than 32 open challenges allowed", async function () {
    const f = await deployFixture();
    const asset = await f.stock.getAddress();
    const garbageRoot = ethers.id("many-challenges");
    const total = ethers.parseEther("300");
    await commitSigned(f, asset, 1, garbageRoot, total, [f.chainId], [total], 2);

    const wallets: ReturnType<typeof ethers.Wallet.createRandom>[] = [];
    for (let i = 0; i < 33; i++) {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);
      await f.operator.sendTransaction({ to: w.address, value: ethers.parseEther("0.01") });
      await f.usdg.mint(w.address, CHALLENGE_BOND);
      await f.usdg.connect(w).approve(await f.disputes.getAddress(), CHALLENGE_BOND);
      const stated = ethers.parseEther(String(i + 1));
      const sig = await signBalanceStatement(
        f.disputes,
        f.operator,
        f.custodianId,
        asset,
        1,
        w.address,
        stated
      );
      await f.disputes
        .connect(w)
        .challengeInclusion(f.custodianId, asset, 1, w.address, stated, sig);
      wallets.push(w);
    }
    expect(await f.disputes.openChallengeCount(f.custodianId, asset)).to.equal(33n);

    // Real user can still open
    await approveChallengeBond(f, f.userA);
    const sigA = await signBalanceStatement(
      f.disputes,
      f.operator,
      f.custodianId,
      asset,
      1,
      f.userA.address,
      ethers.parseEther("100")
    );
    await f.disputes
      .connect(f.userA)
      .challengeInclusion(f.custodianId, asset, 1, f.userA.address, ethers.parseEther("100"), sigA);
    expect(await f.disputes.openChallengeCount(f.custodianId, asset)).to.equal(34n);
    void wallets;
  });

  it("equivocation unlocks open challenge bonds for withdraw", async function () {
    const f = await deployFixture();
    const asset = await f.stock.getAddress();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { root, total, leafCount } = buildSortedTree(f.custodianId, asset, 1, leaves);
    await commitSigned(f, asset, 1, root, total, [f.chainId], [total], leafCount);

    const amount = leaves[0].amount;
    const sig = await signBalanceStatement(
      f.disputes,
      f.operator,
      f.custodianId,
      asset,
      1,
      f.userA.address,
      amount
    );
    await approveChallengeBond(f, f.userA);
    const before = await f.usdg.balanceOf(f.userA.address);
    await f.disputes
      .connect(f.userA)
      .challengeInclusion(f.custodianId, asset, 1, f.userA.address, amount, sig);

    const otherRoot = ethers.id("other-root-fifo");
    const otherTotal = total + 1n;
    const otherAlloc = allocationCommitment([f.chainId], [otherTotal]);
    const otherSig = await signEpochCommitment(
      f.operator,
      f.deploymentSalt,
      f.custodianId,
      f.assetId,
      1,
      otherRoot,
      otherTotal,
      otherAlloc,
      leafCount
    );
    await f.disputes.openEquivocationDispute(
      f.custodianId,
      asset,
      1,
      otherRoot,
      otherTotal,
      otherAlloc,
      leafCount,
      otherSig
    );

    expect(await f.disputes.challengeRefunds(f.userA.address)).to.equal(CHALLENGE_BOND);
    const ch = await f.disputes.challenges(f.custodianId, asset, f.userA.address);
    expect(ch.open).to.equal(false);
    await f.disputes.connect(f.userA).withdrawChallengeBond();
    expect(await f.usdg.balanceOf(f.userA.address)).to.equal(before);

    // expire after equivocation unlocks nothing more / does not revert trapping funds
    await expect(f.disputes.expireChallenge(f.custodianId, asset, f.userA.address)).to.be
      .revertedWithCustomError(f.disputes, "NoChallenge");
  });
});
