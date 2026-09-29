import { cn } from "@/lib/utils";
import { NumberTicker } from "../fx/NumberTicker";
import { TONE_TEXT, type Tone } from "./StateBadge";

export function KpiCard({
  label,
  value,
  format,
  display,
  sub,
  tone = "neutral",
  icon,
  className,
  children,
}: {
  label: React.ReactNode;
  value?: number;
  format?: (v: number) => string;
  display?: React.ReactNode;
  sub?: React.ReactNode;
  tone?: Tone;
  icon?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("relative overflow-hidden rounded-xl border border-border/70 bg-card/70 p-4 md:p-5", className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[0.7rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
        {icon && <span className="text-muted-foreground/70">{icon}</span>}
      </div>
      <p className={cn("mt-2 font-display text-2xl font-semibold tracking-tight md:text-3xl", tone !== "neutral" && TONE_TEXT[tone])}>
        {display ?? (value !== undefined ? <NumberTicker value={value} format={format} /> : "—")}
      </p>
      {sub && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{sub}</p>}
      {children}
    </div>
  );
}
