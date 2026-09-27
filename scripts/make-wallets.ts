/**
 * Create the testnet reserve wallet (shared by both chains) and a private demo user.
 * Writes gitignored deployments/wallets.local.json; refuses to overwrite unless FORCE=1.
 * Usage: npx ts-node scripts/make-wallets.ts
 */
import { Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";

const outDir = path.join(__dirname, "..", "deployments");
const outFile = path.join(outDir, "wallets.local.json");

type WalletsFile = {
  reserve: { address: string; privateKey: string };
  demoUser: { address: string; privateKey: string };
};

function main() {
  if (fs.existsSync(outFile) && process.env.FORCE !== "1") {
    const existing = JSON.parse(fs.readFileSync(outFile, "utf8")) as WalletsFile;
    console.log(`${outFile} already exists (set FORCE=1 to regenerate)`);
    console.log(`Reserve:   ${existing.reserve.address}`);
    console.log(`Demo user: ${existing.demoUser.address}`);
    return;
  }
  const reserve = Wallet.createRandom();
  const demoUser = Wallet.createRandom();
  const doc: WalletsFile = {
    reserve: { address: reserve.address, privateKey: reserve.privateKey },
    demoUser: { address: demoUser.address, privateKey: demoUser.privateKey },
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(doc, null, 2));
  console.log(`Wrote ${outFile} (gitignored — do not commit)`);
  console.log(`Reserve:   ${reserve.address}`);
  console.log(`Demo user: ${demoUser.address}`);
}

main();
