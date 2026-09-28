"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReadContract, usePublicClient, useAccount } from "wagmi";
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import {
  custodianRegistryAbi,
  solvencyOracleAbi,
  liabilityLedgerAbi,
  gatedPayoutAbi,
  exitRightAbi,
  reserveSamplerAbi,
  assetConfigAbi,
} from "../lib/abis";
import { buildSortedTree, verifyInclusion, type ProofNode } from "../lib/merkle";
import { reasonLabel } from "../lib/reasons";
import { SCENES, SCENE_EXIT, SCENE_VERIFY, SCENE_WHATIF, type Deployment } from "../lib/types";
import {
  ASSET_META,
  DEMO_VIDEO_URL,
  GITHUB_URL,
  NETWORKS,
  NETWORK_KEYS,
  defaultNetwork,
  type AssetKind,
  type NetworkKey,
} from "../lib/deployments";
import {
  SCENARIOS,
  SCENARIO_EXPECTED_REASON,
  buildOverrides,
  type ScenarioId,
  type WhatIfOverrides,
} from "../lib/whatif";

type ChainId = 46630 | 421614 | 31337;

type Status = { ok: boolean; epochId: bigint; updatedAt: bigint; reason: number };
type EpochView = {
  liabilityRoot: Hex;
  totalLiability: bigint;
  allocation: bigint;
  exists: boolean;
  leafCount: number;
};

type BalanceResult = {
  user: Address;
  asset: AssetKind;
  epochId: number;
  found: boolean;
  amount: bigint;
  proof: ProofNode[];
  computedRoot: Hex;
  onchainRoot: Hex;
  rootMatches: boolean;
  verified: boolean;
};

type ExitInfo = {
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

type GateResult = "allowed" | string;

type SimResult = {
  id: ScenarioId;
  detail: string;
  liveReason: number | null;
  reason: number | null;
  livePayout: GateResult;
  payout: GateResult;
  error?: string;
};

const ZERO = BigInt(0);
const BPS = BigInt(10_000);
const VERIFIED_CONTRACTS = 10;

function short(addr?: string) {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function parseStatus(raw: unknown): Status | null {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    return { ok: raw[0], epochId: raw[1], updatedAt: raw[2], reason: Number(raw[3]) };
  }
  const s = raw as Status;
  return { ok: s.ok, epochId: s.epochId, updatedAt: s.updatedAt, reason: Number(s.reason) };
}

function parseEpoch(raw: unknown): EpochView | null {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    return {
      liabilityRoot: raw[0] as Hex,
      totalLiability: raw[1] as bigint,
      allocation: raw[2] as bigint,
      exists: raw[6] as boolean,
      leafCount: Number(raw[7]),
    };
  }
  const e = raw as Omit<EpochView, "leafCount"> & { leafCount: number | bigint };
  return { ...e, leafCount: Number(e.leafCount) };
}

function revertName(e: unknown, abi?: Abi): string | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
  if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName) return revert.data.errorName;
  if (!abi) return undefined;
  const withData = e.walk((err) => typeof (err as { data?: unknown }).data === "string") as
    | { data?: Hex }
    | null;
  if (withData?.data) {
    try {
      return decodeErrorResult({ abi, data: withData.data }).errorName;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function amount(value: bigint | undefined, kind: AssetKind) {
  if (value === undefined) return "—";
  const n = Number(formatUnits(value, ASSET_META[kind].decimals));
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${ASSET_META[kind].label}`;
}

function percent(bps: bigint | undefined | null) {
  if (bps === undefined || bps === null) return "—";
  return `${(Number(bps) / 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
}

function ago(fromSec: bigint | undefined, nowSec: number) {
  if (!fromSec || fromSec === ZERO) return "—";
  const d = Math.max(0, nowSec - Number(fromSec));
  if (d < 90) return "just now";
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 172800) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} days ago`;
}

function gateLabel(g: GateResult) {
  return g === "allowed" ? "Allowed" : `Blocked: ${g}`;
}

export function KopiApp() {
  const [network, setNetwork] = useState<NetworkKey>(defaultNetwork);
  const [dep, setDep] = useState<Deployment | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scene, setScene] = useState(1);
  const [proofText, setProofText] = useState("");
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
  const [actionLog, setActionLog] = useState<string | null>(null);
  const [balAsset, setBalAsset] = useState<AssetKind>("stock");
  const [balAddr, setBalAddr] = useState("");
  const [balResult, setBalResult] = useState<BalanceResult | null>(null);
  const [balError, setBalError] = useState<string | null>(null);
  const [balBusy, setBalBusy] = useState(false);
  const [exitInfo, setExitInfo] = useState<ExitInfo | null>(null);
  const [sim, setSim] = useState<SimResult | null>(null);
  const [simBusy, setSimBusy] = useState<ScenarioId | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const scenesRef = useRef<HTMLElement>(null);

  const net = NETWORKS[network];
  const isLocal = network === "localhost";
  const chainId = dep?.chainId as ChainId | undefined;

  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId });

  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, []);

  const refreshDep = useCallback(async () => {
    if (net.deployment) {
      setDep(net.deployment);
      setLoadError(null);
      return;
    }
    setDep(null);
    try {
      const res = await fetch("/api/deployment");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load deployment");
      setDep(data);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [net]);

  useEffect(() => {
    void refreshDep();
  }, [refreshDep]);

  const custodianId = dep?.custodianId;
  const asset = dep?.contracts.MockStockToken;
  const usdg = dep?.contracts.USDG;
  const oracle = dep?.contracts.SolvencyOracle;
  const registry = dep?.contracts.CustodianRegistry;
  const ledger = dep?.contracts.LiabilityLedger;
  const sampler = dep?.contracts.ReserveSampler;
  const assetConfig = dep?.contracts.AssetConfig;
  const gated = dep?.contracts.GatedPayout;
  const exitRight = dep?.contracts.ExitRight;
  const reserveWallet = dep?.reserveWallet as Address | undefined;
  const assetAddr = (kind: AssetKind) => (kind === "stock" ? asset : usdg);
  const stockArgs = custodianId && asset ? ([custodianId, asset] as const) : undefined;

  const { data: status, refetch: refetchStatus } = useReadContract({
    address: oracle,
    abi: solvencyOracleAbi,
    functionName: "status",
    chainId,
    args: stockArgs,
    query: { enabled: Boolean(oracle && stockArgs), refetchInterval: 15_000 },
  });

  const { data: usdgStatus, refetch: refetchUsdg } = useReadContract({
    address: oracle,
    abi: solvencyOracleAbi,
    functionName: "status",
    chainId,
    args: custodianId && usdg ? [custodianId, usdg] : undefined,
    query: { enabled: Boolean(oracle && custodianId && usdg), refetchInterval: 30_000 },
  });

  const { data: epochId } = useReadContract({
    address: ledger,
    abi: liabilityLedgerAbi,
    functionName: "latestEpochId",
    chainId,
    args: stockArgs,
    query: { enabled: Boolean(ledger && stockArgs), refetchInterval: 60_000 },
  });

  const { data: epoch } = useReadContract({
    address: ledger,
    abi: liabilityLedgerAbi,
    functionName: "getEpoch",
    chainId,
    args: stockArgs && epochId ? [...stockArgs, epochId] : undefined,
    query: { enabled: Boolean(ledger && stockArgs && epochId && Number(epochId) > 0) },
  });

  const { data: liveReserves, refetch: refetchReserves } = useReadContract({
    address: sampler,
    abi: reserveSamplerAbi,
    functionName: "liveReserves",
    chainId,
    args: stockArgs,
    query: { enabled: Boolean(sampler && stockArgs), refetchInterval: 30_000 },
  });

  const { data: stockConfig } = useReadContract({
    address: assetConfig,
    abi: assetConfigAbi,
    functionName: "getConfig",
    chainId,
    args: stockArgs,
    query: { enabled: Boolean(assetConfig && stockArgs) },
  });

  const parsed = useMemo(() => parseStatus(status), [status]);
  const parsedUsdg = useMemo(() => parseStatus(usdgStatus), [usdgStatus]);
  const epochData = useMemo(() => parseEpoch(epoch), [epoch]);
  const usdgHomeOnly = network === "arbitrumSepolia" && !net.books.liabilities.usdg;
  const floorBps = (stockConfig as { coverageFloorBps?: number } | undefined)?.coverageFloorBps;
  const coverageBps =
    epochData && epochData.allocation > ZERO && typeof liveReserves === "bigint"
      ? (liveReserves * BPS) / epochData.allocation
      : null;
  const covered =
    coverageBps !== null && floorBps !== undefined ? coverageBps >= BigInt(floorBps) : undefined;

  function refreshAll() {
    void refetchStatus();
    void refetchUsdg();
    void refetchReserves();
  }

  function goToScene(id: number) {
    setScene(id);
    setActionLog(null);
    setVerifyMsg(null);
    scenesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const loadEpoch = useCallback(
    async (kind: AssetKind) => {
      const addr = assetAddr(kind);
      if (!publicClient || !ledger || !custodianId || !addr) throw new Error("Deployment not loaded");
      const latest = (await publicClient.readContract({
        address: ledger,
        abi: liabilityLedgerAbi,
        functionName: "latestEpochId",
        args: [custodianId, addr],
      })) as bigint;
      if (latest === ZERO) return { latest: 0, ep: null, addr };
      const ep = parseEpoch(
        await publicClient.readContract({
          address: ledger,
          abi: liabilityLedgerAbi,
          functionName: "getEpoch",
          args: [custodianId, addr, latest],
        })
      );
      return { latest: Number(latest), ep, addr };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publicClient, ledger, custodianId, asset, usdg]
  );

  function fillDemoUser() {
    const book = net.books.liabilities[balAsset];
    const demo = net.books.demoUser ?? book?.[0]?.user ?? "";
    setBalAddr(demo);
    setBalResult(null);
    setBalError(null);
  }

  async function runBalanceCheck() {
    setBalResult(null);
    setBalError(null);
    const book = net.books.liabilities[balAsset];
    const label = ASSET_META[balAsset].label;
    if (!book) {
      setBalError(
        balAsset === "usdg" && network === "arbitrumSepolia"
          ? "USDG is home-chain only: its leaves bind Robinhood's USDG address, so the USDG book is published on Robinhood testnet."
          : `No ${label} liability book is published on ${net.label}.`
      );
      return;
    }
    if (!isAddress(balAddr.trim())) {
      setBalError("Enter a valid 0x address.");
      return;
    }
    if (!dep) return;
    setBalBusy(true);
    try {
      const { latest, ep, addr } = await loadEpoch(balAsset);
      if (!ep?.exists || !addr) {
        setBalError(`No ${label} epoch committed on ${net.label} yet.`);
        return;
      }
      const tree = buildSortedTree(
        dep.custodianId,
        addr,
        latest,
        book.map((l) => ({ user: l.user as Address, amount: BigInt(l.amount) }))
      );
      const user = getAddress(balAddr.trim());
      const proof = tree.proofs.get(user.toLowerCase()) ?? [];
      const leaf = tree.sorted.find((l) => l.user.toLowerCase() === user.toLowerCase());
      const rootMatches =
        tree.root.toLowerCase() === ep.liabilityRoot.toLowerCase() && tree.total === ep.totalLiability;
      const verified = leaf
        ? verifyInclusion({
            custodianId: dep.custodianId,
            asset: addr,
            epochId: latest,
            leafCount: ep.leafCount,
            user,
            amount: leaf.amount,
            root: ep.liabilityRoot,
            totalSum: ep.totalLiability,
            siblings: proof,
          })
        : false;
      setBalResult({
        user,
        asset: balAsset,
        epochId: latest,
        found: Boolean(leaf),
        amount: leaf?.amount ?? ZERO,
        proof,
        computedRoot: tree.root,
        onchainRoot: ep.liabilityRoot,
        rootMatches,
        verified,
      });
    } catch (e) {
      setBalError((e as Error).message);
    } finally {
      setBalBusy(false);
    }
  }

  async function runScene1() {
    if (!dep || !registry || !publicClient || !reserveWallet) return;
    setActionLog("Reading the registry…");
    try {
      const owner = (await publicClient.readContract({
        address: registry,
        abi: custodianRegistryAbi,
        functionName: "walletOwner",
        args: [BigInt(dep.chainId), reserveWallet],
      })) as Hex;
      if (owner && BigInt(owner) !== ZERO) {
        setActionLog(
          `Reserve wallet ${short(reserveWallet)} is already bound to custodian "${dep.custodianName}" (${short(owner)}).\n` +
            `Any other custodian calling addReserveWallet with it reverts WalletTaken, so the same coins can't be counted twice.`
        );
      } else {
        setActionLog("This reserve wallet isn't registered on this network yet.");
      }
    } catch (e) {
      setActionLog(`Error: ${(e as Error).message}`);
    }
  }

  async function runVerify() {
    setVerifyMsg(null);
    if (!dep) return;
    try {
      const { latest, ep, addr } = await loadEpoch(balAsset);
      if (!ep?.exists || !addr) {
        setVerifyMsg(`No ${ASSET_META[balAsset].label} epoch committed yet.`);
        return;
      }
      const parsedProof = JSON.parse(proofText) as { user: string; amount: string; proof: ProofNode[] };
      const ok = verifyInclusion({
        custodianId: dep.custodianId,
        asset: addr,
        epochId: latest,
        leafCount: ep.leafCount,
        user: parsedProof.user as Address,
        amount: BigInt(parsedProof.amount),
        root: ep.liabilityRoot,
        totalSum: ep.totalLiability,
        siblings: parsedProof.proof,
      });
      setVerifyMsg(
        ok
          ? `Inclusion verified for ${short(parsedProof.user)}: ${amount(BigInt(parsedProof.amount), balAsset)} at epoch ${latest}`
          : "Proof does NOT match the on-chain root / total for the latest epoch."
      );
    } catch (e) {
      setVerifyMsg(`Invalid proof JSON: ${(e as Error).message}`);
    }
  }

  const probeGate = useCallback(
    async (o: WhatIfOverrides): Promise<GateResult> => {
      if (!publicClient || !gated || !reserveWallet) return "unavailable";
      const probe = (net.books.demoUser ?? reserveWallet) as Address;
      try {
        await publicClient.call({
          account: probe,
          to: gated,
          data: encodeFunctionData({
            abi: gatedPayoutAbi,
            functionName: "payout",
            args: [reserveWallet, ZERO],
          }),
          ...o,
        });
        return "allowed";
      } catch (e) {
        return revertName(e, gatedPayoutAbi) ?? "reverted";
      }
    },
    [publicClient, gated, reserveWallet, net.books.demoUser]
  );

  async function runWhatIf(id: ScenarioId) {
    if (!publicClient || !oracle || !stockArgs || !reserveWallet || !dep) return;
    setSimBusy(id);
    const block = await publicClient.getBlock();
    const o = buildOverrides(id, {
      custodianId: dep.custodianId,
      stockToken: dep.contracts.MockStockToken,
      reserveWallet,
      disputes: dep.contracts.DisputeModule,
      now: block.timestamp,
    });
    const details: Record<ScenarioId, string> = {
      drain: `stateOverride on mTSLA ${short(asset)}: balanceOf(${short(reserveWallet)}) = 0 (live: ${amount(
        typeof liveReserves === "bigint" ? liveReserves : undefined,
        "stock"
      )})`,
      skip8d: `blockOverrides: timestamp = ${new Date(Number(block.timestamp + BigInt(8 * 86400)) * 1000)
        .toISOString()
        .slice(0, 16)
        .replace("T", " ")} UTC (now + 8 days)`,
      split: `stateOverride on mTSLA ${short(asset)}: uiMultiplier = 2.0 (committed epoch snapshot: 1.0)`,
      dispute: `stateOverride on DisputeModule ${short(dep.contracts.DisputeModule)}: openDisputeCount[kopi][mTSLA] = 1`,
    };
    try {
      const [liveRaw, simRaw, livePayout, payout] = await Promise.all([
        publicClient.readContract({ address: oracle, abi: solvencyOracleAbi, functionName: "status", args: stockArgs }),
        publicClient.readContract({
          address: oracle,
          abi: solvencyOracleAbi,
          functionName: "status",
          args: stockArgs,
          ...o,
        }),
        probeGate({}),
        probeGate(o),
      ]);
      setSim({
        id,
        detail: details[id],
        liveReason: parseStatus(liveRaw)?.reason ?? null,
        reason: parseStatus(simRaw)?.reason ?? null,
        livePayout,
        payout,
      });
    } catch (e) {
      const err = e as Error & { shortMessage?: string };
      setSim({
        id,
        detail: details[id],
        liveReason: null,
        reason: null,
        livePayout: "—",
        payout: "—",
        error: `This network's RPC rejected the simulated call: ${err.shortMessage || err.message}`,
      });
    } finally {
      setSimBusy(null);
    }
  }

  const loadExit = useCallback(async () => {
    if (!publicClient || !exitRight || !custodianId || !asset) return;
    const read = (functionName: string, args: unknown[]) =>
      publicClient.readContract({ address: exitRight, abi: exitRightAbi, functionName, args });
    try {
      const [bal, inFlight, cfg, count, def] = (await Promise.all([
        read("bondBalance", [custodianId]),
        read("bondInFlight", [custodianId]),
        read("bondConfigs", [custodianId]),
        read("nextClaimId", []),
        read("exitDefault", [custodianId, asset]),
      ])) as [bigint, bigint, readonly [bigint, bigint, bigint, bigint, boolean], bigint, boolean];
      const info: ExitInfo = {
        bondBalance: bal,
        bondInFlight: inFlight,
        payoutDelay: cfg[1],
        perClaim: cfg[2],
        configured: cfg[4],
        claimCount: count,
        exitDefault: def,
      };
      if (count > ZERO) {
        const c = (await read("claims", [count - BigInt(1)])) as readonly [
          Hex, Address, Address, bigint, bigint, bigint, bigint, boolean, boolean, boolean,
        ];
        info.last = {
          id: count - BigInt(1),
          user: c[1],
          amount: c[4],
          deadline: c[6],
          open: c[7],
          settled: c[8],
          slashed: c[9],
        };
      }
      setExitInfo(info);
    } catch (e) {
      setActionLog(`ExitRight read failed: ${(e as Error).message}`);
    }
  }, [publicClient, exitRight, custodianId, asset]);

  useEffect(() => {
    setExitInfo(null);
    if (scene === SCENE_EXIT) void loadExit();
  }, [scene, loadExit]);

  useEffect(() => {
    setSim(null);
  }, [network]);

  const current = SCENES.find((s) => s.id === scene)!;
  const simScenario = sim ? SCENARIOS.find((s) => s.id === sim.id)! : null;
  const exitHomeElsewhere = !isLocal && exitInfo !== null && !exitInfo.configured && !net.books.exitright;
  const verifiedHref =
    network === "robinhoodTestnet"
      ? `${net.explorer}/address/${oracle}#code`
      : network === "arbitrumSepolia"
        ? `https://repo.sourcify.dev/421614/${oracle}`
        : undefined;

  const txLink = (hash?: string | null) =>
    hash && net.explorer ? (
      <a href={`${net.explorer}/tx/${hash}`} target="_blank" rel="noreferrer">
        {short(hash)} ↗
      </a>
    ) : (
      <span>{hash ? short(hash) : "—"}</span>
    );
  const addrLink = (addr?: string) =>
    addr && net.explorer ? (
      <a href={`${net.explorer}/address/${addr}`} target="_blank" rel="noreferrer">
        {short(addr)} ↗
      </a>
    ) : (
      short(addr)
    );

  return (
    <div className="shell">
      <header className="hero">
        <div className="hero-copy">
          <p className="eyebrow">ReserveProof · open-source proof of reserves</p>
          <h1 className="headline">Proof that your custodian actually holds your stocks and dollars.</h1>
          <p className="lede">
            When a custodian fails, customers find out last. ReserveProof puts the proof on-chain instead: the
            custodian commits what it owes, reserves are read straight from its wallets, and anyone can check
            their own balance. Payout and lending contracts ask one question, <code>isSolvent</code>, and stop
            automatically the moment the answer is no.
          </p>
          <div className="cta-row">
            <button type="button" className="primary" onClick={() => goToScene(SCENE_VERIFY)}>
              Verify a balance
            </button>
            <button type="button" className="ghost" onClick={() => goToScene(SCENE_WHATIF)}>
              Try the what-if simulator
            </button>
            {DEMO_VIDEO_URL && (
              <a className="ghost" href={DEMO_VIDEO_URL} target="_blank" rel="noreferrer">
                Watch the demo
              </a>
            )}
            <a className="ghost" href={GITHUB_URL} target="_blank" rel="noreferrer">
              GitHub
            </a>
          </div>
        </div>

        <aside className="status-panel" aria-label="Live status">
          <div className="netswitch" role="group" aria-label="Network">
            {NETWORK_KEYS.map((k) => (
              <button
                key={k}
                type="button"
                className={network === k ? "step active" : "step"}
                onClick={() => {
                  setNetwork(k);
                  setActionLog(null);
                  setVerifyMsg(null);
                  setBalResult(null);
                  setBalError(null);
                }}
              >
                {NETWORKS[k].label}
              </button>
            ))}
          </div>
          <div className="stat">
            <span className="label">mTSLA custody</span>
            <span className="row">
              <span className={`pill ${parsed?.ok ? "ok" : "bad"}`}>
                {parsed ? (parsed.ok ? "solvent" : "insolvent") : "—"}
              </span>
              <span className="value mono">{parsed ? reasonLabel(parsed.reason) : ""}</span>
            </span>
          </div>
          <div className="stat">
            <span className="label">USDG custody</span>
            {usdgHomeOnly ? (
              <span className="value muted-text">published on Robinhood</span>
            ) : (
              <span className="row">
                <span className={`pill ${parsedUsdg?.ok ? "ok" : "bad"}`}>
                  {parsedUsdg ? (parsedUsdg.ok ? "solvent" : "insolvent") : "—"}
                </span>
                <span className="value mono">{parsedUsdg ? reasonLabel(parsedUsdg.reason) : ""}</span>
              </span>
            )}
          </div>
          <div className="stat">
            <span className="label">Demo custodian</span>
            <span className="value">Kopi Wallet</span>
          </div>
          <div className="stat">
            <span className="label">Oracle</span>
            <span className="value mono">{addrLink(oracle)}</span>
          </div>
          <div className="stat wide">
            <span className="label">Reserve wallet</span>
            <span className="value mono">{addrLink(reserveWallet)}</span>
          </div>
          <button type="button" className="icon-btn" onClick={refreshAll} aria-label="Refresh live status">
            ↻ Refresh
          </button>
        </aside>
      </header>

      <section className="live-strip" aria-label="Live proof">
        <div className="strip-cell">
          <span className="label">Latest epoch</span>
          <span className="big">{epochId ? String(epochId) : "—"}</span>
          <a
            className="sub"
            href={`${GITHUB_URL}/actions/workflows/ops-epoch.yml`}
            target="_blank"
            rel="noreferrer"
          >
            auto-published every 3 days ↗
          </a>
        </div>
        <div className="strip-cell">
          <span className="label">Last published</span>
          <span className="big">{ago(parsed?.updatedAt, nowSec)}</span>
          <span className="sub">
            {parsed?.updatedAt && parsed.updatedAt > ZERO
              ? new Date(Number(parsed.updatedAt) * 1000).toUTCString().slice(5, 22) + " UTC"
              : "—"}
          </span>
        </div>
        <div className="strip-cell">
          <span className="label">mTSLA coverage</span>
          <span className={`big ${covered === false ? "bad-text" : ""}`}>{percent(coverageBps)}</span>
          <span className="sub">required ≥ {percent(floorBps !== undefined ? BigInt(floorBps) : undefined)}</span>
        </div>
        <div className="strip-cell">
          <span className="label">Contracts verified</span>
          <span className="big">{isLocal ? "—" : `${VERIFIED_CONTRACTS} / ${VERIFIED_CONTRACTS}`}</span>
          {verifiedHref ? (
            <a className="sub" href={verifiedHref} target="_blank" rel="noreferrer">
              {network === "robinhoodTestnet" ? "Blockscout" : "Sourcify"} ↗
            </a>
          ) : (
            <span className="sub">local node</span>
          )}
        </div>
      </section>

      {loadError && (
        <div className="banner warn">
          {loadError} Start the Hardhat node, then <code>npm run demo:setup</code>.
        </div>
      )}

      <nav className="stepper" aria-label="Demo scenes" ref={scenesRef}>
        {SCENES.map((s) => (
          <button
            key={s.id}
            type="button"
            className={scene === s.id ? "step active" : "step"}
            onClick={() => {
              setScene(s.id);
              setActionLog(null);
              setVerifyMsg(null);
            }}
          >
            <span className="num">{s.id}</span>
            <span className="stitle">{s.title}</span>
          </button>
        ))}
      </nav>

      <main className="scene">
        <h2>{current.title}</h2>
        <p className="blurb">{current.blurb}</p>

        {scene === 1 && (
          <div className="actions">
            <button type="button" className="primary" onClick={() => void runScene1()}>
              Check who owns the reserve wallet
            </button>
          </div>
        )}

        {scene === 2 && (
          <div className="actions">
            <dl className="kv">
              <dt>Epoch</dt>
              <dd className="mono">{epochId ? String(epochId) : "—"}</dd>
              <dt>Liability root</dt>
              <dd className="mono">{epochData?.liabilityRoot ? short(epochData.liabilityRoot) : "—"}</dd>
              <dt>Owed to customers</dt>
              <dd>{amount(epochData?.totalLiability, "stock")}</dd>
              <dt>Allocated to this chain</dt>
              <dd>{amount(epochData?.allocation, "stock")}</dd>
              <dt>Live reserves</dt>
              <dd>{amount(typeof liveReserves === "bigint" ? liveReserves : undefined, "stock")}</dd>
              <dt>Coverage</dt>
              <dd>
                <strong>{percent(coverageBps)}</strong> actual · required ≥{" "}
                {percent(floorBps !== undefined ? BigInt(floorBps) : undefined)}
              </dd>
            </dl>
            {covered !== undefined && (
              <p className={`result ${covered ? "" : "bad"}`}>
                {covered
                  ? `Reserves cover the allocation above the ${percent(BigInt(floorBps!))} floor, so the oracle reports solvent.`
                  : `Reserves are below the ${percent(BigInt(floorBps!))} floor, so the oracle fails closed.`}
              </p>
            )}
          </div>
        )}

        {scene === SCENE_VERIFY && (
          <div className="actions">
            <div className="row">
              {(["stock", "usdg"] as AssetKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={balAsset === k ? "step active" : "step"}
                  onClick={() => {
                    setBalAsset(k);
                    setBalResult(null);
                    setBalError(null);
                  }}
                >
                  {ASSET_META[k].label}
                </button>
              ))}
            </div>
            <label className="field">
              <span>Your address</span>
              <input
                value={balAddr}
                onChange={(e) => setBalAddr(e.target.value)}
                spellCheck={false}
                placeholder="0x…"
              />
            </label>
            <div className="row">
              <button type="button" className="ghost" onClick={fillDemoUser}>
                Try demo user
              </button>
              {isConnected && address && (
                <button type="button" className="ghost" onClick={() => setBalAddr(address)}>
                  Use my wallet
                </button>
              )}
              <button
                type="button"
                className="primary"
                disabled={balBusy}
                onClick={() => void runBalanceCheck()}
              >
                {balBusy ? "Checking…" : "Verify my balance"}
              </button>
            </div>
            {balError && <p className="result bad">{balError}</p>}
            {balResult && (
              <div className="verify-card">
                <p className={`result ${balResult.verified ? "" : "bad"}`}>
                  {balResult.verified
                    ? `✓ ${short(balResult.user)} holds ${amount(balResult.amount, balResult.asset)} in epoch ${balResult.epochId}, proven against the on-chain root.`
                    : !balResult.rootMatches
                      ? "✗ The published book does not rebuild to the on-chain root, so this UI's copy is out of date."
                      : `✗ ${short(balResult.user)} is not in the ${ASSET_META[balResult.asset].label} book for epoch ${balResult.epochId}.`}
                </p>
                <dl className="kv">
                  <dt>Epoch</dt>
                  <dd className="mono">{balResult.epochId}</dd>
                  <dt>Computed root</dt>
                  <dd className="mono">{balResult.computedRoot}</dd>
                  <dt>On-chain root</dt>
                  <dd className="mono">
                    {balResult.onchainRoot} {balResult.rootMatches ? "✓" : "✗"}
                  </dd>
                  {balResult.found && (
                    <>
                      <dt>Proof path</dt>
                      <dd>
                        <ol className="proof-path">
                          {balResult.proof.map((p, i) => (
                            <li key={i} className="mono">
                              {p.isLeft ? "left " : "right"} sibling {short(p.hash)} · sum{" "}
                              {amount(BigInt(p.sum), balResult.asset)}
                            </li>
                          ))}
                        </ol>
                      </dd>
                    </>
                  )}
                </dl>
                {balResult.found && (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() =>
                      setProofText(
                        JSON.stringify(
                          {
                            user: balResult.user,
                            amount: balResult.amount.toString(),
                            proof: balResult.proof.map((p) => ({ ...p, sum: String(p.sum) })),
                          },
                          null,
                          2
                        )
                      )
                    }
                  >
                    Export as proof JSON
                  </button>
                )}
              </div>
            )}
            <details className="advanced">
              <summary>Advanced: paste a proof JSON</summary>
              <label className="field">
                <span>Proof JSON exported above or produced by the CLI</span>
                <textarea
                  value={proofText}
                  onChange={(e) => setProofText(e.target.value)}
                  rows={8}
                  spellCheck={false}
                  placeholder='{"user":"0x…","amount":"…","proof":[{...}]}'
                />
              </label>
              <button type="button" className="primary" onClick={() => void runVerify()}>
                Verify pasted proof
              </button>
              {verifyMsg && <p className="result">{verifyMsg}</p>}
            </details>
          </div>
        )}

        {scene === SCENE_WHATIF && (
          <div className="actions">
            <div className="sim-grid">
              {SCENARIOS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`sim-card ${sim?.id === s.id ? "active" : ""}`}
                  disabled={simBusy !== null}
                  onClick={() => void runWhatIf(s.id)}
                >
                  <span className="sim-btn">{simBusy === s.id ? "Simulating…" : s.button}</span>
                  <span className="sim-story">{s.story}</span>
                </button>
              ))}
            </div>

            {sim && simScenario && (
              <div className="sim-result">
                <h3>{simScenario.title}</h3>
                <p className="muted-text">
                  What changed (simulated, nothing sent): <span className="mono">{sim.detail}</span>
                </p>
                {sim.error ? (
                  <p className="result bad">{sim.error}</p>
                ) : (
                  <table className="compare">
                    <thead>
                      <tr>
                        <th />
                        <th>Live chain now</th>
                        <th>With this change</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>Oracle status</td>
                        <td>
                          <span className={`pill ${sim.liveReason === 0 ? "ok" : "bad"}`}>
                            {reasonLabel(sim.liveReason ?? undefined)}
                          </span>
                        </td>
                        <td>
                          <span className={`pill ${sim.reason === 0 ? "ok" : "bad"}`}>
                            {reasonLabel(sim.reason ?? undefined)}
                          </span>
                        </td>
                      </tr>
                      <tr>
                        <td>GatedPayout.payout</td>
                        <td>
                          <span className={`pill ${sim.livePayout === "allowed" ? "ok" : "bad"}`}>
                            {gateLabel(sim.livePayout)}
                          </span>
                        </td>
                        <td>
                          <span className={`pill ${sim.payout === "allowed" ? "ok" : "bad"}`}>
                            {gateLabel(sim.payout)}
                          </span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                )}
                {!sim.error && sim.reason === SCENARIO_EXPECTED_REASON[sim.id] && sim.payout !== "allowed" && (
                  <p className="result">
                    The real {net.label} contracts fail closed: the oracle reports{" "}
                    <strong>{reasonLabel(sim.reason ?? undefined)}</strong> and every payout is refused until the
                    custodian fixes it.
                  </p>
                )}
                <button type="button" className="ghost" onClick={() => setSim(null)}>
                  Reset
                </button>
              </div>
            )}

            {isLocal && (
              <p className="hint">
                On the local node you can also make these changes for real: <code>SCENE=4|5|6|7 npm run demo:prepare</code>,
                then <code>npm run demo:reset</code>.
              </p>
            )}
          </div>
        )}

        {scene === SCENE_EXIT && (
          <div className="actions">
            {exitHomeElsewhere ? (
              <>
                <p className="result">
                  ExitRight&apos;s bond and the recorded claim live on Robinhood testnet, the home chain for this
                  demo. {net.label} runs the same contracts without a bond posted.
                </p>
                <button type="button" className="primary" onClick={() => setNetwork("robinhoodTestnet")}>
                  Switch to Robinhood testnet
                </button>
              </>
            ) : (
              <>
                <dl className="kv">
                  <dt>Bond posted</dt>
                  <dd className="mono">{exitInfo ? amount(exitInfo.bondBalance, "usdg") : "…"}</dd>
                  <dt>Bond in flight</dt>
                  <dd className="mono">{exitInfo ? amount(exitInfo.bondInFlight, "usdg") : "…"}</dd>
                  <dt>Bond per claim</dt>
                  <dd className="mono">{exitInfo?.configured ? amount(exitInfo.perClaim, "usdg") : "…"}</dd>
                  <dt>Payout window</dt>
                  <dd className="mono">
                    {exitInfo?.configured ? `${Number(exitInfo.payoutDelay) / 3600} h` : "—"}
                  </dd>
                  <dt>Claims opened</dt>
                  <dd className="mono">{exitInfo ? String(exitInfo.claimCount) : "…"}</dd>
                  <dt>Exit default (mTSLA)</dt>
                  <dd className="mono">{exitInfo ? (exitInfo.exitDefault ? "YES, permanent" : "no") : "…"}</dd>
                  {exitInfo?.last && (
                    <>
                      <dt>Last claim</dt>
                      <dd className="mono">
                        #{String(exitInfo.last.id)} · {short(exitInfo.last.user)} ·{" "}
                        {amount(exitInfo.last.amount, "stock")} ·{" "}
                        {exitInfo.last.settled ? "settled ✓" : exitInfo.last.slashed ? "slashed ✗" : "open"}
                      </dd>
                    </>
                  )}
                </dl>
                {net.books.exitright && (
                  <dl className="kv">
                    <dt>openClaim tx</dt>
                    <dd className="mono">{txLink(net.books.exitright.txs.openClaim)}</dd>
                    <dt>settle tx</dt>
                    <dd className="mono">{txLink(net.books.exitright.txs.settle)}</dd>
                    <dt>Recorded</dt>
                    <dd className="mono">{net.books.exitright.recordedAt.slice(0, 10)}</dd>
                  </dl>
                )}
                {isLocal && !net.books.exitright && (
                  <p className="hint">
                    Run <code>npx hardhat run scripts/exitright-setup.ts --network localhost</code> then{" "}
                    <code>scripts/exitright-demo.ts</code>.
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {actionLog && <pre className="log">{actionLog}</pre>}
      </main>

      <footer className="foot">
        <span>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>{" "}
          ·{" "}
          <a href={`${GITHUB_URL}/blob/master/docs/SUBMISSION.md`} target="_blank" rel="noreferrer">
            Submission
          </a>{" "}
          · MIT licensed
        </span>
        <span>
          {net.label}
          {oracle && net.explorer ? <> · oracle {addrLink(oracle)}</> : null}
        </span>
      </footer>
    </div>
  );
}
