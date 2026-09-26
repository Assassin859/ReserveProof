/**
 * Advance local chain time (Hardhat / localhost only). Used for scene 6 (STALE).
 *
 * Usage:
 *   npx hardhat run scripts/demo-warp.ts --network localhost
 *
 * Env:
 *   SECONDS=604801   (default ~7d+1s — past maxOracleAge in deploy)
 */
import hre from "hardhat";
import { ethers } from "hardhat";

async function main() {
  if (hre.network.name !== "hardhat" && hre.network.name !== "localhost") {
    throw new Error("demo-warp only works on hardhat/localhost");
  }
  const seconds = Number(process.env.SECONDS || String(7 * 24 * 3600 + 1));
  console.log(`Increasing time by ${seconds}s on ${hre.network.name}`);
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
  const block = await ethers.provider.getBlock("latest");
  console.log(`New timestamp: ${block?.timestamp}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
