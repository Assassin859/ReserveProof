/**
 * Challenge-response / permanent equivocation / assetId regressions.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import {
  buildSortedTree,
  leafHash,
  nodeHash,
  type Leaf,
  type ProofNode,
} from "./helpers/merkle";
import {
  allocationCommitment,
  CHALLENGE_WINDOW,
  commitAndSample,
  commitSigned,
  deployFixture,
  signBalanceStatement,
  signEpochCommitment,
  TEST_ASSET_ID,
  twoLeaves,
} from "./helpers/fixture";

/** Unbalanced tree: depths differ; leafCount still bound into leaves. */
function buildLopsidedTree(
  custodianId: string,
  asset: string,
  epochId: number,
  leaves: Leaf[]
): { root: string; total: bigint; proofs: Map<string, ProofNode[]>; leafCount: number } {
  const leafCount = leaves.length;
  if (leafCount !== 4) throw new Error("lopsided PoC expects 4 leaves");
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
  proofs.set(hashed[3].user.toLowerCase(), [
    { hash: n012.hash, sum: n012.sum, isLeft: true },
  ]);
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

/** Balanced tree with index-0 replaced by a dummy hash (fake slot). */
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
  if (realLeaves.length !== 3) throw new Error("fake-slot PoC expects 3 real leaves");
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

  // level0: [dummy, R0, R1, R2]
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
  // R0 at index 1
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

describe("zz_poc_review — challenge / equivocation / assetId", function () {
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

  it("rejects allocation vector that omits an allowlisted chain or uses wrong order", async function () {
    const peer = 421614;
    const f = await deployFixture({ allocationChains: [31337, peer] });
    const asset = await f.stock.getAddress();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { root, total, leafCount } = buildSortedTree(f.custodianId, asset, 1, leaves);
    const sigBad = await signEpochCommitment(
      f.operator,
      f.deploymentSalt,
      f.custodianId,
      f.assetId,
      1,
      root,
      total,
      allocationCommitment([f.chainId], [total]),
      leafCount
    );

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
        leafCount,
        sigBad
      )
    ).to.be.revertedWithCustomError(f.ledger, "BadAllocation");
  });

  it("garbage root → challenge → expire → disputed", async function () {
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

    let [ok] = await f.oracle.isSolvent(f.custodianId, asset);
    expect(ok).to.equal(true);

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
    await f.disputes.challengeInclusion(f.custodianId, asset, 1, f.userA.address, stated, sig);

    await ethers.provider.send("evm_increaseTime", [CHALLENGE_WINDOW + 1]);
    await ethers.provider.send("evm_mine", []);
    await f.disputes.expireChallenge(f.custodianId, asset);

    expect(await f.disputes.isDisputed(f.custodianId, asset)).to.equal(true);
    [ok] = await f.oracle.isSolvent(f.custodianId, asset);
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
    await f.disputes.challengeInclusion(f.custodianId, asset, 1, leaves[0].user, stated, sig);
    await ethers.provider.send("evm_increaseTime", [CHALLENGE_WINDOW + 1]);
    await ethers.provider.send("evm_mine", []);
    await f.disputes.expireChallenge(f.custodianId, asset);
    expect(await f.disputes.isDisputed(f.custodianId, asset)).to.equal(true);
  });

  it("fake index-0 slot → challenge expire (omission answer fails)", async function () {
    const f = await deployFixture();
    const asset = await f.stock.getAddress();
    const realLeaves: Leaf[] = [
      { user: f.userB.address, amount: ethers.parseEther("20") },
      { user: f.userC.address, amount: ethers.parseEther("30") },
      { user: f.userD.address, amount: ethers.parseEther("40") },
    ];
    const { root, total, proofs, leafCount, sortedReal } = buildFakeSlotTree(
      f.custodianId,
      asset,
      1,
      realLeaves
    );
    await commitSigned(f, asset, 1, root, total, [f.chainId], [total], leafCount);

    // Victim sorts before first real leaf
    let victim = "";
    for (let i = 0; i < 500; i++) {
      const w = ethers.Wallet.createRandom().address;
      if (w.toLowerCase() < sortedReal[0].user.toLowerCase()) {
        victim = w;
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
    await f.disputes.challengeInclusion(f.custodianId, asset, 1, victim, stated, sig);

    // Operator cannot answer inclusion for omitted victim
    await expect(
      f.disputes.connect(f.operator).answerInclusion(
        f.custodianId,
        asset,
        proofs.get(sortedReal[0].user.toLowerCase())!
      )
    ).to.be.reverted;

    // Left-edge omission requires rightIdx == 0; first real is at index 1
    await expect(
      f.disputes.connect(f.operator).answerOmission(
        f.custodianId,
        asset,
        ethers.ZeroAddress,
        0n,
        [],
        sortedReal[0].user,
        sortedReal[0].amount,
        proofs.get(sortedReal[0].user.toLowerCase())!
      )
    ).to.be.revertedWithCustomError(f.disputes, "BadBounds");

    await ethers.provider.send("evm_increaseTime", [CHALLENGE_WINDOW + 1]);
    await ethers.provider.send("evm_mine", []);
    await f.disputes.expireChallenge(f.custodianId, asset);
    expect(await f.disputes.isDisputed(f.custodianId, asset)).to.equal(true);
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
    await f.disputes.challengeInclusion(f.custodianId, asset, 1, leaves[0].user, amount, sig);
    await f.disputes
      .connect(f.operator)
      .answerInclusion(f.custodianId, asset, proofs.get(leaves[0].user.toLowerCase())!);

    const ch = await f.disputes.challenges(f.custodianId, asset);
    expect(ch.open).to.equal(false);
    const [ok] = await f.oracle.isSolvent(f.custodianId, asset);
    expect(ok).to.equal(true);
  });

  it("malformed/lopsided tree → openMalformedTreeDispute; evidence burned after clear", async function () {
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
    expect(await f.disputes.isDisputed(f.custodianId, asset)).to.equal(true);

    // Clear via matching epoch with same amount in balanced tree
    const tree2 = buildSortedTree(f.custodianId, asset, 2, leaves);
    await commitSigned(f, asset, 2, tree2.root, tree2.total, [f.chainId], [tree2.total], tree2.leafCount);
    // shortLeaf may not be in balanced proofs at same amount — use matching inclusion of shortLeaf
    const matchProof = tree2.proofs.get(shortLeaf.user.toLowerCase())!;
    await f.disputes
      .connect(f.operator)
      .markMatchingEpoch(f.custodianId, asset, 2, matchProof);
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
    await f.disputes.clearDispute(f.custodianId, asset);

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

  it("equivocation with shared assetId is permanent and non-replayable", async function () {
    const f = await deployFixture();
    const asset = await f.stock.getAddress();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { root, total, leafCount } = buildSortedTree(f.custodianId, asset, 1, leaves);
    await commitSigned(f, asset, 1, root, total, [f.chainId], [total], leafCount);

    // Simulate other-chain commitment: different root/alloc, same assetId + salt
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
    const d = await f.disputes.disputes(f.custodianId, asset);
    expect(d.kind).to.equal(2); // KIND_EQUIVOCATION

    await expect(
      f.disputes.connect(f.operator).markMatchingEpoch(f.custodianId, asset, 2, [])
    ).to.be.revertedWithCustomError(f.disputes, "PermanentDispute");
    await expect(f.disputes.clearDispute(f.custodianId, asset)).to.be.revertedWithCustomError(
      f.disputes,
      "PermanentDispute"
    );

    // Cannot "clear" — still disputed; replay would need isDisputed false.
    // Prove evidence burn: open a second fixture-like reopen is blocked by EvidenceUsed
    // if we could clear — permanent blocks that. Separate salt domain test below.
  });

  it("EpochCommitment sig verifies across different local asset addresses with same assetId", async function () {
    const f = await deployFixture();
    const assetA = await f.stock.getAddress();
    // Second token with same assetId on same deployment salt
    const Token = await ethers.getContractFactory("MockStockToken");
    const stockB = await Token.deploy("Mock TSLA B", "mTSLAb");
    const assetB = await stockB.getAddress();
    await f.assetConfig.connect(f.owner).setAssetConfig(
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
      f.assetId, // same cross-chain id
      [f.chainId]
    );

    const leaves = twoLeaves(f.userA.address, f.userB.address);
    // Trees differ per local asset address in leaf hash — commit different roots
    const treeA = buildSortedTree(f.custodianId, assetA, 1, leaves);
    const treeB = buildSortedTree(f.custodianId, assetB, 1, leaves);
    expect(treeA.root).to.not.equal(treeB.root);

    await commitSigned(f, assetA, 1, treeA.root, treeA.total, [f.chainId], [treeA.total], treeA.leafCount);

    // Operator also signed the B commitment (other chain) — use as equivocation evidence on A
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

  it("different deployment salt rejects foreign equivocation signature", async function () {
    const f = await deployFixture();
    const asset = await f.stock.getAddress();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { root, total, leafCount } = buildSortedTree(f.custodianId, asset, 1, leaves);
    await commitSigned(f, asset, 1, root, total, [f.chainId], [total], leafCount);

    const otherRoot = ethers.id("foreign");
    const otherTotal = total + 1n;
    const otherAlloc = allocationCommitment([f.chainId], [otherTotal]);
    const foreignSalt = ethers.id("ReserveProof.foreign");
    const otherSig = await signEpochCommitment(
      f.operator,
      foreignSalt,
      f.custodianId,
      f.assetId,
      1,
      otherRoot,
      otherTotal,
      otherAlloc,
      leafCount
    );

    await expect(
      f.disputes.openEquivocationDispute(
        f.custodianId,
        asset,
        1,
        otherRoot,
        otherTotal,
        otherAlloc,
        leafCount,
        otherSig
      )
    ).to.be.revertedWithCustomError(f.disputes, "BadSignature");
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
});
