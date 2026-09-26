/**
 * LeafCount-in-root / malformed / equivocation regressions.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { buildSortedTree, leafHash, nodeHash, type Leaf, type ProofNode } from "./helpers/merkle";
import {
  allocationCommitment,
  commitAndSample,
  deployFixture,
  signBalanceStatement,
  signEpochCommitment,
  twoLeaves,
} from "./helpers/fixture";

async function commitSigned(
  f: Awaited<ReturnType<typeof deployFixture>>,
  asset: string,
  epochId: number,
  root: string,
  total: bigint,
  chains: number[],
  allocations: bigint[],
  leafCount: number
) {
  const allocCmt = allocationCommitment(chains, allocations);
  const sig = await signEpochCommitment(
    f.operator,
    f.custodianId,
    asset,
    epochId,
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
      epochId,
      root,
      total,
      chains,
      allocations,
      ethers.parseEther("1"),
      0,
      leafCount,
      sig
    );
}

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

  // (((L0,L1),L2),L3) — L3 has depth 1; L0 has depth 3
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
  // L3: sibling is n012 on the left
  proofs.set(hashed[3].user.toLowerCase(), [
    { hash: n012.hash, sum: n012.sum, isLeft: true },
  ]);
  // L2: sibling L-side of n01 pair under n012, then L3
  proofs.set(hashed[2].user.toLowerCase(), [
    { hash: n01.hash, sum: n01.sum, isLeft: true },
    { hash: hashed[3].hash, sum: hashed[3].amount, isLeft: false },
  ]);
  // L0: sibling L1, then L2, then L3
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

describe("zz_poc_review — leafCount / malformed / equivocation", function () {
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
    const { root, total, leafCount } = buildSortedTree(f.custodianId, asset, 1, leaves);
    const sigBad = await signEpochCommitment(
      f.operator,
      f.custodianId,
      asset,
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

    const half = total / 2n;
    const sigOrder = await signEpochCommitment(
      f.operator,
      f.custodianId,
      asset,
      1,
      root,
      total,
      allocationCommitment([peer, f.chainId], [half, total - half]),
      leafCount
    );
    await expect(
      f.ledger.connect(f.operator).commitEpoch(
        f.custodianId,
        asset,
        1,
        root,
        total,
        [peer, f.chainId],
        [half, total - half],
        ethers.parseEther("1"),
        0,
        leafCount,
        sigOrder
      )
    ).to.be.revertedWithCustomError(f.ledger, "BadAllocation");
  });

  it("stores allocationCommitment identical for the same vector", async function () {
    const peer = 421614;
    const f = await deployFixture({ allocationChains: [31337, peer] });
    const asset = await f.stock.getAddress();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { root, total, leafCount } = buildSortedTree(f.custodianId, asset, 1, leaves);
    const half = total / 2n;
    await commitSigned(f, asset, 1, root, total, [f.chainId, peer], [half, total - half], leafCount);
    const ep = await f.ledger.getEpoch(f.custodianId, asset, 1);
    expect(ep.allocationCommitment).to.equal(
      allocationCommitment([f.chainId, peer], [half, total - half])
    );
    expect(ep.leafCount).to.equal(2n);
    expect(ep.commitmentDigest).to.not.equal(ethers.ZeroHash);
  });

  it("rejects non power-of-two leafCount", async function () {
    const f = await deployFixture();
    const asset = await f.stock.getAddress();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { root, total } = buildSortedTree(f.custodianId, asset, 1, leaves);
    const sig = await signEpochCommitment(
      f.operator,
      f.custodianId,
      asset,
      1,
      root,
      total,
      allocationCommitment([f.chainId], [total]),
      3
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
        3,
        sig
      )
    ).to.be.revertedWithCustomError(f.ledger, "BadLeafCount");
  });

  it("wrong leafCount vs tree makes inclusion fail; consistent recommit restores proofs", async function () {
    const f = await deployFixture();
    const asset = await f.stock.getAddress();
    const addrs = [f.userA.address, f.userB.address, f.userC.address, f.userD.address];
    const leaves: Leaf[] = addrs.map((u, i) => ({
      user: u,
      amount: ethers.parseEther(String((i + 1) * 10)),
    }));
    const { root, total, proofs, leafCount } = buildSortedTree(f.custodianId, asset, 1, leaves);

    // Commit 4-leaf root claiming leafCount=2 — signatures must match claimed count
    await commitSigned(f, asset, 1, root, total, [f.chainId], [total], 2);

    const user = leaves[0].user;
    const amount = leaves[0].amount;
    const sibs = proofs.get(user.toLowerCase())!;
    // Inclusion used by exit/dispute fails (leafHash uses ep.leafCount=2)
    const stated = amount;
    const sig = await signBalanceStatement(
      f.disputes,
      f.operator,
      f.custodianId,
      asset,
      1,
      user,
      stated + 1n
    );
    await expect(
      f.disputes.openMismatchDispute(
        f.custodianId,
        asset,
        1,
        user,
        amount,
        stated + 1n,
        sig,
        sibs
      )
    ).to.be.revertedWithCustomError(f.disputes, "BadProof");

    // Consistent recommit at epoch 2
    const tree2 = buildSortedTree(f.custodianId, asset, 2, leaves);
    await commitSigned(
      f,
      asset,
      2,
      tree2.root,
      tree2.total,
      [f.chainId],
      [tree2.total],
      tree2.leafCount
    );
    await f.sampler.connect(f.operator).setSampleWallets(f.custodianId, asset, [f.wallet1.address]);
    await f.sampler.connect(f.operator).recordSample(f.custodianId, asset);
    await ethers.provider.send("evm_increaseTime", [2]);
    await ethers.provider.send("evm_mine", []);
    await f.sampler.connect(f.operator).recordSample(f.custodianId, asset);

    const [ok] = await f.oracle.isSolvent(f.custodianId, asset);
    expect(ok).to.equal(true);

    const sig2 = await signBalanceStatement(
      f.disputes,
      f.operator,
      f.custodianId,
      asset,
      2,
      user,
      amount + 1n
    );
    await f.disputes.openMismatchDispute(
      f.custodianId,
      asset,
      2,
      user,
      amount,
      amount + 1n,
      sig2,
      tree2.proofs.get(user.toLowerCase())!
    );
    expect(await f.disputes.isDisputed(f.custodianId, asset)).to.equal(true);
  });

  it("malformed/lopsided tree → openMalformedTreeDispute succeeds", async function () {
    const f = await deployFixture();
    const asset = await f.stock.getAddress();
    const leaves: Leaf[] = [
      { user: f.userA.address, amount: ethers.parseEther("10") },
      { user: f.userB.address, amount: ethers.parseEther("20") },
      { user: f.userC.address, amount: ethers.parseEther("30") },
      { user: f.userD.address, amount: ethers.parseEther("40") },
    ];
    const { root, total, proofs, leafCount } = buildLopsidedTree(
      f.custodianId,
      asset,
      1,
      leaves
    );
    await commitSigned(f, asset, 1, root, total, [f.chainId], [total], leafCount);

    const sorted = [...leaves].sort((a, b) =>
      a.user.toLowerCase() < b.user.toLowerCase() ? -1 : 1
    );
    const shortLeaf = sorted[3]; // deepest-right in (((a,b),c),d)
    const shortProof = proofs.get(shortLeaf.user.toLowerCase())!;
    expect(shortProof.length).to.equal(1); // depth != 2

    await f.disputes.openMalformedTreeDispute(
      f.custodianId,
      asset,
      1,
      shortLeaf.user,
      shortLeaf.amount,
      shortProof
    );
    expect(await f.disputes.isDisputed(f.custodianId, asset)).to.equal(true);
  });

  it("balanced trees reject malformed dispute (depth matches)", async function () {
    const f = await deployFixture();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { proofs, asset } = await commitAndSample(f, leaves);
    const u = leaves[0];
    await expect(
      f.disputes.openMalformedTreeDispute(
        f.custodianId,
        asset,
        1,
        u.user,
        u.amount,
        proofs.get(u.user.toLowerCase())!
      )
    ).to.be.revertedWithCustomError(f.disputes, "BadProof");
  });

  it("two different signed EpochCommitments → equivocation dispute", async function () {
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
      f.custodianId,
      asset,
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
    const [ok] = await f.oracle.isSolvent(f.custodianId, asset);
    expect(ok).to.equal(false);
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
