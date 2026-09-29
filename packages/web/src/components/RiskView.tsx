"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { GITHUB_URL, NETWORK_KEYS, type NetworkKey } from "../lib/deployments";
import type { AssetRisk, ConsumerRisk, FreezeTrigger, RiskReport } from "../lib/risk";
import { cn } from "../lib/utils";
import { KpiCard } from "./site/KpiCard";
import { PageHeader } from "./site/PageHeader";
import { StateBadge } from "./site/StateBadge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Skeleton } from "./ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type Loaded = { report?: RiskReport; error?: string };

const REFRESH_MS = 30_000;
const CHAINS = NETWORK_KEYS.filter((k): k is Exclude<NetworkKey, "localhost"> => k !== "localhost");

function fmt(n: number, max = 2) {
  return n.toLocaleString("en-US", { maximumFractionDigits: max });
}

function pct(bps: number | null | undefined) {
  return bps === null || bps === undefined ? "—" : `${fmt(bps / 100, 1)}%`;
}

function utc(sec: number) {
  return new Date(sec * 1000).toUTCString().slice(5, 22) + " UTC";
}

function dur(sec: number) {
  const s = Math.abs(Math.round(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function until(at: number, now: number) {
  return at > now ? `in ${dur(at - now)}` : `${dur(now - at)} ago`;
}

function multiplier(n: number) {
  return n.toLocaleString("en-US", { maximumFractionDigits: 9 });
}

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function CoverageBar({ coverageBps, floorBps }: { coverageBps: number | null; floorBps: number }) {
  if (coverageBps === null) return null;
  const scale = Math.max(coverageBps, floorBps * 2);
  const fill = Math.min(100, (coverageBps / scale) * 100);
  const floor = (floorBps / scale) * 100;
  return (
    <div>
      <div className="relative mt-4 h-2 w-full rounded-full bg-muted">
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              tabIndex={0}
              aria-label={`coverage ${pct(coverageBps)}`}
              className={cn("absolute inset-y-0 left-0 rounded-full outline-none", coverageBps >= floorBps ? "bg-success/80" : "bg-destructive/80")}
              style={{ width: `${fill}%` }}
            />
          </TooltipTrigger>
          <TooltipContent className="font-mono text-xs">coverage {pct(coverageBps)}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              tabIndex={0}
              aria-label={`floor ${pct(floorBps)}`}
              className="absolute top-1/2 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground outline-none ring-2 ring-background"
              style={{ left: `${floor}%` }}
            />
          </TooltipTrigger>
          <TooltipContent className="font-mono text-xs">floor {pct(floorBps)}</TooltipContent>
        </Tooltip>
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[0.65rem] text-muted-foreground">
        <span>0%</span>
        <span>{pct(scale)}</span>
      </div>
    </div>
  );
}

function Block({ title, status, tone, warn, children }: { title: string; status: ReactNode; tone?: string; warn?: boolean; children: ReactNode }) {
  return (
    <div className={cn("rounded-lg border border-border/60 bg-background/30 p-3.5", warn && "border-warning/40 bg-warning/5")}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[0.7rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">{title}</p>
        <span className={cn("text-sm", tone === "bad" ? "text-destructive" : tone === "ok" ? "text-success" : "")}>{status}</span>
      </div>
      {children}
    </div>
  );
}

function KV({ rows }: { rows: { k: string; v: ReactNode; bad?: boolean }[] }) {
  return (
    <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[max-content_minmax(0,1fr)]">
      {rows.map((r) => (
        <div key={r.k} className="contents">
          <dt className="text-muted-foreground">{r.k}</dt>
          <dd className={cn("mb-1 break-words font-mono sm:mb-0", r.bad && "text-destructive")}>{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}

const muted = (s: ReactNode) => <span className="text-muted-foreground">{s}</span>;

function AssetCard({ a, now, gatedBy }: { a: AssetRisk; now: number; gatedBy: string[] }) {
  if (!a.published) {
    return (
      <Card className="bg-card/40">
        <CardContent className="space-y-1 p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="font-semibold">{a.label}</p>
            <span className="text-xs text-muted-foreground">not published on this chain</span>
          </div>
          <p className="text-xs text-muted-foreground">{a.identity}</p>
        </CardContent>
      </Card>
    );
  }
  const cov = a.coverage;
  const st = a.staleness;
  const d = a.disputes;
  const x = a.exit;
  const mu = a.multiplier;
  const liveStale = st ? st.staleAt - now : null;
  const liveMargin = st ? st.staleAt - Math.max(st.nextPublish, now) : null;
  return (
    <Card className={cn("border-l-2 bg-card/60", a.status?.ok ? "border-l-success/70" : "border-l-destructive/80")}>
      <CardContent className="space-y-3 p-4 md:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-display text-lg font-semibold">{a.label}</p>
          <StateBadge state={a.status ? (a.status.ok ? "ok" : "bad") : "neutral"}>
            {a.status ? (a.status.ok ? "solvent" : "insolvent") : "—"}
          </StateBadge>
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            {a.status?.reasonLabel ?? ""} · epoch {a.status?.epochId ?? "—"}
          </span>
        </div>
        <p className="text-sm">
          {gatedBy.length ? (
            <>
              Gates <strong>{gatedBy.length}</strong> consumer{gatedBy.length > 1 ? "s" : ""}: {gatedBy.join(", ")}
            </>
          ) : (
            muted("No gated consumer on this chain")
          )}
        </p>
        <p className="text-xs text-muted-foreground">{a.identity}</p>

        {cov && (
          <Block
            title="Coverage vs floor"
            tone={cov.coverageBps !== null && cov.coverageBps < cov.floorBps ? "bad" : undefined}
            status={
              <>
                <strong className="font-mono">{pct(cov.coverageBps)}</strong> {muted(`/ ${pct(cov.floorBps)} required`)}
              </>
            }
          >
            <CoverageBar coverageBps={cov.coverageBps} floorBps={cov.floorBps} />
            <KV
              rows={[
                { k: "Owed here", v: `${fmt(cov.allocation.value)} ${a.label}` },
                { k: "Required (floor)", v: fmt(cov.need.value) },
                {
                  k: "Counted reserves",
                  v: (
                    <>
                      {cov.effective ? fmt(cov.effective.value) : "—"}{" "}
                      {muted(
                        `min(live ${cov.live ? fmt(cov.live.value) : "—"}, lowest sample ${cov.sampleMin ? fmt(cov.sampleMin.value) : "—"})`
                      )}
                    </>
                  ),
                },
                {
                  k: "Headroom",
                  v: `${cov.headroom ? fmt(cov.headroom.value) : "—"} (${pct(cov.headroomBps)} can go before LIVE_SHORT)`,
                  bad: !!cov.headroom && cov.headroom.value < 0,
                },
                { k: "Samples", v: `${cov.samples} / ${cov.minSamples} required`, bad: cov.samples < cov.minSamples },
              ]}
            />
          </Block>
        )}

        {mu && (
          <Block
            title="Multiplier (ERC-8056)"
            warn={mu.drift || mu.pendingChange}
            tone={mu.drift || mu.pendingChange ? "bad" : "ok"}
            status={mu.drift ? "drift: MULTIPLIER_DRIFT now" : mu.pendingChange ? "change pending: MULTIPLIER_DRIFT now" : "matches the epoch"}
          >
            <KV
              rows={[
                { k: "Live uiMultiplier", v: mu.live === null ? "reverts" : multiplier(mu.live) },
                { k: "Committed in epoch", v: mu.committed === null ? "—" : multiplier(mu.committed), bad: mu.drift },
                {
                  k: "Scheduled change",
                  v:
                    mu.pendingChange && mu.pending !== null && mu.effectiveAt
                      ? `→ ${multiplier(mu.pending)} at ${utc(mu.effectiveAt)} (${until(mu.effectiveAt, now)})`
                      : "none",
                  bad: mu.pendingChange,
                },
              ]}
            />
            <p className="mt-3 text-xs text-muted-foreground">
              Only the registry-listed contract is ever gated; a copycat or unlisted token never is. See{" "}
              <Link href="/radar" className="text-primary underline-offset-4 hover:underline">
                the mainnet radar
              </Link>
              .
            </p>
          </Block>
        )}

        {st && liveStale !== null && liveMargin !== null && (
          <Block
            title="Time to stale"
            tone={liveStale <= 0 ? "bad" : undefined}
            status={
              <>
                <strong className="font-mono">{liveStale > 0 ? dur(liveStale) : "STALE"}</strong> {muted(`at ${utc(st.staleAt)}`)}
              </>
            }
          >
            <KV
              rows={[
                { k: "Last published", v: <>{utc(st.committedAt)} {muted(`(${until(st.committedAt, now)})`)}</> },
                { k: "Max age", v: dur(st.maxOracleAge) },
                { k: "Next scheduled publish", v: <>{utc(st.nextPublish)} {muted(`(${until(st.nextPublish, now)})`)}</> },
                {
                  k: "Margin",
                  v: (
                    <span className={liveMargin < 0 ? "text-destructive" : "text-success"}>
                      {liveMargin < 0 ? `next publish lands ${dur(-liveMargin)} after stale` : `${dur(liveMargin)} to spare`}
                    </span>
                  ),
                },
              ]}
            />
          </Block>
        )}

        {d && x && (
          <Block
            title="Disputes and exits"
            tone={d.isDisputed || d.overdue || d.equivocated || x.exitDefault ? "bad" : "ok"}
            status={
              d.equivocated
                ? "equivocation proven (permanent)"
                : x.exitDefault
                  ? "exit default (permanent)"
                  : d.isDisputed || d.overdue
                    ? "disputed"
                    : "none open"
            }
          >
            <KV
              rows={[
                { k: "Open disputes", v: d.openDisputes },
                {
                  k: "Balance challenges",
                  v: (
                    <>
                      {d.openChallenges} open · {d.queueLength} ever queued{d.overdue ? " · OVERDUE" : ""}{" "}
                      {muted(`(answer window ${dur(d.challengeWindowSec)})`)}
                    </>
                  ),
                  bad: d.overdue,
                },
                {
                  k: "Exit claims",
                  v: `${x.openClaims} open${x.nextDeadline ? ` · next deadline ${utc(x.nextDeadline)} (${until(x.nextDeadline, now)})` : ""}`,
                  bad: x.exitDefault,
                },
              ]}
            />
          </Block>
        )}
      </CardContent>
    </Card>
  );
}

function morphoLine(c: ConsumerRisk, now: number) {
  const m = c.morpho!;
  const cap = `${fmt(m.postCapBps / 100, 0)}%`;
  const freeze = dur(m.maxFreezeSec);
  switch (m.phase) {
    case "open":
      return `Prices at the full base price. On a failed proof it reverts for up to ${freeze} of one poked incident, then prices at ${cap}.`;
    case "frozen-unpoked":
      return `Reverting. No freeze clock yet: the first poke() starts the ${freeze} countdown to ${cap} pricing.`;
    case "frozen":
      return `Reverting. ${cap} pricing from ${utc(m.capEndsAt)} (${until(m.capEndsAt, now)}); the clock is void at ${utc(m.voidAt)} unless poked again.`;
    case "discounted":
      return `Freeze cap reached ${until(m.capEndsAt, now)}: pricing at ${cap} of the base so liquidations can clear.`;
  }
}

function ConsumerName({ c, explorer }: { c: ConsumerRisk; explorer: string | null }) {
  return (
    <div className="min-w-0">
      <p className="font-semibold">{c.name}</p>
      <p className="font-mono text-xs text-muted-foreground">
        {explorer ? (
          <a href={`${explorer}/address/${c.address}`} target="_blank" rel="noreferrer" className="transition-colors hover:text-primary">
            {short(c.address)}
          </a>
        ) : (
          short(c.address)
        )}
      </p>
      <p className="text-xs text-muted-foreground">gated on {c.gatedLabel}</p>
    </div>
  );
}

function ConsumerState({ c }: { c: ConsumerRisk }) {
  return (
    <div className="space-y-1">
      <StateBadge state={c.state === "open" ? "ok" : "bad"}>
        {c.state === "open" ? "open" : c.state === "frozen" ? "frozen now" : "unknown"}
      </StateBadge>
      {c.reasonLabel && <p className="font-mono text-xs text-destructive">{c.reasonLabel}</p>}
    </div>
  );
}

function ConsumerEffects({ c, now }: { c: ConsumerRisk; now: number }) {
  return (
    <div className="space-y-1 text-xs leading-relaxed">
      <p>
        <span className="font-medium text-destructive">Freezes:</span> {c.freezes.join(", ")}
      </p>
      <p>
        <span className="font-medium text-success">Stays open:</span> {c.staysOpen.join(", ")}
      </p>
      <p className="text-muted-foreground">{c.exposure.map((e) => `${e.label}: ${e.value}`).join(" · ")}</p>
      {c.morpho && (
        <p className="rounded-md border border-border/60 bg-background/40 px-2 py-1.5">
          {morphoLine(c, now)}
          {c.morpho.basePrice !== null && muted(` Base oracle: ${fmt(c.morpho.basePrice, 4)} USDG/${c.gatedLabel}.`)}
        </p>
      )}
    </div>
  );
}

function Consumers({ consumers, explorer, now }: { consumers: ConsumerRisk[]; explorer: string | null; now: number }) {
  return (
    <Card className="overflow-hidden bg-card/60">
      <div className="hidden sm:block">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Consumer</TableHead>
              <TableHead>State</TableHead>
              <TableHead>What freezes · what stays open</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {consumers.map((c) => (
              <TableRow key={c.address}>
                <TableCell className="align-top">
                  <ConsumerName c={c} explorer={explorer} />
                </TableCell>
                <TableCell className="align-top">
                  <ConsumerState c={c} />
                </TableCell>
                <TableCell className="align-top">
                  <ConsumerEffects c={c} now={now} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="divide-y divide-border/60 sm:hidden">
        {consumers.map((c) => (
          <li key={c.address} className="space-y-2.5 p-4">
            <div className="flex items-start justify-between gap-3">
              <ConsumerName c={c} explorer={explorer} />
              <ConsumerState c={c} />
            </div>
            <ConsumerEffects c={c} now={now} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Triggers({ triggers, now }: { triggers: FreezeTrigger[]; now: number }) {
  if (!triggers.length) return <p className="text-sm text-muted-foreground">No gated consumer depends on a published asset here.</p>;
  return (
    <Card className="overflow-hidden bg-card/60">
      <ul className="divide-y divide-border/60">
        {triggers.map((t, i) => (
          <li key={i} className={cn("flex items-start gap-3 px-4 py-2.5 text-sm", t.active && "bg-destructive/[0.06]")}>
            <StateBadge state={t.active ? "bad" : "neutral"} dot={t.active} className="mt-0.5 w-12 justify-center">
              {t.active ? "now" : "if"}
            </StateBadge>
            <span className="min-w-0">
              {t.text}
              {t.at && !t.active ? muted(` (${until(t.at, now)})`) : null}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Kicker({ children }: { children: ReactNode }) {
  return <p className="mb-2.5 mt-6 text-xs font-semibold uppercase tracking-[0.16em] text-primary first:mt-0">{children}</p>;
}

function ChainColumn({ keyName, state, now }: { keyName: NetworkKey; state: Loaded | undefined; now: number }) {
  const r = state?.report;
  return (
    <section aria-label={r?.label ?? keyName} className="min-w-0">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2 border-b border-border/60 pb-3">
        <h2 className="font-display text-2xl font-semibold tracking-tight">{r?.label ?? keyName}</h2>
        {r && (
          <span className="font-mono text-xs text-muted-foreground">
            block {r.block ?? "—"} · read {until(r.readAt, now)}
          </span>
        )}
      </div>
      {!state && (
        <div className="space-y-3" aria-busy>
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading the chain…
          </p>
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}
      {state?.error && <p role="alert" className="text-sm text-destructive">Could not load: {state.error}</p>}
      {r && (
        <>
          <Kicker>Custody proofs</Kicker>
          <div className="space-y-3">
            {r.assets.map((a) => (
              <AssetCard
                key={a.address}
                a={a}
                now={now}
                gatedBy={r.consumers.filter((c) => c.gatedAsset === a.kind).map((c) => c.name)}
              />
            ))}
          </div>
          <Kicker>Gated consumers</Kicker>
          <Consumers consumers={r.consumers} explorer={r.explorer} now={now} />
          <Kicker>Freezes if</Kicker>
          <Triggers triggers={r.triggers} now={now} />
          {r.errors.length > 0 && (
            <p className="mt-4 text-sm text-warning">
              {r.errors.length} read{r.errors.length > 1 ? "s" : ""} failed: {r.errors.slice(0, 3).join("; ")}
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function RiskView() {
  const [data, setData] = useState<Partial<Record<NetworkKey, Loaded>>>({});
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [tab, setTab] = useState<string>(CHAINS[0]);

  const load = useCallback(async () => {
    await Promise.all(
      CHAINS.map(async (k) => {
        try {
          const res = await fetch(`/api/risk?network=${k}`, { cache: "no-store" });
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
          setData((d) => ({ ...d, [k]: { report: body as RiskReport } }));
        } catch (e) {
          setData((d) => ({ ...d, [k]: { ...d[k], error: (e as Error).message } }));
        }
      })
    );
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const reports = CHAINS.map((k) => data[k]?.report).filter((r): r is RiskReport => Boolean(r));
  const consumers = reports.flatMap((r) => r.consumers);
  const openCount = consumers.filter((c) => c.state === "open").length;
  const gatedAssets = reports.flatMap((r) =>
    r.assets.filter((a) => a.published && r.consumers.some((c) => c.gatedAsset === a.kind)).map((a) => ({ r, a }))
  );
  const tightest = gatedAssets
    .filter((x) => x.a.coverage?.headroomBps !== null && x.a.coverage?.headroomBps !== undefined)
    .sort((p, q) => p.a.coverage!.headroomBps! - q.a.coverage!.headroomBps!)[0];
  const soonestStale = gatedAssets
    .filter((x) => x.a.staleness)
    .sort((p, q) => p.a.staleness!.staleAt - q.a.staleness!.staleAt)[0];
  const nextPublish = reports.find((r) => r.assets.some((a) => a.staleness))?.assets.find((a) => a.staleness)?.staleness
    ?.nextPublish;

  return (
    <>
      <PageHeader
        eyebrow="ReserveProof · curator risk"
        title="What would freeze, and when."
        lede="For vault curators and risk teams: every solvency-gated market on both testnets, the custody proof it depends on, how much room that proof has left, and exactly what would stop it. Everything is read live from the chain every 30 seconds."
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <a href={`${GITHUB_URL}/actions/workflows/ops-epoch.yml`} target="_blank" rel="noreferrer">
                Epoch publisher <ArrowUpRight className="h-3.5 w-3.5" />
              </a>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <a href="/api/risk?network=robinhoodTestnet" target="_blank" rel="noreferrer">
                JSON feed
              </a>
            </Button>
          </>
        }
      />
      <div className="container space-y-8 py-10 lg:py-12">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="Gated consumers open"
            display={consumers.length ? `${openCount} / ${consumers.length}` : "—"}
            tone={consumers.length && openCount < consumers.length ? "bad" : consumers.length ? "ok" : "neutral"}
            sub={`across ${reports.length || "—"} chains`}
          />
          <KpiCard
            label="Tightest headroom"
            display={tightest ? pct(tightest.a.coverage!.headroomBps) : "—"}
            tone={tightest && tightest.a.coverage!.headroomBps! < 0 ? "bad" : "neutral"}
            sub={tightest ? `${tightest.a.label} on ${tightest.r.label}: drop before LIVE_SHORT` : "reserves above the floor"}
          />
          <KpiCard
            label="Soonest stale"
            display={soonestStale ? dur(Math.max(0, soonestStale.a.staleness!.staleAt - now)) : "—"}
            tone={soonestStale && soonestStale.a.staleness!.staleAt <= now ? "bad" : "neutral"}
            sub={soonestStale ? `${soonestStale.a.label} on ${soonestStale.r.label}, ${utc(soonestStale.a.staleness!.staleAt)}` : undefined}
          />
          <KpiCard
            label="Next scheduled publish"
            display={nextPublish ? dur(Math.max(0, nextPublish - now)) : "—"}
            sub={nextPublish ? `${utc(nextPublish)} · every 3 days` : undefined}
          />
        </div>

        <Tabs value={tab} onValueChange={setTab} className="lg:grid lg:grid-cols-2 lg:gap-8">
          <TabsList className="mb-5 grid w-full grid-cols-2 lg:hidden">
            {CHAINS.map((k) => (
              <TabsTrigger key={k} value={k}>
                {data[k]?.report?.label ?? k}
              </TabsTrigger>
            ))}
          </TabsList>
          {CHAINS.map((k) => (
            <TabsContent key={k} value={k} forceMount className="mt-0 data-[state=inactive]:hidden lg:!block">
              <ChainColumn keyName={k} state={data[k]} now={now} />
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </>
  );
}
