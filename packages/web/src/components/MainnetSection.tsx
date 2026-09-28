"use client";

import { useEffect, useMemo, useState } from "react";
import { createPublicClient, formatUnits, http, type Address } from "viem";
import { assetConfigAbi, liabilityLedgerAbi, reserveSamplerAbi, solvencyOracleAbi } from "../lib/abis";
import { FAILURES, MAINNET, MAINNET_EXPLORER, SITE_STATS, robinhoodMainnet } from "../lib/mainnet";
import { reasonLabel } from "../lib/reasons";

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
    <a href={`${MAINNET_EXPLORER}/address/${addr}`} target="_blank" rel="noreferrer">
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
    <section className="mainnet" aria-label="Robinhood Chain mainnet">
      {m && (
        <>
          <p className="section-kicker">
            On Robinhood Chain mainnet today{" "}
            <span className="muted-text">
              · block {m.block.toLocaleString("en-US")},{" "}
              {new Date(m.timestamp).toUTCString().slice(5, 16)} ·{" "}
              <a href="https://github.com/Assassin859/ReserveProof/blob/master/docs/market-size.json" target="_blank" rel="noreferrer">
                method ↗
              </a>
            </span>
          </p>
          <div className="live-strip numbers">
            <div className="strip-cell">
              <span className="label">Tokenized stocks</span>
              <span className="big">{usd(m.stockSupplyUsd)}</span>
              <span className="sub">{m.stockTokens} stock and ETF tokens</span>
            </div>
            <div className="strip-cell">
              <span className="label">USDG in circulation</span>
              <span className="big">{compact(m.usdgSupply)}</span>
              <span className="sub">Paxos dollar stablecoin</span>
            </div>
            <div className="strip-cell">
              <span className="label">Lent against stocks</span>
              <span className="big">{compact(m.usdgSuppliedAgainstStocks)} USDG</span>
              <span className="sub">
                {m.morphoStockMarkets} Morpho markets · {compact(m.usdgBorrowedAgainstStocks)} borrowed
              </span>
            </div>
            <div className="strip-cell">
              <span className="label">Markets that check reserves</span>
              <span className="big bad-text">0 of {m.morphoStockMarkets}</span>
              <span className="sub">each asks its oracle for price() only</span>
            </div>
          </div>
          {FAILURES.length > 0 && (
            <p className="failures">
              {FAILURES.map((f, i) => (
                <span key={f.name}>
                  {i > 0 && " · "}
                  {f.name}: <strong>{f.figure}</strong>{" "}
                  <a href={f.source} target="_blank" rel="noreferrer">
                    source ↗
                  </a>
                </span>
              ))}
            </p>
          )}
        </>
      )}

      {MAINNET && (
        <div className="mainnet-card">
          <div className="mainnet-head">
            <span className="pill ok">live on mainnet</span>
            <span className="value">
              Real USDG{MAINNET.contracts.TSLA ? " and real TSLA" : ""} in our own reserve wallet, proven by the same
              contracts as the demo below.
            </span>
          </div>
          {error && <p className="muted-text">Mainnet read failed: {error}</p>}
          <div className="mainnet-rows">
            {(rows ?? []).map((r) => {
              const coverage = r.allocation > ZERO ? (r.effective * BPS) / r.allocation : null;
              return (
                <div className="stat" key={r.label}>
                  <span className="label">{r.label} custody</span>
                  <span className="row">
                    <span className={`pill ${r.ok ? "ok" : "bad"}`}>{r.ok ? "solvent" : "insolvent"}</span>
                    <span className="value mono">{reasonLabel(r.reason)}</span>
                  </span>
                  <span className="value mono">
                    epoch {String(r.epochId)} · coverage{" "}
                    {coverage !== null ? `${(Number(coverage) / 100).toFixed(1)}%` : "—"} (floor{" "}
                    {(r.floorBps / 100).toFixed(0)}%) ·{" "}
                    {Number(formatUnits(r.allocation, r.decimals)).toLocaleString("en-US", {
                      maximumFractionDigits: 4,
                    })}{" "}
                    {r.label} owed
                  </span>
                </div>
              );
            })}
            {!rows && !error && <span className="muted-text">Reading mainnet…</span>}
          </div>
          <div className="mainnet-links mono">
            Oracle {explorerLink(MAINNET.contracts.SolvencyOracle)} · Ledger{" "}
            {explorerLink(MAINNET.contracts.LiabilityLedger)}
            {MAINNET.reserveWallet && <> · Reserve wallet {explorerLink(MAINNET.reserveWallet)}</>}
            {MAINNET.contracts.SolvencyGatedMorphoOracle && (
              <> · Gated Morpho oracle {explorerLink(MAINNET.contracts.SolvencyGatedMorphoOracle)}</>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
