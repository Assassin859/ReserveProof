/**
 * Count the test cases CI runs: Hardhat `it(...)` blocks in test/*.ts and Foundry test / fuzz /
 * invariant functions in test/foundry/*.t.sol. Prints a per-file table and the total.
 *
 *   npm run test:count            # table
 *   npm run test:count -- --json  # machine-readable
 */
import * as fs from "fs";
import * as path from "path";

const root = path.join(__dirname, "..");

type Row = { file: string; unit: number; fuzz: number; invariant: number };

function hardhat(): Row[] {
  const dir = path.join(root, "test");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      const unit = (src.match(/^\s*it(\.only)?\(\s*["'`]/gm) ?? []).length;
      return { file: `test/${f}`, unit, fuzz: 0, invariant: 0 };
    })
    .filter((r) => r.unit > 0);
}

function foundry(): Row[] {
  const dir = path.join(root, "test", "foundry");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".t.sol"))
    .map((f) => {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      const fns = [...src.matchAll(/function\s+((?:testFuzz|test|invariant)_?\w*)\s*\(([^)]*)\)/g)];
      let unit = 0;
      let fuzz = 0;
      let invariant = 0;
      for (const [, name, params] of fns) {
        if (name.startsWith("invariant")) invariant++;
        else if (params.trim().length > 0) fuzz++;
        else unit++;
      }
      return { file: `test/foundry/${f}`, unit, fuzz, invariant };
    });
}

export function countTests() {
  const hh = hardhat();
  const rows = [...hh, ...foundry()];
  const sum = (k: keyof Omit<Row, "file">) => rows.reduce((s, r) => s + r[k], 0);
  const totals = { unit: sum("unit"), fuzz: sum("fuzz"), invariant: sum("invariant") };
  const total = totals.unit + totals.fuzz + totals.invariant;
  const hardhatTotal = hh.reduce((s, r) => s + r.unit, 0);
  return { total, hardhat: hardhatTotal, foundry: total - hardhatTotal, ...totals, rows };
}

if (require.main === module) {
  const { total, hardhat: hardhatTotal, rows, ...totals } = countTests();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ total, hardhat: hardhatTotal, ...totals, rows }, null, 2));
  } else {
    print(rows, total, hardhatTotal, totals);
  }
}

function print(rows: Row[], total: number, hardhatTotal: number, totals: { unit: number; fuzz: number; invariant: number }) {
  const w = Math.max(...rows.map((r) => r.file.length));
  console.log(`${"file".padEnd(w)}  unit  fuzz  invariant`);
  for (const r of rows) {
    console.log(`${r.file.padEnd(w)}  ${String(r.unit).padStart(4)}  ${String(r.fuzz).padStart(4)}  ${String(r.invariant).padStart(9)}`);
  }
  console.log(
    `\n${total} tests: ${hardhatTotal} Hardhat + ${total - hardhatTotal} Foundry ` +
      `(${totals.fuzz} fuzz, ${totals.invariant} invariants, ${totals.unit} unit)`
  );
}
