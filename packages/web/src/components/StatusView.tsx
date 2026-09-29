"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, Loader2, XCircle } from "lucide-react";
import { GITHUB_URL } from "../lib/deployments";
import type { HourCell, Level, RunInfo, StatusComponent, StatusReport } from "../lib/status";
import { cn } from "../lib/utils";
import { ExtLink, PageHeader, Section } from "./site/PageHeader";
import { StateBadge, StatusDot } from "./site/StateBadge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Skeleton } from "./ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const REFRESH_MS = 60_000;

const OVERALL: Record<Level, string> = {
  ok: "All systems operational",
  warn: "Degraded: needs attention",
  down: "Outage: a proof is failing",
};

const LEVEL_LABEL: Record<Level, string> = { ok: "operational", warn: "degraded", down: "down" };

const HOUR_COLOR: Record<HourCell["state"], string> = {
  success: "bg-success hover:bg-success/80",
  failure: "bg-destructive hover:bg-destructive/80",
  running: "bg-warning hover:bg-warning/80",
  none: "bg-muted hover:bg-muted-foreground/30",
};

function utc(sec: number) {
  return new Date(sec * 1000).toUTCString().slice(5, 22) + " UTC";
}

function ago(sec: number, now: number) {
  const s = Math.max(0, now - sec);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function until(sec: number, now: number) {
  const s = Math.max(0, sec - now);
  if (s < 5400) return `in ${Math.round(s / 60)}m`;
  if (s < 172800) return `in ${Math.round(s / 3600)}h`;
  return `in ${Math.round(s / 86400)}d`;
}

function runLabel(r: RunInfo) {
  if (r.status !== "completed") return r.status.replace("_", " ");
  return r.conclusion ?? "unknown";
}

function runTone(r: RunInfo) {
  return r.status !== "completed" ? "warn" : r.conclusion === "success" ? "ok" : "bad";
}

function hourTip(h: HourCell) {
  return `${utc(h.start).slice(0, 12)} ${new Date(h.start * 1000).toISOString().slice(11, 16)} UTC: ${
    h.state === "none" ? "no check ran" : `${h.runs} check${h.runs > 1 ? "s" : ""}, ${h.state}`
  }`;
}

function HourTracker({ hours }: { hours: HourCell[] }) {
  return (
    <ul className="flex h-9 items-stretch gap-0.5" aria-label="Watchtower checks, last 48 hours">
      {hours.map((h, i) => {
        const tip = hourTip(h);
        const cls = cn(
          "block h-full w-full rounded-[2px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          i === 0 && "rounded-l-md",
          i === hours.length - 1 && "rounded-r-md",
          HOUR_COLOR[h.state]
        );
        return (
          <li key={h.start} className="flex-1">
            <Tooltip>
              <TooltipTrigger asChild>
                {h.url ? (
                  <a href={h.url} target="_blank" rel="noreferrer" aria-label={tip} className={cls} />
                ) : (
                  <span tabIndex={0} aria-label={tip} className={cls} />
                )}
              </TooltipTrigger>
              <TooltipContent className="font-mono text-xs">{tip}</TooltipContent>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}

function ComponentRow({ c }: { c: StatusComponent }) {
  return (
    <li className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 items-center gap-2.5 sm:w-64 sm:shrink-0">
        <StatusDot state={c.state} />
        <span className="truncate text-sm font-medium">
          {c.link ? (
            <a href={c.link} target="_blank" rel="noreferrer" className="transition-colors hover:text-primary">
              {c.name}
            </a>
          ) : (
            c.name
          )}
        </span>
      </div>
      <p className="min-w-0 flex-1 break-words pl-[18px] text-sm text-muted-foreground sm:pl-0">{c.detail}</p>
      <StateBadge state={c.state} dot={false} className="ml-[18px] self-start sm:ml-0 sm:self-center">
        {LEVEL_LABEL[c.state]}
      </StateBadge>
    </li>
  );
}

function RunRow({ href, title, meta, tone }: { href: string; title: string; meta: string; tone: string }) {
  return (
    <li className="flex items-center gap-3 px-4 py-2.5 text-sm">
      <StatusDot state={tone} />
      <a href={href} target="_blank" rel="noreferrer" className="font-medium transition-colors hover:text-primary">
        {title}
      </a>
      <span className="ml-auto text-right font-mono text-xs text-muted-foreground">{meta}</span>
    </li>
  );
}

export function StatusView() {
  const [report, setReport] = useState<StatusReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setReport(body as StatusReport);
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

  const groups = report ? Array.from(new Set(report.components.map((c) => c.group))) : [];
  const failedRuns = report
    ? [
        ...(report.watchtower?.runs ?? []).map((r) => ({ ...r, workflow: "Watchtower" })),
        ...(report.publisher?.runs ?? []).map((r) => ({ ...r, workflow: "Epoch publisher" })),
      ]
        .filter((r) => r.status === "completed" && r.conclusion !== "success")
        .sort((a, b) => b.createdAt - a.createdAt)
    : [];

  const overallIcon = report
    ? report.overall === "ok"
      ? <CheckCircle2 className="h-7 w-7 shrink-0 text-success" aria-hidden />
      : report.overall === "warn"
        ? <CircleAlert className="h-7 w-7 shrink-0 text-warning" aria-hidden />
        : <XCircle className="h-7 w-7 shrink-0 text-destructive" aria-hidden />
    : null;

  return (
    <>
      <PageHeader
        eyebrow="ReserveProof · status"
        title="Are the proofs up?"
        lede="Every custody proof on both testnets, the Morpho oracle wrapper, the epoch publisher (every 3 days), the hourly watchtower that re-publishes if a run is missed, and the publisher's gas. Proof health is read from the chain; run history comes from GitHub Actions."
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href="/verify">Verify every claim</Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <a href="/api/status" target="_blank" rel="noreferrer">
                JSON feed
              </a>
            </Button>
          </>
        }
      />
      <div className="container space-y-10 py-10 lg:py-12">
        {!report && !error && (
          <div className="space-y-3" aria-busy>
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Reading both chains and the run history…
            </p>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        )}
        {error && (
          <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            Could not load status: {error}
          </p>
        )}

        {report && (
          <>
            <Card
              aria-live="polite"
              className={cn(
                "border-l-2 bg-card/70",
                report.overall === "ok" ? "border-l-success/70" : report.overall === "warn" ? "border-l-warning/70" : "border-l-destructive/80"
              )}
            >
              <CardContent className="space-y-3 p-5 md:p-6">
                <div className="flex items-center gap-3">
                  {overallIcon}
                  <div className="min-w-0">
                    <p className="font-display text-xl font-semibold tracking-tight md:text-2xl">{OVERALL[report.overall]}</p>
                    <p className="font-mono text-xs text-muted-foreground">
                      read {ago(report.readAt, now)} · {report.chains.map((c) => `${c.label} block ${c.block ?? "—"}`).join(" · ")}
                    </p>
                  </div>
                </div>
                {report.reasons.length > 0 && (
                  <ul className="space-y-1 pl-10 text-sm text-warning">
                    {report.reasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            {report.watchtower && (
              <Section
                kicker="Watchtower, last 48 hours"
                title={`${report.watchtower.ranInWindow} of 48 hourly slots had a check`}
                description={
                  <>
                    Next slot {utc(report.watchtower.nextSlot).slice(12)} ({until(report.watchtower.nextSlot, now)}) ·{" "}
                    <ExtLink href={report.watchtower.workflowUrl}>all runs ↗</ExtLink>
                  </>
                }
              >
                <Card className="bg-card/60">
                  <CardContent className="p-4 md:p-5">
                    <HourTracker hours={report.watchtower.hours} />
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>48h ago</span>
                      <span className="order-last flex w-full flex-wrap gap-3 sm:order-none sm:w-auto">
                        {(["success", "failure", "running", "none"] as const).map((s) => (
                          <span key={s} className="inline-flex items-center gap-1.5">
                            <span className={cn("h-2 w-2 rounded-sm", HOUR_COLOR[s])} aria-hidden />
                            {s === "none" ? "no check" : s}
                          </span>
                        ))}
                      </span>
                      <span>now</span>
                    </div>
                  </CardContent>
                </Card>
              </Section>
            )}

            {groups.map((g) => (
              <Section key={g} kicker={g}>
                <Card className="overflow-hidden bg-card/60">
                  <ul className="divide-y divide-border/60">
                    {report.components
                      .filter((c) => c.group === g)
                      .map((c, i) => (
                        <ComponentRow key={i} c={c} />
                      ))}
                  </ul>
                </Card>
              </Section>
            ))}

            <div className="grid gap-6 lg:grid-cols-2">
              {report.publisher && (
                <Section
                  kicker="Epoch publisher runs"
                  description={
                    <>
                      Next scheduled {utc(report.publisher.nextScheduled)} ({until(report.publisher.nextScheduled, now)}) ·{" "}
                      <ExtLink href={report.publisher.workflowUrl}>all runs ↗</ExtLink>
                    </>
                  }
                >
                  <Card className="overflow-hidden bg-card/60">
                    <ul className="divide-y divide-border/60">
                      {report.publisher.runs.map((r) => (
                        <RunRow
                          key={r.id}
                          href={r.url}
                          title={utc(r.createdAt)}
                          tone={runTone(r)}
                          meta={`${r.event === "schedule" ? "scheduled" : r.event === "workflow_dispatch" ? "manual" : r.event} · ${runLabel(r)} · ${ago(r.createdAt, now)}`}
                        />
                      ))}
                      {report.publisher.runs.length === 0 && <li className="px-4 py-3 text-sm text-muted-foreground">No runs yet.</li>}
                    </ul>
                  </Card>
                </Section>
              )}

              <Section kicker="Incidents">
                <Card className="overflow-hidden bg-card/60">
                  {failedRuns.length === 0 && report.overall === "ok" ? (
                    <p className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
                      <CheckCircle2 className="h-4 w-4 text-success" /> No failed runs in the window shown and nothing degraded right now.
                    </p>
                  ) : (
                    <ul className="divide-y divide-border/60">
                      {report.reasons.map((r, i) => (
                        <li key={`now-${i}`} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                          <StatusDot state="warn" className="mt-1.5" />
                          <span>
                            <strong>Now:</strong> {r}
                          </span>
                        </li>
                      ))}
                      {failedRuns.map((r) => (
                        <RunRow
                          key={r.id}
                          href={r.url}
                          title={`${r.workflow} ${runLabel(r)}`}
                          tone="bad"
                          meta={`${utc(r.createdAt)} · ${ago(r.createdAt, now)}`}
                        />
                      ))}
                    </ul>
                  )}
                </Card>
              </Section>
            </div>

            {report.errors.length > 0 && (
              <p className="text-sm text-warning">
                {report.errors.length} source{report.errors.length > 1 ? "s" : ""} degraded: {report.errors.slice(0, 3).join("; ")}
              </p>
            )}
          </>
        )}

        <Section kicker="How this is judged">
          <Card className="bg-card/40">
            <CardContent className="p-5 md:p-6">
              <ul className="space-y-3 text-sm leading-relaxed text-muted-foreground">
                <li>
                  <strong className="text-destructive">Down</strong>: a custody proof is failing, an equivocation is proven, a
                  balance challenge is past its deadline, an ExitRight claim defaulted, the Morpho wrapper is reverting, or a gated
                  consumer is frozen.
                </li>
                <li>
                  <strong className="text-warning">Degraded</strong>: a proof has under 48 hours before it goes stale, a dispute or
                  challenge is open, the last publisher or watchtower run failed, no watchtower check ran in the last 3 hours, or
                  the publisher has under 0.001 ETH.
                </li>
                <li>
                  GitHub runs scheduled workflows best-effort and can start them hours late, so a gap in the hourly bar is shown as
                  it is rather than hidden. The watchtower re-publishes whenever a proof has under 72 hours left, so a late check
                  still lands days before anything goes stale.
                </li>
                <li>
                  Sources: <span className="font-mono text-xs text-foreground/80">loadRisk</span> reads of both testnets (the same
                  data as{" "}
                  <Link href="/risk" className="text-primary underline-offset-4 hover:underline">
                    /risk
                  </Link>
                  ), the deployer&apos;s balance, and the GitHub Actions API for{" "}
                  <ExtLink href={`${GITHUB_URL}/actions/workflows/watchtower.yml`}>watchtower.yml</ExtLink> and{" "}
                  <ExtLink href={`${GITHUB_URL}/actions/workflows/ops-epoch.yml`}>ops-epoch.yml</ExtLink>. Cached for 2 minutes;
                  the page refreshes every minute.
                </li>
              </ul>
            </CardContent>
          </Card>
        </Section>
      </div>
    </>
  );
}
