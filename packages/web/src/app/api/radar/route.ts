import { NextResponse } from "next/server";
import { loadRadar } from "../../../lib/radar";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const CACHE_SECONDS = 300;

const bigintSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export async function GET() {
  try {
    const report = await loadRadar();
    return new NextResponse(JSON.stringify(report, bigintSafe), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS * 2}`,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
