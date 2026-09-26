import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

function tryRead(file: string) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function GET() {
  const root = path.resolve(process.cwd(), "../..");
  const preferred = tryRead(path.join(root, "deployments", "localhost.json"));
  const fallback = tryRead(path.join(root, "deployments", "hardhat.json"));
  const dep = preferred || fallback;
  if (!dep) {
    return NextResponse.json(
      { error: "No deployments/localhost.json or hardhat.json found. Run npm run demo:deploy." },
      { status: 404 }
    );
  }
  return NextResponse.json(dep);
}
