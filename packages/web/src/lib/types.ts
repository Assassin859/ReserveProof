export type Deployment = {
  network: string;
  chainId: number;
  deployedAt: string;
  deployer: string;
  reserveWallet?: string;
  custodianName: string;
  custodianId: `0x${string}`;
  contracts: {
    CustodianRegistry: `0x${string}`;
    AssetConfig: `0x${string}`;
    LiabilityLedger: `0x${string}`;
    ReserveSampler: `0x${string}`;
    DisputeModule: `0x${string}`;
    SolvencyOracle: `0x${string}`;
    ExitRight: `0x${string}`;
    GatedPayout?: `0x${string}`;
    GatedLendWithdraw?: `0x${string}`;
    MockStockToken: `0x${string}`;
    USDG: `0x${string}`;
  };
};

export const SCENES = [
  {
    id: 1,
    title: "Duplicate wallet rejected",
    blurb: "A reserve address already claimed by another custodian cannot be re-registered.",
  },
  {
    id: 2,
    title: "Epoch at 103% coverage",
    blurb: "Operator commits a Merkle-sum root with allocation covered at the coverage floor.",
  },
  {
    id: 3,
    title: "Verify my balance",
    blurb:
      "Your browser rebuilds the Merkle-sum tree from the published book for the latest on-chain epoch and checks your leaf against the committed root.",
  },
  {
    id: 4,
    title: "Reserves drained → payout blocked",
    blurb: "When live reserves fall short, GatedPayout / GatedLendWithdraw fail closed.",
  },
  {
    id: 5,
    title: "Multiplier drift",
    blurb: "ERC-8056 uiMultiplier changes without a recommit → MULTIPLIER_DRIFT.",
  },
  {
    id: 6,
    title: "Stale oracle",
    blurb: "Past maxOracleAge the status flips to STALE. Local: npm run demo:warp.",
  },
  {
    id: 7,
    title: "Fraud dispute",
    blurb: "Mismatch between signed statement and tree opens DISPUTED until cleared.",
  },
  {
    id: 8,
    title: "ExitRight claim",
    blurb:
      "A user with a leaf proof opens a bonded withdrawal claim. The operator must settle before the deadline, or anyone can slash the bond and the oracle flips to EXIT_DEFAULT for good.",
  },
] as const;
