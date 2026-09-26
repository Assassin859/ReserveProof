export const REASON_LABELS: Record<number, string> = {
  0: "OK",
  1: "NO_EPOCH",
  2: "STALE",
  3: "DISPUTED",
  4: "INSUFFICIENT_SAMPLES",
  5: "UNDERCOLLATERALIZED",
  6: "LIVE_SHORT",
  7: "MULTIPLIER_DRIFT",
  8: "EXIT_DEFAULT",
  9: "INACTIVE",
};

export function reasonLabel(code: number | undefined): string {
  if (code === undefined) return "—";
  return REASON_LABELS[code] ?? `UNKNOWN(${code})`;
}
