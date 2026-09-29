"use client";

import { useState } from "react";
import { CalendarX2, FileDown, Gavel, Loader2, RotateCcw, Split, TrendingDown, Wallet } from "lucide-react";
import type { BalanceResult } from "@/lib/balance";
import { ASSET_META, type AssetKind } from "@/lib/deployments";
import { reasonLabel } from "@/lib/reasons";
import { SCENARIOS, type ScenarioId } from "@/lib/whatif";
import { cn } from "@/lib/utils";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../ui/accordion";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { CopyButton } from "../site/CopyButton";
import { StateBadge } from "../site/StateBadge";
import { ACTIVE_TOGGLE, KV, Note } from "./parts";
import type { ExitInfo, GateResult, SimResult } from "./types";

type Fmt = (v: bigint | undefined, kind: AssetKind) => string;
type Short = (s?: string) => string;

export function ActionLog({ text }: { text: string }) {
  return (
    <pre className="mt-5 whitespace-pre-wrap break-words rounded-lg border border-border/70 bg-background/70 p-4 font-mono text-xs leading-relaxed text-foreground/85">
      {text}
    </pre>
  );
}

export function WalletScene({ onCheck }: { onCheck: () => void }) {
  return (
    <Button onClick={onCheck}>
      <Wallet className="mr-1.5 h-4 w-4" />
      Check who owns the reserve wallet
    </Button>
  );
}

export function LedgerScene({
  items,
  covered,
  floor,
}: {
  items: [React.ReactNode, React.ReactNode][];
  covered: boolean | undefined;
  floor: string;
}) {
  return (
    <div className="space-y-4">
      <KV items={items} />
      {covered !== undefined && (
        <Note tone={covered ? "ok" : "bad"}>
          {covered
            ? `Reserves cover the allocation above the ${floor} floor, so the oracle reports solvent.`
            : `Reserves are below the ${floor} floor, so the oracle fails closed.`}
        </Note>
      )}
    </div>
  );
}

export function VerifyScene({
  asset,
  onAsset,
  addr,
  onAddr,
  onDemo,
  walletAddress,
  busy,
  onCheck,
  error,
  result,
  fmt,
  short,
  proofText,
  onProofText,
  onVerifyPasted,
  verifyMsg,
}: {
  asset: AssetKind;
  onAsset: (k: AssetKind) => void;
  addr: string;
  onAddr: (v: string) => void;
  onDemo: () => void;
  walletAddress?: string;
  busy: boolean;
  onCheck: () => void;
  error: string | null;
  result: BalanceResult | null;
  fmt: Fmt;
  short: Short;
  proofText: string;
  onProofText: (v: string) => void;
  onVerifyPasted: () => void;
  verifyMsg: string | null;
}) {
  const [advanced, setAdvanced] = useState("");
  const proofJson =
    result?.found &&
    JSON.stringify(
      {
        user: result.user,
        amount: result.amount.toString(),
        proof: result.proof.map((p) => ({ ...p, sum: String(p.sum) })),
      },
      null,
      2
    );

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Asset</p>
        <ToggleGroup
          type="single"
          value={asset}
          onValueChange={(v) => v && onAsset(v as AssetKind)}
          aria-label="Asset"
          className="justify-start"
        >
          {(["stock", "usdg", "tsla"] as AssetKind[]).map((k) => (
            <ToggleGroupItem key={k} value={k} variant="outline" size="sm" className={cn("px-4", ACTIVE_TOGGLE)}>
              {ASSET_META[k].label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          onCheck();
        }}
      >
        <label className="block space-y-2">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Your address</span>
          <Input
            value={addr}
            onChange={(e) => onAddr(e.target.value)}
            spellCheck={false}
            placeholder="0x…"
            className="h-10 font-mono text-sm"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {busy ? "Checking…" : "Verify my balance"}
          </Button>
          <Button type="button" variant="outline" onClick={onDemo}>
            Try demo user
          </Button>
          {walletAddress && (
            <Button type="button" variant="outline" onClick={() => onAddr(walletAddress)}>
              Use my wallet
            </Button>
          )}
        </div>
      </form>

      {error && <Note tone="bad">{error}</Note>}

      {result && (
        <div className="space-y-4 rounded-xl border border-border/70 bg-background/40 p-4">
          <Note tone={result.verified ? "ok" : "bad"}>
            {result.verified
              ? `${short(result.user)} holds ${fmt(result.amount, result.asset)} in epoch ${result.epochId}, proven against the on-chain root.`
              : !result.rootMatches
                ? "The published book does not rebuild to the on-chain root, so this UI's copy is out of date."
                : `${short(result.user)} is not in the ${ASSET_META[result.asset].label} book for epoch ${result.epochId}.`}
          </Note>
          <KV
            items={[
              ["Epoch", result.epochId],
              ["Computed root", result.computedRoot],
              [
                "On-chain root",
                <span key="r">
                  {result.onchainRoot}{" "}
                  <span className={result.rootMatches ? "text-success" : "text-destructive"}>
                    {result.rootMatches ? "✓ match" : "✗ mismatch"}
                  </span>
                </span>,
              ],
            ]}
          />
          {result.found && (
            <div>
              <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                Proof path · leaf to root
              </p>
              <ol className="space-y-1.5">
                {result.proof.map((p, i) => (
                  <li
                    key={i}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/60 bg-card/60 px-3 py-2 font-mono text-xs"
                  >
                    <span className="text-muted-foreground">{i + 1}</span>
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[0.65rem] uppercase",
                        p.isLeft ? "bg-primary/15 text-primary" : "bg-success/15 text-success"
                      )}
                    >
                      {p.isLeft ? "left" : "right"}
                    </span>
                    <span>{short(p.hash)}</span>
                    <span className="text-muted-foreground">sum {fmt(BigInt(p.sum), result.asset)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {proofJson && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  onProofText(proofJson);
                  setAdvanced("paste");
                }}
              >
                <FileDown className="mr-1.5 h-3.5 w-3.5" />
                Export as proof JSON
              </Button>
              <CopyButton value={proofJson} label="Copy proof JSON" toastText="Proof JSON copied" showLabel className="h-8 px-3" />
            </div>
          )}
        </div>
      )}

      <Accordion type="single" collapsible value={advanced} onValueChange={setAdvanced}>
        <AccordionItem value="paste" className="border-border/60">
          <AccordionTrigger className="text-sm text-muted-foreground hover:text-foreground hover:no-underline">
            Advanced: paste a proof JSON
          </AccordionTrigger>
          <AccordionContent className="space-y-3">
            <label className="block space-y-2">
              <span className="text-xs text-muted-foreground">Proof JSON exported above or produced by the CLI</span>
              <textarea
                value={proofText}
                onChange={(e) => onProofText(e.target.value)}
                rows={8}
                spellCheck={false}
                placeholder='{"user":"0x…","amount":"…","proof":[{...}]}'
                className="w-full rounded-md border border-input bg-background/60 p-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </label>
            <Button type="button" size="sm" onClick={onVerifyPasted}>
              Verify pasted proof
            </Button>
            {verifyMsg && <Note tone={verifyMsg.startsWith("Inclusion verified") ? "ok" : "bad"}>{verifyMsg}</Note>}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

const SCENARIO_ICON: Record<ScenarioId, React.ReactNode> = {
  drain: <TrendingDown className="h-4 w-4" />,
  skip8d: <CalendarX2 className="h-4 w-4" />,
  split: <Split className="h-4 w-4" />,
  dispute: <Gavel className="h-4 w-4" />,
};

function GateBadge({ result, text }: { result: GateResult; text: string }) {
  return (
    <StateBadge state={result === "allowed" ? "ok" : "bad"} className="max-w-full whitespace-normal rounded-md normal-case tracking-normal">
      {text}
    </StateBadge>
  );
}

export function WhatIfScene({
  sim,
  busy,
  onRun,
  onReset,
  summary,
  isLocal,
  gateLabel,
}: {
  sim: SimResult | null;
  busy: ScenarioId | null;
  onRun: (id: ScenarioId) => void;
  onReset: () => void;
  summary: string | null;
  isLocal: boolean;
  gateLabel: (g: GateResult, text?: string, openNote?: string) => string;
}) {
  const scenario = sim ? SCENARIOS.find((s) => s.id === sim.id) : null;
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        {SCENARIOS.map((s) => {
          const active = sim?.id === s.id;
          return (
            <button
              key={s.id}
              type="button"
              disabled={busy !== null}
              onClick={() => onRun(s.id)}
              className={cn(
                "group relative overflow-hidden rounded-xl border bg-card/60 p-4 text-left transition-colors disabled:cursor-wait",
                active ? "border-primary/50 bg-primary/[0.07]" : "border-border/70 hover:border-primary/40"
              )}
            >
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(400px_circle_at_0%_0%,rgba(196,163,90,0.10),transparent_50%)] opacity-0 transition-opacity group-hover:opacity-100" />
              <div className="relative flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
                  {busy === s.id ? <Loader2 className="h-4 w-4 animate-spin" /> : SCENARIO_ICON[s.id]}
                </span>
                <span className="font-semibold">{busy === s.id ? "Simulating…" : s.button}</span>
              </div>
              <p className="relative mt-2 text-sm leading-relaxed text-muted-foreground">{s.story}</p>
            </button>
          );
        })}
      </div>

      {sim && scenario && (
        <div className="space-y-4 rounded-xl border border-border/70 bg-background/40 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-display text-lg font-semibold">{scenario.title}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                What changed (simulated, nothing sent): <span className="break-all font-mono">{sim.detail}</span>
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={onReset}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Reset
            </Button>
          </div>
          {sim.error ? (
            <Note tone="bad">{sim.error}</Note>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border/60">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="min-w-[12rem]" />
                    <TableHead>Live chain now</TableHead>
                    <TableHead>With this change</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell className="font-medium">Oracle status</TableCell>
                    <TableCell>
                      <GateBadge result={sim.liveReason === 0 ? "allowed" : "x"} text={reasonLabel(sim.liveReason ?? undefined)} />
                    </TableCell>
                    <TableCell>
                      <GateBadge result={sim.reason === 0 ? "allowed" : "x"} text={reasonLabel(sim.reason ?? undefined)} />
                    </TableCell>
                  </TableRow>
                  {sim.gates.map((g) => (
                    <TableRow key={g.label}>
                      <TableCell className="text-sm">{g.label}</TableCell>
                      <TableCell>
                        <GateBadge result={g.live} text={gateLabel(g.live, g.liveText)} />
                      </TableCell>
                      <TableCell>
                        <GateBadge result={g.sim} text={gateLabel(g.sim, g.simText, g.staysOpen ? g.openNote : undefined)} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {summary && <Note tone="ok">{summary}</Note>}
        </div>
      )}

      {isLocal && (
        <p className="text-xs text-muted-foreground">
          On the local node you can also make these changes for real:{" "}
          <code className="font-mono">SCENE=4|5|6|7 npm run demo:prepare</code>, then{" "}
          <code className="font-mono">npm run demo:reset</code>.
        </p>
      )}
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "bad" }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 px-3.5 py-3">
      <p className="text-[0.68rem] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1 font-mono text-sm", tone === "bad" && "text-destructive")}>{value}</p>
    </div>
  );
}

export function ExitScene({
  homeElsewhere,
  netLabel,
  onSwitchHome,
  info,
  fmt,
  short,
  txRows,
  isLocal,
}: {
  homeElsewhere: boolean;
  netLabel: string;
  onSwitchHome: () => void;
  info: ExitInfo | null;
  fmt: Fmt;
  short: Short;
  txRows: [React.ReactNode, React.ReactNode][] | null;
  isLocal: boolean;
}) {
  if (homeElsewhere) {
    return (
      <div className="space-y-4">
        <Note>
          ExitRight&apos;s bond and the recorded claim live on Robinhood testnet, the home chain for this demo.{" "}
          {netLabel} runs the same contracts without a bond posted.
        </Note>
        <Button onClick={onSwitchHome}>Switch to Robinhood testnet</Button>
      </div>
    );
  }
  const last = info?.last;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Tile label="Bond posted" value={info ? fmt(info.bondBalance, "usdg") : "…"} />
        <Tile label="Bond in flight" value={info ? fmt(info.bondInFlight, "usdg") : "…"} />
        <Tile label="Bond per claim" value={info?.configured ? fmt(info.perClaim, "usdg") : "…"} />
        <Tile label="Payout window" value={info?.configured ? `${Number(info.payoutDelay) / 3600} h` : "—"} />
        <Tile label="Claims opened" value={info ? String(info.claimCount) : "…"} />
        <Tile
          label="Exit default (mTSLA)"
          value={info ? (info.exitDefault ? "YES, permanent" : "no") : "…"}
          tone={info?.exitDefault ? "bad" : undefined}
        />
      </div>
      {last && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-3.5 py-3 text-sm">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Last claim</span>
          <span className="font-mono text-xs">
            #{String(last.id)} · {short(last.user)} · {fmt(last.amount, "stock")}
          </span>
          <StateBadge state={last.settled ? "ok" : last.slashed ? "bad" : "warn"}>
            {last.settled ? "settled" : last.slashed ? "slashed" : "open"}
          </StateBadge>
        </div>
      )}
      {txRows && <KV items={txRows} />}
      {isLocal && !txRows && (
        <p className="text-xs text-muted-foreground">
          Run <code className="font-mono">npx hardhat run scripts/exitright-setup.ts --network localhost</code> then{" "}
          <code className="font-mono">scripts/exitright-demo.ts</code>.
        </p>
      )}
    </div>
  );
}
