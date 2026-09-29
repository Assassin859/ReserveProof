import { createPublicClient, formatUnits, http, type Address, type Hex } from "viem";
import forkDrillJson from "../deployments/fork-drill.json";
import { readLatestEpoch } from "./balance";
import { ASSET_META, GITHUB_URL, NETWORKS } from "./deployments";
import { SITE_STATS } from "./mainnet";
import { loadRisk, type RiskReport } from "./risk";
import { RPC_URLS } from "./rpc";
import { dur, errMsg, hourCells, repoRuns, utc, type RunInfo } from "./status";
import { checkVerified, type VerifiedReport } from "./verified";

export type ClaimState = "pass" | "fail" | "unknown";

export type Claim = {
  id: string;
  title: string;
  state: ClaimState;
  evidence: string[];
  /** Shown on every render, whatever the state (e.g. "fork-only"). */
  note?: string;
  links: { label: string; href: string }[];
  reproduce: string;
};

export type VerifyReport = { readAt: number; claims: Claim[]; errors: string[] };

export type ForkDrill = {
  ranAt: string;
  forkBlock: number;
  rpcHost: string;
  morpho: string;
  token: string;
  baseOracle: string;
  passed: number;
  total: number;
  checks: { step: string; check: string; ok: boolean; detail: string }[];
};

export const FORK_DRILL = forkDrillJson as ForkDrill;

type Chain = "robinhoodTestnet" | "arbitrumSepolia";
const CHAINS: Chain[] = ["robinhoodTestnet", "arbitrumSepolia"];
const RUNS_URL = `${GITHUB_URL}/actions/workflows`;
/** Ops epoch publishes every 3 days; allow a day of GitHub cron delay before calling it missed. */
const PUBLISH_WITHIN_SEC = 4 * 86400;

const client = (k: Chain) => createPublicClient({ transport: http(RPC_URLS[k]) });
const shortHex = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const pct = (bps: number) => `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
const settledValue = <T,>(r: PromiseSettledResult<T>) => (r.status === "fulfilled" ? r.value : null);

function runsOf(runs: RunInfo[] | null, file: string) {
  return (runs ?? []).filter((r) => r.path.endsWith(`/${file}`));
}

function runLine(r: RunInfo, nowSec: number) {
  const outcome = r.status === "completed" ? r.conclusion : r.status;
  return `${outcome}, ${utc(r.createdAt)} (${dur(nowSec - r.createdAt)} ago, ${r.event === "schedule" ? "scheduled" : r.event === "workflow_dispatch" ? "manual" : r.event})`;
}

function testsClaim(runs: RunInfo[] | null, nowSec: number): Claim {
  const t = SITE_STATS.tests;
  const ci = runsOf(runs, "ci.yml").filter((r) => r.branch === "master");
  const done = ci.find((r) => r.status === "completed") ?? null;
  const evidence = [`${t.total} tests: ${t.hardhat} Hardhat, ${t.foundryFuzz} Foundry fuzz, ${t.foundryUnit} Foundry unit, ${t.invariants} stateful invariants`];
  if (done) evidence.push(`Latest CI on master: ${runLine(done, nowSec)}`);
  else evidence.push(runs ? "No completed CI run on master in the latest 100 workflow runs" : "GitHub run history unavailable");
  if (ci[0] && ci[0] !== done) evidence.push("A newer CI run is in progress");
  return {
    id: "tests",
    title: `${t.total} tests pass in CI`,
    state: !done ? "unknown" : done.conclusion === "success" ? "pass" : "fail",
    evidence,
    links: [
      ...(done ? [{ label: "CI run", href: done.url }] : []),
      { label: "CI workflow", href: `${RUNS_URL}/ci.yml` },
    ],
    reproduce: "npm ci\nnpm test              # Hardhat\nforge install foundry-rs/forge-std --no-git\nforge install morpho-org/morpho-blue@v1.0.0 --no-git\nforge test            # fuzz, unit, invariants, real Morpho Blue\nnpm run test:count    # the breakdown",
  };
}

function contractsClaim(reports: (VerifiedReport | null)[]): Claim {
  const evidence: string[] = [];
  let state: ClaimState = "pass";
  CHAINS.forEach((k, i) => {
    const r = reports[i];
    const label = NETWORKS[k].label;
    if (!r) {
      state = state === "fail" ? "fail" : "unknown";
      evidence.push(`${label}: explorer check unavailable`);
      return;
    }
    const where = r.source === "blockscout" ? "Blockscout" : "Sourcify";
    evidence.push(
      `${label}: ${r.verified} of ${r.total} verified on ${where}` +
        (r.unverified.length ? `; not verified: ${r.unverified.join(", ")}` : "") +
        (r.unknown ? `; ${r.unknown} could not be checked right now` : "")
    );
    if (r.unverified.length) state = "fail";
    else if (r.unknown && state === "pass") state = "unknown";
  });
  return {
    id: "contracts",
    title: "Every contract is source-verified on both chains",
    state,
    evidence,
    links: [
      { label: "Robinhood address book", href: `${GITHUB_URL}/blob/master/deployments/robinhoodTestnet.json` },
      { label: "Arbitrum address book", href: `${GITHUB_URL}/blob/master/deployments/arbitrumSepolia.json` },
      { label: "Sourcify (Arbitrum)", href: `https://repo.sourcify.dev/421614/${NETWORKS.arbitrumSepolia.deployment!.contracts.SolvencyOracle}` },
    ],
    reproduce: "npm run verify:rh         # Blockscout, Robinhood testnet\nnpm run verify:sourcify   # Sourcify, Arbitrum Sepolia",
  };
}

function proofsClaim(risks: (RiskReport | null)[], nowSec: number): Claim {
  const evidence: string[] = [];
  let state: ClaimState = "pass";
  CHAINS.forEach((k, i) => {
    const r = risks[i];
    if (!r) {
      if (state === "pass") state = "unknown";
      evidence.push(`${NETWORKS[k].label}: could not read the chain`);
      return;
    }
    for (const a of r.assets.filter((x) => x.published)) {
      const ok = Boolean(a.status?.ok);
      if (!ok) state = "fail";
      const cov = a.coverage?.coverageBps != null ? `, coverage ${pct(a.coverage.coverageBps)} vs ${pct(a.coverage.floorBps)} floor` : "";
      const stale = a.staleness ? `, stale in ${dur(a.staleness.staleAt - nowSec)}` : "";
      evidence.push(`${r.label} ${a.label}: ${ok ? `solvent, epoch ${a.status!.epochId}` : `failing (${a.status?.reasonLabel ?? "unreadable"})`}${cov}${stale}`);
    }
  });
  return {
    id: "proofs",
    title: "Every published proof is live and solvent",
    state,
    evidence,
    links: [
      { label: "Curator risk view", href: "/risk" },
      { label: "Status page", href: "/status" },
    ],
    reproduce: "npm run status:rh\nnpm run status:arb",
  };
}

async function sameRootClaim(): Promise<Claim> {
  const reads = await Promise.allSettled(
    CHAINS.map((k) => {
      const dep = NETWORKS[k].deployment!;
      return readLatestEpoch(client(k), dep.contracts.LiabilityLedger, dep.custodianId, dep.contracts.MockStockToken as Address);
    })
  );
  const [rh, arb] = reads.map(settledValue);
  const dep = NETWORKS.robinhoodTestnet.deployment!;
  const cast = (k: Chain) =>
    `cast call ${NETWORKS[k].deployment!.contracts.LiabilityLedger} "latestEpochId(bytes32,address)(uint256)" ${NETWORKS[k].deployment!.custodianId} ${NETWORKS[k].deployment!.contracts.MockStockToken} --rpc-url ${RPC_URLS[k]}`;
  const base = {
    id: "same-root",
    title: "The same mTSLA liability root is committed on both chains",
    links: CHAINS.map((k) => ({
      label: `${NETWORKS[k].label} ledger`,
      href: `${NETWORKS[k].explorer}/address/${NETWORKS[k].deployment!.contracts.LiabilityLedger}`,
    })),
    reproduce: `${cast("robinhoodTestnet")}\n${cast("arbitrumSepolia")}\n# then getEpoch(bytes32,address,uint256) on each and compare the first field (the root)`,
  };
  if (!rh?.ep || !arb?.ep) {
    return { ...base, state: "unknown", evidence: ["Could not read the latest mTSLA epoch on both chains"] };
  }
  if (rh.latest !== arb.latest) {
    return {
      ...base,
      state: "unknown",
      evidence: [`Epochs differ right now (Robinhood ${rh.latest}, Arbitrum ${arb.latest}); a publish is probably mid-cycle`],
    };
  }
  const same = rh.ep.liabilityRoot.toLowerCase() === arb.ep.liabilityRoot.toLowerCase() && rh.ep.totalLiability === arb.ep.totalLiability;
  return {
    ...base,
    state: same ? "pass" : "fail",
    evidence: [
      `Epoch ${rh.latest} on both chains, custodian ${shortHex(dep.custodianId)}`,
      `Robinhood root ${shortHex(rh.ep.liabilityRoot)}, Arbitrum root ${shortHex(arb.ep.liabilityRoot)}${same ? " (identical, same total)" : ""}`,
    ],
  };
}

function consumersClaim(risks: (RiskReport | null)[]): Claim {
  const evidence: string[] = [];
  let state: ClaimState = "pass";
  CHAINS.forEach((k, i) => {
    const r = risks[i];
    if (!r) {
      if (state === "pass") state = "unknown";
      evidence.push(`${NETWORKS[k].label}: could not read the chain`);
      return;
    }
    const open = r.consumers.filter((c) => c.state === "open");
    const frozen = r.consumers.filter((c) => c.state === "frozen");
    if (frozen.length) state = "fail";
    else if (open.length < r.consumers.length && state === "pass") state = "unknown";
    evidence.push(
      `${r.label}: ${open.length} of ${r.consumers.length} open (${r.consumers.map((c) => c.name).join(", ")})` +
        (frozen.length ? `; frozen: ${frozen.map((c) => `${c.name} (${c.reasonLabel})`).join(", ")}` : "")
    );
  });
  evidence.push("Each one calls the oracle on chain and reverts Insolvent(reason) the moment a proof fails; the what-if simulator shows it");
  return {
    id: "consumers",
    title: "Gated integrations answer on chain and fail closed",
    state,
    evidence,
    links: [
      { label: "What-if simulator (scene 4)", href: "/" },
      { label: "SolvencyGuard source", href: `${GITHUB_URL}/blob/master/src/guards/SolvencyGuard.sol` },
    ],
    reproduce: "npm run whatif:check:rh\nnpm run whatif:check:arb\nforge test --match-path test/foundry/MorphoIntegration.t.sol",
  };
}

async function exitRightClaim(): Promise<Claim> {
  const rec = NETWORKS.robinhoodTestnet.books.exitright;
  const explorer = NETWORKS.robinhoodTestnet.explorer!;
  const base = {
    id: "exitright",
    title: "An ExitRight claim was opened and settled on chain",
    reproduce: rec
      ? `cast receipt ${rec.txs.openClaim} --rpc-url ${RPC_URLS.robinhoodTestnet}\ncast receipt ${rec.txs.settle} --rpc-url ${RPC_URLS.robinhoodTestnet}`
      : "npm run exitright:demo",
  };
  if (!rec?.txs.openClaim || !rec.txs.settle) {
    return { ...base, state: "unknown", evidence: ["No ExitRight record in the deployment files"], links: [] };
  }
  const c = client("robinhoodTestnet");
  const [open, settle] = (
    await Promise.allSettled([rec.txs.openClaim, rec.txs.settle].map((h) => c.getTransactionReceipt({ hash: h as Hex })))
  ).map(settledValue);
  const ok = open?.status === "success" && settle?.status === "success";
  return {
    ...base,
    state: !open || !settle ? "unknown" : ok ? "pass" : "fail",
    evidence: [
      `Claim #${rec.claimId}: ${formatUnits(BigInt(rec.amount), ASSET_META.stock.decimals)} ${ASSET_META.stock.label} for ${shortHex(rec.user)}, epoch ${rec.epochId}, bonded by the custodian`,
      `openClaim ${open ? `${open.status} in block ${open.blockNumber}` : "receipt unavailable"}; settle ${settle ? `${settle.status} in block ${settle.blockNumber}` : "receipt unavailable"}`,
    ],
    links: [
      { label: "openClaim tx", href: `${explorer}/tx/${rec.txs.openClaim}` },
      { label: "settle tx", href: `${explorer}/tx/${rec.txs.settle}` },
    ],
  };
}

function scheduleClaim(risks: (RiskReport | null)[], runs: RunInfo[] | null, nowSec: number): Claim {
  const evidence: string[] = [];
  let state: ClaimState = "pass";
  let newest = 0;
  risks.forEach((r, i) => {
    if (!r) {
      if (state === "pass") state = "unknown";
      evidence.push(`${NETWORKS[CHAINS[i]].label}: could not read the chain`);
      return;
    }
    for (const a of r.assets.filter((x) => x.published && x.staleness)) {
      const age = nowSec - a.staleness!.committedAt;
      newest = Math.max(newest, a.staleness!.committedAt);
      if (age > PUBLISH_WITHIN_SEC) {
        state = "fail";
        evidence.push(`${r.label} ${a.label}: last committed ${dur(age)} ago, longer than the 3-day cadence allows`);
      }
    }
  });
  if (newest) evidence.unshift(`Latest on-chain commit ${dur(nowSec - newest)} ago; every published proof was re-committed within the last 4 days (cadence 3 days, stale after 7)`);
  const ops = runsOf(runs, "ops-epoch.yml");
  if (ops[0]) evidence.push(`Ops epoch workflow: ${runLine(ops[0], nowSec)}`);
  const watch = runsOf(runs, "watchtower.yml");
  if (runs) {
    const ran = hourCells(watch, nowSec).filter((h) => h.state !== "none").length;
    evidence.push(`Watchtower: ${ran} of the last 48 hourly slots ran (GitHub starts scheduled runs best-effort, often late)`);
  }
  return {
    id: "schedule",
    title: "Proofs are re-published on schedule",
    state,
    evidence,
    links: [
      { label: "Ops epoch runs", href: `${RUNS_URL}/ops-epoch.yml` },
      { label: "Watchtower runs", href: `${RUNS_URL}/watchtower.yml` },
      { label: "Status page", href: "/status" },
    ],
    reproduce: "npm run ops:cycle:rh     # needs the deployer key\nnpm run watch:rh         # WATCH_ACT=0 for read-only",
  };
}

function forkClaim(runs: RunInfo[] | null, nowSec: number): Claim {
  const d = FORK_DRILL;
  const drills = runsOf(runs, "fork-drill.yml").slice(0, 5);
  const lastDone = drills.find((r) => r.status === "completed") ?? null;
  const artifactOk = d.passed === d.total;
  const state: ClaimState = !artifactOk || (lastDone && lastDone.conclusion !== "success") ? "fail" : "pass";
  const evidence = [
    `${d.passed} of ${d.total} checks passed on a fork of Robinhood Chain mainnet block ${d.forkBlock.toLocaleString("en-US")} (recorded ${d.ranAt.slice(0, 10)}): the real TSLA token, its real TSLA/USDG oracle and the real Morpho Blue`,
    lastDone ? `Daily drill in CI: ${runLine(lastDone, nowSec)}` : runs ? "Daily drill in CI: no run yet" : "Daily drill in CI: GitHub run history unavailable",
  ];
  if (drills.length > 1) {
    const ok = drills.filter((r) => r.status === "completed" && r.conclusion === "success").length;
    evidence.push(`Last ${drills.length} drills: ${ok} passed`);
  }
  return {
    id: "morpho-fork",
    title: "A drained custodian freezes a real Morpho Blue market",
    state,
    note: "Fork-only today: no ReserveProof contract is deployed on Robinhood Chain mainnet yet. The drill forks the latest mainnet state in memory and broadcasts nothing.",
    evidence,
    links: [
      ...(lastDone ? [{ label: "Latest drill run", href: lastDone.url }] : []),
      { label: "Fork drill workflow", href: `${RUNS_URL}/fork-drill.yml` },
      { label: "Drill script", href: `${GITHUB_URL}/blob/master/scripts/morpho-fork-demo.ts` },
    ],
    reproduce: "npm run demo:morpho-fork        # ~45s, no keys, nothing broadcast\nFORK_JSON=drill.json npm run demo:morpho-fork   # also save every check",
  };
}

export async function loadVerify(): Promise<VerifyReport> {
  const nowSec = Math.floor(Date.now() / 1000);
  const errors: string[] = [];
  const [riskRes, verifiedRes, runsRes, sameRoot, exitRight] = await Promise.all([
    Promise.allSettled(CHAINS.map((k) => loadRisk(k))),
    Promise.allSettled(CHAINS.map((k) => checkVerified(k))),
    repoRuns(100).then(
      (r) => r,
      (e) => {
        errors.push(errMsg(e));
        return null;
      }
    ),
    sameRootClaim(),
    exitRightClaim(),
  ]);
  const risks = riskRes.map((r, i) => {
    if (r.status === "rejected") errors.push(`${NETWORKS[CHAINS[i]].label}: ${errMsg(r.reason)}`);
    return settledValue(r);
  });
  const verified = verifiedRes.map(settledValue);

  return {
    readAt: nowSec,
    claims: [
      testsClaim(runsRes, nowSec),
      contractsClaim(verified),
      proofsClaim(risks, nowSec),
      sameRoot,
      consumersClaim(risks),
      exitRight,
      scheduleClaim(risks, runsRes, nowSec),
      forkClaim(runsRes, nowSec),
    ],
    errors,
  };
}
