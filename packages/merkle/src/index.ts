import { keccak256, solidityPacked, toUtf8Bytes, getAddress } from "ethers";

export type ProofNode = { hash: string; sum: bigint; isLeft: boolean };

export type Leaf = { user: string; amount: bigint };

export type Neighbours = {
  leftUser: string | null;
  leftAmount: bigint | null;
  rightUser: string | null;
  rightAmount: bigint | null;
};

export const MERKLE_DOMAIN = keccak256(toUtf8Bytes("ReserveProof.MerkleSum.v1"));

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

export function leafHash(
  custodianId: string,
  asset: string,
  epochId: number,
  user: string,
  amount: bigint
): string {
  return keccak256(
    solidityPacked(
      ["bytes1", "bytes32", "bytes32", "address", "uint64", "address", "uint256"],
      ["0x00", MERKLE_DOMAIN, custodianId, getAddress(asset), epochId, getAddress(user), amount]
    )
  );
}

export function nodeHash(
  leftHash: string,
  leftSum: bigint,
  rightHash: string,
  rightSum: bigint
): string {
  return keccak256(
    solidityPacked(
      ["bytes1", "bytes32", "bytes32", "uint256", "uint256"],
      ["0x01", leftHash, rightHash, leftSum, rightSum]
    )
  );
}

type Node = { hash: string; sum: bigint; user?: string };

/**
 * Build a sorted Merkle-sum tree. Leaf count must be a power of two (2, 4, 8, ...).
 */
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
  if (!isPowerOfTwo(leaves.length)) {
    throw new Error(`leaf count must be a power of two, got ${leaves.length}`);
  }

  const sorted = [...leaves].sort((a, b) => {
    const aa = getAddress(a.user).toLowerCase();
    const bb = getAddress(b.user).toLowerCase();
    return aa < bb ? -1 : aa > bb ? 1 : 0;
  });

  let level: Node[] = sorted.map((l) => ({
    hash: leafHash(custodianId, asset, epochId, l.user, l.amount),
    sum: l.amount,
    user: getAddress(l.user),
  }));

  const layers: Node[][] = [level];
  while (level.length > 1) {
    const next: Node[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1];
      next.push({
        hash: nodeHash(left.hash, left.sum, right.hash, right.sum),
        sum: left.sum + right.sum,
      });
    }
    layers.push(next);
    level = next;
  }

  const rootNode = level[0];
  const proofs = new Map<string, ProofNode[]>();

  for (let leafIndex = 0; leafIndex < sorted.length; leafIndex++) {
    const leaf = sorted[leafIndex];
    const proof: ProofNode[] = [];
    let index = leafIndex;
    let currentHash = leafHash(custodianId, asset, epochId, leaf.user, leaf.amount);
    let currentSum = leaf.amount;

    for (let li = 0; li < layers.length - 1; li++) {
      const layer = layers[li];
      const isRight = index % 2 === 1;
      const siblingIndex = isRight ? index - 1 : index + 1;
      const sib = layer[siblingIndex];
      proof.push({ hash: sib.hash, sum: sib.sum, isLeft: isRight });
      if (isRight) {
        currentHash = nodeHash(sib.hash, sib.sum, currentHash, currentSum);
      } else {
        currentHash = nodeHash(currentHash, currentSum, sib.hash, sib.sum);
      }
      currentSum += sib.sum;
      index = Math.floor(index / 2);
    }
    proofs.set(getAddress(leaf.user).toLowerCase(), proof);
  }

  return {
    root: rootNode.hash,
    total: rootNode.sum,
    sorted: sorted.map((l) => ({ user: getAddress(l.user), amount: l.amount })),
    proofs,
  };
}

/** Neighbour bounds for an address in a sorted leaf list (for omission disputes). */
export function neighboursFor(sorted: Leaf[], user: string): Neighbours {
  const target = getAddress(user).toLowerCase();
  const idx = sorted.findIndex((l) => l.user.toLowerCase() === target);
  if (idx >= 0) {
    return {
      leftUser: idx > 0 ? sorted[idx - 1].user : null,
      leftAmount: idx > 0 ? sorted[idx - 1].amount : null,
      rightUser: idx < sorted.length - 1 ? sorted[idx + 1].user : null,
      rightAmount: idx < sorted.length - 1 ? sorted[idx + 1].amount : null,
    };
  }
  // Missing user: find insertion point
  let insertAt = sorted.findIndex((l) => l.user.toLowerCase() > target);
  if (insertAt < 0) insertAt = sorted.length;
  return {
    leftUser: insertAt > 0 ? sorted[insertAt - 1].user : null,
    leftAmount: insertAt > 0 ? sorted[insertAt - 1].amount : null,
    rightUser: insertAt < sorted.length ? sorted[insertAt].user : null,
    rightAmount: insertAt < sorted.length ? sorted[insertAt].amount : null,
  };
}

/** Serialize proof nodes for JSON / contract args. */
export function proofToContractArgs(proof: ProofNode[]): { hash: string; sum: bigint; isLeft: boolean }[] {
  return proof.map((p) => ({ hash: p.hash, sum: p.sum, isLeft: p.isLeft }));
}
