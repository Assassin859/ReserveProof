"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { GITHUB_URL, NETWORK_KEYS, type NetworkKey } from "../lib/deployments";
import type { AssetRisk, ConsumerRisk, FreezeTrigger, RiskReport } from "../lib/risk";

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
    <div className="cov-bar" role="img" aria-label={`coverage ${pct(coverageBps)}, floor ${pct(floorBps)}`}>
      <div className={`cov-fill ${coverageBps >= floorBps ? "ok" : "bad"}`} style={{ width: `${fill}%` }} />
      <div className="cov-floor" style={{ left: `${floor}%` }} title={`floor ${pct(floorBps)}`} />
    </div>
  );
}

function AssetCard({ a, now, gatedBy }: { a: AssetRisk; now: number; gatedBy: string[] }) {
  if (!a.published) {
    return (
      <div className="risk-card">
        <div className="risk-card-head">
          <strong>{a.label}</strong>
          <span className="muted-text">not published on this chain</span>
        </div>
        <p className="risk-identity">{a.identity}</p>
      </div>
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
    <div className="risk-card">
      <div className="risk-card-head">
        <strong>{a.label}</strong>
        <span className={`pill ${a.status?.ok ? "ok" : "bad"}`}>
          {a.status ? (a.status.ok ? "solvent" : "insolvent") : "—"}
        </span>
        <span className="mono muted-text">
          {a.status?.reasonLabel ?? ""} · epoch {a.status?.epochId ?? "—"}
        </span>
      </div>
      <p className="risk-gated">
        {gatedBy.length ? (
          <>
            Gates <strong>{gatedBy.length}</strong> consumer{gatedBy.length > 1 ? "s" : ""}: {gatedBy.join(", ")}
          </>
        ) : (
          <span className="muted-text">No gated consumer on this chain</span>
        )}
      </p>
      <p className="risk-identity">{a.identity}</p>

      {cov && (
        <div className="risk-block">
          <div className="risk-row">
            <span className="label">Coverage vs floor</span>
            <span className={cov.coverageBps !== null && cov.coverageBps < cov.floorBps ? "bad-text" : ""}>
              <strong>{pct(cov.coverageBps)}</strong> <span className="muted-text">/ {pct(cov.floorBps)} required</span>
            </span>
          </div>
          <CoverageBar coverageBps={cov.coverageBps} floorBps={cov.floorBps} />
          <div className="risk-kv">
            <span>Owed here</span>
            <span className="mono">{fmt(cov.allocation.value)} {a.label}</span>
            <span>Required (floor)</span>
            <span className="mono">{fmt(cov.need.value)}</span>
            <span>Counted reserves</span>
            <span className="mono">
              {cov.effective ? fmt(cov.effective.value) : "—"}{" "}
              <span className="muted-text">
                min(live {cov.live ? fmt(cov.live.value) : "—"}, lowest sample {cov.sampleMin ? fmt(cov.sampleMin.value) : "—"})
              </span>
            </span>
            <span>Headroom</span>
            <span className={`mono ${cov.headroom && cov.headroom.value < 0 ? "bad-text" : ""}`}>
              {cov.headroom ? fmt(cov.headroom.value) : "—"} ({pct(cov.headroomBps)} can go before LIVE_SHORT)
            </span>
            <span>Samples</span>
            <span className={`mono ${cov.samples < cov.minSamples ? "bad-text" : ""}`}>
              {cov.samples} / {cov.minSamples} required
            </span>
          </div>
        </div>
      )}

      {mu && (
        <div className={`risk-block ${mu.drift || mu.pendingChange ? "risk-warn" : ""}`}>
          <div className="risk-row">
            <span className="label">Multiplier (ERC-8056)</span>
            <span className={mu.drift || mu.pendingChange ? "bad-text" : "ok-text"}>
              {mu.drift
                ? "drift: MULTIPLIER_DRIFT now"
                : mu.pendingChange
                  ? "change pending: MULTIPLIER_DRIFT now"
                  : "matches the epoch"}
            </span>
          </div>
          <div className="risk-kv">
            <span>Live uiMultiplier</span>
            <span className="mono">{mu.live === null ? "reverts" : multiplier(mu.live)}</span>
            <span>Committed in epoch</span>
            <span className={`mono ${mu.drift ? "bad-text" : ""}`}>{mu.committed === null ? "—" : multiplier(mu.committed)}</span>
            <span>Scheduled change</span>
            <span className={`mono ${mu.pendingChange ? "bad-text" : ""}`}>
              {mu.pendingChange && mu.pending !== null && mu.effectiveAt
                ? `→ ${multiplier(mu.pending)} at ${utc(mu.effectiveAt)} (${until(mu.effectiveAt, now)})`
                : "none"}
            </span>
          </div>
          <p className="risk-note">
            Only the registry-listed contract is ever gated; a copycat or unlisted token never is. See{" "}
            <Link href="/radar">the mainnet radar</Link>.
          </p>
        </div>
      )}

      {st && liveStale !== null && liveMargin !== null && (
        <div className="risk-block">
          <div className="risk-row">
            <span className="label">Time to stale</span>
            <span className={liveStale <= 0 ? "bad-text" : ""}>
              <strong>{liveStale > 0 ? dur(liveStale) : "STALE"}</strong>{" "}
              <span className="muted-text">at {utc(st.staleAt)}</span>
            </span>
          </div>
          <div className="risk-kv">
            <span>Last published</span>
            <span className="mono">
              {utc(st.committedAt)} <span className="muted-text">({until(st.committedAt, now)})</span>
            </span>
            <span>Max age</span>
            <span className="mono">{dur(st.maxOracleAge)}</span>
            <span>Next scheduled publish</span>
            <span className="mono">
              {utc(st.nextPublish)} <span className="muted-text">({until(st.nextPublish, now)})</span>
            </span>
            <span>Margin</span>
            <span className={`mono ${liveMargin < 0 ? "bad-text" : "ok-text"}`}>
              {liveMargin < 0 ? `next publish lands ${dur(-liveMargin)} after stale` : `${dur(liveMargin)} to spare`}
            </span>
          </div>
        </div>
      )}

      {d && x && (
        <div className="risk-block">
          <div className="risk-row">
            <span className="label">Disputes and exits</span>
            <span className={d.isDisputed || d.overdue || d.equivocated || x.exitDefault ? "bad-text" : "ok-text"}>
              {d.equivocated
                ? "equivocation proven (permanent)"
                : x.exitDefault
                  ? "exit default (permanent)"
                  : d.isDisputed || d.overdue
                    ? "disputed"
                    : "none open"}
            </span>
          </div>
          <div className="risk-kv">
            <span>Open disputes</span>
            <span className="mono">{d.openDisputes}</span>
            <span>Balance challenges</span>
            <span className={`mono ${d.overdue ? "bad-text" : ""}`}>
              {d.openChallenges} open · {d.queueLength} ever queued{d.overdue ? " · OVERDUE" : ""}{" "}
              <span className="muted-text">(answer window {dur(d.challengeWindowSec)})</span>
            </span>
            <span>Exit claims</span>
            <span className={`mono ${x.exitDefault ? "bad-text" : ""}`}>
              {x.openClaims} open
              {x.nextDeadline ? ` · next deadline ${utc(x.nextDeadline)} (${until(x.nextDeadline, now)})` : ""}
            </span>
          </div>
        </div>
      )}
    </div>
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

function Consumers({ consumers, explorer, now }: { consumers: ConsumerRisk[]; explorer: string | null; now: number }) {
  return (
    <table className="risk-table">
      <thead>
        <tr>
          <th>Consumer</th>
          <th>State</th>
          <th>What freezes · what stays open</th>
        </tr>
      </thead>
      <tbody>
        {consumers.map((c) => (
          <tr key={c.address}>
            <td>
              <strong>{c.name}</strong>
              <div className="mono muted-text">
                {explorer ? (
                  <a href={`${explorer}/address/${c.address}`} target="_blank" rel="noreferrer">
                    {short(c.address)}
                  </a>
                ) : (
                  short(c.address)
                )}
              </div>
              <div className="muted-text">gated on {c.gatedLabel}</div>
            </td>
            <td>
              <span className={`pill ${c.state === "open" ? "ok" : "bad"}`}>
                {c.state === "open" ? "open" : c.state === "frozen" ? "frozen now" : "unknown"}
              </span>
              {c.reasonLabel && <div className="mono bad-text">{c.reasonLabel}</div>}
            </td>
            <td>
              <div>
                <span className="bad-text">Freezes:</span> {c.freezes.join(", ")}
              </div>
              <div>
                <span className="ok-text">Stays open:</span> {c.staysOpen.join(", ")}
              </div>
              <div className="muted-text">
                {c.exposure.map((e) => `${e.label}: ${e.value}`).join(" · ")}
              </div>
              {c.morpho && (
                <div className="risk-morpho">
                  {morphoLine(c, now)}
                  {c.morpho.basePrice !== null && (
                    <span className="muted-text"> Base oracle: {fmt(c.morpho.basePrice, 4)} USDG/{c.gatedLabel}.</span>
                  )}
                </div>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Triggers({ triggers, now }: { triggers: FreezeTrigger[]; now: number }) {
  if (!triggers.length) return <p className="muted-text">No gated consumer depends on a published asset here.</p>;
  return (
    <ul className="risk-triggers">
      {triggers.map((t, i) => (
        <li key={i} className={t.active ? "active" : ""}>
          <span className={`pill ${t.active ? "bad" : "ok"}`}>{t.active ? "now" : "if"}</span>
          <span>
            {t.text}
            {t.at && !t.active ? <span className="muted-text"> ({until(t.at, now)})</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ChainColumn({ keyName, state, now }: { keyName: NetworkKey; state: Loaded | undefined; now: number }) {
  const r = state?.report;
  return (
    <section className="risk-col" aria-label={r?.label ?? keyName}>
      <div className="risk-col-head">
        <h2>{r?.label ?? keyName}</h2>
        {r && (
          <span className="muted-text mono">
            block {r.block ?? "—"} · read {until(r.readAt, now)}
          </span>
        )}
      </div>
      {!state && <p className="muted-text">Reading the chain…</p>}
      {state?.error && <p className="bad-text">Could not load: {state.error}</p>}
      {r && (
        <>
          <p className="section-kicker">Custody proofs</p>
          {r.assets.map((a) => (
            <AssetCard
              key={a.address}
              a={a}
              now={now}
              gatedBy={r.consumers.filter((c) => c.gatedAsset === a.kind).map((c) => c.name)}
            />
          ))}
          <p className="section-kicker">Gated consumers</p>
          <Consumers consumers={r.consumers} explorer={r.explorer} now={now} />
          <p className="section-kicker">Freezes if</p>
          <Triggers triggers={r.triggers} now={now} />
          {r.errors.length > 0 && (
            <p className="warn-text risk-errors">
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
    <div className="shell">
      <header className="risk-hero">
        <p className="eyebrow">ReserveProof · curator risk</p>
        <h1 className="headline">What would freeze, and when.</h1>
        <p className="lede">
          For vault curators and risk teams: every solvency-gated market on both testnets, the custody proof it
          depends on, how much room that proof has left, and exactly what would stop it. Everything is read live
          from the chain every 30 seconds.
        </p>
        <div className="cta-row">
          <Link className="ghost" href="/">
            ← Live demo
          </Link>
          <Link className="ghost" href="/radar">
            Mainnet radar
          </Link>
          <Link className="ghost" href="/status">
            Status
          </Link>
          <a className="ghost" href="/api/risk?network=robinhoodTestnet" target="_blank" rel="noreferrer">
            JSON feed
          </a>
          <a className="ghost" href={`${GITHUB_URL}/actions/workflows/ops-epoch.yml`} target="_blank" rel="noreferrer">
            Epoch publisher
          </a>
        </div>
      </header>

      <section className="live-strip" aria-label="Summary">
        <div className="strip-cell">
          <span className="label">Gated consumers open</span>
          <span className={`big ${consumers.length && openCount < consumers.length ? "bad-text" : ""}`}>
            {consumers.length ? `${openCount} / ${consumers.length}` : "—"}
          </span>
          <span className="sub">across {reports.length || "—"} chains</span>
        </div>
        <div className="strip-cell">
          <span className="label">Tightest headroom</span>
          <span className={`big ${tightest && tightest.a.coverage!.headroomBps! < 0 ? "bad-text" : ""}`}>
            {tightest ? pct(tightest.a.coverage!.headroomBps) : "—"}
          </span>
          <span className="sub">
            {tightest ? `${tightest.a.label} on ${tightest.r.label}: drop before LIVE_SHORT` : "reserves above the floor"}
          </span>
        </div>
        <div className="strip-cell">
          <span className="label">Soonest stale</span>
          <span className={`big ${soonestStale && soonestStale.a.staleness!.staleAt <= now ? "bad-text" : ""}`}>
            {soonestStale ? dur(Math.max(0, soonestStale.a.staleness!.staleAt - now)) : "—"}
          </span>
          <span className="sub">
            {soonestStale ? `${soonestStale.a.label} on ${soonestStale.r.label}, ${utc(soonestStale.a.staleness!.staleAt)}` : ""}
          </span>
        </div>
        <div className="strip-cell">
          <span className="label">Next scheduled publish</span>
          <span className="big">{nextPublish ? dur(Math.max(0, nextPublish - now)) : "—"}</span>
          <span className="sub">{nextPublish ? `${utc(nextPublish)} · every 3 days` : ""}</span>
        </div>
      </section>

      <div className="risk-grid">
        {CHAINS.map((k) => (
          <ChainColumn key={k} keyName={k} state={data[k]} now={now} />
        ))}
      </div>

      <footer className="foot">
        <span>
          <Link href="/">Live demo</Link> · <Link href="/radar">Mainnet radar</Link> · <Link href="/status">Status</Link> ·{" "}
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>{" "}
          · MIT licensed
        </span>
        <span>
          JSON: <a href="/api/risk?network=robinhoodTestnet">robinhoodTestnet</a> ·{" "}
          <a href="/api/risk?network=arbitrumSepolia">arbitrumSepolia</a>
        </span>
      </footer>
    </div>
  );
}
