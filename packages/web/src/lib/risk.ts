import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  formatUnits,
  http,
  parseAbi,
  type Abi,
  type Address,
} from "viem";
import {
  assetConfigAbi,
  disputeModuleAbi,
  exitRightAbi,
  gatedMorphoOracleAbi,
  gatedPayoutAbi,
  guardedVaultAbi,
  liabilityLedgerAbi,
  mockStockAbi,
  reserveSamplerAbi,
  solvencyOracleAbi,
} from "./abis";
import { ASSET_META, NETWORKS, type AssetKind, type NetworkKey } from "./deployments";
import { reasonLabel } from "./reasons";
import { RPC_URLS } from "./rpc";

/** A token amount: the raw integer as a string (JSON-safe) and its human value. */
export type Amount = { raw: string; value: number };

export type AssetRisk = {
  kind: AssetKind;
  label: string;
  address: Address;
  /** False when no epoch was ever committed for this asset on this chain. */
  published: boolean;
  status: { ok: boolean; reason: number; reasonLabel: string; epochId: number; updatedAt: number } | null;
  coverage: {
    totalLiability: Amount;
    allocation: Amount;
    live: Amount | null;
    sampleMin: Amount | null;
    samples: number;
    minSamples: number;
    effective: Amount | null;
    floorBps: number;
    coverageBps: number | null;
    /** Reserves the oracle requires: allocation x floor. */
    need: Amount;
    /** How far effective reserves can fall before the proof fails (negative when already short). */
    headroom: Amount | null;
    headroomBps: number | null;
  } | null;
  staleness: {
    committedAt: number;
    maxOracleAge: number;
    staleAt: number;
    nextPublish: number;
    /** staleAt - nextPublish; negative means the next scheduled publish lands after the proof is stale. */
    marginSec: number;
  } | null;
  disputes: {
    isDisputed: boolean;
    openDisputes: number;
    equivocated: boolean;
    openChallenges: number;
    queueLength: number;
    overdue: boolean;
    challengeWindowSec: number;
  } | null;
  exit: { exitDefault: boolean; openClaims: number; nextDeadline: number | null } | null;
  isStockToken: boolean;
  /** Which token contract this is, in plain words (demo mock, testnet token, ...). */
  identity: string;
  /** ERC-8056 multipliers, for stock tokens with a published epoch. */
  multiplier: {
    live: number | null;
    committed: number | null;
    pending: number | null;
    effectiveAt: number | null;
    /** live differs from the epoch's snapshot, or a getter reverts: the oracle returns MULTIPLIER_DRIFT now. */
    drift: boolean;
    /** effectiveAt is in the future with a different new multiplier: also MULTIPLIER_DRIFT now. */
    pendingChange: boolean;
  } | null;
};

const IDENTITY: Record<AssetKind, string> = {
  stock: "Mock ERC-8056 stock token we deployed for the demo (same getters as a Robinhood Stock Token)",
  usdg: "Paxos test USDG on this testnet (mainnet USDG is 0x5fc5…d168)",
  tsla: "Robinhood's testnet TSLA (the official asset registry lists mainnet contracts only)",
};

export type ConsumerKind = "payout" | "lendWithdraw" | "vault" | "morpho";

export type ConsumerRisk = {
  kind: ConsumerKind;
  name: string;
  address: Address;
  gatedAsset: AssetKind | null;
  gatedLabel: string;
  state: "open" | "frozen" | "unknown";
  reasonLabel: string | null;
  freezes: string[];
  staysOpen: string[];
  exposure: { label: string; value: string }[];
  morpho?: {
    /** Price per whole collateral token in loan-token units, or null while price() reverts. */
    price: number | null;
    basePrice: number | null;
    revert: string | null;
    phase: "open" | "frozen-unpoked" | "frozen" | "discounted";
    running: boolean;
    startedAt: number;
    capEndsAt: number;
    voidAt: number;
    maxFreezeSec: number;
    maxPokeGapSec: number;
    postCapBps: number;
  };
};

export type FreezeTrigger = { asset: string; text: string; at: number | null; active: boolean; consumers: string[] };

export type RiskReport = {
  network: NetworkKey;
  label: string;
  chainId: number;
  explorer: string | null;
  block: number | null;
  readAt: number;
  custodianId: string;
  assets: AssetRisk[];
  consumers: ConsumerRisk[];
  triggers: FreezeTrigger[];
  errors: string[];
};

// The ops-epoch workflow cron ("0 2 */3 * *"): days 1, 4, 7, ... 31 of each month at 02:00 UTC.
export function nextCronRun(nowSec: number): number {
  const d = new Date(nowSec * 1000);
  for (let i = 0; i < 40; i++) {
    const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + i, 2, 0, 0);
    if ((new Date(t).getUTCDate() - 1) % 3 === 0 && t / 1000 > nowSec) return t / 1000;
  }
  return nowSec + 3 * 86400;
}

const BPS = BigInt(10_000);
const ZERO = BigInt(0);
const EXIT_SCAN = 50;
const ORACLE_PRICE_ABI = parseAbi(["function price() view returns (uint256)"]);
const ERC8056_ABI = parseAbi([
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
]);
const mul = (x: bigint | null) => (x === null ? null : Number(formatUnits(x, 18)));

function amt(raw: bigint, decimals: number): Amount {
  return { raw: raw.toString(), value: Number(formatUnits(raw, decimals)) };
}

function fmt(n: number, max = 2) {
  return n.toLocaleString("en-US", { maximumFractionDigits: max });
}

function utc(sec: number) {
  return new Date(sec * 1000).toUTCString().slice(5, 22) + " UTC";
}

function errMsg(e: unknown) {
  const m = e instanceof BaseError ? e.shortMessage : (e as Error)?.message ?? String(e);
  return m.split("\n")[0].slice(0, 160);
}

/** `Insolvent (REASON)` for a SolvencyGuard revert, otherwise the error name or message. */
function revertText(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError && r.data?.errorName) {
      if (r.data.errorName === "Insolvent" && r.data.args?.length) {
        return `Insolvent (${reasonLabel(Number(r.data.args[0]))})`;
      }
      return r.data.errorName;
    }
  }
  return errMsg(e);
}

export async function loadRisk(key: NetworkKey): Promise<RiskReport> {
  const net = NETWORKS[key];
  const dep = net.deployment;
  if (!dep || key === "localhost") throw new Error(`no deployment for ${key}`);
  const client = createPublicClient({ transport: http(RPC_URLS[key as keyof typeof RPC_URLS]) });
  const c = dep.contracts;
  const cid = dep.custodianId;
  const errors: string[] = [];
  const nowSec = Math.floor(Date.now() / 1000);

  async function read<T>(label: string, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) {
    try {
      return (await client.readContract({ address, abi, functionName, args })) as T;
    } catch (e) {
      errors.push(`${label}: ${errMsg(e)}`);
      return null;
    }
  }

  const block = await client.getBlockNumber().then(Number, (e) => {
    errors.push(`block: ${errMsg(e)}`);
    return null;
  });

  const kinds: [AssetKind, Address | undefined][] = [
    ["stock", c.MockStockToken],
    ["usdg", c.USDG],
    ["tsla", c.TSLA],
  ];

  const nextClaimId = await read<bigint>("ExitRight.nextClaimId", c.ExitRight, exitRightAbi, "nextClaimId");
  type Claim = { custodianId: string; asset: Address; deadline: bigint; open: boolean; settled: boolean; slashed: boolean };
  const claims: Claim[] = [];
  if (nextClaimId !== null) {
    const n = Number(nextClaimId);
    const ids = Array.from({ length: Math.min(n, EXIT_SCAN) }, (_, i) => n - 1 - i);
    const rows = await Promise.all(
      ids.map((id) => read<readonly unknown[]>(`ExitRight.claims(${id})`, c.ExitRight, exitRightAbi, "claims", [BigInt(id)]))
    );
    for (const r of rows) {
      if (!r) continue;
      claims.push({
        custodianId: r[0] as string,
        asset: r[2] as Address,
        deadline: r[6] as bigint,
        open: r[7] as boolean,
        settled: r[8] as boolean,
        slashed: r[9] as boolean,
      });
    }
  }

  async function assetRisk(kind: AssetKind, address: Address): Promise<AssetRisk> {
    const label = ASSET_META[kind].label;
    const decimals = ASSET_META[kind].decimals;
    const args = [cid, address] as const;
    const [statusRaw, epochId, cfg] = await Promise.all([
      read<{ ok: boolean; epochId: bigint; updatedAt: bigint; reason: number }>(`${label} status`, c.SolvencyOracle, solvencyOracleAbi, "status", args),
      read<bigint>(`${label} latestEpochId`, c.LiabilityLedger, liabilityLedgerAbi, "latestEpochId", args),
      read<{ coverageFloorBps: number; maxOracleAge: bigint; minSamples: number; isStockToken: boolean }>(
        `${label} config`, c.AssetConfig, assetConfigAbi, "getConfig", args
      ),
    ]);
    const status = statusRaw
      ? {
          ok: statusRaw.ok,
          reason: Number(statusRaw.reason),
          reasonLabel: reasonLabel(Number(statusRaw.reason)),
          epochId: Number(statusRaw.epochId),
          updatedAt: Number(statusRaw.updatedAt),
        }
      : null;
    const published = epochId !== null && epochId > ZERO;
    const base: AssetRisk = {
      kind,
      label,
      address,
      published,
      status,
      coverage: null,
      staleness: null,
      disputes: null,
      exit: null,
      isStockToken: Boolean(cfg?.isStockToken),
      identity: IDENTITY[kind],
      multiplier: null,
    };
    if (!published || !epochId) return base;

    const [epoch, live, sMin, effective, isDisputed, openDisputes, equivocated, openChallenges, queueLength, overdue, windowSec, exitDefault] =
      await Promise.all([
        read<{ totalLiability: bigint; allocation: bigint; committedAt: bigint; multiplierSnapshot: bigint }>(`${label} epoch`, c.LiabilityLedger, liabilityLedgerAbi, "getEpoch", [...args, epochId]),
        read<bigint>(`${label} liveReserves`, c.ReserveSampler, reserveSamplerAbi, "liveReserves", args),
        read<readonly [bigint, bigint]>(`${label} sampleMin`, c.ReserveSampler, reserveSamplerAbi, "sampleMin", [...args, epochId]),
        read<bigint>(`${label} effectiveReserves`, c.ReserveSampler, reserveSamplerAbi, "effectiveReserves", [...args, epochId]),
        read<boolean>(`${label} isDisputed`, c.DisputeModule, disputeModuleAbi, "isDisputed", args),
        read<bigint>(`${label} openDisputeCount`, c.DisputeModule, disputeModuleAbi, "openDisputeCount", args),
        read<boolean>(`${label} equivocationPermanent`, c.DisputeModule, disputeModuleAbi, "equivocationPermanent", args),
        read<bigint>(`${label} openChallengeCount`, c.DisputeModule, disputeModuleAbi, "openChallengeCount", args),
        read<bigint>(`${label} challengeQueueLength`, c.DisputeModule, disputeModuleAbi, "challengeQueueLength", args),
        read<boolean>(`${label} hasOverdueChallenge`, c.DisputeModule, disputeModuleAbi, "hasOverdueChallenge", args),
        read<bigint>("challengeWindow", c.DisputeModule, disputeModuleAbi, "challengeWindow"),
        read<boolean>(`${label} hasExitDefault`, c.ExitRight, exitRightAbi, "hasExitDefault", args),
      ]);

    if (epoch && cfg) {
      const floorBps = Number(cfg.coverageFloorBps);
      const need = (epoch.allocation * BigInt(floorBps)) / BPS;
      const samples = sMin ? Number(sMin[1]) : 0;
      const eff = effective ?? null;
      base.coverage = {
        totalLiability: amt(epoch.totalLiability, decimals),
        allocation: amt(epoch.allocation, decimals),
        live: live !== null ? amt(live, decimals) : null,
        sampleMin: sMin && samples > 0 ? amt(sMin[0], decimals) : null,
        samples,
        minSamples: Number(cfg.minSamples),
        effective: eff !== null ? amt(eff, decimals) : null,
        floorBps,
        coverageBps: eff !== null && epoch.allocation > ZERO ? Number((eff * BPS) / epoch.allocation) : null,
        need: amt(need, decimals),
        headroom: eff !== null ? amt(eff - need, decimals) : null,
        headroomBps: eff !== null && eff > ZERO ? Number(((eff - need) * BPS) / eff) : null,
      };
      const committedAt = Number(epoch.committedAt);
      const maxOracleAge = Number(cfg.maxOracleAge);
      const staleAt = committedAt + maxOracleAge;
      const nextPublish = nextCronRun(nowSec);
      base.staleness = { committedAt, maxOracleAge, staleAt, nextPublish, marginSec: staleAt - nextPublish };
    }

    if (base.isStockToken) {
      const [liveMul, newMul, effAt] = await Promise.all([
        read<bigint>(`${label} uiMultiplier`, address, ERC8056_ABI, "uiMultiplier"),
        read<bigint>(`${label} newUIMultiplier`, address, ERC8056_ABI, "newUIMultiplier"),
        read<bigint>(`${label} effectiveAt`, address, ERC8056_ABI, "effectiveAt"),
      ]);
      const snapshot = epoch ? epoch.multiplierSnapshot : null;
      const pendingChange =
        effAt !== null && Number(effAt) > nowSec && newMul !== null && newMul !== ZERO && newMul !== liveMul;
      base.multiplier = {
        live: mul(liveMul),
        committed: mul(snapshot),
        pending: newMul !== null && newMul !== ZERO ? mul(newMul) : null,
        effectiveAt: effAt !== null && effAt > ZERO ? Number(effAt) : null,
        drift: liveMul === null || newMul === null || effAt === null || (snapshot !== null && liveMul !== snapshot),
        pendingChange,
      };
    }

    base.disputes = {
      isDisputed: Boolean(isDisputed),
      openDisputes: Number(openDisputes ?? 0),
      equivocated: Boolean(equivocated),
      openChallenges: Number(openChallenges ?? 0),
      queueLength: Number(queueLength ?? 0),
      overdue: Boolean(overdue),
      challengeWindowSec: Number(windowSec ?? 0),
    };

    const mine = claims.filter(
      (cl) =>
        cl.custodianId.toLowerCase() === cid.toLowerCase() &&
        cl.asset.toLowerCase() === address.toLowerCase() &&
        cl.open &&
        !cl.settled &&
        !cl.slashed
    );
    base.exit = {
      exitDefault: Boolean(exitDefault),
      openClaims: mine.length,
      nextDeadline: mine.length ? Math.min(...mine.map((cl) => Number(cl.deadline))) : null,
    };
    return base;
  }

  const assets = await Promise.all(
    kinds.filter((k): k is [AssetKind, Address] => Boolean(k[1])).map(([kind, addr]) => assetRisk(kind, addr))
  );

  const kindOf = (addr: Address | null): AssetKind | null => {
    if (!addr) return null;
    const hit = kinds.find(([, a]) => a && a.toLowerCase() === addr.toLowerCase());
    return hit ? hit[0] : null;
  };
  const assetState = (k: AssetKind | null) => {
    const a = assets.find((x) => x.kind === k);
    if (!a?.status) return { state: "unknown" as const, reason: null };
    return { state: a.status.ok ? ("open" as const) : ("frozen" as const), reason: a.status.ok ? null : a.status.reasonLabel };
  };
  const tokenAmount = async (token: Address, holder: Address, decimals: number, label: string) => {
    const b = await read<bigint>(`${label} balance`, token, mockStockAbi, "balanceOf", [holder]);
    return b === null ? "—" : fmt(Number(formatUnits(b, decimals)));
  };

  const consumers: ConsumerRisk[] = [];

  for (const [kind, name, addr] of [
    ["payout", "GatedPayout", c.GatedPayout],
    ["lendWithdraw", "GatedLendWithdraw", c.GatedLendWithdraw],
  ] as [ConsumerKind, string, Address | undefined][]) {
    if (!addr) continue;
    const gated = kindOf(await read<Address>(`${name}.asset`, addr, gatedPayoutAbi, "asset"));
    const s = assetState(gated);
    const label = gated ? ASSET_META[gated].label : "?";
    const held = gated ? await tokenAmount(kinds.find((k) => k[0] === gated)![1]!, addr, ASSET_META[gated].decimals, name) : "—";
    consumers.push({
      kind,
      name,
      address: addr,
      gatedAsset: gated,
      gatedLabel: label,
      state: s.state,
      reasonLabel: s.reason,
      freezes: kind === "payout" ? ["payout"] : ["withdraw"],
      staysOpen: ["deposit"],
      exposure: [{ label: `${label} held`, value: held }],
    });
  }

  if (c.GuardedLendingVault) {
    const v = c.GuardedLendingVault;
    const [collateral, loanToken, totalBorrowed, liquidity] = await Promise.all([
      read<Address>("vault.collateral", v, guardedVaultAbi, "collateral"),
      read<Address>("vault.loanToken", v, guardedVaultAbi, "loanToken"),
      read<bigint>("vault.totalBorrowed", v, guardedVaultAbi, "totalBorrowed"),
      read<bigint>("vault.availableLiquidity", v, guardedVaultAbi, "availableLiquidity"),
    ]);
    const gated = kindOf(collateral);
    const s = assetState(gated);
    const loanDecimals = 6;
    const loanLabel = loanToken && c.VaultLoanToken && loanToken.toLowerCase() === c.VaultLoanToken.toLowerCase() ? "USDG (vault mock)" : "USDG";
    const exposure = [
      { label: `${loanLabel} borrowed`, value: totalBorrowed === null ? "—" : fmt(Number(formatUnits(totalBorrowed, loanDecimals))) },
      { label: `${loanLabel} liquidity`, value: liquidity === null ? "—" : fmt(Number(formatUnits(liquidity, loanDecimals))) },
    ];
    if (collateral) {
      const posted = await read<bigint>("vault collateral held", collateral, mockStockAbi, "balanceOf", [v]);
      if (posted !== null && gated) {
        exposure.push({ label: `${ASSET_META[gated].label} collateral`, value: fmt(Number(formatUnits(posted, ASSET_META[gated].decimals))) });
      }
    }
    consumers.push({
      kind: "vault",
      name: "GuardedLendingVault",
      address: v,
      gatedAsset: gated,
      gatedLabel: gated ? ASSET_META[gated].label : "?",
      state: s.state,
      reasonLabel: s.reason,
      freezes: ["borrow", "withdrawCollateral while in debt"],
      staysOpen: ["supply", "withdrawSupply", "depositCollateral", "repay", "debt-free withdrawCollateral"],
      exposure,
    });
  }

  if (c.SolvencyGatedMorphoOracle) {
    const w = c.SolvencyGatedMorphoOracle;
    const [gatedAddr, baseOracle, fs, maxFreeze, maxPokeGap, postCapBps] = await Promise.all([
      read<Address>("wrapper.asset", w, gatedMorphoOracleAbi, "asset"),
      read<Address>("wrapper.baseOracle", w, gatedMorphoOracleAbi, "baseOracle"),
      read<readonly [boolean, bigint, bigint, bigint]>("wrapper.freezeState", w, gatedMorphoOracleAbi, "freezeState"),
      read<number | bigint>("wrapper.maxFreeze", w, gatedMorphoOracleAbi, "maxFreeze"),
      read<number | bigint>("wrapper.maxPokeGap", w, gatedMorphoOracleAbi, "maxPokeGap"),
      read<number | bigint>("wrapper.postCapBps", w, gatedMorphoOracleAbi, "postCapBps"),
    ]);
    const gated = kindOf(gatedAddr);
    const s = assetState(gated);
    const collDecimals = gated ? ASSET_META[gated].decimals : 18;
    // Morpho prices are loan units per collateral unit x 1e36; the loan token (USDG) has 6 decimals.
    const perWhole = (p: bigint) => Number(formatUnits(p, 36 - collDecimals + 6));
    let price: number | null = null;
    let revert: string | null = null;
    try {
      price = perWhole((await client.readContract({ address: w, abi: gatedMorphoOracleAbi, functionName: "price" })) as bigint);
    } catch (e) {
      revert = revertText(e);
    }
    const basePriceRaw = baseOracle ? await read<bigint>("base oracle price", baseOracle, ORACLE_PRICE_ABI, "price") : null;
    const running = Boolean(fs?.[0]);
    const capEndsAt = fs ? Number(fs[2]) : 0;
    const phase: NonNullable<ConsumerRisk["morpho"]>["phase"] =
      s.state === "open" ? "open" : !running ? "frozen-unpoked" : nowSec >= capEndsAt ? "discounted" : "frozen";
    const label = gated ? ASSET_META[gated].label : "?";
    consumers.push({
      kind: "morpho",
      name: "SolvencyGatedMorphoOracle",
      address: w,
      gatedAsset: gated,
      gatedLabel: label,
      state: s.state,
      reasonLabel: s.reason,
      freezes: ["Morpho borrow", "withdrawCollateral while in debt", "liquidate (until the cap)"],
      staysOpen: ["supply", "withdraw", "supplyCollateral", "repay", "debt-free withdrawCollateral"],
      exposure: [
        { label: "price()", value: price !== null ? `${fmt(price, 4)} USDG/${label}` : revert ?? "reverts" },
      ],
      morpho: {
        price,
        basePrice: basePriceRaw !== null ? perWhole(basePriceRaw) : null,
        revert,
        phase,
        running,
        startedAt: fs ? Number(fs[1]) : 0,
        capEndsAt,
        voidAt: fs ? Number(fs[3]) : 0,
        maxFreezeSec: Number(maxFreeze ?? 0),
        maxPokeGapSec: Number(maxPokeGap ?? 0),
        postCapBps: Number(postCapBps ?? 0),
      },
    });
  }

  const triggers: FreezeTrigger[] = [];
  for (const a of assets) {
    const gatedBy = consumers.filter((x) => x.gatedAsset === a.kind).map((x) => x.name);
    if (!a.published || gatedBy.length === 0) continue;
    const push = (text: string, at: number | null, active: boolean) =>
      triggers.push({ asset: a.label, text, at, active, consumers: gatedBy });
    if (a.status && !a.status.ok) push(`Failing now: ${a.status.reasonLabel}`, null, true);
    const cov = a.coverage;
    if (cov?.effective && cov.headroom) {
      const floor = `${fmt(cov.need.value)} (${fmt(cov.floorBps / 100, 1)}% of the ${fmt(cov.allocation.value)} owed here)`;
      push(
        cov.headroom.value < 0
          ? `${a.label} reserves ${fmt(cov.effective.value)} are below the required ${floor}`
          : `${a.label} reserves drop ${cov.headroomBps !== null ? `more than ${fmt(cov.headroomBps / 100, 1)}%` : ""}, from ${fmt(cov.effective.value)} to below ${floor}`,
        null,
        cov.headroom.value < 0
      );
    }
    if (a.staleness) {
      push(`No new epoch by ${utc(a.staleness.staleAt)} (STALE)`, a.staleness.staleAt, nowSec >= a.staleness.staleAt);
    }
    if (a.disputes) {
      const d = a.disputes;
      const hours = fmt(d.challengeWindowSec / 3600, 1);
      push(
        d.openChallenges > 0
          ? `${d.openChallenges} open balance challenge(s) left unanswered past the ${hours} h window (DISPUTED)`
          : `Any balance challenge left unanswered for ${hours} h, or a proven equivocation (DISPUTED)`,
        null,
        d.overdue || d.isDisputed || d.equivocated
      );
    }
    if (a.exit) {
      push(
        a.exit.nextDeadline
          ? `ExitRight claim unsettled by ${utc(a.exit.nextDeadline)} (EXIT_DEFAULT, permanent)`
          : "Any ExitRight claim left unsettled past its deadline (EXIT_DEFAULT, permanent)",
        a.exit.nextDeadline,
        a.exit.exitDefault
      );
    }
    const m = a.multiplier;
    if (m?.drift) {
      push(
        m.live === null
          ? `${a.label} ERC-8056 getters revert (MULTIPLIER_DRIFT)`
          : `${a.label} uiMultiplier is ${m.live}, but the epoch committed ${m.committed ?? "?"} (MULTIPLIER_DRIFT until the custodian recommits)`,
        null,
        true
      );
    } else if (m?.pendingChange && m.effectiveAt) {
      push(
        `${a.label} multiplier change ${m.live} → ${m.pending} scheduled for ${utc(m.effectiveAt)} (MULTIPLIER_DRIFT from now until the custodian recommits after it)`,
        m.effectiveAt,
        true
      );
    } else if (a.isStockToken) {
      push(
        `${a.label} schedules a split or multiplier change (newUIMultiplier with a future effectiveAt) before the next epoch (MULTIPLIER_DRIFT)`,
        null,
        false
      );
    }
  }

  return {
    network: key,
    label: net.label,
    chainId: dep.chainId,
    explorer: net.explorer ?? null,
    block,
    readAt: nowSec,
    custodianId: cid,
    assets,
    consumers,
    triggers,
    errors,
  };
}
