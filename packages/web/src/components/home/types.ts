import type { Address } from "viem";
import type { ScenarioId } from "@/lib/whatif";

export type ExitInfo = {
  bondBalance: bigint;
  bondInFlight: bigint;
  perClaim: bigint;
  payoutDelay: bigint;
  configured: boolean;
  claimCount: bigint;
  exitDefault: boolean;
  last?: {
    id: bigint;
    user: Address;
    amount: bigint;
    deadline: bigint;
    open: boolean;
    settled: boolean;
    slashed: boolean;
  };
};

export type GateResult = "allowed" | string;

export type GateKind = "payout" | "withdraw" | "borrow" | "morpho";

export type GateRow = {
  kind: GateKind;
  label: string;
  live: GateResult;
  sim: GateResult;
  liveText?: string;
  simText?: string;
  staysOpen?: boolean;
  openNote?: string;
};

export type SimResult = {
  id: ScenarioId;
  detail: string;
  liveReason: number | null;
  reason: number | null;
  gates: GateRow[];
  error?: string;
};
