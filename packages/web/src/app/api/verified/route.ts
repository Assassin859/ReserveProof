import { NextResponse } from "next/server";
import { NETWORKS, ownContracts, type NetworkKey } from "../../../lib/deployments";

export const dynamic = "force-dynamic";

const CACHE_SECONDS = 3600;

type Check = "verified" | "unverified" | "unknown";

async function blockscout(explorer: string, address: string): Promise<Check> {
  try {
    const res = await fetch(`${explorer}/api?module=contract&action=getabi&address=${address}`, {
      next: { revalidate: CACHE_SECONDS },
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
      next: { revalidate: CACHE_SECONDS },
    });
    if (res.status === 404) return "unverified";
    if (!res.ok) return "unknown";
    const body = (await res.json()) as { match?: string | null };
    return body.match === "exact_match" || body.match === "match" ? "verified" : "unverified";
  } catch {
    return "unknown";
  }
}

export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("network") as NetworkKey | null;
  const net = key ? NETWORKS[key] : undefined;
  const dep = net?.deployment;
  if (!net || !dep || key === "localhost") {
    return NextResponse.json({ error: "unknown network" }, { status: 400 });
  }
  const contracts = ownContracts(dep);
  const source = key === "robinhoodTestnet" ? "blockscout" : "sourcify";
  const checks = await Promise.all(
    contracts.map(([, addr]) =>
      source === "blockscout" ? blockscout(net.explorer!, addr) : sourcify(dep.chainId, addr)
    )
  );
  const count = (c: Check) => checks.filter((x) => x === c).length;
  return NextResponse.json(
    {
      network: key,
      source,
      total: contracts.length,
      verified: count("verified"),
      unverified: contracts.filter((_, i) => checks[i] === "unverified").map(([name]) => name),
      unknown: count("unknown"),
      checkedAt: new Date().toISOString(),
    },
    { headers: { "Cache-Control": `s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS}` } }
  );
}
