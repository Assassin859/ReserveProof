import Link from "next/link";
import { GITHUB_URL } from "../lib/deployments";
import { CodeBlock } from "./site/CopyButton";
import { Section } from "./site/PageHeader";
import { StateBadge } from "./site/StateBadge";
import { Card, CardContent } from "./ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

const STOCKGUARD_URL = "https://arbitrum-singapore.hackquest.io/projects/StockGuard";

const code = (s: string) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.8em] text-foreground">{s}</code>;

const ROWS: { label: string; price: React.ReactNode; reserve: React.ReactNode }[] = [
  {
    label: "Question it answers",
    price: "Is this price right, fresh and from the right source?",
    reserve: "Does the custodian still hold what it owes, and will it pay people who exit?",
  },
  {
    label: "What it catches",
    price: "Market closed, a split or dividend mid-flight, the wrong feed, a copycat token",
    reserve: (
      <>
        Reserves drained ({code("LIVE_SHORT")}), a proof left to go {code("STALE")}, liabilities understated (user fraud
        proofs, {code("DISPUTED")}), an unanswered balance challenge, an unpaid exit claim ({code("EXIT_DEFAULT")}), a
        stock split the liability book hasn&apos;t caught up with ({code("MULTIPLIER_DRIFT")})
      </>
    ),
  },
  {
    label: "Blind spot",
    price: "A perfectly priced token whose custodian has already sold the stock behind it",
    reserve: "Whether the price itself is right: it forwards whatever the base oracle says",
  },
  {
    label: "On Morpho",
    price: "Replaces the market's oracle",
    reserve: "Wraps any base oracle, including a price guard",
  },
];

const STACK_CODE = `new SolvencyGatedMorphoOracle(
    stockGuardOracle,           // base price: already refuses bad prices
    solvencyOracle, custodianId, TSLA,
    72 hours, 6 hours, 5000     // freeze cap, poke gap, 50% price after the cap
);`;

const link = "text-primary underline-offset-4 hover:underline";

/** Price guards vs ReserveProof: why a stock-token market needs both. Used on / and /compare. */
export function CompareSection({ standalone = false, onWhatIf }: { standalone?: boolean; onWhatIf?: () => void }) {
  const whatIf = onWhatIf ? (
    <a
      href="#demo"
      className={link}
      onClick={(e) => {
        e.preventDefault();
        onWhatIf();
      }}
    >
      what-if simulator
    </a>
  ) : (
    <Link href="/#demo" className={link}>
      what-if simulator
    </Link>
  );
  return (
    <Section
      id="compare"
      kicker={standalone ? undefined : "Price safety is not reserve safety"}
      title="They block bad prices. We block unproven reserves and unpaid exits."
      description={
        <>
          Price guards such as{" "}
          <a href={STOCKGUARD_URL} target="_blank" rel="noreferrer" className={link}>
            StockGuard
          </a>{" "}
          stop a Morpho market from lending on a price it can&apos;t trust. ReserveProof stops it from lending against a
          stock token whose custodian can&apos;t prove it still holds the stock. They fail on different days, so a market
          needs both.
        </>
      }
      actions={
        standalone ? undefined : (
          <Link href="/compare" className="text-sm text-primary underline-offset-4 hover:underline">
            How we differ →
          </Link>
        )
      }
    >
      <div className="hidden overflow-hidden rounded-xl border border-border/70 bg-card/50 md:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-44" />
              <TableHead className="text-muted-foreground">Price guards (StockGuard)</TableHead>
              <TableHead className="text-primary">ReserveProof</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ROWS.map((r) => (
              <TableRow key={r.label} className="align-top hover:bg-transparent">
                <TableCell className="py-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {r.label}
                </TableCell>
                <TableCell className="py-4 text-sm leading-relaxed text-muted-foreground">{r.price}</TableCell>
                <TableCell className="bg-primary/[0.03] py-4 text-sm leading-relaxed">{r.reserve}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-3 md:hidden">
        {ROWS.map((r) => (
          <div key={r.label} className="rounded-xl border border-border/70 bg-card/50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{r.label}</p>
            <p className="mt-3 text-[0.7rem] uppercase tracking-wide text-muted-foreground">Price guards</p>
            <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{r.price}</p>
            <p className="mt-3 text-[0.7rem] uppercase tracking-wide text-primary">ReserveProof</p>
            <p className="mt-0.5 text-sm leading-relaxed">{r.reserve}</p>
          </div>
        ))}
      </div>

      <Card className="mt-6 border-border/70 bg-card/60">
        <CardContent className="space-y-4 p-5 md:p-6">
          <div className="flex flex-wrap items-center gap-3">
            <StateBadge state="ok">stack them</StateBadge>
            <p className="text-sm">One constructor: the price guard becomes the base oracle, ReserveProof gates it.</p>
          </div>
          <CodeBlock code={STACK_CODE} copyLabel="Copy constructor" />
          <p className="text-sm leading-relaxed text-muted-foreground">
            See it fail closed: the {whatIf} on the live contracts ·{" "}
            <a href={`${GITHUB_URL}#re-run-the-morpho-freeze-yourself`} target="_blank" rel="noreferrer" className={link}>
              <code className="font-mono text-[0.85em]">npm run demo:morpho-fork</code>
            </a>{" "}
            against the real Morpho Blue on a mainnet fork · <Link href="/risk" className={link}>curator risk</Link>: which
            gated markets would freeze, and when · <Link href="/radar" className={link}>mainnet radar</Link>: every live
            Morpho market marked would gate, wouldn&apos;t, or copycat
          </p>
        </CardContent>
      </Card>
    </Section>
  );
}
