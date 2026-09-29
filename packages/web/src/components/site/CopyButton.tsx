"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export function CopyButton({
  value,
  label = "Copy",
  toastText = "Copied to clipboard",
  className,
  showLabel,
}: {
  value: string;
  label?: string;
  toastText?: string;
  className?: string;
  showLabel?: boolean;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          toast.success(toastText);
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error("Could not copy");
        }
      }}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-background/60 px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground",
        className
      )}
    >
      {done ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      {showLabel && <span>{done ? "Copied" : label}</span>}
    </button>
  );
}

export function CodeBlock({ code, className, copyLabel }: { code: string; className?: string; copyLabel?: string }) {
  return (
    <div className={cn("group relative", className)}>
      <pre className="overflow-x-auto rounded-lg border border-border/70 bg-background/80 p-4 pr-12 font-mono text-xs leading-relaxed text-foreground/90">
        {code}
      </pre>
      <CopyButton value={code} label={copyLabel ?? "Copy command"} className="absolute right-2 top-2" />
    </div>
  );
}
