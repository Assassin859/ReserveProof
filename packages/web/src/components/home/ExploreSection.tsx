"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, Radar, ShieldCheck, Snowflake } from "lucide-react";
import { BentoCard, BentoGrid } from "../fx/BentoGrid";
import { Section } from "../site/PageHeader";
import { StateBadge, StatusDot } from "../site/StateBadge";

type Hooks = {
  verify?: { pass: number; total: number };
  radar?: { wouldGate: number; reject: number };
  status?: { overall: string; reasons: string[] };
};

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

const OVERALL_LABEL: Record<string, string> = {
  ok: "All systems operational",
  warn: "Degraded",
  down: "Down",
};

/** Four entry points, each with a one-line live hook fetched once the section scrolls into view. */
export function ExploreSection() {
  const ref = useRef<HTMLDivElement>(null);
  const [hooks, setHooks] = useState<Hooks>({});

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let started = false;
    const load = () => {
      if (started) return;
      started = true;
      void getJson<{ claims: { state: string }[] }>("/api/verify").then((v) => {
        if (v) setHooks((h) => ({ ...h, verify: { pass: v.claims.filter((c) => c.state === "pass").length, total: v.claims.length } }));
      });
      void getJson<{ summary: { wouldGate: { markets: number }; reject: { markets: number } } }>("/api/radar").then((r) => {
        if (r) setHooks((h) => ({ ...h, radar: { wouldGate: r.summary.wouldGate.markets, reject: r.summary.reject.markets } }));
      });
      void getJson<{ overall: string; reasons: string[] }>("/api/status").then((s) => {
        if (s) setHooks((h) => ({ ...h, status: { overall: s.overall, reasons: s.reasons } }));
      });
    };
    if (typeof IntersectionObserver === "undefined") {
      load();
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          load();
          io.disconnect();
        }
      },
      { rootMargin: "300px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const { verify, radar, status } = hooks;

  return (
    <Section
      id="explore"
      kicker="Explore"
      title="Check it yourself"
      description="Every claim on this site links to a live read or a public run. Start anywhere."
    >
      <div ref={ref}>
        <BentoGrid className="md:grid-cols-4">
          <BentoCard
            href="/verify"
            icon={<ShieldCheck className="h-4 w-4" />}
            title="Verify every claim"
            description="Tests, verified source, both chains' proofs, the fork drill: each claim with its evidence and a command to reproduce it."
            className="md:col-span-2"
          >
            {verify ? (
              <StateBadge state={verify.pass === verify.total ? "ok" : "warn"}>
                {verify.pass} of {verify.total} pass
              </StateBadge>
            ) : (
              <StateBadge state="checking">checking…</StateBadge>
            )}
          </BentoCard>
          <BentoCard
            href="/radar"
            icon={<Radar className="h-4 w-4" />}
            title="Mainnet radar"
            description="Every Morpho market on Robinhood Chain, marked would gate, wouldn't, or copycat."
            className="md:col-span-2"
          >
            {radar ? (
              <div className="flex flex-wrap gap-2">
                <StateBadge state="gold">{radar.wouldGate} would gate</StateBadge>
                {radar.reject > 0 && <StateBadge state="bad">{radar.reject} copycats</StateBadge>}
              </div>
            ) : (
              <StateBadge state="checking">reading mainnet…</StateBadge>
            )}
          </BentoCard>
          <BentoCard
            href="/risk"
            icon={<Snowflake className="h-4 w-4" />}
            title="Curator risk"
            description="What would freeze, and when: coverage against the floor, time to stale, open disputes, per gated market."
            className="md:col-span-2"
          />
          <BentoCard
            href="/status"
            icon={<Activity className="h-4 w-4" />}
            title="Status"
            description="Proof health on both testnets, the 3-day publisher and the hourly watchtower."
            className="md:col-span-2"
          >
            <span className="inline-flex items-center gap-2 text-sm">
              <StatusDot state={status?.overall ?? "checking"} pulse={Boolean(status)} />
              <span className={status ? "text-foreground" : "text-muted-foreground"}>
                {status ? OVERALL_LABEL[status.overall] ?? status.overall : "checking…"}
              </span>
            </span>
          </BentoCard>
        </BentoGrid>
      </div>
    </Section>
  );
}
