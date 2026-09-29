import { cn } from "@/lib/utils";
import { EDGES, LEVELS, ROOT, VAULT_PALETTE, type P3, type VaultState } from "./vaultLayout";

const SCALE = 62;
const CX = 200;
const CY = 150;

function project(p: P3): [number, number] {
  return [CX + p[0] * SCALE, CY - (p[1] - 0.05) * SCALE];
}

function hexagon(cx: number, cy: number, r: number, rotate = 0) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i + rotate;
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
}

/** Static Merkle-vault drawing for no-WebGL, reduced motion and narrow screens. */
export function VaultFallback({ state, className }: { state: VaultState; className?: string }) {
  const c = VAULT_PALETTE[state];
  const [rx, ry] = project(ROOT);
  const glowId = `vault-glow-${state}`;
  const fadeId = `vault-fade-${state}`;
  return (
    <svg viewBox="0 0 400 300" className={cn("h-full w-full", className)} role="img" aria-label={`Merkle-sum tree into the vault: ${c.label}`}>
      <defs>
        <radialGradient id={glowId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={c.root} stopOpacity="0.45" />
          <stop offset="100%" stopColor={c.root} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={fadeId} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor={c.line} stopOpacity="0.5" />
          <stop offset="100%" stopColor={c.edge} stopOpacity="0.9" />
        </linearGradient>
      </defs>

      <circle cx={rx} cy={ry} r={90} fill={`url(#${glowId})`} />

      {EDGES.map(([a, b], i) => {
        const [x1, y1] = project(a);
        const [x2, y2] = project(b);
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={`url(#${fadeId})`} strokeWidth={1.4} />;
      })}

      <polygon points={hexagon(rx, ry, 52, Math.PI / 6)} fill="none" stroke={c.edge} strokeOpacity={0.3} strokeWidth={1} />
      <polygon points={hexagon(rx, ry, 38)} fill={c.edge} fillOpacity={0.07} stroke={c.edge} strokeOpacity={0.8} strokeWidth={1.2} />

      {LEVELS.slice(0, -1).map((level, d) =>
        level.map((p, i) => {
          const [x, y] = project(p);
          return d === 0 ? (
            <rect
              key={`${d}-${i}`}
              x={x - 5}
              y={y - 5}
              width={10}
              height={10}
              transform={`rotate(45 ${x} ${y})`}
              fill={c.pulse}
              fillOpacity={0.9}
            />
          ) : (
            <circle key={`${d}-${i}`} cx={x} cy={y} r={4.5} fill="#1e2429" stroke={c.node} strokeWidth={1.4} />
          );
        })
      )}

      <circle cx={rx} cy={ry} r={11} fill={c.root} />
      <circle cx={rx} cy={ry} r={17} fill="none" stroke={c.root} strokeOpacity={0.35} strokeWidth={1.5} />
    </svg>
  );
}
