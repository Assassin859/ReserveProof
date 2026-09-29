"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPublicClient, formatUnits, http, isAddress, type Address } from "viem";
import forkDrillJson from "../deployments/fork-drill.json";
import { checkBalance, readLatestEpoch, type BalanceResult } from "../lib/balance";
import { ASSET_META, GITHUB_URL, NETWORKS, type AssetKind } from "../lib/deployments";
import { Button } from "./ui/button";
import { PageHeader } from "./site/PageHeader";
import { SITE_STATS } from "../lib/mainnet";
import type { RadarReport } from "../lib/radar";
import { RPC_URLS } from "../lib/rpc";
import type { Claim, ClaimState, ForkDrill, VerifyReport } from "../lib/verify";

const FORK = forkDrillJson as ForkDrill;
const NET = NETWORKS.robinhoodTestnet;
const DEP = NET.deployment!;
const BALANCE_ASSETS: AssetKind[] = ["stock", "usdg", "tsla"];
const PILL_TEXT: Record<ClaimState | "checking", string> = { pass: "pass", fail: "fail", unknown: "unknown", checking: "checking" };
const PILL_CLASS: Record<ClaimState | "checking", string> = { pass: "ok", fail: "down", unknown: "warn", checking: "" };
const DOT_CLASS: Record<ClaimState | "checking", string> = { pass: "ok", fail: "down", unknown: "warn", checking: "" };

type BalanceRow = { kind: AssetKind; result?: BalanceResult; error?: string };

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
  title,
  state,
  note,
  evidence,
  links,
  reproduce,
  children,
}: {
  id: string;
  title: string;
  state: ClaimState | "checking";
  note?: string;
  evidence: string[];
  links: { label: string; href: string }[];
  reproduce: string;
  children?: ReactNode;
}) {
  return (
    <section id={id} className={`verify-claim ${state}`} aria-label={title}>
      <header className="verify-head">
        <span className={`status-dot ${DOT_CLASS[state]}`} aria-hidden />
        <h2>
          <a href={`#${id}`}>{title}</a>
        </h2>
        <span className={`pill status-pill ${PILL_CLASS[state]}`}>{PILL_TEXT[state]}</span>
      </header>
      {note && <p className="verify-note">{note}</p>}
      {evidence.length > 0 && (
        <ul className="verify-evidence">
          {evidence.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {children}
      {links.length > 0 && (
        <p className="verify-links">
          {links.map((l, i) => (
            <span key={l.href + i}>
              {i > 0 && " · "}
              {l.href.startsWith("/") ? (
                <Link href={l.href}>{l.label}</Link>
              ) : (
                <a href={l.href} target="_blank" rel="noreferrer">
                  {l.label} ↗
                </a>
              )}
            </span>
          ))}
        </p>
      )}
      <details className="verify-repro">
        <summary>Reproduce locally</summary>
        <pre>{reproduce}</pre>
      </details>
    </section>
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

  const balanceState: ClaimState | "checking" = !balances
    ? "checking"
    : balances.some((b) => b.result && (!b.result.rootMatches || (b.result.found && !b.result.verified)))
      ? "fail"
      : balances.some((b) => b.result?.verified) && balances.every((b) => b.result)
        ? "pass"
        : "unknown";

  const radarState: ClaimState | "checking" = radar ? "pass" : radarError ? "unknown" : "checking";
  const m = SITE_STATS.market;

  const states: (ClaimState | "checking")[] = [
    ...(report ? report.claims.map((c) => c.state) : []),
    balanceState,
    radarState,
  ];
  const total = (report ? report.claims.length : 8) + 2;
  const passed = states.filter((s) => s === "pass").length;
  const checking = !report || states.includes("checking");

  const serverCard = (id: string, fallbackTitle: string, extra?: ReactNode) => {
    const c = byId(id);
    return (
      <ClaimCard
        key={id}
        id={id}
        title={c?.title ?? fallbackTitle}
        state={c ? c.state : error ? "unknown" : "checking"}
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
              VERIFY.md
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
    <div className="shell">

      <section className={`status-banner ${checking ? "" : passed === total ? "ok" : states.includes("fail") ? "down" : "warn"}`} aria-live="polite">
        <strong>{checking ? `Checking… ${passed} of ${total} pass so far` : `${passed} of ${total} checks pass`}</strong>
        <span className="muted-text mono">
          {report ? `read ${ago(report.readAt, now)} · server checks cached up to 2 minutes` : "reading chains, explorers and GitHub…"} ·{" "}
          <button type="button" className="linklike" onClick={() => {
            void load();
            void runBalances(addr || NET.books.demoUser || "");
          }}>
            re-run
          </button>
        </span>
        {report && report.errors.length > 0 && (
          <span className="warn-text">Degraded sources: {report.errors.slice(0, 3).join("; ")}</span>
        )}
      </section>

      {serverCard("tests", "Tests pass in CI")}
      {serverCard("contracts", "Every contract is source-verified on both chains")}
      {serverCard("proofs", "Every published proof is live and solvent")}
      {serverCard("same-root", "The same mTSLA liability root is committed on both chains")}

      <ClaimCard
        id="balance"
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
          className="verify-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (isAddress(addr.trim())) void runBalances(addr.trim());
          }}
        >
          <input value={addr} onChange={(e) => setAddr(e.target.value)} spellCheck={false} placeholder="0x… any address" aria-label="Address to check" />
          <button type="submit" className="ghost" disabled={busy || !isAddress(addr.trim())}>
            {busy ? "Checking…" : "Check this address"}
          </button>
          {NET.books.demoUser && addr !== NET.books.demoUser && (
            <button type="button" className="ghost" onClick={() => {
              setAddr(NET.books.demoUser!);
              void runBalances(NET.books.demoUser!);
            }}>
              Demo user
            </button>
          )}
        </form>
        {balances && (
          <ul className="verify-rows">
            {balances.map((b) => (
              <li key={b.kind}>
                <span className={`status-dot ${b.result?.verified ? "ok" : b.result && (!b.result.rootMatches || b.result.found) ? "down" : "warn"}`} aria-hidden />
                <strong>{ASSET_META[b.kind].label}</strong>
                {b.error ? (
                  <span className="muted-text">{b.error}</span>
                ) : b.result ? (
                  <span>
                    {b.result.verified
                      ? `${formatUnits(b.result.amount, ASSET_META[b.kind].decimals)} ${ASSET_META[b.kind].label} proven in epoch ${b.result.epochId}`
                      : !b.result.rootMatches
                        ? "the published book does not rebuild to the on-chain root"
                        : b.result.found
                          ? `in the epoch ${b.result.epochId} book, but the proof does not verify`
                          : `not in the epoch ${b.result.epochId} book`}
                    <span className="muted-text mono">
                      {" "}
                      · root {short(b.result.computedRoot)} {b.result.rootMatches ? "= on chain" : `≠ ${short(b.result.onchainRoot)}`}
                      {b.result.found ? ` · ${b.result.proof.length}-step proof` : ""}
                    </span>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </ClaimCard>

      {serverCard("consumers", "Gated integrations answer on chain and fail closed")}
      {serverCard("exitright", "An ExitRight claim was opened and settled on chain")}
      {serverCard("schedule", "Proofs are re-published on schedule")}

      <ClaimCard
        id="mainnet"
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
        <>
          <p className="section-kicker verify-sub">
            Recorded drill: {FORK.passed} of {FORK.total} checks, fork of block {FORK.forkBlock.toLocaleString("en-US")},{" "}
            {FORK.ranAt.slice(0, 16).replace("T", " ")} UTC
          </p>
          <ul className="verify-steps">
            {steps.map((s) => {
              const rows = FORK.checks.filter((c) => c.step === s);
              return (
                <li key={s}>
                  <strong>
                    {s} <span className="muted-text">{rows.filter((r) => r.ok).length}/{rows.length}</span>
                  </strong>
                  <ul>
                    {rows.map((r, i) => (
                      <li key={i}>
                        <span className={r.ok ? "ok-text" : "bad-text"}>{r.ok ? "PASS" : "FAIL"}</span> {r.check}
                        {r.detail && <span className="muted-text"> ({r.detail})</span>}
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
          <p className="section-kicker verify-sub">Path to live</p>
          <ul className="verify-evidence">
            <li>
              The mainnet deploy is scripted and resumable (<span className="mono">npm run deploy:rhmain</span>), against the
              official USDG and Robinhood&apos;s real TSLA. It hasn&apos;t run: a live pilot needs a partner custodian&apos;s
              real book and reserve wallet, not ours.
            </li>
            <li>
              A pilot adds one <span className="mono">SolvencyGatedMorphoOracle</span> over a curator&apos;s chosen price oracle,
              a capped market, and this same drill run against that exact market before any money goes in.
            </li>
            <li>
              The offer and success criteria:{" "}
              <a href={`${GITHUB_URL}/blob/master/docs/FOUNDER-HOUSE.md#4-the-90-day-pilot-offer`} target="_blank" rel="noreferrer">
                FOUNDER-HOUSE.md, the 90-day pilot ↗
              </a>
            </li>
          </ul>
        </>
      )}

    </div>
    </>
  );
}
