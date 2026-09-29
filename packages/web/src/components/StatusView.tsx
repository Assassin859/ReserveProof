"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { GITHUB_URL } from "../lib/deployments";
import type { HourCell, Level, RunInfo, StatusComponent, StatusReport } from "../lib/status";
import { Button } from "./ui/button";
import { PageHeader } from "./site/PageHeader";

const REFRESH_MS = 60_000;

const OVERALL: Record<Level, string> = {
  ok: "All systems operational",
  warn: "Degraded: needs attention",
  down: "Outage: a proof is failing",
};

const PILL: Record<Level, string> = { ok: "ok", warn: "warn", down: "down" };

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

function ComponentRow({ c }: { c: StatusComponent }) {
  return (
    <li className="status-row">
      <span className={`status-dot ${PILL[c.state]}`} aria-hidden />
      <span className="status-name">
        {c.link ? (
          <a href={c.link} target="_blank" rel="noreferrer">
            {c.name}
          </a>
        ) : (
          c.name
        )}
      </span>
      <span className="status-detail">{c.detail}</span>
      <span className={`pill status-pill ${PILL[c.state]}`}>{c.state === "ok" ? "operational" : c.state === "warn" ? "degraded" : "down"}</span>
    </li>
  );
}

function HourBar({ hours }: { hours: HourCell[] }) {
  return (
    <div className="status-bar" role="img" aria-label="Watchtower checks, last 48 hours">
      {hours.map((h) => {
        const tip = `${utc(h.start).slice(0, 12)} ${new Date(h.start * 1000).toISOString().slice(11, 16)} UTC: ${
          h.state === "none" ? "no check ran" : `${h.runs} check${h.runs > 1 ? "s" : ""}, ${h.state}`
        }`;
        const cell = <span className={`status-cell ${h.state}`} title={tip} />;
        return h.url ? (
          <a key={h.start} href={h.url} target="_blank" rel="noreferrer" aria-label={tip}>
            {cell}
          </a>
        ) : (
          <span key={h.start}>{cell}</span>
        );
      })}
      <div className="status-bar-axis muted-text">
        <span>48h ago</span>
        <span>now</span>
      </div>
    </div>
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
    <div className="shell">

      {!report && !error && <p className="muted-text">Reading both chains and the run history…</p>}
      {error && <p className="bad-text">Could not load status: {error}</p>}

      {report && (
        <>
          <section className={`status-banner ${PILL[report.overall]}`} aria-live="polite">
            <strong>{OVERALL[report.overall]}</strong>
            <span className="muted-text mono">
              read {ago(report.readAt, now)} ·{" "}
              {report.chains.map((c) => `${c.label} block ${c.block ?? "—"}`).join(" · ")}
            </span>
            {report.reasons.length > 0 && (
              <ul className="status-reasons">
                {report.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
          </section>

          {groups.map((g) => (
            <section key={g} className="status-group" aria-label={g}>
              <p className="section-kicker">{g}</p>
              <ul className="status-list">
                {report.components
                  .filter((c) => c.group === g)
                  .map((c, i) => (
                    <ComponentRow key={i} c={c} />
                  ))}
              </ul>
            </section>
          ))}

          {report.watchtower && (
            <section className="status-group" aria-label="Watchtower history">
              <p className="section-kicker">
                Watchtower, last 48 hours{" "}
                <span className="muted-text">
                  · {report.watchtower.ranInWindow} of 48 hourly slots had a check · next slot{" "}
                  {utc(report.watchtower.nextSlot).slice(12)} ({until(report.watchtower.nextSlot, now)}) ·{" "}
                  <a href={report.watchtower.workflowUrl} target="_blank" rel="noreferrer">
                    all runs ↗
                  </a>
                </span>
              </p>
              <HourBar hours={report.watchtower.hours} />
            </section>
          )}

          {report.publisher && (
            <section className="status-group" aria-label="Recent publishes">
              <p className="section-kicker">
                Epoch publisher runs{" "}
                <span className="muted-text">
                  · next scheduled {utc(report.publisher.nextScheduled)} ({until(report.publisher.nextScheduled, now)}) ·{" "}
                  <a href={report.publisher.workflowUrl} target="_blank" rel="noreferrer">
                    all runs ↗
                  </a>
                </span>
              </p>
              <ul className="status-runs">
                {report.publisher.runs.map((r) => (
                  <li key={r.id}>
                    <span className={`status-dot ${r.status !== "completed" ? "warn" : r.conclusion === "success" ? "ok" : "down"}`} aria-hidden />
                    <a href={r.url} target="_blank" rel="noreferrer">
                      {utc(r.createdAt)}
                    </a>
                    <span className="muted-text">
                      {r.event === "schedule" ? "scheduled" : r.event === "workflow_dispatch" ? "manual" : r.event} ·{" "}
                      {runLabel(r)} · {ago(r.createdAt, now)}
                    </span>
                  </li>
                ))}
                {report.publisher.runs.length === 0 && <li className="muted-text">No runs yet.</li>}
              </ul>
            </section>
          )}

          <section className="status-group" aria-label="Incidents">
            <p className="section-kicker">Incidents</p>
            {failedRuns.length === 0 && report.overall === "ok" ? (
              <p className="muted-text">No failed runs in the window shown and nothing degraded right now.</p>
            ) : (
              <ul className="status-runs">
                {report.reasons.map((r, i) => (
                  <li key={`now-${i}`}>
                    <span className="status-dot warn" aria-hidden />
                    <span>
                      <strong>Now:</strong> {r}
                    </span>
                  </li>
                ))}
                {failedRuns.map((r) => (
                  <li key={r.id}>
                    <span className="status-dot down" aria-hidden />
                    <a href={r.url} target="_blank" rel="noreferrer">
                      {r.workflow} {runLabel(r)}
                    </a>
                    <span className="muted-text">
                      {utc(r.createdAt)} · {ago(r.createdAt, now)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {report.errors.length > 0 && (
            <p className="warn-text risk-errors">
              {report.errors.length} source{report.errors.length > 1 ? "s" : ""} degraded: {report.errors.slice(0, 3).join("; ")}
            </p>
          )}
        </>
      )}

      <section className="radar-method" aria-label="Method">
        <p className="section-kicker">How this is judged</p>
        <ul>
          <li>
            <strong>Down</strong>: a custody proof is failing, an equivocation is proven, a balance challenge is past its
            deadline, an ExitRight claim defaulted, the Morpho wrapper is reverting, or a gated consumer is frozen.
          </li>
          <li>
            <strong>Degraded</strong>: a proof has under 48 hours before it goes stale, a dispute or challenge is open, the
            last publisher or watchtower run failed, no watchtower check ran in the last 3 hours, or the publisher has
            under 0.001 ETH.
          </li>
          <li>
            GitHub runs scheduled workflows best-effort and can start them hours late, so a gap in the hourly bar is shown
            as it is rather than hidden. The watchtower re-publishes whenever a proof has under 72 hours left, so a late
            check still lands days before anything goes stale.
          </li>
          <li>
            Sources: <span className="mono">loadRisk</span> reads of both testnets (the same data as{" "}
            <Link href="/risk">/risk</Link>), the deployer&apos;s balance, and the GitHub Actions API for{" "}
            <a href={`${GITHUB_URL}/actions/workflows/watchtower.yml`} target="_blank" rel="noreferrer">
              watchtower.yml
            </a>{" "}
            and{" "}
            <a href={`${GITHUB_URL}/actions/workflows/ops-epoch.yml`} target="_blank" rel="noreferrer">
              ops-epoch.yml
            </a>
            . Cached for 2 minutes; the page refreshes every minute.
          </li>
        </ul>
      </section>

    </div>
    </>
  );
}
