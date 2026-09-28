/**
 * One-off: add Robinhood's own testnet Tesla token (ERC-8056 stock token) as a third asset for the
 * demo custodian, and make sure the reserve wallet holds at least 103% of the TSLA book.
 * The deployer's TSLA is moved into the reserve wallet if it is short.
 *
 *   npx hardhat run scripts/add-tsla.ts --network robinhoodTestnet
 *   ASSETS=tsla npm run ops:cycle:rh      # publish epoch 1 + samples
 */
import hre from "hardhat";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { BOOKS, readBook } from "./books";

const TSLA = "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E";
const ASSET_ID = ethers.id("TSLA-RH");
const COVERAGE_BPS = 10300;
const MAX_ORACLE_AGE = 7 * 24 * 3600;
const MIN_SAMPLES = 2;
const MIN_SAMPLE_GAP = 60;

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function symbol() view returns (string)",
  "function uiMultiplier() view returns (uint256)",
];

async function main() {
  const net = hre.network.name;
  if (net !== "robinhoodTestnet") throw new Error("TSLA only exists on Robinhood testnet");
  const depPath = path.join(__dirname, "..", "deployments", `${net}.json`);
  const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const assetConfig = await ethers.getContractAt("AssetConfig", dep.contracts.AssetConfig);
  const token = new ethers.Contract(TSLA, ERC20, deployer);

  console.log(`Token ${await token.symbol()} uiMultiplier=${ethers.formatEther(await token.uiMultiplier())}`);

  const cfg = await assetConfig.getConfig(dep.custodianId, TSLA);
  if (cfg.exists) {
    console.log("AssetConfig: TSLA already configured");
  } else {
    await (
      await assetConfig.setAssetConfig(
        dep.custodianId,
        TSLA,
        TSLA,
        chainId,
        true,
        0,
        COVERAGE_BPS,
        MAX_ORACLE_AGE,
        MIN_SAMPLES,
        MIN_SAMPLE_GAP,
        ASSET_ID,
        [chainId]
      )
    ).wait();
    console.log("AssetConfig: TSLA configured (stock token, home chain only, 103% floor)");
  }

  const total = readBook(BOOKS[net].tsla!).reduce((s, l) => s + BigInt(l.amount), 0n);
  const need = (total * BigInt(COVERAGE_BPS) + 9999n) / 10000n;
  let reserve: bigint = await token.balanceOf(dep.reserveWallet);
  console.log(`Book ${ethers.formatEther(total)} TSLA → need ${ethers.formatEther(need)} in reserve, have ${ethers.formatEther(reserve)}`);

  if (reserve < need) {
    const mine: bigint = await token.balanceOf(deployer.address);
    if (mine > 0n) {
      await (await token.transfer(dep.reserveWallet, mine)).wait();
      reserve += mine;
      console.log(`Moved ${ethers.formatEther(mine)} TSLA from deployer to reserve wallet`);
    }
  }
  if (reserve < need) {
    console.log(`WARNING: reserve wallet is still short (${ethers.formatEther(reserve)} TSLA). Fund it before publishing.`);
  } else {
    console.log(`Coverage ${(Number((reserve * 10000n) / total) / 100).toFixed(1)}% ✓`);
  }

  dep.contracts.TSLA = TSLA;
  dep.assetIds = { ...(dep.assetIds ?? {}), tsla: ASSET_ID };
  fs.writeFileSync(depPath, JSON.stringify(dep, null, 2));
  console.log(`Updated ${depPath}. Next: ASSETS=tsla npm run ops:cycle:rh`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
