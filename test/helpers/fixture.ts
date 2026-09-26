import { ethers } from "hardhat";
import { buildSortedTree, type Leaf, type ProofNode } from "./merkle";

export async function deployFixture(opts?: {
  maxOracleAge?: number;
  minSamples?: number;
  allocationChains?: number[];
}) {
  const maxOracleAge = opts?.maxOracleAge ?? 7 * 24 * 3600;
  const minSamples = opts?.minSamples ?? 2;

  const [owner, operator, userA, userB, userC, userD, wallet1] = await ethers.getSigners();

  const Registry = await ethers.getContractFactory("CustodianRegistry");
  const registry = await Registry.deploy(owner.address);

  const AssetConfig = await ethers.getContractFactory("AssetConfig");
  const assetConfig = await AssetConfig.deploy(owner.address, await registry.getAddress());

  const Ledger = await ethers.getContractFactory("LiabilityLedger");
  const ledger = await Ledger.deploy(await registry.getAddress(), await assetConfig.getAddress());

  const Sampler = await ethers.getContractFactory("ReserveSampler");
  const sampler = await Sampler.deploy(
    await registry.getAddress(),
    await assetConfig.getAddress(),
    await ledger.getAddress()
  );

  const Disputes = await ethers.getContractFactory("DisputeModule");
  const disputes = await Disputes.deploy(await registry.getAddress(), await ledger.getAddress(), 3600);

  const Oracle = await ethers.getContractFactory("SolvencyOracle");
  const oracle = await Oracle.deploy(
    await registry.getAddress(),
    await assetConfig.getAddress(),
    await ledger.getAddress(),
    await sampler.getAddress(),
    await disputes.getAddress(),
    owner.address
  );

  const USDG = await ethers.getContractFactory("MockUSDG");
  const usdg = await USDG.deploy();

  const ExitRight = await ethers.getContractFactory("ExitRight");
  const exitRight = await ExitRight.deploy(
    await registry.getAddress(),
    await ledger.getAddress(),
    await usdg.getAddress()
  );
  await oracle.setExitRight(await exitRight.getAddress());

  const Stock = await ethers.getContractFactory("MockStockToken");
  const stock = await Stock.deploy("Mock TSLA", "mTSLA");

  const custodianId = ethers.id("kopi");
  await registry.registerCustodian(custodianId, operator.address, 3600);

  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const allocationChains = opts?.allocationChains ?? [chainId];

  const msgHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint64", "uint256", "address", "address"],
      [custodianId, chainId, network.chainId, wallet1.address, await registry.getAddress()]
    )
  );
  const sig = await wallet1.signMessage(ethers.getBytes(msgHash));
  await registry.connect(operator).addReserveWallet(custodianId, chainId, wallet1.address, sig);

  await assetConfig.connect(owner).setAssetConfig(
    custodianId,
    await stock.getAddress(),
    await stock.getAddress(),
    chainId,
    true,
    0,
    10300,
    maxOracleAge,
    minSamples,
    1,
    allocationChains
  );

  await stock.mint(wallet1.address, ethers.parseEther("1000"));
  await usdg.mint(operator.address, 1_000_000n * 1_000_000n);

  return {
    owner,
    operator,
    userA,
    userB,
    userC,
    userD,
    wallet1,
    registry,
    assetConfig,
    ledger,
    sampler,
    disputes,
    oracle,
    exitRight,
    usdg,
    stock,
    custodianId,
    chainId,
  };
}

export type Fixture = Awaited<ReturnType<typeof deployFixture>>;

/** Cross-chain EpochCommitment domain (matches LiabilityLedger). */
export const EPOCH_COMMITMENT_DOMAIN = {
  name: "ReserveProof",
  version: "1",
  chainId: 0,
  verifyingContract: ethers.ZeroAddress,
};

export const EPOCH_COMMITMENT_TYPES = {
  EpochCommitment: [
    { name: "custodianId", type: "bytes32" },
    { name: "asset", type: "address" },
    { name: "epochId", type: "uint64" },
    { name: "liabilityRoot", type: "bytes32" },
    { name: "totalLiability", type: "uint256" },
    { name: "allocationCommitment", type: "bytes32" },
    { name: "leafCount", type: "uint32" },
  ],
};

export function allocationCommitment(chains: number[], allocations: bigint[]): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["uint64[]", "uint256[]"], [chains, allocations])
  );
}

export async function signEpochCommitment(
  operator: Fixture["operator"],
  custodianId: string,
  asset: string,
  epochId: number,
  liabilityRoot: string,
  totalLiability: bigint,
  allocCommitment: string,
  leafCount: number
): Promise<string> {
  return operator.signTypedData(EPOCH_COMMITMENT_DOMAIN, EPOCH_COMMITMENT_TYPES, {
    custodianId,
    asset,
    epochId,
    liabilityRoot,
    totalLiability,
    allocationCommitment: allocCommitment,
    leafCount,
  });
}

export async function commitAndSample(
  f: Fixture,
  leaves: Leaf[],
  epochId = 1
): Promise<{ root: string; total: bigint; proofs: Map<string, ProofNode[]>; asset: string }> {
  const asset = await f.stock.getAddress();
  const { root, total, proofs, sorted, leafCount } = buildSortedTree(
    f.custodianId,
    asset,
    epochId,
    leaves
  );
  void sorted;

  const rawChains = await f.assetConfig.getAllocationChains(f.custodianId, asset);
  const chains = rawChains.map((c: bigint | number) => Number(c));
  const n = chains.length;
  const base = total / BigInt(n);
  const allocations: bigint[] = [];
  let sum = 0n;
  for (let i = 0; i < n; i++) {
    const a = i === n - 1 ? total - sum : base;
    allocations.push(a);
    sum += a;
  }

  const allocCmt = allocationCommitment(chains, allocations);
  const commitmentSig = await signEpochCommitment(
    f.operator,
    f.custodianId,
    asset,
    epochId,
    root,
    total,
    allocCmt,
    leafCount
  );

  await f.ledger
    .connect(f.operator)
    .commitEpoch(
      f.custodianId,
      asset,
      epochId,
      root,
      total,
      chains,
      allocations,
      ethers.parseEther("1"),
      0,
      leafCount,
      commitmentSig
    );

  await f.sampler.connect(f.operator).setSampleWallets(f.custodianId, asset, [f.wallet1.address]);

  const cfg = await f.assetConfig.getConfig(f.custodianId, asset);
  const need = Number(cfg.minSamples);
  for (let i = 0; i < need; i++) {
    if (i > 0) {
      await ethers.provider.send("evm_increaseTime", [2]);
      await ethers.provider.send("evm_mine", []);
    }
    await f.sampler.connect(f.operator).recordSample(f.custodianId, asset);
  }

  return { root, total, proofs, asset };
}

export function twoLeaves(userA: string, userB: string, a = "100", b = "200"): Leaf[] {
  return [
    { user: userA, amount: ethers.parseEther(a) },
    { user: userB, amount: ethers.parseEther(b) },
  ];
}

export async function signBalanceStatement(
  disputes: Fixture["disputes"],
  operator: Fixture["operator"],
  custodianId: string,
  asset: string,
  epochId: number,
  user: string,
  amount: bigint
): Promise<string> {
  const network = await ethers.provider.getNetwork();
  const domain = {
    name: "ReserveProof",
    version: "1",
    chainId: Number(network.chainId),
    verifyingContract: await disputes.getAddress(),
  };
  const types = {
    BalanceStatement: [
      { name: "custodianId", type: "bytes32" },
      { name: "asset", type: "address" },
      { name: "epochId", type: "uint64" },
      { name: "user", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  };
  const value = { custodianId, asset, epochId, user, amount };
  return operator.signTypedData(domain, types, value);
}
