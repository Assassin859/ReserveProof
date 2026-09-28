import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";

const CHALLENGE_BOND = 1_000_000n;
const CLEAR_TIMELOCK = 3600;
const CHALLENGE_WINDOW = 3600;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const depPath = path.resolve(
    process.env.DEPLOYMENT || `deployments/${hre.network.name}.json`
  );
  const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
  const c = dep.contracts;

  const targets: [string, string, unknown[]][] = [
    ["CustodianRegistry", c.CustodianRegistry, [dep.deployer]],
    ["AssetConfig", c.AssetConfig, [dep.deployer, c.CustodianRegistry]],
    ["LiabilityLedger", c.LiabilityLedger, [c.CustodianRegistry, c.AssetConfig, dep.deploymentSalt]],
    ["ReserveSampler", c.ReserveSampler, [c.CustodianRegistry, c.AssetConfig, c.LiabilityLedger]],
    [
      "DisputeModule",
      c.DisputeModule,
      [c.CustodianRegistry, c.LiabilityLedger, c.USDG, CHALLENGE_BOND, CLEAR_TIMELOCK, CHALLENGE_WINDOW],
    ],
    [
      "SolvencyOracle",
      c.SolvencyOracle,
      [c.CustodianRegistry, c.AssetConfig, c.LiabilityLedger, c.ReserveSampler, c.DisputeModule, dep.deployer],
    ],
    ["ExitRight", c.ExitRight, [c.CustodianRegistry, c.LiabilityLedger, c.USDG]],
    ["MockStockToken", c.MockStockToken, ["Mock TSLA", "mTSLA"]],
    ["GatedPayout", c.GatedPayout, [c.SolvencyOracle, dep.custodianId, c.MockStockToken]],
    ["GatedLendWithdraw", c.GatedLendWithdraw, [c.SolvencyOracle, dep.custodianId, c.MockStockToken]],
  ];
  if (c.GuardedLendingVault && dep.vault) {
    targets.push([
      "GuardedLendingVault",
      c.GuardedLendingVault,
      [c.SolvencyOracle, dep.custodianId, c.MockStockToken, c.USDG, dep.vault.collateralPrice, dep.vault.ltvBps],
    ]);
  }

  const only = process.env.ONLY?.split(",");
  const delayMs = Number(process.env.VERIFY_DELAY_MS || "5000");
  // Blockscout reports byte-identical redeploys as verified via a "twin"; FORCE=1 submits anyway.
  const force = process.env.FORCE === "1";
  for (const [name, address, constructorArguments] of targets) {
    if (only && !only.includes(name)) continue;
    console.log(`\n== ${name} @ ${address}`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await hre.run("verify:verify", { address, constructorArguments, force });
        break;
      } catch (e) {
        const msg = (e as Error).message;
        if (/already verified/i.test(msg)) {
          console.log("already verified");
          break;
        }
        if (/429|too many requests/i.test(msg) && attempt < 3) {
          console.log(`rate limited — retrying in ${(delayMs * 6) / 1000}s`);
          await sleep(delayMs * 6);
          continue;
        }
        console.log(`FAILED: ${msg.split("\n")[0]}`);
        break;
      }
    }
    await sleep(delayMs);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
