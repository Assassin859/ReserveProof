/**
 * Take an evm_snapshot of the local node and save its id to out/demo-snapshot.json.
 * Usage: npx hardhat run scripts/demo-snapshot.ts --network localhost
 */
import hre from "hardhat";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

export const SNAPSHOT_FILE = path.join(__dirname, "..", "out", "demo-snapshot.json");

export async function takeSnapshot(): Promise<string> {
  const id = (await ethers.provider.send("evm_snapshot", [])) as string;
  fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({ id, takenAt: new Date().toISOString() }, null, 2));
  return id;
}

async function main() {
  if (hre.network.name !== "localhost") throw new Error("demo:snapshot is for --network localhost only");
  const id = await takeSnapshot();
  console.log(`Snapshot ${id} saved to ${SNAPSHOT_FILE}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
