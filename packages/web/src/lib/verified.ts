import { NETWORKS, ownContracts, type NetworkKey } from "./deployments";

export const VERIFIED_CACHE_SECONDS = 3600;

type Check = "verified" | "unverified" | "unknown";

export type VerifiedReport = {
  network: NetworkKey;
  source: "blockscout" | "sourcify";
  total: number;
  verified: number;
  unverified: string[];
  unknown: number;
  checkedAt: string;
};

async function blockscout(explorer: string, address: string): Promise<Check> {
  try {
    const res = await fetch(`${explorer}/api?module=contract&action=getabi&address=${address}`, {
      next: { revalidate: VERIFIED_CACHE_SECONDS },
    });
    if (!res.ok) return "unknown";
    const body = (await res.json()) as { status?: string; message?: string };
    if (body.status === "1" && body.message === "OK") return "verified";
    return /not verified/i.test(body.message ?? "") ? "unverified" : "unknown";
  } catch {
    return "unknown";
  }
}

async function sourcify(chainId: number, address: string): Promise<Check> {
  try {
    const res = await fetch(`https://sourcify.dev/server/v2/contract/${chainId}/${address}`, {
      next: { revalidate: VERIFIED_CACHE_SECONDS },
    });
    if (res.status === 404) return "unverified";
    if (!res.ok) return "unknown";
    const body = (await res.json()) as { match?: string | null };
    return body.match === "exact_match" || body.match === "match" ? "verified" : "unverified";
  } catch {
    return "unknown";
  }
}

/** Source verification of every contract we deployed: Blockscout on Robinhood testnet, Sourcify on Arbitrum. */
export async function checkVerified(key: NetworkKey): Promise<VerifiedReport | null> {
  const net = NETWORKS[key];
  const dep = net?.deployment;
  if (!net || !dep || key === "localhost") return null;
  const contracts = ownContracts(dep);
  const source = key === "robinhoodTestnet" ? "blockscout" : "sourcify";
  const checks = await Promise.all(
    contracts.map(([, addr]) => (source === "blockscout" ? blockscout(net.explorer!, addr) : sourcify(dep.chainId, addr)))
  );
  return {
    network: key,
    source,
    total: contracts.length,
    verified: checks.filter((c) => c === "verified").length,
    unverified: contracts.filter((_, i) => checks[i] === "unverified").map(([name]) => name),
    unknown: checks.filter((c) => c === "unknown").length,
    checkedAt: new Date().toISOString(),
  };
}
