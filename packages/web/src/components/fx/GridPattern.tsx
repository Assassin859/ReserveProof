"use client";

import { useEffect, useId, useState } from "react";
import { cn } from "@/lib/utils";

type Square = { id: number; x: number; y: number };

/**
 * Adapted from Magic UI's AnimatedGridPattern (MIT): a faint grid with a few cells fading in and out.
 * CSS-only animation; each cell jumps to a new spot when its fade cycle ends. Under reduced motion the
 * global rule stops the animation and the cells stay faintly visible.
 */
export function GridPattern({
  className,
  size = 44,
  cols = 28,
  rows = 14,
  squares = 18,
}: {
  className?: string;
  size?: number;
  cols?: number;
  rows?: number;
  squares?: number;
}) {
  const id = useId().replace(/:/g, "");
  const [cells, setCells] = useState<Square[]>([]);

  useEffect(() => {
    const pick = (i: number): Square => ({ id: i, x: Math.floor(Math.random() * cols), y: Math.floor(Math.random() * rows) });
    setCells(Array.from({ length: squares }, (_, i) => pick(i)));
  }, [cols, rows, squares]);

  const move = (i: number) =>
    setCells((cur) => cur.map((c) => (c.id === i ? { id: i, x: Math.floor(Math.random() * cols), y: Math.floor(Math.random() * rows) } : c)));

  return (
    <svg aria-hidden className={cn("pointer-events-none absolute inset-0 h-full w-full stroke-border/50", className)}>
      <defs>
        <pattern id={`grid-${id}`} width={size} height={size} patternUnits="userSpaceOnUse" x={-1} y={-1}>
          <path d={`M.5 ${size}V.5H${size}`} fill="none" strokeDasharray="0" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#grid-${id})`} />
      <svg x={-1} y={-1} className="overflow-visible">
        {cells.map((c, i) => (
          <rect
            key={c.id}
            width={size - 1}
            height={size - 1}
            x={c.x * size + 1}
            y={c.y * size + 1}
            className="animate-grid-fade fill-primary/[0.07]"
            style={{ animationDelay: `${(i * 0.35) % 6}s` }}
            strokeWidth="0"
            onAnimationIteration={() => move(c.id)}
          />
        ))}
      </svg>
    </svg>
  );
}
