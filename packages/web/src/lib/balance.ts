import { getAddress, type Address, type Hex, type PublicClient } from "viem";
import { liabilityLedgerAbi } from "./abis";
import type { AssetKind, BookLeaf } from "./deployments";
import { buildSortedTree, verifyInclusion, type ProofNode } from "./merkle";

export type EpochView = {
  liabilityRoot: Hex;
  totalLiability: bigint;
  allocation: bigint;
  exists: boolean;
  leafCount: number;
};

export type BalanceResult = {
  user: Address;
  asset: AssetKind;
  epochId: number;
  found: boolean;
  amount: bigint;
  proof: ProofNode[];
  computedRoot: Hex;
  onchainRoot: Hex;
  rootMatches: boolean;
  verified: boolean;
};

export function parseEpoch(raw: unknown): EpochView | null {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    return {
      liabilityRoot: raw[0] as Hex,
      totalLiability: raw[1] as bigint,
      allocation: raw[2] as bigint,
      exists: raw[6] as boolean,
      leafCount: Number(raw[7]),
    };
  }
  const e = raw as Omit<EpochView, "leafCount"> & { leafCount: number | bigint };
  return { ...e, leafCount: Number(e.leafCount) };
}

/** Latest committed epoch for (custodian, asset); `ep` is null when nothing was ever committed. */
export async function readLatestEpoch(
  client: PublicClient,
  ledger: Address,
  custodianId: Hex,
  asset: Address
): Promise<{ latest: number; ep: EpochView | null }> {
  const latest = (await client.readContract({
    address: ledger,
    abi: liabilityLedgerAbi,
    functionName: "latestEpochId",
    args: [custodianId, asset],
  })) as bigint;
  if (latest === BigInt(0)) return { latest: 0, ep: null };
  const ep = parseEpoch(
    await client.readContract({
      address: ledger,
      abi: liabilityLedgerAbi,
      functionName: "getEpoch",
      args: [custodianId, asset, latest],
    })
  );
  return { latest: Number(latest), ep };
}

/**
 * Rebuild the Merkle-sum tree from the published book, check it reproduces the on-chain root and total,
 * then verify the user's leaf against that root. Runs entirely in the caller (the browser on /verify).
 */
export function checkBalance(args: {
  custodianId: Hex;
  kind: AssetKind;
  asset: Address;
  epochId: number;
  ep: EpochView;
  book: BookLeaf[];
  user: string;
}): BalanceResult {
  const { custodianId, kind, asset, epochId, ep, book } = args;
  const tree = buildSortedTree(
    custodianId,
    asset,
    epochId,
    book.map((l) => ({ user: l.user as Address, amount: BigInt(l.amount) }))
  );
  const user = getAddress(args.user.trim());
  const proof = tree.proofs.get(user.toLowerCase()) ?? [];
  const leaf = tree.sorted.find((l) => l.user.toLowerCase() === user.toLowerCase());
  const rootMatches = tree.root.toLowerCase() === ep.liabilityRoot.toLowerCase() && tree.total === ep.totalLiability;
  const verified = leaf
    ? verifyInclusion({
        custodianId,
        asset,
        epochId,
        leafCount: ep.leafCount,
        user,
        amount: leaf.amount,
        root: ep.liabilityRoot,
        totalSum: ep.totalLiability,
        siblings: proof,
      })
    : false;
  return {
    user,
    asset: kind,
    epochId,
    found: Boolean(leaf),
    amount: leaf?.amount ?? BigInt(0),
    proof,
    computedRoot: tree.root,
    onchainRoot: ep.liabilityRoot,
    rootMatches,
    verified,
  };
}
