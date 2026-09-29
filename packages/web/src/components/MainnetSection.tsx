"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { createPublicClient, formatUnits, http, type Address } from "viem";
import { assetConfigAbi, liabilityLedgerAbi, reserveSamplerAbi, solvencyOracleAbi } from "../lib/abis";
import { FAILURES, MAINNET, MAINNET_EXPLORER, SITE_STATS, robinhoodMainnet } from "../lib/mainnet";
import { reasonLabel } from "../lib/reasons";
import { Section } from "./site/PageHeader";
import { KpiCard } from "./site/KpiCard";
import { StateBadge } from "./site/StateBadge";
import { Card, CardContent } from "./ui/card";

const ZERO = BigInt(0);
const BPS = BigInt(10_000);

type AssetRow = {
  label: string;
  token: Address;
  decimals: number;
  ok: boolean;
  reason: number;
  epochId: bigint;
  updatedAt: bigint;
  allocation: bigint;
  effective: bigint;
  floorBps: number;
};

function usd(n: number) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3).toLocaleString("en-US")}K`;
  return `$${n.toFixed(0)}`;
}

function compact(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3).toLocaleString("en-US")}K`;
  return n.toFixed(0);
}

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function explorerLink(addr: string, label?: string) {
  return (
    <a href={`${MAINNET_EXPLORER}/address/${addr}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">
      {label ?? short(addr)} ↗
    </a>
  );
}

function useMainnetStatus() {
  const [rows, setRows] = useState<AssetRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const client = useMemo(
    () => (MAINNET ? createPublicClient({ chain: robinhoodMainnet, transport: http() }) : null),
    []
  );

  useEffect(() => {
    if (!client || !MAINNET) return;
    const dep = MAINNET;
    const candidates: [string, Address | undefined, number][] = [
      ["USDG", dep.contracts.USDG, 6],
      ["TSLA", dep.contracts.TSLA, 18],
    ];
    const assets = candidates.filter((a): a is [string, Address, number] => Boolean(a[1]));

    let cancelled = false;
    async function load() {
      try {
        const out = await Promise.all(
          assets.map(async ([label, token, decimals]) => {
            const args = [dep.custodianId, token] as const;
            const [status, epochId, config] = await Promise.all([
              client!.readContract({
                address: dep.contracts.SolvencyOracle,
                abi: solvencyOracleAbi,
                functionName: "status",
                args,
              }),
              client!.readContract({
                address: dep.contracts.LiabilityLedger,
                abi: liabilityLedgerAbi,
                functionName: "latestEpochId",
                args,
              }) as Promise<bigint>,
              client!.readContract({
                address: dep.contracts.AssetConfig,
                abi: assetConfigAbi,
                functionName: "getConfig",
                args,
              }),
            ]);
            const s = status as { ok: boolean; updatedAt: bigint; reason: number };
            let allocation = ZERO;
            let effective = ZERO;
            if (epochId > ZERO) {
              const [epoch, eff] = await Promise.all([
                client!.readContract({
                  address: dep.contracts.LiabilityLedger,
                  abi: liabilityLedgerAbi,
                  functionName: "getEpoch",
                  args: [...args, epochId],
                }),
                client!.readContract({
                  address: dep.contracts.ReserveSampler,
                  abi: reserveSamplerAbi,
                  functionName: "effectiveReserves",
                  args: [...args, epochId],
                }) as Promise<bigint>,
              ]);
              allocation = (epoch as { allocation: bigint }).allocation;
              effective = eff;
            }
            return {
              label,
              token,
              decimals,
              ok: s.ok,
              reason: Number(s.reason),
              epochId,
              updatedAt: s.updatedAt,
              allocation,
              effective,
              floorBps: Number((config as { coverageFloorBps: number }).coverageFloorBps),
            };
          })
        );
        if (!cancelled) {
          setRows(out);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message.split("\n")[0]);
      }
    }
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [client]);

  return { rows, error };
}

/** Mainnet market size (read on chain by scripts/market-size.ts) plus the live mainnet proof, if deployed. */
export function MainnetSection() {
  const m = SITE_STATS.market;
  const { rows, error } = useMainnetStatus();

  return (
    <Section
      id="mainnet"
      kicker="On Robinhood Chain mainnet today"
      title="Real stock tokens back real loans. Nothing checks the custodian."
      description={
        m && (
          <>
            Block {m.block.toLocaleString("en-US")}, {new Date(m.timestamp).toUTCString().slice(5, 16)} ·{" "}
            <a
              href="https://github.com/Assassin859/ReserveProof/blob/master/docs/market-size.json"
              target="_blank"
              rel="noreferrer"
              className="text-primary underline-offset-4 hover:underline"
            >
              method ↗
            </a>{" "}
            ·{" "}
            <Link href="/radar" className="text-primary underline-offset-4 hover:underline">
              every market, live →
            </Link>
          </>
        )
      }
    >
      {m && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard
              label="Stock tokens on Morpho"
              value={m.stockSupplyUsd}
              format={usd}
              sub={`total supply of ${m.stockTokens} issuer-listed stock and ETF tokens`}
            />
            <KpiCard label="USDG in circulation" value={m.usdgSupply} format={compact} sub="Paxos dollar stablecoin" />
            <KpiCard
              label="Lent against stocks"
              value={m.usdgSuppliedAgainstStocks}
              format={(n) => `${compact(n)} USDG`}
              sub={`${m.morphoStockMarkets} Morpho markets · ${compact(m.usdgBorrowedAgainstStocks)} borrowed`}
            />
            <KpiCard
              label="Reserve-proof oracles"
              tone="bad"
              display={m.oracles && m.oracles.reserveProofFeedsFound > 0 ? m.oracles.reserveProofFeedsFound : "None"}
              sub={
                m.oracles
                  ? `${m.oracles.priceFeedOnly} of ${m.oracles.distinct} oracles read price feeds only; ${m.oracles.unclassified} unclassified`
                  : "Morpho asks each oracle for price() only"
              }
            />
          </div>
          {FAILURES.length > 0 && (
            <p className="mt-4 text-sm text-muted-foreground">
              {FAILURES.map((f, i) => (
                <span key={f.name}>
                  {i > 0 && " · "}
                  {f.name}: <strong className="text-foreground">{f.figure}</strong>{" "}
                  <a href={f.source} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    source ↗
                  </a>
                </span>
              ))}
            </p>
          )}
        </>
      )}

      {MAINNET && (
        <Card className="mt-6 border-border/70 bg-card/60">
          <CardContent className="space-y-4 p-5 md:p-6">
            <div className="flex flex-wrap items-center gap-3">
              <StateBadge state="ok">live on mainnet</StateBadge>
              <p className="text-sm">
                Real USDG{MAINNET.contracts.TSLA ? " and real TSLA" : ""} in our own reserve wallet, proven by the same
                contracts as the demo below.
              </p>
            </div>
            {MAINNET.book?.kind !== "real" && (
              <p className="text-sm text-warning">
                Demo book: the liabilities are{" "}
                {MAINNET.book
                  ? `${MAINNET.book.realUsers} real wallet we control and ${MAINNET.book.placeholders} placeholder addresses`
                  : "our own test accounts"}
                , not customer balances. The reserves and the on-chain checks are real.
              </p>
            )}
            {error && <p className="text-sm text-muted-foreground">Mainnet read failed: {error}</p>}
            <div className="grid gap-3 md:grid-cols-2">
              {(rows ?? []).map((r) => {
                const coverage = r.allocation > ZERO ? (r.effective * BPS) / r.allocation : null;
                return (
                  <div key={r.label} className="rounded-lg border border-border/60 bg-background/40 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium">{r.label} custody</p>
                      <StateBadge state={r.ok ? "ok" : "bad"}>{r.ok ? "solvent" : "insolvent"}</StateBadge>
                    </div>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">{reasonLabel(r.reason)}</p>
                    <p className="mt-2 font-mono text-xs text-foreground/85">
                      epoch {String(r.epochId)} · coverage{" "}
                      {coverage !== null ? `${(Number(coverage) / 100).toFixed(1)}%` : "—"} (floor{" "}
                      {(r.floorBps / 100).toFixed(0)}%) ·{" "}
                      {Number(formatUnits(r.allocation, r.decimals)).toLocaleString("en-US", {
                        maximumFractionDigits: 4,
                      })}{" "}
                      {r.label} owed
                    </p>
                  </div>
                );
              })}
              {!rows && !error && <span className="text-sm text-muted-foreground">Reading mainnet…</span>}
            </div>
            <p className="font-mono text-xs leading-relaxed text-muted-foreground">
              Oracle {explorerLink(MAINNET.contracts.SolvencyOracle)} · Ledger{" "}
              {explorerLink(MAINNET.contracts.LiabilityLedger)}
              {MAINNET.reserveWallet && <> · Reserve wallet {explorerLink(MAINNET.reserveWallet)}</>}
              {MAINNET.contracts.SolvencyGatedMorphoOracle && (
                <> · Gated Morpho oracle {explorerLink(MAINNET.contracts.SolvencyGatedMorphoOracle)}</>
              )}
            </p>
          </CardContent>
        </Card>
      )}
    </Section>
  );
}
