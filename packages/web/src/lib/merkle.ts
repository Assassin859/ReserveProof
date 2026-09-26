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
