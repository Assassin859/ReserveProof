import { NextResponse } from "next/server";
import type { NetworkKey } from "../../../lib/deployments";
import { VERIFIED_CACHE_SECONDS, checkVerified } from "../../../lib/verified";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("network") as NetworkKey | null;
  const report = key ? await checkVerified(key) : null;
  if (!report) return NextResponse.json({ error: "unknown network" }, { status: 400 });
  return NextResponse.json(report, {
    headers: { "Cache-Control": `s-maxage=${VERIFIED_CACHE_SECONDS}, stale-while-revalidate=${VERIFIED_CACHE_SECONDS}` },
  });
}
