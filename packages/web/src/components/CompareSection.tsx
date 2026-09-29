import Link from "next/link";
import { GITHUB_URL } from "../lib/deployments";

const STOCKGUARD_URL = "https://arbitrum-singapore.hackquest.io/projects/StockGuard";

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
        Reserves drained (<code>LIVE_SHORT</code>), a proof left to go <code>STALE</code>, liabilities understated
        (user fraud proofs, <code>DISPUTED</code>), an unanswered balance challenge, an unpaid exit claim (
        <code>EXIT_DEFAULT</code>), a stock split the liability book hasn&apos;t caught up with (
        <code>MULTIPLIER_DRIFT</code>)
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

/** Price guards vs ReserveProof: why a stock-token market needs both. Used on / and /compare. */
export function CompareSection({ standalone = false, onWhatIf }: { standalone?: boolean; onWhatIf?: () => void }) {
  const whatIf = onWhatIf ? (
    <a
      href="#"
      onClick={(e) => {
        e.preventDefault();
        onWhatIf();
      }}
    >
      what-if simulator
    </a>
  ) : (
    <Link href="/">what-if simulator</Link>
  );
  return (
    <section className="compare" aria-label="Price safety vs reserve safety">
      {!standalone && (
        <p className="section-kicker">
          Price safety is not reserve safety{" "}
          <span className="muted-text">
            · <Link href="/compare">how we differ</Link>
          </span>
        </p>
      )}
      <h2 className="compare-head">They block bad prices. We block unproven reserves and unpaid exits.</h2>
      <p className="compare-lede">
        Price guards such as{" "}
        <a href={STOCKGUARD_URL} target="_blank" rel="noreferrer">
          StockGuard
        </a>{" "}
        stop a Morpho market from lending on a price it can&apos;t trust. ReserveProof stops it from lending against
        a stock token whose custodian can&apos;t prove it still holds the stock. They fail on different days, so a
        market needs both.
      </p>

      <table className="compare-table">
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col">Price guards (StockGuard)</th>
            <th scope="col">ReserveProof</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              <td data-label="Price guards">{r.price}</td>
              <td data-label="ReserveProof">{r.reserve}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mainnet-card compare-stack">
        <div className="mainnet-head">
          <span className="pill ok">stack them</span>
          <span className="value">One constructor: the price guard becomes the base oracle, ReserveProof gates it.</span>
        </div>
        <pre className="compare-code mono">
          {`new SolvencyGatedMorphoOracle(
    stockGuardOracle,           // base price: already refuses bad prices
    solvencyOracle, custodianId, TSLA,
    72 hours, 6 hours, 5000     // freeze cap, poke gap, 50% price after the cap
);`}
        </pre>
        <p className="mainnet-links">
          See it fail closed: the {whatIf} on the live contracts ·{" "}
          <a href={`${GITHUB_URL}#re-run-the-morpho-freeze-yourself`} target="_blank" rel="noreferrer">
            <code>npm run demo:morpho-fork</code>
          </a>{" "}
          against the real Morpho Blue on a mainnet fork · <Link href="/risk">curator risk</Link>: which gated markets
          would freeze, and when · <Link href="/radar">mainnet radar</Link>: every live Morpho market marked would gate,
          wouldn&apos;t, or copycat
        </p>
      </div>
    </section>
  );
}
