/**
 * Watchtower: read every published proof on this network, heal what the operator can heal (a missed
 * publish, missing samples, multiplier drift) by running ops-cycle, keep the gated Morpho oracle's
 * incident clock alive, and alert on anything else. Exits 1 on any CRITICAL finding.
 *
 * Usage: npx hardhat run scripts/watchtower.ts --network robinhoodTestnet
 * Env:
 *   WATCH_ACT=0                  read-only: never publish or poke
 *   WATCH_REPUBLISH_BELOW_H=72   run ops-cycle when a proof has less than this left before STALE
 *   WATCH_WARN_BELOW_H=48        warn when, after healing, a proof still has less than this left
 *   WATCH_MIN_ETH=0.001          warn when the deployer's balance drops below this (a full cycle costs ~0.00003)
 *   ALERT_WEBHOOK_URL            optional Discord/Slack webhook for CRITICAL and WARN findings
 *   DEPLOYMENT                   default deployments/<network>.json
 */
import hre from "hardhat";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { BOOKS, assetAddress, type AssetKind } from "./books";
import { pokeGatedOracle } from "./morpho-poke";

const REASONS: Record<number, string> = {
  0: "OK",
  1: "NO_EPOCH",
  2: "STALE",
  3: "DISPUTED",
  4: "INSUFFICIENT_SAMPLES",
  5: "UNDERCOLLATERALIZED",
  6: "LIVE_SHORT",
  7: "MULTIPLIER_DRIFT",
  8: "EXIT_DEFAULT",
  9: "INACTIVE",
};
/** Failures a fresh epoch plus fresh samples fix. */
const HEALABLE = new Set([1, 2, 4, 7]);
const LABEL: Record<AssetKind, string> = { stock: "mTSLA", usdg: "USDG", tsla: "TSLA" };
const EXIT_SCAN = 50;

const ACT = process.env.WATCH_ACT !== "0";
const REPUBLISH_BELOW = Number(process.env.WATCH_REPUBLISH_BELOW_H || 72) * 3600;
const WARN_BELOW = Number(process.env.WATCH_WARN_BELOW_H || 48) * 3600;
const MIN_ETH = process.env.WATCH_MIN_ETH || "0.001";

type Level = "CRITICAL" | "WARN";
type Finding = { level: Level; subject: string; message: string };
type AssetState = {
  kind: AssetKind;
  label: string;
  ok: boolean;
  reason: number;
  epoch: bigint;
  staleIn: number | null;
  openDisputes: bigint;
  equivocated: boolean;
  openChallenges: bigint;
  overdue: boolean;
  exitDefault: boolean;
};

const hours = (sec: number) => {
  const h = Math.floor(Math.abs(sec) / 3600);
  const text = h >= 48 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${Math.floor((Math.abs(sec) % 3600) / 60)}m`;
  return sec < 0 ? `-${text}` : text;
};

async function main() {
  const net = hre.network.name;
  const dep = JSON.parse(fs.readFileSync(path.resolve(process.env.DEPLOYMENT || `deployments/${net}.json`), "utf8"));
  const books = BOOKS[net];
  if (!books) throw new Error(`No liability books configured for ${net}`);
  const cid: string = dep.custodianId;
  const c = dep.contracts;

  const oracle = await ethers.getContractAt("SolvencyOracle", c.SolvencyOracle);
  const ledger = await ethers.getContractAt("LiabilityLedger", c.LiabilityLedger);
  const config = await ethers.getContractAt("AssetConfig", c.AssetConfig);
  const disputes = await ethers.getContractAt("DisputeModule", c.DisputeModule);
  const exit = c.ExitRight ? await ethers.getContractAt("ExitRight", c.ExitRight) : null;

  const [signer] = await ethers.getSigners().catch(() => []);
  const canAct = ACT && Boolean(signer);
  const kinds = (Object.keys(books) as AssetKind[]).filter((k) => assetAddress(dep, k));
  const findings: Finding[] = [];
  const notes: string[] = [];

  async function readAsset(kind: AssetKind, now: number): Promise<AssetState> {
    const asset = assetAddress(dep, kind)!;
    const [s, epoch, cfg, openDisputes, equivocated, openChallenges, overdue, exitDefault] = await Promise.all([
      oracle.status(cid, asset),
      ledger.latestEpochId(cid, asset),
      config.getConfig(cid, asset),
      disputes.openDisputeCount(cid, asset),
      disputes.equivocationPermanent(cid, asset),
      disputes.openChallengeCount(cid, asset),
      disputes.hasOverdueChallenge(cid, asset),
      exit ? exit.hasExitDefault(cid, asset) : Promise.resolve(false),
    ]);
    let staleIn: number | null = null;
    if (epoch > 0n) {
      const ep = await ledger.getEpoch(cid, asset, epoch);
      staleIn = Number(ep.committedAt + cfg.maxOracleAge) - now;
    }
    return {
      kind,
      label: LABEL[kind],
      ok: s.ok,
      reason: Number(s.reason),
      epoch,
      staleIn,
      openDisputes,
      equivocated,
      openChallenges,
      overdue,
      exitDefault,
    };
  }

  const blockTime = async () => (await ethers.provider.getBlock("latest"))!.timestamp;
  const readAll = async () => {
    const now = await blockTime();
    return Promise.all(kinds.map((k) => readAsset(k, now)));
  };

  let states = await readAll();
  const heal = states.filter((a) => (!a.ok && HEALABLE.has(a.reason)) || (a.staleIn !== null && a.staleIn < REPUBLISH_BELOW));
  if (heal.length) {
    const why = heal.map((a) => `${a.label} ${a.ok ? `stale in ${hours(a.staleIn!)}` : REASONS[a.reason]}`).join(", ");
    if (canAct) {
      console.log(`${net}: healing (${why}), running ops-cycle`);
      const run = spawnSync("npx", ["hardhat", "run", "scripts/ops-cycle.ts", "--network", net], {
        stdio: "inherit",
        shell: process.platform === "win32",
        env: process.env,
      });
      if (run.status !== 0) {
        findings.push({ level: "CRITICAL", subject: "ops-cycle", message: `heal attempt failed (exit ${run.status})` });
      } else {
        notes.push(`Healed by running ops-cycle: ${why}.`);
      }
      states = await readAll();
    } else {
      findings.push({
        level: "WARN",
        subject: "heal",
        message: `would run ops-cycle (${why}) but ${ACT ? "no deployer key is configured" : "WATCH_ACT=0"}`,
      });
    }
  }

  for (const a of states) {
    if (!a.ok) findings.push({ level: "CRITICAL", subject: a.label, message: `proof failing: ${REASONS[a.reason] ?? a.reason}` });
    if (a.equivocated) findings.push({ level: "CRITICAL", subject: a.label, message: "equivocation proven (permanent DISPUTED)" });
    if (a.overdue) findings.push({ level: "CRITICAL", subject: a.label, message: "a balance challenge is past its answer deadline" });
    if (a.exitDefault) findings.push({ level: "CRITICAL", subject: a.label, message: "ExitRight default set (permanent)" });
    if (a.staleIn !== null && a.staleIn < WARN_BELOW) {
      findings.push({ level: "WARN", subject: a.label, message: `proof goes STALE in ${hours(a.staleIn)}` });
    }
    if (a.openDisputes > 0n) findings.push({ level: "WARN", subject: a.label, message: `${a.openDisputes} open dispute(s)` });
    if (a.openChallenges > 0n) {
      findings.push({ level: "WARN", subject: a.label, message: `${a.openChallenges} open balance challenge(s)` });
    }
  }

  if (exit) {
    const now = await blockTime();
    const n = Number(await exit.nextClaimId());
    for (let id = n - 1; id >= Math.max(0, n - EXIT_SCAN); id--) {
      const cl = await exit.claims(id);
      if (cl.custodianId !== cid || !cl.open || cl.settled || cl.slashed) continue;
      const left = Number(cl.deadline) - now;
      const who = `ExitRight #${id}`;
      if (left <= 0) findings.push({ level: "CRITICAL", subject: who, message: "unsettled past its deadline (slashable)" });
      else if (left < 12 * 3600) findings.push({ level: "WARN", subject: who, message: `unsettled, ${hours(left)} to deadline` });
      else notes.push(`${who} open, ${hours(left)} to deadline.`);
    }
  }

  if (c.SolvencyGatedMorphoOracle) {
    if (canAct) await pokeGatedOracle(dep, oracle, net);
    const gated = await ethers.getContractAt("SolvencyGatedMorphoOracle", c.SolvencyGatedMorphoOracle);
    const [running, startedAt, capEndsAt, voidAt] = await gated.freezeState();
    if (running) {
      const iso = (t: bigint) => new Date(Number(t) * 1000).toISOString();
      findings.push({
        level: "CRITICAL",
        subject: "Morpho wrapper",
        message: `frozen since ${iso(startedAt)}; discounted price from ${iso(capEndsAt)}; void at ${iso(voidAt)} unless poked`,
      });
    } else {
      notes.push("Morpho wrapper: no incident clock, price() open.");
    }
  }

  const who = signer ? await signer.getAddress() : (dep.deployer as string);
  const balance = await ethers.provider.getBalance(who);
  if (balance < ethers.parseEther(MIN_ETH)) {
    findings.push({ level: "WARN", subject: "deployer", message: `${who} has ${ethers.formatEther(balance)} ETH (< ${MIN_ETH})` });
  }

  report(net, states, findings, notes, `${ethers.formatEther(balance)} ETH (${who})`);
  await alert(net, findings);
  if (findings.some((f) => f.level === "CRITICAL")) process.exitCode = 1;
}

function report(net: string, states: AssetState[], findings: Finding[], notes: string[], balance: string) {
  for (const a of states) {
    console.log(
      `${net} ${a.label}: ${a.ok ? "OK" : REASONS[a.reason]} epoch=${a.epoch} ` +
        `staleIn=${a.staleIn === null ? "-" : hours(a.staleIn)} disputes=${a.openDisputes} challenges=${a.openChallenges}`
    );
  }
  for (const n of notes) console.log(`${net} ${n}`);
  console.log(`${net} deployer balance: ${balance}`);
  for (const f of findings) console.log(`${net} ${f.level} ${f.subject}: ${f.message}`);
  if (!findings.length) console.log(`${net}: all clear`);

  if (!process.env.GITHUB_ACTIONS) return;
  for (const f of findings) {
    console.log(`::${f.level === "CRITICAL" ? "error" : "warning"} title=${net} ${f.subject}::${f.message}`);
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  const rows = states.map(
    (a) =>
      `| ${a.label} | ${a.ok ? "OK" : `**${REASONS[a.reason]}**`} | ${a.epoch} | ${a.staleIn === null ? "-" : hours(a.staleIn)} | ${a.openDisputes} | ${a.openChallenges} |`
  );
  const lines = [
    `### Watchtower: ${net}`,
    "",
    "| Asset | Status | Epoch | Stale in | Disputes | Challenges |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    ...(findings.length ? findings.map((f) => `- **${f.level}** ${f.subject}: ${f.message}`) : ["All clear."]),
    ...notes.map((n) => `- ${n}`),
    `- Deployer balance: ${balance}`,
    "",
  ];
  fs.appendFileSync(summary, lines.join("\n"));
}

async function alert(net: string, findings: Finding[]) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url || !findings.length) return;
  const text = [`ReserveProof watchtower (${net})`, ...findings.map((f) => `${f.level} ${f.subject}: ${f.message}`)].join("\n");
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text, text }),
    });
    if (!res.ok) console.error(`alert webhook returned ${res.status}`);
  } catch (e) {
    console.error(`alert webhook failed: ${(e as Error).message}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
