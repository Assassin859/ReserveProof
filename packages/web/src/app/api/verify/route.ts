import { NextResponse } from "next/server";
import { loadVerify } from "../../../lib/verify";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  try {
    const report = await loadVerify();
    return NextResponse.json(report, {
      headers: { "Cache-Control": "s-maxage=120, stale-while-revalidate=300" },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
