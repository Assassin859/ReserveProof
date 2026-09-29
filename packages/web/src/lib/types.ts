export type Deployment = {
  network: string;
  chainId: number;
  deployedAt: string;
  deployer: string;
  reserveWallet?: string;
  /** Liability book behind the mainnet proof; "demo" means our own test accounts, not customers. */
  book?: { kind: "demo" | "real"; realUsers: number; placeholders: number };
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
    FixedPriceMorphoOracle?: `0x${string}`;
    SolvencyGatedMorphoOracle?: `0x${string}`;
    /** Testnets only; the mainnet deployment guards real tokens. */
    MockStockToken?: `0x${string}`;
    USDG: `0x${string}`;
    /** Robinhood's own Tesla stock token (home chain only). */
    TSLA?: `0x${string}`;
  };
  vault?: {
    demoBorrower: `0x${string}`;
    collateralPrice: string;
    ltvBps: number;
  };
  morpho?: {
    basePrice?: string;
    baseOracle: `0x${string}`;
    asset: `0x${string}`;
    maxFreeze?: number;
    maxPokeGap?: number;
    postCapBps?: number;
  };
  demoUser?: `0x${string}`;
};

export type SiteStats = {
  tests: { total: number; hardhat: number; foundryFuzz: number; foundryUnit: number; invariants: number };
  market: {
    block: number;
    timestamp: string;
    usdgSupply: number;
    stockTokens: number;
    stockSupplyUsd: number;
    morphoStockMarkets: number;
    usdgSuppliedAgainstStocks: number;
    usdgBorrowedAgainstStocks: number;
    oracles: { distinct: number; priceFeedOnly: number; unclassified: number; reserveProofFeedsFound: number } | null;
  } | null;
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
      "Each epoch the custodian commits what it owes as a Merkle-sum root. The oracle only reports solvent while reserves cover that allocation by at least the coverage floor, counting the lower of the epoch's lowest sample and the live balance.",
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
