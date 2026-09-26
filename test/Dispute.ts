import { expect } from "chai";
import { ethers } from "hardhat";
import { neighboursFor } from "./helpers/merkle";
import {
  commitAndSample,
  deployFixture,
  signBalanceStatement,
  twoLeaves,
} from "./helpers/fixture";

describe("DisputeModule", function () {
  it("mismatch dispute flips insolvent", async function () {
    const f = await deployFixture();
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { proofs, asset } = await commitAndSample(f, leaves);
    const epochId = 1;
    const proved = ethers.parseEther("100");
    const stated = ethers.parseEther("150");
    const proof = proofs.get(f.userA.address.toLowerCase())!;

    const sig = await signBalanceStatement(
      f.disputes,
      f.operator,
      f.custodianId,
      asset,
      epochId,
      f.userA.address,
      stated
    );

    await f.disputes.openMismatchDispute(
      f.custodianId,
      asset,
      epochId,
      f.userA.address,
      proved,
      stated,
      sig,
      proof
    );

    expect(await f.disputes.isDisputed(f.custodianId, asset)).to.equal(true);
    const status = await f.oracle.status(f.custodianId, asset);
    expect(status.ok).to.equal(false);
    expect(status.reason).to.equal(3); // DISPUTED
  });

  it("omission dispute with neighbours flips insolvent", async function () {
    const f = await deployFixture();
    // Tree with A and B only; C is omitted but has a statement
    const leaves = twoLeaves(f.userA.address, f.userB.address);
    const { proofs, asset } = await commitAndSample(f, leaves);
    const epochId = 1;
    const sorted = [
      { user: f.userA.address, amount: ethers.parseEther("100") },
      { user: f.userB.address, amount: ethers.parseEther("200") },
    ].sort((a, b) =>
      a.user.toLowerCase() < b.user.toLowerCase()
        ? -1
        : a.user.toLowerCase() > b.user.toLowerCase()
          ? 1
          : 0
    );

    // Pick an omitted address that sorts between A and B if possible, else outside
    const omitted = f.userC.address;
    const stated = ethers.parseEther("50");
    const n = neighboursFor(sorted, omitted);

    const sig = await signBalanceStatement(
      f.disputes,
      f.operator,
      f.custodianId,
      asset,
      epochId,
      omitted,
      stated
    );

    const leftProof =
      n.leftUser != null ? proofs.get(n.leftUser.toLowerCase())! : [];
    const rightProof =
      n.rightUser != null ? proofs.get(n.rightUser.toLowerCase())! : [];

    await f.disputes.openOmissionDispute(
      f.custodianId,
      asset,
      epochId,
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
    const status = await f.oracle.status(f.custodianId, asset);
    expect(status.ok).to.equal(false);
    expect(status.reason).to.equal(3);
  });
});
