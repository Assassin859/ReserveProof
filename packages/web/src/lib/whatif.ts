import {
  encodeAbiParameters,
  keccak256,
  numberToHex,
  pad,
  type Address,
  type BlockOverrides,
  type Hex,
  type StateOverride,
} from "viem";
import {
  SCENARIO_EXPECTED_REASON,
  SKIP_SECONDS,
  SPLIT_MULTIPLIER,
  WHATIF_SLOTS,
  type ScenarioId,
} from "./whatif-slots";

export { SCENARIO_EXPECTED_REASON, type ScenarioId };

export type WhatIfContext = {
  custodianId: Hex;
  stockToken: Address;
  reserveWallet: Address;
  disputes: Address;
  now: bigint;
};

export type WhatIfOverrides = {
  stateOverride?: StateOverride;
  blockOverrides?: BlockOverrides;
};

export const SCENARIOS: {
  id: ScenarioId;
  button: string;
  title: string;
  story: string;
}[] = [
  {
    id: "drain",
    button: "Drain reserves",
    title: "The custodian moves the stock out",
    story: "The reserve wallet's mTSLA balance is set to zero, as if the custodian quietly moved it elsewhere.",
  },
  {
    id: "skip8d",
    button: "Skip 8 days",
    title: "The custodian stops publishing",
    story: "The clock moves 8 days forward with no new epoch, past the 7-day freshness limit.",
  },
  {
    id: "split",
    button: "Stock split",
    title: "A 2-for-1 split nobody accounted for",
    story: "The token's ERC-8056 multiplier doubles, but the committed liabilities still use the old one.",
  },
  {
    id: "dispute",
    button: "Fraud dispute",
    title: "A user proves the books are wrong",
    story: "One open fraud dispute is recorded against the custodian, as after a signed-statement mismatch.",
  },
];

const mapSlot = (key: Address, slot: number) =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, BigInt(slot)]));

const word = (v: bigint) => pad(numberToHex(v), { size: 32 });

export function buildOverrides(id: ScenarioId, ctx: WhatIfContext): WhatIfOverrides {
  switch (id) {
    case "drain":
      return {
        stateOverride: [
          {
            address: ctx.stockToken,
            stateDiff: [{ slot: mapSlot(ctx.reserveWallet, WHATIF_SLOTS.stockBalances), value: word(BigInt(0)) }],
          },
        ],
      };
    case "skip8d":
      return { blockOverrides: { time: ctx.now + BigInt(SKIP_SECONDS) } };
    case "split":
      return {
        stateOverride: [
          {
            address: ctx.stockToken,
            stateDiff: [{ slot: word(BigInt(WHATIF_SLOTS.stockUiMultiplier)), value: word(SPLIT_MULTIPLIER) }],
          },
        ],
      };
    case "dispute": {
      const inner = keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "uint256" }],
          [ctx.custodianId, BigInt(WHATIF_SLOTS.disputeOpenCount)]
        )
      );
      const slot = keccak256(
        encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [ctx.stockToken, inner])
      );
      return {
        stateOverride: [{ address: ctx.disputes, stateDiff: [{ slot, value: word(BigInt(1)) }] }],
      };
    }
  }
}
