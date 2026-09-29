"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { VaultFallback } from "./VaultFallback";
import type { VaultState } from "./vaultLayout";

export type { VaultState } from "./vaultLayout";

const Scene = dynamic(() => import("./MerkleVaultScene"), { ssr: false, loading: () => null });

let webgl: boolean | undefined;
function hasWebGL() {
  if (webgl === undefined) {
    try {
      const c = document.createElement("canvas");
      webgl = Boolean(c.getContext("webgl2") || c.getContext("webgl"));
    } catch {
      webgl = false;
    }
  }
  return webgl;
}

/**
 * The SVG renders first (and on the server); the three.js chunk only loads on wide screens with WebGL
 * and motion allowed, then fades in over it.
 */
export function MerkleVault({ state, className }: { state: VaultState; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [use3d, setUse3d] = useState(false);
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const narrow = window.matchMedia("(max-width: 639px)");
    const decide = () => setUse3d(!reduce.matches && !narrow.matches && hasWebGL());
    decide();
    reduce.addEventListener("change", decide);
    narrow.addEventListener("change", decide);
    return () => {
      reduce.removeEventListener("change", decide);
      narrow.removeEventListener("change", decide);
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "80px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const show3d = use3d && ready;

  return (
    <div ref={ref} className={cn("relative", className)}>
      <VaultFallback
        state={state}
        className={cn("absolute inset-0 transition-opacity duration-700", show3d ? "opacity-0" : "opacity-100")}
      />
      {use3d && (
        <div
          aria-hidden
          className={cn("absolute inset-0 transition-opacity duration-700", show3d ? "opacity-100" : "opacity-0")}
        >
          <Scene state={state} active={visible} onReady={() => setReady(true)} />
        </div>
      )}
    </div>
  );
}
