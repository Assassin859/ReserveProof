"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Loader2, Search } from "lucide-react";
import type { RadarMarket, RadarReport, RadarWarning, Verdict, WarningCode } from "../lib/radar";
import { cn } from "../lib/utils";
import { ACTIVE_TOGGLE } from "./home/parts";
import { Donut } from "./site/Donut";
import { KpiCard } from "./site/KpiCard";
import { ExtLink, PageHeader, Section } from "./site/PageHeader";
import { StateBadge } from "./site/StateBadge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Input } from "./ui/input";
import { Skeleton } from "./ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Toggle } from "./ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const REFRESH_MS = 5 * 60_000;

type VerdictFilter = "all" | Verdict;
type SortKey = "default" | "supply" | "borrow" | "lltv";

const VERDICT_LABEL: Record<Verdict, string> = {
  "would-gate": "would gate",
  wouldnt: "wouldn't gate",
  reject: "reject",
};

const VERDICT_TONE: Record<Verdict, string> = { "would-gate": "ok", wouldnt: "neutral", reject: "bad" };

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

const addrLink = "transition-colors hover:text-primary";

function ClassBadge({ m }: { m: RadarMarket }) {
  switch (m.collateral.class) {
    case "issuer":
      return <StateBadge state="ok" dot={false} className="normal-case">issuer-listed</StateBadge>;
    case "usdg":
      return <StateBadge state="ok" dot={false} className="normal-case">Paxos USDG</StateBadge>;
    case "copycat":
      return <StateBadge state="bad" dot={false} className="normal-case">copycat</StateBadge>;
    default:
      return null;
  }
}

function WarningBadge({ w }: { w: RadarWarning }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex cursor-help items-center rounded-md border px-1.5 py-0.5 text-[0.7rem] font-medium",
            w.code === "ORACLE_REVERTS"
              ? "border-border bg-muted/60 text-muted-foreground"
              : "border-warning/30 bg-warning/10 text-warning"
          )}
        >
          {WARNING_LABEL[w.code]}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs leading-relaxed">{w.text}</TooltipContent>
    </Tooltip>
  );
}

function MarketCell({ m, explorer, usdg }: { m: RadarMarket; explorer: string; usdg: string }) {
  const colLabel = m.collateral.symbol || short(m.collateral.address);
  const loanLabel = m.loan.symbol || short(m.loan.address);
  const officialUsdg = m.loan.address.toLowerCase() === usdg.toLowerCase();
  return (
    <div className="min-w-0 space-y-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <a href={`${explorer}/address/${m.collateral.address}`} target="_blank" rel="noreferrer" className={cn("font-semibold", addrLink)}>
          {colLabel}
        </a>
        <ClassBadge m={m} />
      </div>
      <p className="truncate text-xs text-muted-foreground">{m.collateral.registry?.name || m.collateral.name || "—"}</p>
      <p className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">lends</span>
        <a href={`${explorer}/address/${m.loan.address}`} target="_blank" rel="noreferrer" className={cn("font-medium", addrLink)}>
          {loanLabel}
        </a>
        {m.loan.copycat && (
          <StateBadge state="bad" dot={false} className="normal-case">
            not the real {loanLabel}
          </StateBadge>
        )}
        {officialUsdg && <span className="text-muted-foreground">(Paxos)</span>}
      </p>
    </div>
  );
}

function OracleCell({ m, explorer }: { m: RadarMarket; explorer: string }) {
  return (
    <div className="space-y-0.5">
      <p className={cn("font-mono text-sm", m.oracle.reverts && "text-destructive")}>{price(m.oracle.price)}</p>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        {m.oracle.address === "0x0000000000000000000000000000000000000000" ? (
          "no oracle"
        ) : (
          <a href={`${explorer}/address/${m.oracle.address}`} target="_blank" rel="noreferrer" className={addrLink}>
            {m.oracle.type && m.oracle.type !== "Unknown" ? m.oracle.type : short(m.oracle.address)}
          </a>
        )}
        {m.oracle.gated && <StateBadge state="gold" dot={false} className="normal-case">ReserveProof-gated</StateBadge>}
      </div>
    </div>
  );
}

function VerdictCell({ m }: { m: RadarMarket }) {
  return (
    <div className="space-y-1.5">
      <StateBadge state={VERDICT_TONE[m.verdict]}>{VERDICT_LABEL[m.verdict]}</StateBadge>
      {m.warnings.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {m.warnings.map((w, i) => (
            <WarningBadge key={i} w={w} />
          ))}
        </div>
      )}
    </div>
  );
}

function MarketCard({ m, explorer, usdg }: { m: RadarMarket; explorer: string; usdg: string }) {
  const loanLabel = m.loan.symbol || short(m.loan.address);
  return (
    <li className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <MarketCell m={m} explorer={explorer} usdg={usdg} />
        <StateBadge state={VERDICT_TONE[m.verdict]} className="shrink-0">
          {VERDICT_LABEL[m.verdict]}
        </StateBadge>
      </div>
      <dl className="grid grid-cols-[1.4fr_0.8fr_1fr] gap-2 text-xs">
        <div>
          <dt className="text-muted-foreground">Supply / borrow</dt>
          <dd className="font-mono">
            {amount(m.supply)} / {amount(m.borrow)} <span className="text-muted-foreground">{loanLabel}</span>
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">LLTV</dt>
          <dd className="font-mono">{fmt(m.lltv * 100, 1)}%</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Oracle</dt>
          <dd className={cn("font-mono", m.oracle.reverts && "text-destructive")}>{price(m.oracle.price)}</dd>
        </div>
      </dl>
      {m.warnings.length > 0 && (
        <ul className="space-y-1.5 text-xs">
          {m.warnings.map((w, i) => (
            <li key={i} className="rounded-md border border-warning/25 bg-warning/5 px-2.5 py-1.5">
              <span className="font-medium text-warning">{WARNING_LABEL[w.code]}</span>{" "}
              <span className="text-muted-foreground">{w.text}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function SortHead({
  label,
  k,
  sort,
  onSort,
  className,
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; desc: boolean };
  onSort: (k: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === k;
  const Icon = !active ? ArrowUpDown : sort.desc ? ArrowDown : ArrowUp;
  return (
    <TableHead className={className} aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cn("-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground", active && "text-foreground")}
      >
        {label}
        <Icon className="h-3 w-3" />
      </button>
    </TableHead>
  );
}

export function RadarView() {
  const [report, setReport] = useState<RadarReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [verdict, setVerdict] = useState<VerdictFilter>("all");
  const [warnOnly, setWarnOnly] = useState(false);
  const [hideEmpty, setHideEmpty] = useState(true);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "default", desc: true });

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

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = (m: RadarMarket) =>
      !q ||
      [
        m.collateral.symbol,
        m.collateral.name,
        m.collateral.registry?.name ?? "",
        m.collateral.address,
        m.loan.symbol,
        m.loan.address,
        m.oracle.type ?? "",
      ].some((s) => s.toLowerCase().includes(q));
    const out = rows.filter(hit);
    if (sort.key === "default") return out;
    const val = (m: RadarMarket) => (sort.key === "supply" ? m.supply : sort.key === "borrow" ? m.borrow : m.lltv);
    return out.slice().sort((a, b) => (sort.desc ? val(b) - val(a) : val(a) - val(b)));
  }, [rows, query, sort]);

  const onSort = (k: SortKey) =>
    setSort((s) => (s.key !== k ? { key: k, desc: true } : s.desc ? { key: k, desc: false } : { key: "default", desc: true }));

  const s = report?.summary;
  const warnTotal = s ? Object.values(s.warnings).reduce((a, b) => a + b, 0) : 0;

  const donut = s
    ? [
        { name: "Would gate", value: s.wouldGate.markets, className: "stroke-success", dot: "bg-success" },
        { name: "Wouldn't gate", value: s.wouldnt.markets, className: "stroke-muted-foreground/50", dot: "bg-muted-foreground/50" },
        { name: "Reject", value: s.reject.markets, className: "stroke-destructive", dot: "bg-destructive" },
      ]
    : [];

  return (
    <>
      <PageHeader
        eyebrow="ReserveProof · mainnet radar"
        title="Which Morpho markets ReserveProof would gate."
        lede="Every Morpho Blue market on Robinhood Chain mainnet, read live at one block. Markets lending against USDG or an issuer-listed Robinhood Stock Token would freeze on a failed custody proof; tokens that only look like one are flagged as copycats. Sources: the Morpho API for the market list, Robinhood's official asset registry for which token contracts are real, and the chain itself (Multicall3) for every number."
        actions={
          <Button asChild variant="ghost" size="sm">
            <a href="/api/radar" target="_blank" rel="noreferrer">
              JSON feed
            </a>
          </Button>
        }
      />
      <div className="container space-y-8 py-10 lg:py-12">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <KpiCard
              label="Would gate"
              value={s?.wouldGate.markets}
              format={(v) => `${Math.round(v)} markets`}
              tone="ok"
              sub={
                s
                  ? `${amount(s.wouldGate.usdgSupplied)} USDG lent, ${amount(s.wouldGate.usdgBorrowed)} borrowed against ${s.issuerTokens} issuer-listed tokens and USDG`
                  : undefined
              }
            />
            <KpiCard label="Gated today" value={s?.gatedToday} format={(v) => String(Math.round(v))} sub="no custodian publishes proofs on mainnet yet" />
            <KpiCard
              label="Copycats to reject"
              value={s?.reject.markets}
              format={(v) => `${Math.round(v)} markets`}
              tone={s && s.reject.markets ? "bad" : "neutral"}
              sub={s ? `${s.reject.tokens} fake token${s.reject.tokens === 1 ? "" : "s"} (collateral or loan)` : undefined}
            />
            <KpiCard
              label="Warnings"
              value={s ? warnTotal : undefined}
              format={(v) => String(Math.round(v))}
              tone={warnTotal ? "warn" : "neutral"}
              sub={
                s
                  ? (Object.keys(s.warnings) as WarningCode[])
                      .filter((k) => s.warnings[k] > 0)
                      .map((k) => `${s.warnings[k]} ${WARNING_LABEL[k]}`)
                      .join(" · ") || "none"
                  : undefined
              }
            />
          </div>
          <Card className="bg-card/70">
            <CardContent className="flex h-full flex-col p-4 md:p-5">
              <p className="text-[0.7rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">Markets by verdict</p>
              {s ? (
                <>
                  <Donut className="mx-auto mt-3" data={donut} label={s.marketsListed} sub="markets" />
                  <ul className="mt-4 space-y-1.5 text-xs">
                    {donut.map((d) => (
                      <li key={d.name} className="flex items-center gap-2">
                        <span className={cn("h-2 w-2 rounded-sm", d.dot)} aria-hidden />
                        <span className="text-muted-foreground">{d.name}</span>
                        <span className="ml-auto font-mono">{d.value}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <Skeleton className="mx-auto mt-3 h-40 w-40 rounded-full" />
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="overflow-hidden bg-card/60">
          <div className="flex flex-col gap-3 border-b border-border/60 p-4 lg:flex-row lg:items-center">
            <ToggleGroup
              type="single"
              value={verdict}
              onValueChange={(v) => v && setVerdict(v as VerdictFilter)}
              variant="outline"
              aria-label="Verdict"
              className="flex-wrap justify-start"
            >
              {(["all", "would-gate", "wouldnt", "reject"] as VerdictFilter[]).map((v) => (
                <ToggleGroupItem key={v} value={v} className={cn("h-8 rounded-full px-3 text-xs", ACTIVE_TOGGLE)}>
                  {v === "all" ? "all" : VERDICT_LABEL[v]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <div className="flex flex-wrap gap-1">
              <Toggle variant="outline" pressed={warnOnly} onPressedChange={setWarnOnly} className={cn("h-8 rounded-full px-3 text-xs", ACTIVE_TOGGLE)}>
                only with warnings
              </Toggle>
              <Toggle variant="outline" pressed={hideEmpty} onPressedChange={setHideEmpty} className={cn("h-8 rounded-full px-3 text-xs", ACTIVE_TOGGLE)}>
                hide empty markets
              </Toggle>
            </div>
            <div className="relative lg:ml-auto lg:w-60">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search token, address, oracle"
                aria-label="Search markets"
                className="h-8 pl-8 text-xs"
              />
            </div>
          </div>
          {report && (
            <p className="border-b border-border/60 px-4 py-2 font-mono text-xs text-muted-foreground">
              {shown.length} of {report.summary.marketsListed} · block{" "}
              <ExtLink href={`${report.explorer}/block/${report.block}`}>{report.block}</ExtLink> · read {ago(report.readAt, now)}
            </p>
          )}

          {!report && !error && (
            <div className="space-y-3 p-4" aria-busy>
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Reading every market from Robinhood Chain mainnet (about 6 seconds)…
              </p>
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          )}
          {error && (
            <p role="alert" className="p-4 text-sm text-destructive">
              Could not load the radar: {error}
            </p>
          )}
          {report && report.errors.length > 0 && (
            <p className="border-b border-border/60 px-4 py-2 text-sm text-warning">
              {report.errors.length} source{report.errors.length > 1 ? "s" : ""} degraded: {report.errors.slice(0, 3).join("; ")}
            </p>
          )}

          {report && (
            <>
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-[34%]">Market (collateral → loan)</TableHead>
                      <SortHead label="Supplied / borrowed" k="borrow" sort={sort} onSort={onSort} />
                      <SortHead label="LLTV" k="lltv" sort={sort} onSort={onSort} />
                      <TableHead>Oracle price</TableHead>
                      <TableHead>Verdict · warnings</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shown.map((m) => {
                      const loanLabel = m.loan.symbol || short(m.loan.address);
                      return (
                        <TableRow key={m.id} className={cn(m.verdict === "reject" && "bg-destructive/[0.04]")}>
                          <TableCell className="align-top">
                            <MarketCell m={m} explorer={report.explorer} usdg={report.usdg} />
                          </TableCell>
                          <TableCell className="align-top font-mono text-sm">
                            {amount(m.supply)} / {amount(m.borrow)}
                            <p className="text-xs text-muted-foreground">{loanLabel}</p>
                          </TableCell>
                          <TableCell className="align-top font-mono text-sm">{fmt(m.lltv * 100, 1)}%</TableCell>
                          <TableCell className="align-top">
                            <OracleCell m={m} explorer={report.explorer} />
                          </TableCell>
                          <TableCell className="align-top">
                            <VerdictCell m={m} />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {shown.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                          No market matches these filters.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              <div className="md:hidden">
                <div className="flex gap-1 border-b border-border/60 px-4 py-2 text-xs">
                  <span className="mr-1 self-center text-muted-foreground">Sort</span>
                  {(["default", "borrow", "lltv"] as SortKey[]).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setSort({ key: k, desc: true })}
                      className={cn(
                        "rounded-full border px-2.5 py-1",
                        sort.key === k ? "border-primary/40 bg-primary/15 text-primary" : "border-border text-muted-foreground"
                      )}
                    >
                      {k === "default" ? "default" : k === "borrow" ? "borrowed" : "LLTV"}
                    </button>
                  ))}
                </div>
                <ul className="divide-y divide-border/60">
                  {shown.map((m) => (
                    <MarketCard key={m.id} m={m} explorer={report.explorer} usdg={report.usdg} />
                  ))}
                  {shown.length === 0 && <li className="p-6 text-center text-sm text-muted-foreground">No market matches these filters.</li>}
                </ul>
              </div>
            </>
          )}
        </Card>

        <Section kicker="How to read this">
          <Card className="bg-card/40">
            <CardContent className="p-5 md:p-6">
              <ul className="space-y-3 text-sm leading-relaxed text-muted-foreground">
                <li>
                  <strong className="text-success">Would gate</strong>: the collateral is Paxos USDG or a token contract listed in
                  Robinhood&apos;s asset registry (<span className="font-mono text-xs">api.robinhood.com/rhj/assets</span>).
                  Wrapping this market&apos;s current oracle in a <span className="font-mono text-xs">SolvencyGatedMorphoOracle</span>{" "}
                  would freeze borrowing and liquidations while the custodian&apos;s proof fails. These verdicts describe what our
                  wrapper would do; none of these markets is gated today.
                </li>
                <li>
                  <strong className="text-foreground">Wouldn&apos;t gate</strong>: crypto or other collateral with no custodian to
                  prove. The market&apos;s price oracle is the right check there.
                </li>
                <li>
                  <strong className="text-destructive">Reject</strong>: the collateral or the loan token is not the registry-listed
                  contract, yet it calls itself USDG, carries a Robinhood name or listed ticker, or answers ERC-8056{" "}
                  <span className="font-mono text-xs">uiMultiplier()</span>. No custodian stands behind it.
                </li>
                <li>
                  <strong className="text-warning">Corporate action pending</strong>: the token&apos;s on-chain{" "}
                  <span className="font-mono text-xs">effectiveAt</span> is in the future with a different{" "}
                  <span className="font-mono text-xs">newUIMultiplier</span>, or the registry lists a pending multiplier. A
                  ReserveProof-gated market returns MULTIPLIER_DRIFT until the custodian recommits.{" "}
                  <strong className="text-warning">Multiplier mismatch</strong>: on-chain{" "}
                  <span className="font-mono text-xs">uiMultiplier</span> differs from the registry&apos;s current multiplier
                  (tolerance 1e-9).
                </li>
                <li>
                  <strong className="text-warning">Price outlier</strong>: the market&apos;s oracle price is more than 5% from the
                  median of every market pricing the same collateral in the same loan token. Prices are loan-token units per whole
                  collateral token. <strong className="text-foreground">Oracle reverts</strong>:{" "}
                  <span className="font-mono text-xs">price()</span> fails, so the market is already stuck.
                </li>
                <li>
                  Rows list official-USDG markets first, then the rest; each group by borrowed. Amounts are in each market&apos;s
                  own loan token, so sorting by amount compares raw token units across loan tokens. The page refreshes every 5
                  minutes (the API is cached for 5).
                </li>
              </ul>
            </CardContent>
          </Card>
        </Section>
      </div>
    </>
  );
}
