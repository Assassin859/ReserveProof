"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu } from "lucide-react";
import { GITHUB_URL } from "@/lib/deployments";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GithubIcon, LogoMark } from "./icons";
import { StatusDot } from "./StateBadge";

type Level = "ok" | "warn" | "down";

const NAV = [
  { href: "/#demo", label: "Live demo", match: "/" },
  { href: "/verify", label: "Verify", match: "/verify" },
  { href: "/radar", label: "Radar", match: "/radar" },
  { href: "/risk", label: "Curator risk", match: "/risk" },
  { href: "/status", label: "Status", match: "/status" },
  { href: "/compare", label: "Compare", match: "/compare" },
];

const LEVEL_TEXT: Record<Level, string> = {
  ok: "All systems operational",
  warn: "Degraded: needs attention",
  down: "Outage: a proof is failing",
};

function useOverall() {
  const [level, setLevel] = useState<Level | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => live && b?.overall && setLevel(b.overall as Level))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return level;
}

export function SiteHeader() {
  const pathname = usePathname();
  const level = useOverall();
  const [open, setOpen] = useState(false);

  const isActive = (match: string) => (match === "/" ? pathname === "/" : pathname.startsWith(match));

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border/60 bg-background/75 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-14 items-center gap-4">
        <Link href="/" className="flex items-center gap-2 font-display text-[1.05rem] font-semibold tracking-tight">
          <LogoMark className="h-6 w-6" />
          ReserveProof
        </Link>

        <nav className="ml-4 hidden items-center gap-0.5 lg:flex" aria-label="Main">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                isActive(n.match) && "bg-accent/70 text-foreground"
              )}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                href="/status"
                className="hidden items-center gap-2 rounded-full border border-border/70 bg-card/60 px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
              >
                <StatusDot state={level ?? "neutral"} pulse={level === "ok"} />
                {level ? (level === "ok" ? "Operational" : level === "warn" ? "Degraded" : "Outage") : "Checking"}
              </Link>
            </TooltipTrigger>
            <TooltipContent>{level ? LEVEL_TEXT[level] : "Reading both chains and the run history"}</TooltipContent>
          </Tooltip>

          <Button asChild variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground">
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" aria-label="GitHub repository">
              <GithubIcon className="h-[18px] w-[18px]" />
            </a>
          </Button>

          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-72 border-border bg-background">
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2 font-display">
                  <LogoMark className="h-6 w-6" /> ReserveProof
                </SheetTitle>
              </SheetHeader>
              <nav className="mt-6 flex flex-col gap-1" aria-label="Mobile">
                {NAV.map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    onClick={() => setOpen(false)}
                    className={cn(
                      "rounded-md px-3 py-2.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground",
                      isActive(n.match) && "bg-accent text-foreground"
                    )}
                  >
                    {n.label}
                  </Link>
                ))}
              </nav>
              <Link
                href="/status"
                onClick={() => setOpen(false)}
                className="mt-6 flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground"
              >
                <StatusDot state={level ?? "neutral"} />
                {level ? LEVEL_TEXT[level] : "Checking status…"}
              </Link>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
