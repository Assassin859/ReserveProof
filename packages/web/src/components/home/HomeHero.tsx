"use client";

import Link from "next/link";
import { ArrowRight, BadgeCheck, FlaskConical, PlayCircle, ShieldCheck } from "lucide-react";
import forkDrill from "@/deployments/fork-drill.json";
import { DEMO_VIDEO_URL, GITHUB_URL } from "@/lib/deployments";
import { SITE_STATS } from "@/lib/mainnet";
import { cn } from "@/lib/utils";
import { GridPattern } from "../fx/GridPattern";
import { Spotlight } from "../fx/Spotlight";
import { Button } from "../ui/button";
import { StatusDot } from "../site/StateBadge";
import { MerkleVault, type VaultState } from "./MerkleVault";

function ProofChip({ href, icon, children }: { href: string; icon: React.ReactNode; children: React.ReactNode }) {
  const cls =
    "inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-card/60 px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground";
  return href.startsWith("/") ? (
    <Link href={href} className={cls}>
      {icon}
      {children}
    </Link>
  ) : (
    <a href={href} target="_blank" rel="noreferrer" className={cls}>
      {icon}
      {children}
    </a>
  );
}

export function HomeHero({
  vaultState,
  vaultCaption,
  statusCard,
}: {
  vaultState: VaultState;
  vaultCaption: string;
  statusCard: React.ReactNode;
}) {
  const t = SITE_STATS.tests;
  return (
    <section className="relative overflow-hidden border-b border-border/50">
      <GridPattern className="[mask-image:radial-gradient(ellipse_at_60%_40%,white,transparent_70%)]" />
      <Spotlight className="-top-40 left-0 md:-top-24 md:left-56" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_75%_30%,rgba(196,163,90,0.10),transparent_55%)]" />

      <div className="container relative grid items-center gap-10 py-12 md:py-16 lg:grid-cols-[1.08fr_0.92fr] lg:gap-14 lg:py-20">
        <div>
          <p className="mb-4 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            Proof of reserves · USDG and Robinhood Stock Tokens · Robinhood Chain
          </p>
          <h1 className="font-display text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl lg:text-[3.6rem]">
            Proof that your custodian{" "}
            <span className="bg-gradient-to-r from-primary via-[#e6cf8f] to-primary bg-clip-text text-transparent">
              actually holds
            </span>{" "}
            your stocks and dollars.
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground md:text-lg">
            The custodian commits what it owes on-chain, reserves are read straight from its wallets, and anyone can
            check their own balance. A lending market adds one modifier,{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">onlySolvent(asset)</code>
            , and new borrowing stops the moment the proof fails. Repaying and exiting never do.
          </p>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Button asChild size="lg" className="h-11 px-6 text-sm font-semibold shadow-lg shadow-primary/20">
              <a href="#demo">
                Try the live demo
                <ArrowRight className="ml-1 h-4 w-4" />
              </a>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-11 px-5 text-sm">
              <Link href="/verify">
                <ShieldCheck className="mr-1 h-4 w-4" />
                Verify every claim
              </Link>
            </Button>
          </div>

          <div className="mt-6 flex flex-wrap gap-2">
            <ProofChip href={`${GITHUB_URL}/actions/workflows/ci.yml`} icon={<BadgeCheck className="h-3.5 w-3.5 text-success" />}>
              {t.total} tests passing
            </ProofChip>
            <ProofChip href="/verify#contracts" icon={<ShieldCheck className="h-3.5 w-3.5 text-success" />}>
              Verified on both chains
            </ProofChip>
            <ProofChip
              href={`${GITHUB_URL}/actions/workflows/fork-drill.yml`}
              icon={<FlaskConical className="h-3.5 w-3.5 text-success" />}
            >
              Daily Morpho fork drill {forkDrill.passed}/{forkDrill.total}
            </ProofChip>
            {DEMO_VIDEO_URL && (
              <ProofChip href={DEMO_VIDEO_URL} icon={<PlayCircle className="h-3.5 w-3.5 text-primary" />}>
                Watch the demo
              </ProofChip>
            )}
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-lg lg:max-w-none">
          <MerkleVault state={vaultState} className="h-[220px] sm:h-[270px] lg:h-[290px]" />
          <div
            className={cn(
              "pointer-events-none absolute left-2 top-2 inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1 text-[0.7rem] text-muted-foreground backdrop-blur"
            )}
          >
            <StatusDot state={vaultState === "solvent" ? "ok" : vaultState === "insolvent" ? "bad" : "neutral"} pulse />
            {vaultCaption}
          </div>
          <div className="relative -mt-1">{statusCard}</div>
        </div>
      </div>
    </section>
  );
}
