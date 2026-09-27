/**
 * Revert the local node to the saved demo snapshot, then take a fresh one
 * (evm_revert consumes the snapshot id).
 * Usage: npx hardhat run scripts/demo-reset.ts --network localhost
 */
import hre from "hardhat";
import { ethers } from "hardhat";
import * as fs from "fs";
import { SNAPSHOT_FILE, takeSnapshot } from "./demo-snapshot";

async function main() {
  if (hre.network.name !== "localhost") throw new Error("demo:reset is for --network localhost only");
  if (!fs.existsSync(SNAPSHOT_FILE)) {
    throw new Error(`No ${SNAPSHOT_FILE} — run npm run demo:setup (or demo:snapshot) first`);
  }
  const { id } = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
  const ok = (await ethers.provider.send("evm_revert", [id])) as boolean;
  if (!ok) {
    throw new Error(`evm_revert(${id}) failed — the node was restarted; run npm run demo:setup again`);
  }
  const fresh = await takeSnapshot();
  console.log(`Reverted to snapshot ${id}; new snapshot ${fresh}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
