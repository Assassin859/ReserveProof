import { cn } from "@/lib/utils";

export type Tone = "ok" | "warn" | "bad" | "neutral" | "gold";

const TONE_ALIASES: Record<string, Tone> = {
  ok: "ok",
  pass: "ok",
  solvent: "ok",
  success: "ok",
  warn: "warn",
  unknown: "warn",
  degraded: "warn",
  bad: "bad",
  fail: "bad",
  down: "bad",
  failure: "bad",
  none: "neutral",
  checking: "neutral",
  neutral: "neutral",
  gold: "gold",
};

export function toTone(state: string | undefined | null): Tone {
  return (state && TONE_ALIASES[state]) || "neutral";
}

const BADGE: Record<Tone, string> = {
  ok: "border-success/30 bg-success/10 text-success",
  warn: "border-warning/30 bg-warning/10 text-warning",
  bad: "border-destructive/35 bg-destructive/10 text-destructive",
  neutral: "border-border bg-muted/60 text-muted-foreground",
  gold: "border-primary/30 bg-primary/10 text-primary",
};

const DOT: Record<Tone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  bad: "bg-destructive",
  neutral: "bg-muted-foreground/50",
  gold: "bg-primary",
};

export function StatusDot({ state, pulse, className }: { state: string | Tone; pulse?: boolean; className?: string }) {
  const tone = toTone(state);
  return (
    <span className={cn("relative inline-flex h-2 w-2 shrink-0", className)} aria-hidden>
      {pulse && tone !== "neutral" && <span className={cn("absolute inset-0 rounded-full animate-pulse-ring", DOT[tone])} />}
      <span className={cn("relative inline-flex h-2 w-2 rounded-full", DOT[tone])} />
    </span>
  );
}

export function StateBadge({
  state,
  children,
  dot = true,
  className,
}: {
  state: string | Tone;
  children?: React.ReactNode;
  dot?: boolean;
  className?: string;
}) {
  const tone = toTone(state);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 font-mono text-[0.7rem] font-medium uppercase tracking-wide",
        BADGE[tone],
        className
      )}
    >
      {dot && <StatusDot state={tone} />}
      {children ?? state}
    </span>
  );
}

export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-success",
  warn: "text-warning",
  bad: "text-destructive",
  neutral: "text-muted-foreground",
  gold: "text-primary",
};
