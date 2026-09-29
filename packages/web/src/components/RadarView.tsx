"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { GITHUB_URL } from "../lib/deployments";
import type { RadarMarket, RadarReport, Verdict, WarningCode } from "../lib/radar";

const REFRESH_MS = 5 * 60_000;

type VerdictFilter = "all" | Verdict;

const VERDICT_LABEL: Record<Verdict, string> = {
  "would-gate": "would gate",
  wouldnt: "wouldn't gate",
  reject: "reject",
};

const WARNING_LABEL: Record<WarningCode, string> = {
  COPYCAT: "copycat",
  MULTIPLIER_PENDING: "corporate action pending",
  MULTIPLIER_MISMATCH: "multiplier mismatch",
  PRICE_OUTLIER: "price outlier",
  ORACLE_REVERTS: "oracle reverts",
};

function fmt(n: number, max = 2) {
  return n.toLocaleString("en-US", { maximumFractionDigits: max });
}

function amount(n: number) {
  if (n === 0) return "0";
  if (n >= 1e6) return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
  if (n >= 1000) return fmt(n, 0);
  if (n < 0.01) return "<0.01";
  return fmt(n, 2);
}

function price(n: number | null) {
  if (n === null) return "reverts";
  if (n === 0) return "0";
  if (n >= 1e9 || n < 1e-4) return n.toExponential(2);
  return n.toLocaleString("en-US", { maximumSignificantDigits: 6 });
}

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function ago(sec: number, now: number) {
  const s = Math.max(0, now - sec);
  return s < 90 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

function ClassBadge({ m }: { m: RadarMarket }) {
  switch (m.collateral.class) {
    case "issuer":
      return <span className="radar-badge ok">issuer-listed</span>;
    case "usdg":
      return <span className="radar-badge ok">Paxos USDG</span>;
    case "copycat":
      return <span className="radar-badge bad">copycat</span>;
    default:
      return null;
  }
}

function MarketRow({ m, explorer, usdg }: { m: RadarMarket; explorer: string; usdg: string }) {
  const colLabel = m.collateral.symbol || short(m.collateral.address);
  const loanLabel = m.loan.symbol || short(m.loan.address);
  const officialUsdg = m.loan.address.toLowerCase() === usdg.toLowerCase();
  return (
    <tr className={`radar-row ${m.verdict}`}>
      <td data-label="Market">
        <div className="radar-market">
          <a href={`${explorer}/address/${m.collateral.address}`} target="_blank" rel="noreferrer">
            <strong>{colLabel}</strong>
          </a>
          <ClassBadge m={m} />
        </div>
        <div className="muted-text radar-name">{m.collateral.registry?.name || m.collateral.name || "—"}</div>
        <div className="radar-loan">
          lends{" "}
          <a href={`${explorer}/address/${m.loan.address}`} target="_blank" rel="noreferrer">
            {loanLabel}
          </a>
          {m.loan.copycat && <span className="radar-badge bad">not the real {loanLabel}</span>}
          {officialUsdg && <span className="muted-text"> (Paxos)</span>}
        </div>
      </td>
      <td data-label="Supplied / borrowed" className="mono">
        {amount(m.supply)} / {amount(m.borrow)}
        <div className="muted-text">{loanLabel}</div>
      </td>
      <td data-label="LLTV" className="mono">
        {fmt(m.lltv * 100, 1)}%
      </td>
      <td data-label="Oracle">
        <span className={`mono ${m.oracle.reverts ? "bad-text" : ""}`}>{price(m.oracle.price)}</span>
        <div className="muted-text">
          {m.oracle.address === "0x0000000000000000000000000000000000000000" ? (
            "no oracle"
          ) : (
            <a href={`${explorer}/address/${m.oracle.address}`} target="_blank" rel="noreferrer">
              {m.oracle.type && m.oracle.type !== "Unknown" ? m.oracle.type : short(m.oracle.address)}
            </a>
          )}
          {m.oracle.gated && <span className="radar-badge ok">ReserveProof-gated</span>}
        </div>
      </td>
      <td data-label="Verdict">
        <span className={`pill radar-verdict ${m.verdict}`}>{VERDICT_LABEL[m.verdict]}</span>
        {m.warnings.length > 0 && (
          <ul className="radar-warnings">
            {m.warnings.map((w, i) => (
              <li key={i}>
                <span className={`radar-chip ${w.code === "ORACLE_REVERTS" ? "soft" : ""}`}>{WARNING_LABEL[w.code]}</span>{" "}
                <span className="radar-warn-text">{w.text}</span>
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}

export function RadarView() {
  const [report, setReport] = useState<RadarReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [verdict, setVerdict] = useState<VerdictFilter>("all");
  const [warnOnly, setWarnOnly] = useState(false);
  const [hideEmpty, setHideEmpty] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/radar", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setReport(body as RadarReport);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 5000);
    return () => clearInterval(t);
  }, []);

  const rows = useMemo(() => {
    if (!report) return [];
    return report.markets.filter(
      (m) =>
        (verdict === "all" || m.verdict === verdict) &&
        (!warnOnly || m.warnings.length > 0) &&
        (!hideEmpty || m.supply > 0 || m.borrow > 0)
    );
  }, [report, verdict, warnOnly, hideEmpty]);

  const s = report?.summary;
  const warnTotal = s ? Object.values(s.warnings).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="shell">
      <header className="risk-hero">
        <p className="eyebrow">ReserveProof · mainnet radar</p>
        <h1 className="headline">Which Morpho markets ReserveProof would gate.</h1>
        <p className="lede">
          Every Morpho Blue market on Robinhood Chain mainnet, read live at one block. Markets lending against USDG or
          an issuer-listed Robinhood Stock Token would freeze on a failed custody proof; tokens that only look like
          one are flagged as copycats. Sources: the Morpho API for the market list, Robinhood&apos;s official asset
          registry for which token contracts are real, and the chain itself (Multicall3) for every number.
        </p>
        <div className="cta-row">
          <Link className="ghost" href="/">
            ← Live demo
          </Link>
          <Link className="ghost" href="/risk">
            Curator risk
          </Link>
          <Link className="ghost" href="/compare">
            How we differ
          </Link>
          <a className="ghost" href="/api/radar" target="_blank" rel="noreferrer">
            JSON feed
          </a>
        </div>
      </header>

      <section className="live-strip" aria-label="Summary">
        <div className="strip-cell">
          <span className="label">Would gate</span>
          <span className="big">{s ? `${s.wouldGate.markets} markets` : "—"}</span>
          <span className="sub">
            {s
              ? `${amount(s.wouldGate.usdgSupplied)} USDG lent, ${amount(s.wouldGate.usdgBorrowed)} borrowed against ${s.issuerTokens} issuer-listed tokens and USDG`
              : ""}
          </span>
        </div>
        <div className="strip-cell">
          <span className="label">Gated today</span>
          <span className="big">{s ? s.gatedToday : "—"}</span>
          <span className="sub">no custodian publishes proofs on mainnet yet</span>
        </div>
        <div className="strip-cell">
          <span className="label">Copycats to reject</span>
          <span className={`big ${s && s.reject.markets ? "bad-text" : ""}`}>{s ? `${s.reject.markets} markets` : "—"}</span>
          <span className="sub">{s ? `${s.reject.tokens} fake token${s.reject.tokens === 1 ? "" : "s"} (collateral or loan)` : ""}</span>
        </div>
        <div className="strip-cell">
          <span className="label">Warnings</span>
          <span className={`big ${warnTotal ? "warn-text" : ""}`}>{s ? warnTotal : "—"}</span>
          <span className="sub">
            {s
              ? (Object.keys(s.warnings) as WarningCode[])
                  .filter((k) => s.warnings[k] > 0)
                  .map((k) => `${s.warnings[k]} ${WARNING_LABEL[k]}`)
                  .join(" · ") || "none"
              : ""}
          </span>
        </div>
      </section>

      <div className="radar-toolbar" role="group" aria-label="Filters">
        {(["all", "would-gate", "wouldnt", "reject"] as VerdictFilter[]).map((v) => (
          <button
            key={v}
            type="button"
            className={`radar-filter ${verdict === v ? "on" : ""}`}
            aria-pressed={verdict === v}
            onClick={() => setVerdict(v)}
          >
            {v === "all" ? "all" : VERDICT_LABEL[v]}
          </button>
        ))}
        <button
          type="button"
          className={`radar-filter ${warnOnly ? "on" : ""}`}
          aria-pressed={warnOnly}
          onClick={() => setWarnOnly((x) => !x)}
        >
          only with warnings
        </button>
        <button
          type="button"
          className={`radar-filter ${hideEmpty ? "on" : ""}`}
          aria-pressed={hideEmpty}
          onClick={() => setHideEmpty((x) => !x)}
        >
          hide empty markets
        </button>
        {report && (
          <span className="muted-text mono radar-meta">
            {rows.length} of {report.summary.marketsListed} · block{" "}
            <a href={`${report.explorer}/block/${report.block}`} target="_blank" rel="noreferrer">
              {report.block}
            </a>{" "}
            · read {ago(report.readAt, now)}
          </span>
        )}
      </div>

      {!report && !error && <p className="muted-text">Reading every market from Robinhood Chain mainnet (about 6 seconds)…</p>}
      {error && <p className="bad-text">Could not load the radar: {error}</p>}
      {report && report.errors.length > 0 && (
        <p className="warn-text risk-errors">
          {report.errors.length} source{report.errors.length > 1 ? "s" : ""} degraded: {report.errors.slice(0, 3).join("; ")}
        </p>
      )}

      {report && (
        <table className="risk-table radar-table">
          <thead>
            <tr>
              <th>Market (collateral → loan)</th>
              <th>Supplied / borrowed</th>
              <th>LLTV</th>
              <th>Oracle price</th>
              <th>Verdict · warnings</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <MarketRow key={m.id} m={m} explorer={report.explorer} usdg={report.usdg} />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="muted-text">
                  No market matches these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      <section className="radar-method" aria-label="Method">
        <p className="section-kicker">How to read this</p>
        <ul>
          <li>
            <strong>Would gate</strong>: the collateral is Paxos USDG or a token contract listed in Robinhood&apos;s
            asset registry (<span className="mono">api.robinhood.com/rhj/assets</span>). Wrapping this market&apos;s
            current oracle in a <span className="mono">SolvencyGatedMorphoOracle</span> would freeze borrowing and
            liquidations while the custodian&apos;s proof fails. These verdicts describe what our wrapper would do; none
            of these markets is gated today.
          </li>
          <li>
            <strong>Wouldn&apos;t gate</strong>: crypto or other collateral with no custodian to prove. Price guards are
            the right tool there.
          </li>
          <li>
            <strong>Reject</strong>: the collateral or the loan token is not the registry-listed contract, yet it calls
            itself USDG, carries a Robinhood name or listed ticker, or answers ERC-8056{" "}
            <span className="mono">uiMultiplier()</span>. No custodian stands behind it.
          </li>
          <li>
            <strong>Corporate action pending</strong>: the token&apos;s on-chain <span className="mono">effectiveAt</span> is
            in the future with a different <span className="mono">newUIMultiplier</span>, or the registry lists a pending
            multiplier. A ReserveProof-gated market returns MULTIPLIER_DRIFT until the custodian recommits.{" "}
            <strong>Multiplier mismatch</strong>: on-chain <span className="mono">uiMultiplier</span> differs from the
            registry&apos;s current multiplier (tolerance 1e-9).
          </li>
          <li>
            <strong>Price outlier</strong>: the market&apos;s oracle price is more than 5% from the median of every market
            pricing the same collateral in the same loan token. Prices are loan-token units per whole collateral token.
            <strong> Oracle reverts</strong>: <span className="mono">price()</span> fails, so the market is already
            stuck.
          </li>
          <li>
            Rows list official-USDG markets first, then the rest; each group by borrowed. Amounts are in each
            market&apos;s own loan token. The page refreshes every 5 minutes (the API is cached for 5).
          </li>
        </ul>
      </section>

      <footer className="foot">
        <span>
          <Link href="/">Live demo</Link> · <Link href="/risk">Curator risk</Link> · <Link href="/compare">How we differ</Link>{" "}
          · <Link href="/verify">Verify</Link> · <Link href="/status">Status</Link> ·{" "}
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>{" "}
          · MIT licensed
        </span>
        <span>
          JSON: <a href="/api/radar">/api/radar</a>
        </span>
      </footer>
    </div>
  );
}
