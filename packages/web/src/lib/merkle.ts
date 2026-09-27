import {
  keccak256,
  encodePacked,
  getAddress,
  toBytes,
  type Hex,
  type Address,
} from "viem";

export const MERKLE_DOMAIN = keccak256(toBytes("ReserveProof.MerkleSum.v2"));

export type ProofNode = { hash: Hex; sum: string | bigint; isLeft: boolean };

export function leafHash(
  custodianId: Hex,
  asset: Address,
  epochId: number,
  leafCount: number,
  user: Address,
  amount: bigint
): Hex {
  return keccak256(
    encodePacked(
      ["bytes1", "bytes32", "bytes32", "address", "uint64", "uint32", "address", "uint256"],
      [
        "0x00",
        MERKLE_DOMAIN,
        custodianId,
        getAddress(asset),
        BigInt(epochId),
        leafCount,
        getAddress(user),
        amount,
      ]
    )
  );
}

export function nodeHash(
  leftHash: Hex,
  leftSum: bigint,
  rightHash: Hex,
  rightSum: bigint
): Hex {
  return keccak256(
    encodePacked(
      ["bytes1", "bytes32", "bytes32", "uint256", "uint256"],
      ["0x01", leftHash, rightHash, leftSum, rightSum]
    )
  );
}

export type TreeLeaf = { user: Address; amount: bigint };

/** Sorted Merkle-sum tree; mirrors packages/merkle buildSortedTree (proof keys are lowercase). */
export function buildSortedTree(
  custodianId: Hex,
  asset: Address,
  epochId: number,
  leaves: TreeLeaf[]
): { root: Hex; total: bigint; leafCount: number; sorted: TreeLeaf[]; proofs: Map<string, ProofNode[]> } {
  const leafCount = leaves.length;
  if (leafCount === 0 || (leafCount & (leafCount - 1)) !== 0) {
    throw new Error(`leaf count must be a power of two, got ${leafCount}`);
  }
  const sorted = [...leaves]
    .map((l) => ({ user: getAddress(l.user), amount: l.amount }))
    .sort((a, b) => {
      const aa = a.user.toLowerCase();
      const bb = b.user.toLowerCase();
      return aa < bb ? -1 : aa > bb ? 1 : 0;
    });

  let level = sorted.map((l) => ({
    hash: leafHash(custodianId, asset, epochId, leafCount, l.user, l.amount),
    sum: l.amount,
  }));
  const layers = [level];
  while (level.length > 1) {
    const next: { hash: Hex; sum: bigint }[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const [l, r] = [level[i], level[i + 1]];
      next.push({ hash: nodeHash(l.hash, l.sum, r.hash, r.sum), sum: l.sum + r.sum });
    }
    layers.push(next);
    level = next;
  }

  const proofs = new Map<string, ProofNode[]>();
  sorted.forEach((leaf, leafIndex) => {
    const proof: ProofNode[] = [];
    let index = leafIndex;
    for (let li = 0; li < layers.length - 1; li++) {
      const isRight = index % 2 === 1;
      const sib = layers[li][isRight ? index - 1 : index + 1];
      proof.push({ hash: sib.hash, sum: sib.sum, isLeft: isRight });
      index = Math.floor(index / 2);
    }
    proofs.set(leaf.user.toLowerCase(), proof);
  });

  return { root: level[0].hash, total: level[0].sum, leafCount, sorted, proofs };
}

/** Client-side inclusion check matching MerkleSumVerifier.verifyInclusion. */
export function verifyInclusion(args: {
  custodianId: Hex;
  asset: Address;
  epochId: number;
  leafCount: number;
  user: Address;
  amount: bigint;
  root: Hex;
  totalSum: bigint;
  siblings: ProofNode[];
}): boolean {
  const depth = Math.log2(args.leafCount);
  if (!Number.isInteger(depth) || args.siblings.length !== depth) return false;

  let computed = leafHash(
    args.custodianId,
    args.asset,
    args.epochId,
    args.leafCount,
    args.user,
    args.amount
  );
  let computedSum = args.amount;

  for (const s of args.siblings) {
    const sum = typeof s.sum === "bigint" ? s.sum : BigInt(s.sum);
    if (s.isLeft) {
      computed = nodeHash(s.hash, sum, computed, computedSum);
    } else {
      computed = nodeHash(computed, computedSum, s.hash, sum);
    }
    computedSum += sum;
  }

  return computed === args.root && computedSum === args.totalSum;
}
