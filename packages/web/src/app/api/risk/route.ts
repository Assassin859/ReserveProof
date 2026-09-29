import { NextResponse } from "next/server";
import { NETWORKS, type NetworkKey } from "../../../lib/deployments";
import { loadRisk } from "../../../lib/risk";

export const dynamic = "force-dynamic";

const CACHE_SECONDS = 30;

export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("network") as NetworkKey | null;
  if (!key || key === "localhost" || !NETWORKS[key]?.deployment) {
    return NextResponse.json({ error: "unknown network; use robinhoodTestnet or arbitrumSepolia" }, { status: 400 });
  }
  try {
    const report = await loadRisk(key);
    return NextResponse.json(report, {
      headers: { "Cache-Control": `s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS * 2}` },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
