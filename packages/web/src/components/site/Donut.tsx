import { cn } from "@/lib/utils";

export type DonutSlice = { name: string; value: number; className: string };

export function Donut({
  data,
  label,
  sub,
  size = 160,
  thickness = 16,
  className,
}: {
  data: DonutSlice[];
  label?: React.ReactNode;
  sub?: React.ReactNode;
  size?: number;
  thickness?: number;
  className?: string;
}) {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const total = data.reduce((a, d) => a + d.value, 0);
  const gap = total > 0 && data.filter((d) => d.value > 0).length > 1 ? 3 : 0;
  let offset = 0;
  return (
    <div className={cn("relative", className)} style={{ width: size, height: size }}>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        className="-rotate-90"
        role="img"
        aria-label={data.map((d) => `${d.name}: ${d.value}`).join(", ")}
      >
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={thickness} className="stroke-muted" />
        {total > 0 &&
          data.map((d) => {
            const len = (d.value / total) * c;
            const seg = (
              <circle
                key={d.name}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                strokeWidth={thickness}
                strokeDasharray={`${Math.max(0, len - gap)} ${c}`}
                strokeDashoffset={-offset}
                className={cn("transition-opacity hover:opacity-80", d.className)}
              >
                <title>{`${d.name}: ${d.value}`}</title>
              </circle>
            );
            offset += len;
            return d.value > 0 ? seg : null;
          })}
      </svg>
      {(label || sub) && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          {label && <span className="font-display text-2xl font-semibold leading-none">{label}</span>}
          {sub && <span className="mt-1 text-[0.7rem] uppercase tracking-wide text-muted-foreground">{sub}</span>}
        </div>
      )}
    </div>
  );
}
