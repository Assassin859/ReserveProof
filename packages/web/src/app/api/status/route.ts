import { NextResponse } from "next/server";
import { loadStatus } from "../../../lib/status";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const CACHE_SECONDS = 120;

export async function GET() {
  try {
    const report = await loadStatus();
    return NextResponse.json(report, {
      headers: { "Cache-Control": `s-maxage=${CACHE_SECONDS}, stale-while-revalidate=300` },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
