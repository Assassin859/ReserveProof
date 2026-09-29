"use client";

import { CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { NETWORKS, NETWORK_KEYS, type NetworkKey } from "@/lib/deployments";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

export const ACTIVE_TOGGLE =
  "data-[state=on]:border-primary/40 data-[state=on]:bg-primary/15 data-[state=on]:text-primary";

export function NetworkSwitch({
  value,
  onChange,
  className,
}: {
  value: NetworkKey;
  onChange: (k: NetworkKey) => void;
  className?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as NetworkKey)}
      aria-label="Network"
      className={cn("flex-wrap justify-start", className)}
    >
      {NETWORK_KEYS.map((k) => (
        <ToggleGroupItem
          key={k}
          value={k}
          size="sm"
          variant="outline"
          className={cn("h-8 rounded-full px-3 text-xs", ACTIVE_TOGGLE)}
        >
          {NETWORKS[k].label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** Two-column key/value list that stacks on narrow screens. */
export function KV({ items, className }: { items: [React.ReactNode, React.ReactNode][]; className?: string }) {
  return (
    <dl
      className={cn(
        "grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-[minmax(9rem,auto)_1fr] sm:gap-y-2.5",
        className
      )}
    >
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="pt-2 text-xs uppercase tracking-wide text-muted-foreground sm:pt-0.5">{k}</dt>
          <dd className="min-w-0 break-words font-mono text-[0.8rem] text-foreground/90">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const NOTE_TONE = {
  ok: { cls: "border-success/30 bg-success/[0.07] text-success", Icon: CheckCircle2 },
  bad: { cls: "border-destructive/35 bg-destructive/[0.08] text-destructive", Icon: XCircle },
  info: { cls: "border-border bg-muted/40 text-foreground/90", Icon: Info },
};

export function Note({
  tone = "info",
  className,
  children,
}: {
  tone?: keyof typeof NOTE_TONE;
  className?: string;
  children: React.ReactNode;
}) {
  const { cls, Icon } = NOTE_TONE[tone];
  return (
    <div role="status" className={cn("flex gap-2.5 rounded-lg border px-3.5 py-3 text-sm leading-relaxed", cls, className)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

export function ExplorerLink({ href, children }: { href?: string; children: React.ReactNode }) {
  if (!href) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">
      {children} ↗
    </a>
  );
}
