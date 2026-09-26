#!/usr/bin/env ts-node
import * as fs from "fs";
import * as path from "path";
import { getAddress, id } from "ethers";
import { buildSortedTree, neighboursFor, type Leaf } from "../../merkle/src/index";

function usage(): never {
  console.error(`Usage:
  npx ts-node packages/cli/src/index.ts build \\
    --csv <liabilities.csv> \\
    --custodian <bytes32|keccak string> \\
    --asset <address> \\
    --epoch <uint> \\
    --out <dir>

CSV format (header optional): user,amount
  user    — wallet address
  amount  — raw integer (wei / smallest unit)

Custodian may be a 0x-prefixed bytes32 or a string (hashed with keccak256 of UTF-8 via ethers.id).
`);
  process.exit(1);
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (!val || val.startsWith("--")) usage();
      out[key] = val;
      i++;
    }
  }
  return out;
}

function parseCsv(file: string): Leaf[] {
  const text = fs.readFileSync(file, "utf8").trim();
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const start = lines[0].toLowerCase().includes("user") ? 1 : 0;
  const leaves: Leaf[] = [];
  for (let i = start; i < lines.length; i++) {
    const [userRaw, amountRaw] = lines[i].split(",").map((s) => s.trim());
    if (!userRaw || amountRaw === undefined) {
      throw new Error(`Bad CSV line ${i + 1}: ${lines[i]}`);
    }
    leaves.push({ user: getAddress(userRaw), amount: BigInt(amountRaw) });
  }
  return leaves;
}

function resolveCustodian(raw: string): string {
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) return raw.toLowerCase();
  return id(raw);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== "build") usage();
  const args = parseArgs(rest);
  if (!args.csv || !args.custodian || !args.asset || !args.epoch || !args.out) usage();

  const custodianId = resolveCustodian(args.custodian);
  const asset = getAddress(args.asset);
  const epochId = Number(args.epoch);
  if (!Number.isInteger(epochId) || epochId <= 0) throw new Error("epoch must be positive integer");

  const leaves = parseCsv(args.csv);
  if (leaves.length === 0) throw new Error("CSV has no leaves");
  if ((leaves.length & (leaves.length - 1)) !== 0) {
    throw new Error(`leaf count must be a power of two (got ${leaves.length})`);
  }

  const { root, total, sorted, proofs } = buildSortedTree(custodianId, asset, epochId, leaves);

  const outDir = path.resolve(args.out);
  fs.mkdirSync(path.join(outDir, "proofs"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "neighbours"), { recursive: true });

  const rootDoc = {
    custodianId,
    asset,
    epochId,
    root,
    total: total.toString(),
    leafCount: sorted.length,
    sorted: sorted.map((l) => ({ user: l.user, amount: l.amount.toString() })),
  };
  fs.writeFileSync(path.join(outDir, "root.json"), JSON.stringify(rootDoc, null, 2));

  for (const leaf of sorted) {
    const key = leaf.user.toLowerCase();
    const proof = proofs.get(key)!;
    fs.writeFileSync(
      path.join(outDir, "proofs", `${leaf.user}.json`),
      JSON.stringify(
        {
          user: leaf.user,
          amount: leaf.amount.toString(),
          proof: proof.map((p) => ({
            hash: p.hash,
            sum: p.sum.toString(),
            isLeft: p.isLeft,
          })),
        },
        null,
        2
      )
    );

    const n = neighboursFor(sorted, leaf.user);
    fs.writeFileSync(
      path.join(outDir, "neighbours", `${leaf.user}.json`),
      JSON.stringify(
        {
          user: leaf.user,
          leftUser: n.leftUser,
          leftAmount: n.leftAmount?.toString() ?? null,
          rightUser: n.rightUser,
          rightAmount: n.rightAmount?.toString() ?? null,
        },
        null,
        2
      )
    );
  }

  console.log(`Wrote root ${root}`);
  console.log(`Total liability ${total.toString()} over ${sorted.length} leaves`);
  console.log(`Output: ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
