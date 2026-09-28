/**
 * Create fresh Robinhood Chain mainnet keys, separate from the testnet key:
 *   - deployer (operator): pays gas, publishes epochs and samples
 *   - reserve: the custodian wallet whose USDG / TSLA balance is proven
 *   - demoUser: one liability leaf a judge can verify
 * Writes gitignored deployments/wallets.mainnet.local.json and appends MAINNET_PRIVATE_KEY to .env.
 * Never prints private keys. Refuses to overwrite unless FORCE=1.
 *
 *   npx ts-node scripts/make-mainnet-wallets.ts
 */
import { Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";

const root = path.join(__dirname, "..");
const outFile = path.join(root, "deployments", "wallets.mainnet.local.json");
const envFile = path.join(root, ".env");

type Key = { address: string; privateKey: string };
type MainnetWallets = { deployer: Key; reserve: Key; demoUser: Key };

function key(): Key {
  const w = Wallet.createRandom();
  return { address: w.address, privateKey: w.privateKey };
}

function main() {
  let doc: MainnetWallets;
  if (fs.existsSync(outFile) && process.env.FORCE !== "1") {
    doc = JSON.parse(fs.readFileSync(outFile, "utf8"));
    console.log(`${outFile} already exists (FORCE=1 to regenerate)`);
  } else {
    doc = { deployer: key(), reserve: key(), demoUser: key() };
    fs.writeFileSync(outFile, JSON.stringify(doc, null, 2));
    console.log(`Wrote ${outFile} (gitignored, never commit)`);
  }

  const env = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
  const line = `MAINNET_PRIVATE_KEY=${doc.deployer.privateKey}`;
  if (!/^MAINNET_PRIVATE_KEY=/m.test(env)) {
    fs.writeFileSync(envFile, `${env}${env.endsWith("\n") || env === "" ? "" : "\n"}${line}\n`);
    console.log("Appended MAINNET_PRIVATE_KEY to .env");
  } else if (!env.includes(line)) {
    console.log("WARNING: .env has a different MAINNET_PRIVATE_KEY than the wallets file");
  }

  console.log(`Deployer:  ${doc.deployer.address}   <- fund with ~0.005 ETH (Robinhood Chain mainnet)`);
  console.log(`Reserve:   ${doc.reserve.address}   <- send ~5 USDG (optionally a little TSLA)`);
  console.log(`Demo user: ${doc.demoUser.address}`);
}

main();
