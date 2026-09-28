// Storage slots from `forge inspect <Contract> storageLayout`. Shared by the web simulator and
// scripts/whatif-check.ts; a redeploy with a changed layout must update these.
export const WHATIF_SLOTS = {
  /** MockStockToken (OZ ERC20): mapping(address => uint256) _balances */
  stockBalances: 0,
  /** MockStockToken: uint256 _uiMultiplier */
  stockUiMultiplier: 6,
  /** DisputeModule: mapping(bytes32 => mapping(address => uint256)) openDisputeCount */
  disputeOpenCount: 4,
} as const;

export const SKIP_SECONDS = 8 * 24 * 60 * 60;
export const SPLIT_MULTIPLIER = BigInt("2000000000000000000");

export type ScenarioId = "drain" | "skip8d" | "split" | "dispute";

export const SCENARIO_EXPECTED_REASON: Record<ScenarioId, number> = {
  drain: 6,
  skip8d: 2,
  split: 7,
  dispute: 3,
};
