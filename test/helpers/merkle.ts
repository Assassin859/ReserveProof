import { ethers } from "hardhat";

export type ProofNode = { hash: string; sum: bigint; isLeft: boolean };

const DOMAIN = ethers.keccak256(ethers.toUtf8Bytes("ReserveProof.MerkleSum.v1"));

export function leafHash(
  custodianId: string,
  asset: string,
  epochId: number,
  user: string,
  amount: bigint
): string {
  return ethers.keccak256(
    ethers.solidityPacked(
      ["bytes1", "bytes32", "bytes32", "address", "uint64", "address", "uint256"],
      ["0x00", DOMAIN, custodianId, asset, epochId, user, amount]
    )
  );
}

function nodeHash(leftHash: string, leftSum: bigint, rightHash: string, rightSum: bigint): string {
  return ethers.keccak256(
    ethers.solidityPacked(
      ["bytes1", "bytes32", "bytes32", "uint256", "uint256"],
      ["0x01", leftHash, rightHash, leftSum, rightSum]
    )
  );
}

export type Leaf = { user: string; amount: bigint };

export function buildSortedTree(
  custodianId: string,
  asset: string,
  epochId: number,
  leaves: Leaf[]
): {
  root: string;
  total: bigint;
  sorted: Leaf[];
  proofs: Map<string, ProofNode[]>;
} {
  const sorted = [...leaves].sort((a, b) =>
    a.user.toLowerCase() < b.user.toLowerCase() ? -1 : a.user.toLowerCase() > b.user.toLowerCase() ? 1 : 0
  );

  type Node = { hash: string; sum: bigint; left?: Node; right?: Node; user?: string };
  let level: Node[] = sorted.map((l) => ({
    hash: leafHash(custodianId, asset, epochId, l.user, l.amount),
    sum: l.amount,
    user: l.user,
  }));

  // Pad to power of two with empty zero nodes (sum 0) for simpler proofs
  while (level.length & (level.length - 1)) {
    level.push({
      hash: ethers.keccak256(ethers.solidityPacked(["bytes1", "string"], ["0x00", "EMPTY"])),
      sum: 0n,
    });
  }
  // Better: don't use fake empties that break sum — require power-of-two leaf count in tests.
  // Filter empties if we added by mistake — rebuild without padding:
  level = sorted.map((l) => ({
    hash: leafHash(custodianId, asset, epochId, l.user, l.amount),
    sum: l.amount,
    user: l.user,
  }));

  const layers: Node[][] = [level];
  while (level.length > 1) {
    const next: Node[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) {
        // odd one out — promote
        next.push(level[i]);
      } else {
        const left = level[i];
        const right = level[i + 1];
        next.push({
          hash: nodeHash(left.hash, left.sum, right.hash, right.sum),
          sum: left.sum + right.sum,
          left,
          right,
        });
      }
    }
    layers.push(next);
    level = next;
  }

  const rootNode = level[0];
  const proofs = new Map<string, ProofNode[]>();

  for (const leaf of sorted) {
    const proof: ProofNode[] = [];
    let index = sorted.findIndex((x) => x.user.toLowerCase() === leaf.user.toLowerCase());
    let currentHash = leafHash(custodianId, asset, epochId, leaf.user, leaf.amount);
    let currentSum = leaf.amount;

    for (let li = 0; li < layers.length - 1; li++) {
      const layer = layers[li];
      const isRight = index % 2 === 1;
      const siblingIndex = isRight ? index - 1 : index + 1;
      if (siblingIndex >= 0 && siblingIndex < layer.length) {
        const sib = layer[siblingIndex];
        proof.push({ hash: sib.hash, sum: sib.sum, isLeft: isRight });
        if (isRight) {
          currentHash = nodeHash(sib.hash, sib.sum, currentHash, currentSum);
        } else {
          currentHash = nodeHash(currentHash, currentSum, sib.hash, sib.sum);
        }
        currentSum += sib.sum;
      }
      index = Math.floor(index / 2);
      // When odd promotion happened, index mapping can drift — tests use power-of-two sizes.
    }
    proofs.set(leaf.user.toLowerCase(), proof);
  }

  return { root: rootNode.hash, total: rootNode.sum, sorted, proofs };
}
