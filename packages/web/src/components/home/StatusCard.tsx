"use client";

import { RefreshCw } from "lucide-react";
import { reasonLabel } from "@/lib/reasons";
import type { NetworkKey } from "@/lib/deployments";
import { BorderBeam } from "../fx/BorderBeam";
import { StateBadge } from "../site/StateBadge";
import { NetworkSwitch } from "./parts";

export type CustodyRow = {
  label: string;
  hint?: string;
  status: { ok: boolean; reason: number } | null;
  /** Shown instead of a state when this asset's proof lives on another chain. */
  elsewhere?: string;
};

export function StatusCard({
  network,
  onNetwork,
  rows,
  oracle,
  reserve,
  onRefresh,
}: {
  network: NetworkKey;
  onNetwork: (k: NetworkKey) => void;
  rows: CustodyRow[];
  oracle: React.ReactNode;
  reserve: React.ReactNode;
  onRefresh: () => void;
}) {
  return (
    <aside
      aria-label="Live status"
      className="relative rounded-2xl border border-white/10 bg-card/65 p-4 shadow-2xl shadow-black/40 backdrop-blur-xl sm:p-5"
    >
      <BorderBeam size={180} duration={14} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <NetworkSwitch value={network} onChange={onNetwork} />
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh live status"
          className="inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      <ul className="mt-4 divide-y divide-border/60">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium">{r.label}</p>
              {r.hint && <p className="text-xs text-muted-foreground">{r.hint}</p>}
            </div>
            {r.elsewhere ? (
              <span className="text-right text-xs text-muted-foreground">{r.elsewhere}</span>
            ) : (
              <div className="flex shrink-0 flex-col items-end gap-1">
                <StateBadge state={r.status ? (r.status.ok ? "solvent" : "bad") : "checking"}>
                  {r.status ? (r.status.ok ? "solvent" : "insolvent") : "reading"}
                </StateBadge>
                {r.status && <span className="font-mono text-[0.68rem] text-muted-foreground">{reasonLabel(r.status.reason)}</span>}
              </div>
            )}
          </li>
        ))}
      </ul>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-border/60 pt-3 text-xs">
        <dt className="text-muted-foreground">Demo custodian</dt>
        <dd className="text-right">Kopi Wallet</dd>
        <dt className="text-muted-foreground">Oracle</dt>
        <dd className="text-right font-mono">{oracle}</dd>
        <dt className="text-muted-foreground">Reserve wallet</dt>
        <dd className="text-right font-mono">{reserve}</dd>
      </dl>
    </aside>
  );
}
