export type VaultState = "solvent" | "insolvent" | "unknown";

export type P3 = readonly [number, number, number];

export const VAULT_PALETTE: Record<
  VaultState,
  { pulse: string; root: string; edge: string; line: string; node: string; speed: number; label: string }
> = {
  solvent: {
    pulse: "#e2c374",
    root: "#3fcf86",
    edge: "#c4a35a",
    line: "#6b5d3c",
    node: "#c4a35a",
    speed: 0.3,
    label: "solvent",
  },
  insolvent: {
    pulse: "#ea6a58",
    root: "#e0604f",
    edge: "#c9503f",
    line: "#6a3129",
    node: "#c9503f",
    speed: 0.09,
    label: "fails closed",
  },
  unknown: {
    pulse: "#9aa4ad",
    root: "#8b959e",
    edge: "#6b737b",
    line: "#39424a",
    node: "#6b737b",
    speed: 0.18,
    label: "reading chain",
  },
};

const LEAF_Y = -1.75;
const LEVEL_DY = 0.95;
const GAP = 0.62;

/** A 3-level Merkle-sum tree: 8 leaves → 4 → 2 → root. */
function buildLevels(): P3[][] {
  const leaves: P3[] = Array.from({ length: 8 }, (_, i) => [(i - 3.5) * GAP, LEAF_Y, i % 2 ? 0.28 : -0.28] as const);
  const levels: P3[][] = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next: P3[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      const a = prev[i];
      const b = prev[i + 1];
      next.push([(a[0] + b[0]) / 2, a[1] + LEVEL_DY, (a[2] + b[2]) / 4]);
    }
    levels.push(next);
  }
  return levels;
}

export const LEVELS = buildLevels();
export const ROOT = LEVELS[LEVELS.length - 1][0];

/** Parent → child segments, for drawing the tree. */
export const EDGES: [P3, P3][] = LEVELS.slice(0, -1).flatMap((level, d) =>
  level.map((node, i) => [node, LEVELS[d + 1][Math.floor(i / 2)]] as [P3, P3])
);

/** Each leaf's route to the root, which the pulses follow. */
export const LEAF_PATHS: P3[][] = LEVELS[0].map((_, i) =>
  LEVELS.map((level, d) => level[Math.floor(i / 2 ** d)])
);
