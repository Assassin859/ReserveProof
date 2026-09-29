"use client";

import { useInView, useMotionValue, useReducedMotion, useSpring } from "framer-motion";
import { useEffect, useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/utils";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Adapted from Magic UI's NumberTicker (MIT). Server-renders the final value, then counts up once in view. */
export function NumberTicker({
  value,
  format = (v) => Math.round(v).toLocaleString("en-US"),
  className,
  delay = 0,
}: {
  value: number;
  format?: (v: number) => string;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  const mv = useMotionValue(0);
  const spring = useSpring(mv, { damping: 50, stiffness: 90 });
  const inView = useInView(ref, { once: true, margin: "-40px" });
  const fmtRef = useRef(format);
  fmtRef.current = format;

  useIsoLayoutEffect(() => {
    if (!reduce && ref.current) ref.current.textContent = fmtRef.current(0);
  }, [reduce]);

  useEffect(() => {
    if (reduce) {
      if (ref.current) ref.current.textContent = fmtRef.current(value);
      return;
    }
    if (!inView) return;
    const t = setTimeout(() => mv.set(value), delay * 1000);
    return () => clearTimeout(t);
  }, [mv, inView, value, delay, reduce]);

  useEffect(
    () =>
      spring.on("change", (v) => {
        if (ref.current) ref.current.textContent = fmtRef.current(v);
      }),
    [spring]
  );

  return (
    <span ref={ref} className={cn("tabular-nums", className)}>
      {format(value)}
    </span>
  );
}
