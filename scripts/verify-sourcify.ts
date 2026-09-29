/**
 * Keyless verification via Sourcify's v2 API (hardhat-verify 2.x still targets the retired v1 API).
 * Usage: DEPLOYMENT=deployments/arbitrumSepolia.json [ONLY=A,B] npm run verify:sourcify
 * Run `npm run build` first so artifacts/build-info matches the deployed bytecode.
 */
import * as fs from "fs";
import * as path from "path";

const SOURCIFY = "https://sourcify.dev/server";
const depFile = process.env.DEPLOYMENT || "deployments/arbitrumSepolia.json";
const dep = JSON.parse(fs.readFileSync(depFile, "utf8"));
const only = (process.env.ONLY || "").split(",").filter(Boolean);

const SOURCES: Record<string, string> = {
  CustodianRegistry: "src/CustodianRegistry.sol",
  AssetConfig: "src/AssetConfig.sol",
  LiabilityLedger: "src/LiabilityLedger.sol",
  ReserveSampler: "src/ReserveSampler.sol",
  DisputeModule: "src/DisputeModule.sol",
  SolvencyOracle: "src/SolvencyOracle.sol",
  ExitRight: "src/ExitRight.sol",
  MockStockToken: "src/mocks/MockStockToken.sol",
  GatedPayout: "src/composers/GatedPayout.sol",
  GatedLendWithdraw: "src/composers/GatedLendWithdraw.sol",
  GuardedLendingVault: "src/examples/GuardedLendingVault.sol",
  VaultLoanToken: "src/mocks/MockUSDG.sol:MockUSDG",
  FixedPriceMorphoOracle: "src/integrations/FixedPriceMorphoOracle.sol",
  SolvencyGatedMorphoOracle: "src/integrations/SolvencyGatedMorphoOracle.sol",
};

const buildInfoDir = "artifacts/build-info";
const buildInfos = fs
  .readdirSync(buildInfoDir)
  .map((f) => path.join(buildInfoDir, f))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  .map((f) => JSON.parse(fs.readFileSync(f, "utf8")));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  for (const [name, spec] of Object.entries(SOURCES)) {
    if (only.length && !only.includes(name)) continue;
    const address = dep.contracts[name];
    if (!address) continue;
    const [source, contract = name] = spec.split(":");
    const bi = buildInfos.find((b) => b.output?.contracts?.[source]?.[contract]);
    if (!bi) throw new Error(`No build-info for ${source}:${contract}`);

    const res = await fetch(`${SOURCIFY}/v2/verify/${dep.chainId}/${address}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stdJsonInput: bi.input,
        compilerVersion: bi.solcLongVersion,
        contractIdentifier: `${source}:${contract}`,
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      console.log(`${name}: submit ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
      continue;
    }
    const id = body.verificationId;
    for (let i = 0; i < 40; i++) {
      await sleep(3000);
      const job = await (await fetch(`${SOURCIFY}/v2/verify/${id}`)).json();
      if (job.isJobCompleted) {
        if (job.error) console.log(`${name}: FAILED ${job.error.customCode} ${job.error.message?.slice(0, 160)}`);
        else console.log(`${name}: ${job.contract?.match ?? job.contract?.runtimeMatch} match`);
        break;
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
