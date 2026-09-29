"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReadContract, usePublicClient, useAccount } from "wagmi";
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  encodeFunctionData,
  formatUnits,
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
  guardedVaultAbi,
  gatedMorphoOracleAbi,
} from "../lib/abis";
import { verifyInclusion, type ProofNode } from "../lib/merkle";
import { checkBalance, parseEpoch, type BalanceResult } from "../lib/balance";
import { reasonLabel } from "../lib/reasons";
import { SCENES, SCENE_EXIT, SCENE_VERIFY, SCENE_WHATIF, type Deployment } from "../lib/types";
import {
  ASSET_META,
  GITHUB_URL,
  NETWORKS,
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
import { MainnetSection } from "./MainnetSection";
import { CompareSection } from "./CompareSection";
import { Section } from "./site/PageHeader";
import { KpiCard } from "./site/KpiCard";
import { Card, CardContent } from "./ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { HomeHero } from "./home/HomeHero";
import { StatusCard, type CustodyRow } from "./home/StatusCard";
import { ExploreSection } from "./home/ExploreSection";
import { NetworkSwitch, Note } from "./home/parts";
import { ActionLog, ExitScene, LedgerScene, VerifyScene, WalletScene, WhatIfScene } from "./home/DemoScenes";
import type { VaultState } from "./home/MerkleVault";
import type { ExitInfo, GateKind, GateResult, GateRow, SimResult } from "./home/types";

type ChainId = 46630 | 421614 | 31337;

type Status = { ok: boolean; epochId: bigint; updatedAt: bigint; reason: number };

type Verification = { total: number; verified: number; unverified: string[]; unknown: number; checkedAt: string };

/**
 * `staysOpen`: the action is deliberately not gated in this scenario, so "allowed" under a failing proof
 * is correct. `format` renders a successful call's return data (e.g. a price) instead of "Allowed".
 */
type GateProbe = {
  kind: GateKind;
  label: string;
  to: Address;
  data: Hex;
  account: Address;
  abi: Abi;
  staysOpen?: boolean;
  openNote?: string;
  format?: (ret: Hex) => string;
};

type ProbeOutcome = { result: GateResult; text?: string };

const ZERO = BigInt(0);
const BPS = BigInt(10_000);
const USDG_UNIT = BigInt(1_000_000);
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

function revertName(e: unknown, abi?: Abi): string | undefined {
  if (!(e instanceof BaseError)) return undefined;
  let decoded: { errorName: string; args?: readonly unknown[] } | undefined;
  const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
  if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName) {
    decoded = revert.data;
  } else if (abi) {
    const withData = e.walk((err) => typeof (err as { data?: unknown }).data === "string") as
      | { data?: Hex }
      | null;
    if (withData?.data) {
      try {
        decoded = decodeErrorResult({ abi, data: withData.data });
      } catch {
        return undefined;
      }
    }
  }
  if (!decoded) return undefined;
  // SolvencyGuard's Insolvent(uint8 reason) carries the oracle reason code.
  if (decoded.errorName === "Insolvent" && decoded.args?.length) {
    return `Insolvent (${reasonLabel(Number(decoded.args[0]))})`;
  }
  return decoded.errorName;
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

/** One sentence describing only the gates the simulator actually probed on this network. */
function simSummary(
  gates: GateRow[],
  reason: string,
  network: string,
  freeze?: { maxFreezeHours: number; postCapPct: number }
) {
  const find = (k: GateKind) => gates.find((g) => g.kind === k);
  const parts: string[] = [];
  const payout = find("payout");
  if (payout && payout.sim !== "allowed") parts.push("payouts are refused");
  const borrow = find("borrow");
  if (borrow && borrow.sim !== "allowed") parts.push("the lending vault stops new borrowing against mTSLA");
  const withdraw = find("withdraw");
  if (withdraw && withdraw.sim !== "allowed") parts.push("an indebted borrower can't pull collateral out");
  const morpho = find("morpho");
  if (morpho && morpho.sim !== "allowed") parts.push("the Morpho oracle stops pricing mTSLA");
  let text = `The real ${network} contracts react: the oracle reports ${reason}`;
  text += parts.length ? `, ${parts.join(", ")}.` : ".";
  if (morpho && morpho.sim !== "allowed" && freeze) {
    text += ` If the failure lasts ${freeze.maxFreezeHours} h, the Morpho oracle reprices at ${freeze.postCapPct}% so liquidations can clear.`;
  }
  if (withdraw && withdraw.sim === "allowed") text += " Withdrawing collateral with no debt stays open.";
  if (borrow || withdraw) text += " Repaying is never blocked.";
  return text;
}

function gateLabel(g: GateResult, text?: string, openNote?: string) {
  if (g !== "allowed") return `Blocked: ${g}`;
  const base = text ?? "Allowed";
  return openNote ? `${base} (${openNote})` : base;
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
  const scenesRef = useRef<HTMLDivElement>(null);

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

  // Checked against Blockscout / Sourcify by /api/verified (cached server-side for an hour).
  const [verification, setVerification] = useState<Verification | null>(null);
  useEffect(() => {
    setVerification(null);
    if (isLocal) return;
    let cancelled = false;
    fetch(`/api/verified?network=${network}`)
      .then((r) => (r.ok ? (r.json() as Promise<Verification>) : null))
      .then((v) => {
        if (!cancelled && v) setVerification(v);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [network, isLocal]);

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
  const tsla = dep?.contracts.TSLA;
  const assetAddr = (kind: AssetKind) => (kind === "stock" ? asset : kind === "usdg" ? usdg : tsla);
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

  const { data: tslaStatus, refetch: refetchTsla } = useReadContract({
    address: oracle,
    abi: solvencyOracleAbi,
    functionName: "status",
    chainId,
    args: custodianId && tsla ? [custodianId, tsla] : undefined,
    query: { enabled: Boolean(oracle && custodianId && tsla), refetchInterval: 30_000 },
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

  // What the oracle compares against the floor: min(lowest sample this epoch, live balance).
  const { data: effectiveReserves, refetch: refetchEffective } = useReadContract({
    address: sampler,
    abi: reserveSamplerAbi,
    functionName: "effectiveReserves",
    chainId,
    args: stockArgs && epochId ? [...stockArgs, epochId] : undefined,
    query: { enabled: Boolean(sampler && stockArgs && epochId && Number(epochId) > 0), refetchInterval: 30_000 },
  });

  const { data: sampleMinRaw } = useReadContract({
    address: sampler,
    abi: reserveSamplerAbi,
    functionName: "sampleMin",
    chainId,
    args: stockArgs && epochId ? [...stockArgs, epochId] : undefined,
    query: { enabled: Boolean(sampler && stockArgs && epochId && Number(epochId) > 0), refetchInterval: 60_000 },
  });
  const sampleMin = Array.isArray(sampleMinRaw) && (sampleMinRaw[1] as bigint) > ZERO ? (sampleMinRaw[0] as bigint) : undefined;

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
  const parsedTsla = useMemo(() => parseStatus(tslaStatus), [tslaStatus]);
  const epochData = useMemo(() => parseEpoch(epoch), [epoch]);
  const usdgHomeOnly = network === "arbitrumSepolia" && !net.books.liabilities.usdg;
  const floorBps = (stockConfig as { coverageFloorBps?: number } | undefined)?.coverageFloorBps;
  const coverageBps =
    epochData && epochData.allocation > ZERO && typeof effectiveReserves === "bigint"
      ? (effectiveReserves * BPS) / epochData.allocation
      : null;
  const covered =
    coverageBps !== null && floorBps !== undefined ? coverageBps >= BigInt(floorBps) : undefined;

  function refreshAll() {
    void refetchStatus();
    void refetchUsdg();
    void refetchTsla();
    void refetchReserves();
    void refetchEffective();
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
    [publicClient, ledger, custodianId, asset, usdg, tsla]
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
          : balAsset === "tsla" && network !== "robinhoodTestnet"
            ? "TSLA is Robinhood's own testnet stock token, so its book is published on Robinhood testnet."
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
      setBalResult(
        checkBalance({
          custodianId: dep.custodianId,
          kind: balAsset,
          asset: addr,
          epochId: latest,
          ep,
          book,
          user: balAddr,
        })
      );
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

  const gateProbes = useCallback(async (): Promise<GateProbe[]> => {
    const probes: GateProbe[] = [];
    if (!publicClient || !reserveWallet) return probes;
    if (gated) {
      probes.push({
        kind: "payout",
        label: "GatedPayout.payout (demo user)",
        to: gated,
        account: (net.books.demoUser ?? reserveWallet) as Address,
        abi: gatedPayoutAbi,
        data: encodeFunctionData({ abi: gatedPayoutAbi, functionName: "payout", args: [reserveWallet, ZERO] }),
      });
    }
    const vault = dep?.contracts.GuardedLendingVault;
    const borrower = dep?.vault?.demoBorrower;
    if (vault && borrower) {
      const [debt, liquidity] = (await Promise.all([
        publicClient
          .readContract({ address: vault, abi: guardedVaultAbi, functionName: "debtOf", args: [borrower] })
          .catch(() => ZERO),
        publicClient
          .readContract({ address: vault, abi: guardedVaultAbi, functionName: "availableLiquidity" })
          .catch(() => ZERO),
      ])) as [bigint, bigint];
      probes.push({
        kind: "withdraw",
        label:
          debt > ZERO
            ? `Lending vault: withdraw mTSLA collateral (borrower owes ${formatUnits(debt, 6)} USDG)`
            : "Lending vault: withdraw mTSLA collateral with no debt",
        staysOpen: debt === ZERO,
        openNote: debt === ZERO ? "by design" : undefined,
        to: vault,
        account: borrower,
        abi: guardedVaultAbi,
        data: encodeFunctionData({ abi: guardedVaultAbi, functionName: "withdrawCollateral", args: [BigInt(1)] }),
      });
      if (liquidity >= USDG_UNIT) {
        probes.push({
          kind: "borrow",
          label: "Lending vault: borrow 1 USDG against mTSLA",
          to: vault,
          account: borrower,
          abi: guardedVaultAbi,
          data: encodeFunctionData({ abi: guardedVaultAbi, functionName: "borrow", args: [USDG_UNIT] }),
        });
      }
    }
    const morphoOracle = dep?.contracts.SolvencyGatedMorphoOracle;
    if (morphoOracle) {
      probes.push({
        kind: "morpho",
        label: "Morpho Blue oracle: SolvencyGatedMorphoOracle.price()",
        to: morphoOracle,
        account: reserveWallet,
        abi: gatedMorphoOracleAbi,
        data: encodeFunctionData({ abi: gatedMorphoOracleAbi, functionName: "price" }),
        // Morpho scale: loan units per collateral unit * 1e36; USDG 6 dp, mTSLA 18 dp, so USDG per mTSLA = p / 1e24.
        format: (ret) => {
          const n = Number(formatUnits(BigInt(ret), 24));
          return `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDG per mTSLA`;
        },
      });
    }
    return probes;
  }, [publicClient, gated, reserveWallet, net.books.demoUser, dep]);

  const runProbe = useCallback(
    async (p: GateProbe, o: WhatIfOverrides): Promise<ProbeOutcome> => {
      if (!publicClient) return { result: "unavailable" };
      try {
        const { data } = await publicClient.call({ account: p.account, to: p.to, data: p.data, ...o });
        return { result: "allowed", text: p.format && data ? p.format(data) : undefined };
      } catch (e) {
        return { result: revertName(e, p.abi) ?? "reverted" };
      }
    },
    [publicClient]
  );

  async function runWhatIf(id: ScenarioId) {
    if (!publicClient || !oracle || !stockArgs || !asset || !reserveWallet || !dep) return;
    setSimBusy(id);
    const block = await publicClient.getBlock();
    const o = buildOverrides(id, {
      custodianId: dep.custodianId,
      stockToken: asset,
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
      const probes = await gateProbes();
      const [liveRaw, simRaw, gates] = await Promise.all([
        publicClient.readContract({ address: oracle, abi: solvencyOracleAbi, functionName: "status", args: stockArgs }),
        publicClient.readContract({
          address: oracle,
          abi: solvencyOracleAbi,
          functionName: "status",
          args: stockArgs,
          ...o,
        }),
        Promise.all(
          probes.map(async (p): Promise<GateRow> => {
            const [live, simulated] = await Promise.all([runProbe(p, {}), runProbe(p, o)]);
            return {
              kind: p.kind,
              label: p.label,
              live: live.result,
              sim: simulated.result,
              liveText: live.text,
              simText: simulated.text,
              staysOpen: p.staysOpen,
              openNote: p.openNote,
            };
          })
        ),
      ]);
      setSim({
        id,
        detail: details[id],
        liveReason: parseStatus(liveRaw)?.reason ?? null,
        reason: parseStatus(simRaw)?.reason ?? null,
        gates,
      });
    } catch (e) {
      const err = e as Error & { shortMessage?: string };
      setSim({
        id,
        detail: details[id],
        liveReason: null,
        reason: null,
        gates: [],
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

  const exitHomeElsewhere = !isLocal && exitInfo !== null && !exitInfo.configured && !net.books.exitright;
  const verifiedHref =
    network === "robinhoodTestnet"
      ? `${net.explorer}/address/${oracle}#code`
      : network === "arbitrumSepolia"
        ? `https://repo.sourcify.dev/421614/${oracle}`
        : undefined;
  const morphoFreeze =
    dep?.morpho?.maxFreeze && dep.morpho.postCapBps
      ? { maxFreezeHours: Math.round(dep.morpho.maxFreeze / 3600), postCapPct: dep.morpho.postCapBps / 100 }
      : undefined;
  const verifiedText = isLocal || !verification ? "—" : `${verification.verified} / ${verification.total}`;
  const verifiedShort = verification !== null && verification.unverified.length > 0;
  const verifiedUnchecked = verification !== null && verification.unknown > 0;
  const floorText = percent(floorBps !== undefined ? BigInt(floorBps) : undefined);

  const simSummaryText =
    sim &&
    !sim.error &&
    sim.reason === SCENARIO_EXPECTED_REASON[sim.id] &&
    sim.gates.length > 0 &&
    sim.gates.every((g) => (g.staysOpen ? g.sim === "allowed" : g.sim !== "allowed"))
      ? simSummary(sim.gates, reasonLabel(sim.reason ?? undefined), net.label, morphoFreeze)
      : null;

  const simulated = sim && !sim.error && sim.reason !== null ? sim : null;
  const vaultState: VaultState = simulated
    ? simulated.reason === 0
      ? "solvent"
      : "insolvent"
    : parsed
      ? parsed.ok
        ? "solvent"
        : "insolvent"
      : "unknown";
  const vaultCaption = simulated
    ? `What-if: ${SCENARIOS.find((s) => s.id === simulated.id)?.button} · ${reasonLabel(simulated.reason ?? undefined)}`
    : parsed
      ? `Live mTSLA proof on ${net.label} · ${parsed.ok ? "solvent" : reasonLabel(parsed.reason)}`
      : `Reading ${net.label}…`;

  const linkCls = "text-primary underline-offset-4 hover:underline";
  const txLink = (hash?: string | null) =>
    hash && net.explorer ? (
      <a href={`${net.explorer}/tx/${hash}`} target="_blank" rel="noreferrer" className={linkCls}>
        {short(hash)} ↗
      </a>
    ) : (
      <span>{hash ? short(hash) : "—"}</span>
    );
  const addrLink = (addr?: string) =>
    addr && net.explorer ? (
      <a href={`${net.explorer}/address/${addr}`} target="_blank" rel="noreferrer" className={linkCls}>
        {short(addr)} ↗
      </a>
    ) : (
      short(addr)
    );

  function changeNetwork(k: NetworkKey) {
    setNetwork(k);
    setActionLog(null);
    setVerifyMsg(null);
    setBalResult(null);
    setBalError(null);
  }

  function selectScene(v: string) {
    setScene(Number(v));
    setActionLog(null);
    setVerifyMsg(null);
  }

  const custodyRows: CustodyRow[] = [
    { label: "mTSLA custody", hint: "demo stock token", status: parsed },
    {
      label: "USDG custody",
      hint: "Paxos dollar stablecoin",
      status: parsedUsdg,
      elsewhere: usdgHomeOnly ? "published on Robinhood" : undefined,
    },
    {
      label: "TSLA custody",
      hint: "real Robinhood stock token",
      status: parsedTsla,
      elsewhere: tsla ? undefined : "published on Robinhood",
    },
  ];

  const ledgerItems: [React.ReactNode, React.ReactNode][] = [
    ["Epoch", epochId ? String(epochId) : "—"],
    ["Liability root", epochData?.liabilityRoot ? short(epochData.liabilityRoot) : "—"],
    ["Owed to customers", amount(epochData?.totalLiability, "stock")],
    ["Allocated to this chain", amount(epochData?.allocation, "stock")],
    ["Live balance", amount(typeof liveReserves === "bigint" ? liveReserves : undefined, "stock")],
    ["Lowest sample this epoch", amount(sampleMin, "stock")],
    [
      "Coverage",
      <span key="c">
        <strong className={covered === false ? "text-destructive" : "text-success"}>{percent(coverageBps)}</strong>{" "}
        <span className="text-muted-foreground">counted (min of samples and live) · required ≥ {floorText}</span>
      </span>,
    ],
  ];

  const exitTxRows: [React.ReactNode, React.ReactNode][] | null = net.books.exitright
    ? [
        ["openClaim tx", txLink(net.books.exitright.txs.openClaim)],
        ["settle tx", txLink(net.books.exitright.txs.settle)],
        ["Recorded", net.books.exitright.recordedAt.slice(0, 10)],
      ]
    : null;

  function sceneBody(id: number) {
    switch (id) {
      case 1:
        return <WalletScene onCheck={() => void runScene1()} />;
      case 2:
        return <LedgerScene items={ledgerItems} covered={covered} floor={floorText} />;
      case SCENE_VERIFY:
        return (
          <VerifyScene
            asset={balAsset}
            onAsset={(k) => {
              setBalAsset(k);
              setBalResult(null);
              setBalError(null);
            }}
            addr={balAddr}
            onAddr={setBalAddr}
            onDemo={fillDemoUser}
            walletAddress={isConnected ? address : undefined}
            busy={balBusy}
            onCheck={() => void runBalanceCheck()}
            error={balError}
            result={balResult}
            fmt={amount}
            short={short}
            proofText={proofText}
            onProofText={setProofText}
            onVerifyPasted={() => void runVerify()}
            verifyMsg={verifyMsg}
          />
        );
      case SCENE_WHATIF:
        return (
          <WhatIfScene
            sim={sim}
            busy={simBusy}
            onRun={(sid) => void runWhatIf(sid)}
            onReset={() => setSim(null)}
            summary={simSummaryText}
            isLocal={isLocal}
            gateLabel={gateLabel}
          />
        );
      case SCENE_EXIT:
        return (
          <ExitScene
            homeElsewhere={exitHomeElsewhere}
            netLabel={net.label}
            onSwitchHome={() => setNetwork("robinhoodTestnet")}
            info={exitInfo}
            fmt={amount}
            short={short}
            txRows={exitTxRows}
            isLocal={isLocal}
          />
        );
      default:
        return null;
    }
  }

  return (
    <>
      <HomeHero
        vaultState={vaultState}
        vaultCaption={vaultCaption}
        statusCard={
          <StatusCard
            network={network}
            onNetwork={changeNetwork}
            rows={custodyRows}
            oracle={addrLink(oracle)}
            reserve={addrLink(reserveWallet)}
            onRefresh={refreshAll}
          />
        }
      />

      <div className="container space-y-20 py-14 md:space-y-24 md:py-20">
        <MainnetSection />

        <Section
          id="demo"
          kicker="Live demo"
          title={<>Kopi Wallet on {net.label}</>}
          description="Every figure below is read from the chain as you watch. Nothing is signed or sent, and no wallet is needed."
          actions={<NetworkSwitch value={network} onChange={changeNetwork} />}
        >
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard
              label="Latest epoch"
              value={epochId ? Number(epochId) : undefined}
              sub={
                <a
                  href={`${GITHUB_URL}/actions/workflows/ops-epoch.yml`}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-primary"
                >
                  auto-published every 3 days ↗
                </a>
              }
            />
            <KpiCard
              label="Last published"
              display={ago(parsed?.updatedAt, nowSec)}
              sub={
                parsed?.updatedAt && parsed.updatedAt > ZERO
                  ? new Date(Number(parsed.updatedAt) * 1000).toUTCString().slice(5, 22) + " UTC"
                  : "—"
              }
            />
            <KpiCard
              label="mTSLA coverage"
              display={percent(coverageBps)}
              tone={covered === false ? "bad" : covered ? "ok" : "neutral"}
              sub={<>min(samples, live) · required ≥ {floorText}</>}
            />
            <KpiCard
              label="Contracts verified"
              display={verifiedText}
              tone={verifiedShort ? "bad" : verifiedUnchecked ? "warn" : verification ? "ok" : "neutral"}
              sub={
                <>
                  {verifiedUnchecked && (
                    <span className="block text-warning">{verification!.unknown} could not be checked right now</span>
                  )}
                  {verifiedHref ? (
                    <a
                      href={verifiedHref}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:text-primary"
                      title={
                        verification
                          ? `Checked ${new Date(verification.checkedAt).toUTCString()}${
                              verification.unverified.length ? ` · not verified: ${verification.unverified.join(", ")}` : ""
                            }${verification.unknown ? ` · ${verification.unknown} could not be checked` : ""}`
                          : undefined
                      }
                    >
                      checked on {network === "robinhoodTestnet" ? "Blockscout" : "Sourcify"} ↗
                    </a>
                  ) : (
                    "local node"
                  )}
                </>
              }
            />
          </div>

          {loadError && (
            <Note tone="bad" className="mt-4">
              {loadError} Start the Hardhat node, then <code className="font-mono">npm run demo:setup</code>.
            </Note>
          )}

          <div ref={scenesRef} className="mt-8 scroll-mt-24">
            <Tabs value={String(scene)} onValueChange={selectScene} className="grid gap-5 lg:grid-cols-[250px_minmax(0,1fr)]">
              <TabsList
                aria-label="Demo scenes"
                className="flex h-auto w-full justify-start gap-1 overflow-x-auto rounded-xl border border-border/60 bg-card/40 p-1.5 lg:sticky lg:top-20 lg:flex-col lg:items-stretch lg:self-start lg:overflow-visible"
              >
                {SCENES.map((s) => (
                  <TabsTrigger
                    key={s.id}
                    value={String(s.id)}
                    className="group shrink-0 justify-start gap-2.5 rounded-lg px-3 py-2 text-left text-sm data-[state=active]:bg-primary/10 data-[state=active]:text-foreground data-[state=active]:shadow-none"
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border font-mono text-[0.7rem] group-data-[state=active]:border-primary/60 group-data-[state=active]:text-primary">
                      {s.id}
                    </span>
                    {s.title}
                  </TabsTrigger>
                ))}
              </TabsList>
              {SCENES.map((s) => (
                <TabsContent key={s.id} value={String(s.id)} className="mt-0 min-w-0">
                  <Card className="border-border/70 bg-card/60">
                    <CardContent className="p-5 md:p-7">
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
                        Scene {s.id} of {SCENES.length}
                      </p>
                      <h3 className="mt-1 font-display text-2xl font-semibold tracking-tight">{s.title}</h3>
                      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{s.blurb}</p>
                      <div className="mt-6">{sceneBody(s.id)}</div>
                      {actionLog && <ActionLog text={actionLog} />}
                    </CardContent>
                  </Card>
                </TabsContent>
              ))}
            </Tabs>
          </div>
        </Section>

        <CompareSection onWhatIf={() => goToScene(SCENE_WHATIF)} />

        <ExploreSection />
      </div>
    </>
  );
}
