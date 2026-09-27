/**
 * One-shot local demo: deploy → CLI build → publish → sample → snapshot.
 * Requires a running node (npm run demo:node). Afterwards, npm run demo:reset restores this state.
 * Usage: npx ts-node scripts/demo-setup.ts
 */
import { spawnSync } from "child_process";

const steps: [string, string[]][] = [
  ["deploy", ["hardhat", "run", "scripts/deploy.ts", "--network", "localhost"]],
  ["cli build", ["ts-node", "scripts/demo-cli-build.ts"]],
  ["publish epoch", ["hardhat", "run", "scripts/publish-epoch.ts", "--network", "localhost"]],
  ["record samples", ["hardhat", "run", "scripts/record-samples.ts", "--network", "localhost"]],
  ["snapshot", ["hardhat", "run", "scripts/demo-snapshot.ts", "--network", "localhost"]],
];

const env = { ...process.env };
for (const k of ["DEPLOYMENT", "ROOT_JSON", "OUT", "CSV", "ASSET", "EPOCH"]) delete env[k];

for (const [label, args] of steps) {
  console.log(`\n=== ${label} ===`);
  const r = spawnSync("npx", args, { stdio: "inherit", shell: true, env });
  if (r.status !== 0) {
    console.error(`\n${label} failed — is the node running? (npm run demo:node)`);
    process.exit(r.status ?? 1);
  }
}
console.log("\nLocal demo ready. Open the UI with npm run demo:web; npm run demo:reset rewinds to this point.");
