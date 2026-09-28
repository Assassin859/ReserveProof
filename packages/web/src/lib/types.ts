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
    GuardedLendingVault?: `0x${string}`;
    MockStockToken: `0x${string}`;
    USDG: `0x${string}`;
  };
  vault?: {
    demoBorrower: `0x${string}`;
    collateralPrice: string;
    ltvBps: number;
  };
};

export const SCENES = [
  {
    id: 1,
    title: "One wallet, one custodian",
    blurb:
      "A reserve wallet can back only one custodian. Trying to count the same wallet for a second custodian is rejected on-chain, so reserves can't be double-counted.",
  },
  {
    id: 2,
    title: "Liabilities vs reserves",
    blurb:
      "Each epoch the custodian commits what it owes as a Merkle-sum root. The oracle only reports solvent while live reserves cover that allocation by at least the coverage floor.",
  },
  {
    id: 3,
    title: "Verify my balance",
    blurb:
      "Your browser rebuilds the Merkle-sum tree from the published book for the latest on-chain epoch and checks your leaf against the committed root.",
  },
  {
    id: 4,
    title: "What-if simulator",
    blurb:
      "Make the custodian misbehave and watch the real contracts react. Each button runs a read-only simulated call against the live deployment with one thing changed. Nothing is signed or sent, and no wallet is needed.",
  },
  {
    id: 5,
    title: "ExitRight claim",
    blurb:
      "A user with a leaf proof opens a bonded withdrawal claim. The operator must settle before the deadline, or anyone can slash the bond and the oracle flips to EXIT_DEFAULT for good.",
  },
] as const;

export const SCENE_VERIFY = 3;
export const SCENE_WHATIF = 4;
export const SCENE_EXIT = 5;
