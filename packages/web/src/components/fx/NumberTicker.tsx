"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/utils";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Adapted from Magic UI's NumberTicker (MIT). Server-renders the final value, then counts up once in view. */
export function NumberTicker({
  value,
  format = (v) => Math.round(v).toLocaleString("en-US"),
  className,
  delay = 0,
  duration = 1400,
}: {
  value: number;
  format?: (v: number) => string;
  className?: string;
  delay?: number;
  duration?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(0);
  const fmtRef = useRef(format);
  fmtRef.current = format;

  useIsoLayoutEffect(() => {
    if (!reducedMotion() && ref.current) ref.current.textContent = fmtRef.current(0);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reducedMotion() || typeof IntersectionObserver === "undefined") {
      el.textContent = fmtRef.current(value);
      shown.current = value;
      return;
    }
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      const from = shown.current;
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
        const v = from + (value - from) * eased;
        shown.current = v;
        el.textContent = fmtRef.current(v);
        if (t < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        timer = setTimeout(run, delay * 1000);
      },
      { rootMargin: "-40px" }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (timer) clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [value, delay, duration]);

  return (
    <span ref={ref} className={cn("tabular-nums", className)}>
      {format(value)}
    </span>
  );
}
