import { BaseError, createPublicClient, formatEther, http, parseEther, type Address } from "viem";
import { GITHUB_URL, NETWORKS, type NetworkKey } from "./deployments";
import { loadRisk, nextCronRun, type RiskReport } from "./risk";
import { RPC_URLS } from "./rpc";

export type Level = "ok" | "warn" | "down";

export type StatusComponent = {
  group: string;
  name: string;
  state: Level;
  detail: string;
  link?: string;
};

export type RunInfo = {
  id: number;
  event: string;
  status: string;
  conclusion: string | null;
  createdAt: number;
  url: string;
  /** Workflow file, e.g. ".github/workflows/ci.yml". */
  path: string;
  branch: string | null;
};

type ApiRun = {
  id: number;
  event: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  html_url: string;
  path?: string;
  head_branch?: string | null;
};

export type HourCell = {
  start: number;
  state: "success" | "failure" | "running" | "none";
  runs: number;
  url: string | null;
};

export type StatusReport = {
  readAt: number;
  overall: Level;
  reasons: string[];
  components: StatusComponent[];
  watchtower: {
    workflowUrl: string;
    last: RunInfo | null;
    nextSlot: number;
    hours: HourCell[];
    ranInWindow: number;
    runs: RunInfo[];
  } | null;
  publisher: { workflowUrl: string; runs: RunInfo[]; nextScheduled: number } | null;
  chains: { key: NetworkKey; label: string; block: number | null; explorer: string | null }[];
  errors: string[];
};

const REPO_API = "https://api.github.com/repos/Assassin859/ReserveProof";
const CHAINS: Exclude<NetworkKey, "localhost">[] = ["robinhoodTestnet", "arbitrumSepolia"];
/** Warn when a proof has less than this left before it goes STALE. */
export const WARN_STALE_SEC = 48 * 3600;
/** GitHub runs scheduled workflows best-effort, often hours late, so only warn after this long without a check. */
export const WATCH_LATE_SEC = 3 * 3600;
export const MIN_GAS_ETH = "0.001";
const HOURS = 48;

const RANK: Record<Level, number> = { ok: 0, warn: 1, down: 2 };
const worst = (a: Level, b: Level): Level => (RANK[b] > RANK[a] ? b : a);

export function errMsg(e: unknown) {
  const m = e instanceof BaseError ? e.shortMessage : (e as Error)?.message ?? String(e);
  return m.split("\n")[0].slice(0, 160);
}

export function dur(sec: number) {
  const s = Math.max(0, Math.round(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function utc(sec: number) {
  return new Date(sec * 1000).toUTCString().slice(5, 22) + " UTC";
}

async function fetchRuns(url: string, label: string): Promise<RunInfo[]> {
  const token = process.env.GITHUB_TOKEN;
  const res = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "reserveproof-status",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const left = res.headers.get("x-ratelimit-remaining");
    throw new Error(`GitHub ${label}: HTTP ${res.status}${left === "0" ? " (rate limited)" : ""}`);
  }
  const body = (await res.json()) as { workflow_runs?: ApiRun[] };
  return (body.workflow_runs ?? []).map((r) => ({
    id: r.id,
    event: r.event,
    status: r.status,
    conclusion: r.conclusion,
    createdAt: Math.floor(Date.parse(r.created_at) / 1000),
    url: r.html_url,
    path: r.path ?? "",
    branch: r.head_branch ?? null,
  }));
}

export function workflowRuns(file: string, perPage: number): Promise<RunInfo[]> {
  return fetchRuns(`${REPO_API}/actions/workflows/${file}/runs?per_page=${perPage}`, file);
}

/** The latest runs of every workflow in one request (the unauthenticated limit is 60 an hour). */
export function repoRuns(perPage = 100): Promise<RunInfo[]> {
  return fetchRuns(`${REPO_API}/actions/runs?per_page=${perPage}`, "runs");
}

function runState(r: RunInfo): HourCell["state"] {
  if (r.status !== "completed") return "running";
  return r.conclusion === "success" ? "success" : "failure";
}

export function hourCells(runs: RunInfo[], nowSec: number): HourCell[] {
  const thisHour = Math.floor(nowSec / 3600) * 3600;
  const cells: HourCell[] = [];
  for (let i = HOURS - 1; i >= 0; i--) {
    const start = thisHour - i * 3600;
    const inSlot = runs.filter((r) => r.createdAt >= start && r.createdAt < start + 3600);
    const states = inSlot.map(runState);
    const state: HourCell["state"] = states.includes("failure")
      ? "failure"
      : states.includes("success")
        ? "success"
        : states.includes("running")
          ? "running"
          : "none";
    cells.push({ start, state, runs: inSlot.length, url: inSlot[0]?.url ?? null });
  }
  return cells;
}

function nextWatchSlot(nowSec: number) {
  const hour = Math.floor(nowSec / 3600) * 3600;
  const slot = hour + 23 * 60;
  return slot > nowSec ? slot : slot + 3600;
}

function chainComponents(r: RiskReport, nowSec: number): StatusComponent[] {
  const out: StatusComponent[] = [];
  const group = r.label;
  for (const a of r.assets) {
    if (!a.published) continue;
    const link = r.explorer ? `${r.explorer}/address/${a.address}` : undefined;
    const d = a.disputes;
    const staleIn = a.staleness ? a.staleness.staleAt - nowSec : null;
    let state: Level = "ok";
    const bits: string[] = [];
    if (a.status?.ok) bits.push(`solvent, epoch ${a.status.epochId}`);
    else {
      state = worst(state, "down");
      bits.push(`failing: ${a.status?.reasonLabel ?? "unreadable"}`);
    }
    if (staleIn !== null) {
      bits.push(staleIn > 0 ? `stale in ${dur(staleIn)}` : "past its stale time");
      if (staleIn < WARN_STALE_SEC) state = worst(state, "warn");
    }
    const flag = (level: Level, text: string) => {
      state = worst(state, level);
      bits.push(text);
    };
    if (d?.equivocated) flag("down", "equivocation proven");
    if (d?.overdue) flag("down", "balance challenge overdue");
    if (a.exit?.exitDefault) flag("down", "ExitRight default");
    if (d && d.openDisputes > 0) flag("warn", `${d.openDisputes} open dispute(s)`);
    if (d && d.openChallenges > 0) flag("warn", `${d.openChallenges} open challenge(s)`);
    out.push({ group, name: `${a.label} custody proof`, state, detail: bits.join(" · "), link });
  }

  const morpho = r.consumers.find((c) => c.kind === "morpho");
  if (morpho?.morpho) {
    const m = morpho.morpho;
    out.push({
      group,
      name: "Morpho oracle wrapper",
      state: m.phase === "open" ? "ok" : "down",
      detail:
        m.phase === "open"
          ? `price() open${m.price !== null ? ` at ${m.price.toLocaleString("en-US", { maximumFractionDigits: 4 })} USDG/${morpho.gatedLabel}` : ""}`
          : m.phase === "frozen-unpoked"
            ? "reverting; no freeze clock yet"
            : m.phase === "frozen"
              ? `reverting; 50% pricing from ${utc(m.capEndsAt)}`
              : "freeze cap reached; pricing at the discounted cap",
      link: r.explorer ? `${r.explorer}/address/${morpho.address}` : undefined,
    });
  }

  const open = r.consumers.filter((c) => c.state === "open").length;
  out.push({
    group,
    name: "Gated consumers",
    state: open === r.consumers.length ? "ok" : "down",
    detail: `${open} of ${r.consumers.length} open`,
  });
  return out;
}

export async function loadStatus(): Promise<StatusReport> {
  const nowSec = Math.floor(Date.now() / 1000);
  const errors: string[] = [];

  const [riskRes, gasRes, watchRes, opsRes] = await Promise.all([
    Promise.allSettled(CHAINS.map((k) => loadRisk(k))),
    Promise.allSettled(
      CHAINS.map((k) => {
        const client = createPublicClient({ transport: http(RPC_URLS[k]) });
        return client.getBalance({ address: NETWORKS[k].deployment!.deployer as Address });
      })
    ),
    workflowRuns("watchtower.yml", 100).then(
      // A run cancelled in the deployer queue never checked anything, so it is neither a check nor a failure.
      (r) => r.filter((x) => x.conclusion !== "cancelled" && x.conclusion !== "skipped"),
      (e) => {
        errors.push(errMsg(e));
        return null;
      }
    ),
    workflowRuns("ops-epoch.yml", 10).then(
      (r) => r,
      (e) => {
        errors.push(errMsg(e));
        return null;
      }
    ),
  ]);

  const components: StatusComponent[] = [];
  const chains: StatusReport["chains"] = [];
  CHAINS.forEach((k, i) => {
    const res = riskRes[i];
    const label = NETWORKS[k].label;
    if (res.status === "fulfilled") {
      const r = res.value;
      chains.push({ key: k, label, block: r.block, explorer: r.explorer });
      components.push(...chainComponents(r, nowSec));
      errors.push(...r.errors.map((e) => `${label}: ${e}`));
    } else {
      chains.push({ key: k, label, block: null, explorer: NETWORKS[k].explorer ?? null });
      components.push({ group: label, name: "Chain reads", state: "down", detail: `could not read: ${errMsg(res.reason)}` });
    }
  });

  const opsUrl = `${GITHUB_URL}/actions/workflows/ops-epoch.yml`;
  const nextScheduled = nextCronRun(nowSec);
  if (opsRes) {
    const last = opsRes[0] ?? null;
    const lastOk = opsRes.find((r) => r.conclusion === "success") ?? null;
    const failed = last !== null && last.status === "completed" && last.conclusion !== "success";
    components.push({
      group: "Operations",
      name: "Epoch publisher (every 3 days)",
      state: failed ? "warn" : "ok",
      detail:
        (last
          ? `last run ${utc(last.createdAt)}: ${last.status === "completed" ? last.conclusion : last.status}`
          : "no runs yet") +
        (failed && lastOk ? ` · last success ${utc(lastOk.createdAt)}` : "") +
        ` · next scheduled ${utc(nextScheduled)}`,
      link: last?.url ?? opsUrl,
    });
  }

  const watchUrl = `${GITHUB_URL}/actions/workflows/watchtower.yml`;
  let watchtower: StatusReport["watchtower"] = null;
  if (watchRes) {
    const last = watchRes[0] ?? null;
    const lastDone = watchRes.find((r) => r.status === "completed") ?? null;
    const hours = hourCells(watchRes, nowSec);
    const age = last ? nowSec - last.createdAt : null;
    let state: Level = "ok";
    const bits: string[] = [];
    if (!last) {
      state = "warn";
      bits.push("no checks have run yet");
    } else {
      bits.push(`last check ${dur(age!)} ago${last.status === "completed" ? `: ${last.conclusion}` : " (running)"}`);
      if (lastDone && lastDone.conclusion !== "success") {
        state = "warn";
        if (lastDone !== last) bits.push(`last completed check: ${lastDone.conclusion}`);
      }
      if (age! > WATCH_LATE_SEC) {
        state = "warn";
        bits.push(`late: none for ${dur(age!)} (GitHub can delay scheduled runs by hours)`);
      }
    }
    components.push({ group: "Operations", name: "Watchtower (hourly)", state, detail: bits.join(" · "), link: last?.url ?? watchUrl });
    watchtower = {
      workflowUrl: watchUrl,
      last,
      nextSlot: nextWatchSlot(nowSec),
      hours,
      ranInWindow: hours.filter((h) => h.state !== "none").length,
      runs: watchRes.filter((r) => r.createdAt >= nowSec - HOURS * 3600),
    };
  }

  const minGas = parseEther(MIN_GAS_ETH);
  CHAINS.forEach((k, i) => {
    const res = gasRes[i];
    const who = NETWORKS[k].deployment!.deployer;
    const explorer = NETWORKS[k].explorer;
    if (res.status === "fulfilled") {
      const low = res.value < minGas;
      components.push({
        group: "Operations",
        name: `Publisher gas (${NETWORKS[k].label})`,
        state: low ? "warn" : "ok",
        detail: `${Number(formatEther(res.value)).toFixed(5)} ETH${low ? ` (below ${MIN_GAS_ETH})` : ""}; a full cycle costs about 0.00003`,
        link: explorer ? `${explorer}/address/${who}` : undefined,
      });
    } else {
      errors.push(`${NETWORKS[k].label} balance: ${errMsg(res.reason)}`);
    }
  });

  const overall = components.reduce<Level>((w, c) => worst(w, c.state), "ok");
  const reasons = components
    .filter((c) => c.state !== "ok")
    .sort((a, b) => RANK[b.state] - RANK[a.state])
    .map((c) => `${c.group}: ${c.name}: ${c.detail}`);

  return {
    readAt: nowSec,
    overall,
    reasons,
    components,
    watchtower,
    publisher: opsRes ? { workflowUrl: opsUrl, runs: opsRes, nextScheduled } : null,
    chains,
    errors,
  };
}
