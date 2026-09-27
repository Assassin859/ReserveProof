/**
 * Scheduled operator cycle: for each asset book on this network, build the tree for
 * latestEpochId + 1, commit it, then record fresh reserve samples.
 *
 * Usage: npx hardhat run scripts/ops-cycle.ts --network robinhoodTestnet
 * Env: DEPLOYMENT (default deployments/<network>.json), ASSETS=stock,usdg (default: every book for the network)
 */
import hre from "hardhat";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { buildSortedTree } from "../packages/merkle/src/index";
import { BOOKS, readBook, type AssetKind } from "./books";
import { publishEpoch } from "./publish-epoch";
import { recordSamples } from "./record-samples";

async function main() {
  const net = hre.network.name;
  const depPath = path.resolve(process.env.DEPLOYMENT || `deployments/${net}.json`);
  const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
  const books = BOOKS[net];
  if (!books) throw new Error(`No liability books configured for ${net}`);

  const only = process.env.ASSETS?.split(",").map((s) => s.trim()) as AssetKind[] | undefined;
  const kinds = (Object.keys(books) as AssetKind[]).filter((k) => !only || only.includes(k));
  const ledger = await ethers.getContractAt("LiabilityLedger", dep.contracts.LiabilityLedger);
  const oracle = await ethers.getContractAt("SolvencyOracle", dep.contracts.SolvencyOracle);
  const assetOf = (k: AssetKind) => (k === "stock" ? dep.contracts.MockStockToken : dep.contracts.USDG) as string;

  for (const kind of kinds) {
    const asset = assetOf(kind);
    const next = Number(await ledger.latestEpochId(dep.custodianId, asset)) + 1;
    const leaves = readBook(books[kind]!).map((l) => ({ user: l.user, amount: BigInt(l.amount) }));
    const tree = buildSortedTree(dep.custodianId, asset, next, leaves);

    const outDir = path.join("out", net, kind);
    fs.mkdirSync(path.join(outDir, "proofs"), { recursive: true });
    const rootDoc = {
      custodianId: dep.custodianId,
      asset: ethers.getAddress(asset),
      epochId: next,
      root: tree.root,
      total: tree.total.toString(),
      leafCount: tree.leafCount,
      sorted: tree.sorted.map((l) => ({ user: l.user, amount: l.amount.toString() })),
    };
    fs.writeFileSync(path.join(outDir, "root.json"), JSON.stringify(rootDoc, null, 2));
    for (const leaf of tree.sorted) {
      const proof = tree.proofs.get(leaf.user.toLowerCase())!;
      fs.writeFileSync(
        path.join(outDir, "proofs", `${leaf.user}.json`),
        JSON.stringify(
          {
            user: leaf.user,
            amount: leaf.amount.toString(),
            proof: proof.map((p) => ({ hash: p.hash, sum: p.sum.toString(), isLeft: p.isLeft })),
          },
          null,
          2
        )
      );
    }

    console.log(`\n== ${net} ${kind}: epoch ${next} ==`);
    await publishEpoch({ rootDoc, dep });
  }

  for (const kind of kinds) {
    console.log(`\n== ${net} ${kind}: samples ==`);
    await recordSamples({ dep, asset: assetOf(kind) });
  }

  for (const kind of kinds) {
    const s = await oracle.status(dep.custodianId, assetOf(kind));
    console.log(`${net} ${kind}: ok=${s.ok} reason=${s.reason} epoch=${s.epochId}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
