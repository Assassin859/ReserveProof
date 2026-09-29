"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowUpRight, CheckCircle2, CircleAlert, Loader2, RefreshCw, XCircle } from "lucide-react";
import { createPublicClient, formatUnits, http, isAddress, type Address } from "viem";
import forkDrillJson from "../deployments/fork-drill.json";
import { checkBalance, readLatestEpoch, type BalanceResult } from "../lib/balance";
import { ASSET_META, GITHUB_URL, NETWORKS, type AssetKind } from "../lib/deployments";
import { SITE_STATS } from "../lib/mainnet";
import type { RadarReport } from "../lib/radar";
import { RPC_URLS } from "../lib/rpc";
import { cn } from "../lib/utils";
import type { Claim, ClaimState, ForkDrill, VerifyReport } from "../lib/verify";
import { CodeBlock } from "./site/CopyButton";
import { ExtLink, PageHeader } from "./site/PageHeader";
import { StateBadge, StatusDot, toTone } from "./site/StateBadge";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./ui/accordion";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Input } from "./ui/input";
import { Progress } from "./ui/progress";

const FORK = forkDrillJson as ForkDrill;
const NET = NETWORKS.robinhoodTestnet;
const DEP = NET.deployment!;
const BALANCE_ASSETS: AssetKind[] = ["stock", "usdg", "tsla"];

type State = ClaimState | "checking";
type BalanceRow = { kind: AssetKind; result?: BalanceResult; error?: string };

const ACCENT: Record<State, string> = {
  pass: "border-l-success/70",
  fail: "border-l-destructive/80",
  unknown: "border-l-warning/70",
  checking: "border-l-border",
};

const CLAIM_ORDER: { id: string; title: string }[] = [
  { id: "tests", title: "Tests pass in CI" },
  { id: "contracts", title: "Every contract is source-verified on both chains" },
  { id: "proofs", title: "Every published proof is live and solvent" },
  { id: "same-root", title: "The same mTSLA liability root is committed on both chains" },
  { id: "balance", title: "Your balance is in the book" },
  { id: "consumers", title: "Gated integrations answer on chain and fail closed" },
  { id: "exitright", title: "An ExitRight claim was opened and settled on chain" },
  { id: "schedule", title: "Proofs are re-published on schedule" },
  { id: "mainnet", title: "The mainnet numbers are live, not a slide" },
  { id: "morpho-fork", title: "A drained custodian freezes a real Morpho Blue market" },
];

function assetAddress(kind: AssetKind): Address | undefined {
  const c = DEP.contracts;
  return (kind === "stock" ? c.MockStockToken : kind === "usdg" ? c.USDG : c.TSLA) as Address | undefined;
}

function short(h: string) {
  return `${h.slice(0, 8)}…${h.slice(-6)}`;
}

function ago(sec: number, now: number) {
  const s = Math.max(0, now - sec);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

const usd = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

function ClaimCard({
  id,
  index,
  title,
  state,
  note,
  evidence,
  links,
  reproduce,
  children,
}: {
  id: string;
  index: number;
  title: string;
  state: State;
  note?: string;
  evidence: string[];
  links: { label: string; href: string }[];
  reproduce: string;
  children?: ReactNode;
}) {
  return (
    <Card id={id} aria-label={title} className={cn("scroll-mt-24 border-l-2 bg-card/60", ACCENT[state])}>
      <CardContent className="space-y-4 p-5 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-muted-foreground">Claim {index}</p>
            <h2 className="mt-1 font-display text-lg font-semibold leading-snug tracking-tight md:text-xl">
              <a href={`#${id}`} className="transition-colors hover:text-primary">
                {title}
              </a>
            </h2>
          </div>
          <StateBadge state={state} className="mt-1">
            {state === "checking" ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" /> checking
              </>
            ) : (
              state
            )}
          </StateBadge>
        </div>
        {note && (
          <p className="rounded-md border border-warning/25 bg-warning/5 px-3 py-2 text-sm text-warning">{note}</p>
        )}
        {evidence.length > 0 && (
          <ul className="space-y-1.5 text-sm leading-relaxed text-foreground/85">
            {evidence.map((e, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-primary/70" aria-hidden />
                <span className="min-w-0 break-words">{e}</span>
              </li>
            ))}
          </ul>
        )}
        {children}
        {links.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {links.map((l, i) =>
              l.href.startsWith("/") ? (
                <Button key={l.href + i} asChild variant="outline" size="sm" className="h-7 rounded-full px-3 text-xs">
                  <Link href={l.href}>{l.label}</Link>
                </Button>
              ) : (
                <Button key={l.href + i} asChild variant="outline" size="sm" className="h-7 rounded-full px-3 text-xs">
                  <a href={l.href} target="_blank" rel="noreferrer">
                    {l.label} <ArrowUpRight className="h-3 w-3" />
                  </a>
                </Button>
              )
            )}
          </div>
        )}
        {reproduce && (
          <Accordion type="single" collapsible className="rounded-lg border border-border/60 bg-background/30 px-3">
            <AccordionItem value="repro" className="border-none">
              <AccordionTrigger className="py-2.5 text-sm text-muted-foreground hover:text-foreground hover:no-underline">
                Reproduce locally
              </AccordionTrigger>
              <AccordionContent>
                <CodeBlock code={reproduce} />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        )}
      </CardContent>
    </Card>
  );
}

function SummaryCard({
  checking,
  passed,
  total,
  anyFail,
  readLine,
  errors,
  onRerun,
}: {
  checking: boolean;
  passed: number;
  total: number;
  anyFail: boolean;
  readLine: string;
  errors: string[];
  onRerun: () => void;
}) {
  const tone = checking ? "neutral" : passed === total ? "ok" : anyFail ? "bad" : "warn";
  const Icon = checking ? Loader2 : tone === "ok" ? CheckCircle2 : tone === "bad" ? XCircle : CircleAlert;
  const iconCls = { neutral: "text-muted-foreground animate-spin", ok: "text-success", bad: "text-destructive", warn: "text-warning" }[tone];
  const barCls = { neutral: "[&>div]:bg-muted-foreground/60", ok: "[&>div]:bg-success", bad: "[&>div]:bg-destructive", warn: "[&>div]:bg-warning" }[tone];
  return (
    <Card className="bg-card/70" aria-live="polite">
      <CardContent className="space-y-4 p-5 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Icon className={cn("h-6 w-6 shrink-0", iconCls)} aria-hidden />
            <div>
              <p className="font-display text-xl font-semibold tracking-tight md:text-2xl">
                {checking ? `Checking… ${passed} of ${total} pass so far` : `${passed} of ${total} checks pass`}
              </p>
              <p className="font-mono text-xs text-muted-foreground">{readLine}</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={onRerun}>
            <RefreshCw className="h-3.5 w-3.5" /> Re-run
          </Button>
        </div>
        <Progress value={(passed / total) * 100} className={cn("h-1.5 bg-muted", barCls)} aria-label={`${passed} of ${total} checks pass`} />
        {errors.length > 0 && <p className="text-sm text-warning">Degraded sources: {errors.slice(0, 3).join("; ")}</p>}
      </CardContent>
    </Card>
  );
}

export function VerifyView() {
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [radar, setRadar] = useState<RadarReport | null>(null);
  const [radarError, setRadarError] = useState<string | null>(null);
  const [balances, setBalances] = useState<BalanceRow[] | null>(null);
  const [addr, setAddr] = useState<string>(NET.books.demoUser ?? "");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const client = useMemo(() => createPublicClient({ transport: http(RPC_URLS.robinhoodTestnet) }), []);

  const runBalances = useCallback(
    async (user: string) => {
      setBusy(true);
      setBalances(null);
      const rows = await Promise.all(
        BALANCE_ASSETS.map(async (kind): Promise<BalanceRow> => {
          const book = NET.books.liabilities[kind];
          const asset = assetAddress(kind);
          if (!book || !asset) return { kind, error: `No ${ASSET_META[kind].label} book published on ${NET.label}` };
          try {
            const { latest, ep } = await readLatestEpoch(client, DEP.contracts.LiabilityLedger, DEP.custodianId, asset);
            if (!ep?.exists) return { kind, error: "No epoch committed yet" };
            return { kind, result: checkBalance({ custodianId: DEP.custodianId, kind, asset, epochId: latest, ep, book, user }) };
          } catch (e) {
            return { kind, error: (e as Error).message.split("\n")[0].slice(0, 140) };
          }
        })
      );
      setBalances(rows);
      setBusy(false);
    },
    [client]
  );

  const load = useCallback(async () => {
    setReport(null);
    setError(null);
    setRadar(null);
    setRadarError(null);
    const verify = fetch("/api/verify", { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        setReport(body as VerifyReport);
      })
      .catch((e: Error) => setError(e.message));
    const radarReq = fetch("/api/radar")
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        setRadar(body as RadarReport);
      })
      .catch((e: Error) => setRadarError(e.message));
    await Promise.all([verify, radarReq]);
  }, []);

  useEffect(() => {
    void load();
    if (NET.books.demoUser) void runBalances(NET.books.demoUser);
  }, [load, runBalances]);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 5000);
    return () => clearInterval(t);
  }, []);

  // Content renders after the fetch, so the browser's own jump to #id happens too early.
  useEffect(() => {
    if (!report || typeof window === "undefined" || !window.location.hash) return;
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [report]);

  const byId = (id: string): Claim | undefined => report?.claims.find((c) => c.id === id);

  const balanceState: State = !balances
    ? "checking"
    : balances.some((b) => b.result && (!b.result.rootMatches || (b.result.found && !b.result.verified)))
      ? "fail"
      : balances.some((b) => b.result?.verified) && balances.every((b) => b.result)
        ? "pass"
        : "unknown";

  const radarState: State = radar ? "pass" : radarError ? "unknown" : "checking";
  const m = SITE_STATS.market;

  const states: State[] = [...(report ? report.claims.map((c) => c.state) : []), balanceState, radarState];
  const total = (report ? report.claims.length : 8) + 2;
  const passed = states.filter((s) => s === "pass").length;
  const checking = !report || states.includes("checking");

  const stateOf = (id: string): State =>
    id === "balance" ? balanceState : id === "mainnet" ? radarState : byId(id)?.state ?? (error ? "unknown" : "checking");
  const titleOf = (id: string, fallback: string) => (id === "balance" || id === "mainnet" ? fallback : byId(id)?.title ?? fallback);
  const indexOf = (id: string) => CLAIM_ORDER.findIndex((c) => c.id === id) + 1;

  const rerun = () => {
    void load();
    void runBalances(addr || NET.books.demoUser || "");
  };

  const serverCard = (id: string, fallbackTitle: string, extra?: ReactNode) => {
    const c = byId(id);
    return (
      <ClaimCard
        key={id}
        id={id}
        index={indexOf(id)}
        title={c?.title ?? fallbackTitle}
        state={stateOf(id)}
        note={c?.note}
        evidence={c?.evidence ?? (error ? [`Could not load: ${error}`] : [])}
        links={c?.links ?? []}
        reproduce={c?.reproduce ?? ""}
      >
        {extra}
      </ClaimCard>
    );
  };

  const steps = Array.from(new Set(FORK.checks.map((c) => c.step)));

  return (
    <>
      <PageHeader
        eyebrow="ReserveProof · verify"
        title="Check every claim yourself"
        lede="Each claim in the submission, checked live when this page opens: against the chains, the block explorers and GitHub Actions. The balance proof runs in your browser against a public RPC, not our server. Every card says how to reproduce it on your own machine."
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <a href={`${GITHUB_URL}/blob/master/docs/VERIFY.md`} target="_blank" rel="noreferrer">
                VERIFY.md <ArrowUpRight className="h-3.5 w-3.5" />
              </a>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <a href="/api/verify" target="_blank" rel="noreferrer">
                JSON feed
              </a>
            </Button>
          </>
        }
      />
      <div className="container grid gap-8 py-10 lg:grid-cols-[240px_minmax(0,1fr)] lg:py-12">
        <nav aria-label="Claims" className="hidden lg:block">
          <div className="sticky top-24">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Claims</p>
            <ol className="space-y-0.5 border-l border-border/60">
              {CLAIM_ORDER.map((c) => (
                <li key={c.id}>
                  <a
                    href={`#${c.id}`}
                    className="-ml-px flex items-start gap-2.5 border-l border-transparent py-1.5 pl-3 text-sm leading-snug text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
                  >
                    <StatusDot state={toTone(stateOf(c.id))} className="mt-1.5" />
                    <span>{titleOf(c.id, c.title)}</span>
                  </a>
                </li>
              ))}
            </ol>
          </div>
        </nav>

        <div className="min-w-0 space-y-5">
          <SummaryCard
            checking={checking}
            passed={passed}
            total={total}
            anyFail={states.includes("fail")}
            readLine={
              report
                ? `read ${ago(report.readAt, now)} · server checks cached up to 2 minutes`
                : "reading chains, explorers and GitHub…"
            }
            errors={report?.errors ?? []}
            onRerun={rerun}
          />

          {serverCard("tests", "Tests pass in CI")}
          {serverCard("contracts", "Every contract is source-verified on both chains")}
          {serverCard("proofs", "Every published proof is live and solvent")}
          {serverCard("same-root", "The same mTSLA liability root is committed on both chains")}

          <ClaimCard
            id="balance"
            index={indexOf("balance")}
            title="Your balance is in the book"
            state={balanceState}
            evidence={[
              `Your browser downloads the published ${NET.label} books, rebuilds each Merkle-sum tree, checks it reproduces the on-chain root and total, then proves the address's leaf against that root.`,
            ]}
            links={[
              { label: "Merkle-sum code", href: `${GITHUB_URL}/blob/master/packages/web/src/lib/merkle.ts` },
              { label: "Published books", href: `${GITHUB_URL}/blob/master/packages/web/src/deployments/books.json` },
            ]}
            reproduce={`npm run cli:build -- --csv packages/cli/examples/testnet-stock.csv \\\n  --custodian ${DEP.custodianId} \\\n  --asset ${DEP.contracts.MockStockToken} \\\n  --epoch ${balances?.find((b) => b.kind === "stock")?.result?.epochId ?? "<latest epoch>"} --out ./out\n# out/root.json has the same root as the ledger's getEpoch; out/proofs/<address>.json is your proof\n# (testnet-usdg.csv and testnet-tsla.csv for the other two books)`}
          >
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                if (isAddress(addr.trim())) void runBalances(addr.trim());
              }}
            >
              <Input
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
                spellCheck={false}
                placeholder="0x… any address"
                aria-label="Address to check"
                className="font-mono text-xs sm:flex-1"
              />
              <div className="flex gap-2">
                <Button type="submit" disabled={busy || !isAddress(addr.trim())}>
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {busy ? "Checking…" : "Check this address"}
                </Button>
                {NET.books.demoUser && addr !== NET.books.demoUser && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setAddr(NET.books.demoUser!);
                      void runBalances(NET.books.demoUser!);
                    }}
                  >
                    Demo user
                  </Button>
                )}
              </div>
            </form>
            {balances && (
              <ul className="divide-y divide-border/60 rounded-lg border border-border/60 bg-background/30">
                {balances.map((b) => {
                  const tone = b.result?.verified ? "ok" : b.result && (!b.result.rootMatches || b.result.found) ? "bad" : "warn";
                  return (
                    <li key={b.kind} className="flex items-start gap-3 px-3 py-2.5 text-sm">
                      <StatusDot state={tone} className="mt-1.5" />
                      <div className="min-w-0">
                        <p>
                          <strong className="font-semibold">{ASSET_META[b.kind].label}</strong>{" "}
                          {b.error ? (
                            <span className="text-muted-foreground">{b.error}</span>
                          ) : b.result ? (
                            b.result.verified ? (
                              `${formatUnits(b.result.amount, ASSET_META[b.kind].decimals)} ${ASSET_META[b.kind].label} proven in epoch ${b.result.epochId}`
                            ) : !b.result.rootMatches ? (
                              "the published book does not rebuild to the on-chain root"
                            ) : b.result.found ? (
                              `in the epoch ${b.result.epochId} book, but the proof does not verify`
                            ) : (
                              `not in the epoch ${b.result.epochId} book`
                            )
                          ) : null}
                        </p>
                        {b.result && (
                          <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">
                            root {short(b.result.computedRoot)} {b.result.rootMatches ? "= on chain" : `≠ ${short(b.result.onchainRoot)}`}
                            {b.result.found ? ` · ${b.result.proof.length}-step proof` : ""}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </ClaimCard>

          {serverCard("consumers", "Gated integrations answer on chain and fail closed")}
          {serverCard("exitright", "An ExitRight claim was opened and settled on chain")}
          {serverCard("schedule", "Proofs are re-published on schedule")}

          <ClaimCard
            id="mainnet"
            index={indexOf("mainnet")}
            title="The mainnet numbers are live, not a slide"
            state={radarState}
            evidence={[
              radar
                ? `Live now, Robinhood Chain mainnet block ${radar.block.toLocaleString("en-US")}: ${radar.summary.wouldGate.markets} Morpho markets lend USDG against USDG or issuer-listed stock tokens (${usd(radar.summary.wouldGate.usdgSupplied)} USDG supplied, ${usd(radar.summary.wouldGate.usdgBorrowed)} borrowed); ${radar.summary.reject.markets} markets lend a fake USDG`
                : radarError
                  ? `Radar unavailable: ${radarError}`
                  : "Reading every Morpho market on mainnet…",
              ...(m
                ? [
                    `Submission snapshot, block ${m.block.toLocaleString("en-US")} (${m.timestamp.slice(0, 10)}): ${usd(m.usdgSupply)} USDG in circulation; ${m.stockTokens} stock tokens with $${usd(m.stockSupplyUsd)} supply; ${m.morphoStockMarkets} stock-collateral markets with ${usd(m.usdgBorrowedAgainstStocks)} USDG borrowed`,
                  ]
                : []),
              "The live radar also counts USDG-collateral markets and moves as markets open, so it won't match the snapshot exactly.",
            ]}
            links={[
              { label: "Mainnet radar", href: "/radar" },
              { label: "Snapshot JSON", href: `${GITHUB_URL}/blob/master/docs/market-size.json` },
            ]}
            reproduce={"npm run market:size     # rewrites docs/market-size.json from chain reads at one block\ncurl https://reserveproof-teal.vercel.app/api/radar"}
          />

          {serverCard(
            "morpho-fork",
            "A drained custodian freezes a real Morpho Blue market",
            <div className="space-y-4">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">
                Recorded drill: {FORK.passed} of {FORK.total} checks, fork of block {FORK.forkBlock.toLocaleString("en-US")},{" "}
                {FORK.ranAt.slice(0, 16).replace("T", " ")} UTC
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                {steps.map((s) => {
                  const rows = FORK.checks.filter((c) => c.step === s);
                  const ok = rows.filter((r) => r.ok).length;
                  return (
                    <div key={s} className="rounded-lg border border-border/60 bg-background/30 p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold">{s}</p>
                        <StateBadge state={ok === rows.length ? "ok" : "bad"} dot={false}>
                          {ok}/{rows.length}
                        </StateBadge>
                      </div>
                      <ul className="space-y-1.5 text-xs leading-relaxed">
                        {rows.map((r, i) => (
                          <li key={i} className="flex gap-2">
                            {r.ok ? (
                              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-label="pass" />
                            ) : (
                              <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-label="fail" />
                            )}
                            <span className="min-w-0">
                              {r.check}
                              {r.detail && <span className="text-muted-foreground"> ({r.detail})</span>}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">Path to live</p>
              <ul className="space-y-1.5 text-sm leading-relaxed text-foreground/85">
                <li className="flex gap-2">
                  <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-primary/70" aria-hidden />
                  <span>
                    The mainnet deploy is scripted and resumable (<span className="font-mono text-xs">npm run deploy:rhmain</span>),
                    against the official USDG and Robinhood&apos;s real TSLA. It hasn&apos;t run: a live pilot needs a partner
                    custodian&apos;s real book and reserve wallet, not ours.
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-primary/70" aria-hidden />
                  <span>
                    A pilot adds one <span className="font-mono text-xs">SolvencyGatedMorphoOracle</span> over a curator&apos;s chosen
                    price oracle, a capped market, and this same drill run against that exact market before any money goes in.
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-primary/70" aria-hidden />
                  <span>
                    The offer and success criteria:{" "}
                    <ExtLink href={`${GITHUB_URL}/blob/master/docs/FOUNDER-HOUSE.md#4-the-90-day-pilot-offer`}>
                      FOUNDER-HOUSE.md, the 90-day pilot ↗
                    </ExtLink>
                  </span>
                </li>
              </ul>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
