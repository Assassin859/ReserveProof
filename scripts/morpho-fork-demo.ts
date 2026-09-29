/**
 * One-command proof that a drained custodian freezes a real Morpho Blue market.
 *
 * Forks Robinhood Chain mainnet in memory (nothing is broadcast, no keys are used), deploys the
 * ReserveProof stack gating the real TSLA stock token, wraps the real TSLA/USDG Morpho oracle in
 * SolvencyGatedMorphoOracle, and opens a market on the real Morpho Blue with the real IRM and 77%
 * LLTV. Then it drains the reserve wallet and checks, step by step, what Morpho allows:
 *
 *   1. healthy: borrow succeeds at full price
 *   2. drained: price(), borrow, indebted withdrawCollateral and liquidate revert Insolvent(6)
 *   3. exits:   repay, supplyCollateral and lender withdraw still work
 *   4. keeper:  pokes every 5h; still frozen at 71h, 50% price at 72h
 *   5. liquidation clears at the discounted price
 *   6. restore: reserves back, healthy poke clears the clock, full price and borrowing resume
 *
 * Only two things are simulated: token balances (set in storage) and, from step 4 on, the feed
 * transmitters. The real oracle rejects feed answers older than 26h and a fork receives no new
 * rounds, so before warping 72h the feed's latest real answer is replayed with fresh timestamps.
 *
 *   npm run demo:morpho-fork
 *   FORK_RPC=<url> FORK_BLOCK=<n> npm run demo:morpho-fork   # optional overrides
 *   FORK_JSON=<path> npm run demo:morpho-fork                # also write every check as JSON
 *
 * Exits 1 if any step fails.
 */
import * as fs from "fs";
import * as path from "path";
import { ethers, network } from "hardhat";
import type { Contract, Log } from "ethers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployFixture, commitAndSample, twoLeaves } from "../test/helpers/fixture";

const FORK_RPC = process.env.FORK_RPC || process.env.ROBINHOOD_MAINNET_RPC || "https://rpc.mainnet.chain.robinhood.com";
const FORK_BLOCK = process.env.FORK_BLOCK ? Number(process.env.FORK_BLOCK) : undefined;
const FORK_JSON = process.env.FORK_JSON;

const MORPHO = "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010";
const TSLA = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
/** The oracle and IRM of the live TSLA/USDG Morpho market on Robinhood Chain. */
const TSLA_USDG_ORACLE = "0x280855A5BF983bf005f19992C157007930B3de2A";
const ADAPTIVE_IRM = "0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1";
/** The Chainlink-style feed proxy that oracle reads; the oracle rejects answers older than 26h. */
const TSLA_FEED_PROXY = ethers.getAddress("0x4a1166a659a55625345e9515b32adecea5547c38");
const LLTV = 770000000000000000n;
const ARBSYS = "0x0000000000000000000000000000000000000064";
/** NUMBER PUSH0 MSTORE PUSH1 0x20 PUSH0 RETURN: answers arbBlockNumber() with block.number. */
const ARBSYS_STUB = "0x435f5260205ff3";
/** OpenZeppelin ERC20Upgradeable namespaced storage; `_balances` is its first slot. */
const TSLA_BALANCES_BASE = "0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00";
const USDG_BALANCES_SLOT = 1n;

const MAX_FREEZE = 72 * 3600;
const POKE_GAP = 6 * 3600;
const POST_CAP_BPS = 5000n;
const HOUR = 3600;

const MORPHO_ABI = [
  "function createMarket((address,address,address,address,uint256))",
  "function supply((address,address,address,address,uint256),uint256,uint256,address,bytes) returns (uint256,uint256)",
  "function withdraw((address,address,address,address,uint256),uint256,uint256,address,address) returns (uint256,uint256)",
  "function borrow((address,address,address,address,uint256),uint256,uint256,address,address) returns (uint256,uint256)",
  "function repay((address,address,address,address,uint256),uint256,uint256,address,bytes) returns (uint256,uint256)",
  "function supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)",
  "function withdrawCollateral((address,address,address,address,uint256),uint256,address,address)",
  "function liquidate((address,address,address,address,uint256),address,uint256,uint256,bytes) returns (uint256,uint256)",
  "function position(bytes32,address) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
];
const ORACLE_ABI = ["function price() view returns (uint256)"];

const INSOLVENT = ethers.id("Insolvent(uint8)").slice(0, 10);
const REASONS = [
  "OK", "NO_EPOCH", "STALE", "DISPUTED", "INSUFFICIENT_SAMPLES",
  "UNDERCOLLATERALIZED", "LIVE_SHORT", "MULTIPLIER_DRIFT", "EXIT_DEFAULT", "INACTIVE",
];

type Result = { step: string; check: string; ok: boolean; detail: string };
const results: Result[] = [];

function record(step: string, check: string, ok: boolean, detail = "") {
  results.push({ step, check, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${check}${detail ? `  (${detail})` : ""}`);
}

/** Revert reason of a failed call, as `Insolvent(n)` when it carries the guard's error. */
function revertOf(e: unknown): string {
  const err = e as { data?: unknown; message?: string; info?: unknown; error?: unknown };
  const blob = [
    typeof err.data === "string" ? err.data : "",
    err.message ?? "",
    JSON.stringify(err.info ?? {}, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    JSON.stringify(err.error ?? {}, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  ].join(" ");
  const m = blob.match(new RegExp(`${INSOLVENT.slice(2)}([0-9a-fA-F]{64})`));
  if (m) return `Insolvent(${Number(BigInt("0x" + m[1]))})`;
  return `reverted: ${(err.message ?? String(e)).split("\n")[0].slice(0, 100)}`;
}

async function expectInsolvent(step: string, check: string, fn: () => Promise<unknown>, reason: number) {
  try {
    await fn();
    record(step, check, false, "did not revert");
  } catch (e) {
    const got = revertOf(e);
    record(step, check, got === `Insolvent(${reason})`, got);
  }
}

async function expectOk(step: string, check: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn();
    record(step, check, true, detail ?? "");
  } catch (e) {
    record(step, check, false, revertOf(e));
  }
}

async function send(txp: Promise<{ wait: () => Promise<unknown> }>) {
  await (await txp).wait();
}

async function setBalance(token: string, slotKey: string, amount: bigint) {
  await network.provider.send("hardhat_setStorageAt", [token, slotKey, ethers.toBeHex(amount, 32)]);
}

/**
 * Keep the real feed answering while time is warped: capture its latest real answer and replay it
 * with a fresh timestamp from the aggregator behind the real proxy. The real oracle and proxy stay in
 * the path; only the missing transmitters are simulated.
 */
async function replayBaseFeed(): Promise<string> {
  const proxy = new ethers.Contract(TSLA_FEED_PROXY, ["function aggregator() view returns (address)"], ethers.provider);
  const agg: string = await proxy.aggregator();
  const a = new ethers.Contract(
    agg,
    ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)"],
    ethers.provider
  );
  const [roundId, answer, , updatedAt] = await a.latestRoundData();
  const replay = await (await ethers.getContractFactory("ReplayFeed")).deploy(roundId, answer, await a.decimals());
  await network.provider.send("hardhat_setCode", [agg, await ethers.provider.getCode(await replay.getAddress())]);
  return `aggregator ${agg}, round ${roundId}, answer ${answer}, last real update ${new Date(Number(updatedAt) * 1000).toISOString()}`;
}

const coder = ethers.AbiCoder.defaultAbiCoder();
const tslaSlot = (who: string) => ethers.keccak256(coder.encode(["address", "bytes32"], [who, TSLA_BALANCES_BASE]));
const usdgSlot = (who: string) => ethers.keccak256(coder.encode(["address", "uint256"], [who, USDG_BALANCES_SLOT]));
const usdg = (n: bigint) => `${ethers.formatUnits(n, 6)} USDG`;
const tsla = (n: bigint) => `${ethers.formatEther(n)} TSLA`;
/** Morpho price: loan units per collateral unit, scaled by 1e36. */
const perTsla = (p: bigint) => `${ethers.formatUnits((p * 10n ** 18n) / 10n ** 36n, 6)} USDG/TSLA`;

async function main() {
  if (network.name !== "hardhat") {
    throw new Error(`demo:morpho-fork only runs on the in-process hardhat network (got "${network.name}"); it never broadcasts`);
  }

  console.log(`Forking Robinhood Chain mainnet from ${FORK_RPC}${FORK_BLOCK ? ` at block ${FORK_BLOCK}` : " (latest)"}`);
  if (FORK_BLOCK) console.log("  note: the public RPC keeps only ~5,000 blocks of state; older FORK_BLOCK values will fail");
  try {
    await network.provider.request({
      method: "hardhat_reset",
      params: [{ forking: { jsonRpcUrl: FORK_RPC, ...(FORK_BLOCK ? { blockNumber: FORK_BLOCK } : {}) } }],
    });
    await network.provider.send("evm_mine", []);
  } catch (e) {
    console.error(`Could not fork ${FORK_RPC}: ${(e as Error).message.split("\n")[0]}`);
    console.error("Offline equivalent: forge test --match-path test/foundry/MorphoIntegration.t.sol");
    process.exit(1);
  }
  // The RPC reports 0xfe at the ArbSys precompile; without a stub ArbBlock's try/catch burns 63/64 of the gas.
  await network.provider.send("hardhat_setCode", [ARBSYS, ARBSYS_STUB]);
  const forkBlock = await ethers.provider.getBlock("latest");
  console.log(`  forked, local head ${forkBlock!.number} at ${new Date(forkBlock!.timestamp * 1000).toISOString()}\n`);

  const signers = await ethers.getSigners();
  const [lender, borrower, liquidator, sink] = signers.slice(7, 11);
  const morpho = new ethers.Contract(MORPHO, MORPHO_ABI, ethers.provider);
  const tslaToken = new ethers.Contract(TSLA, ERC20_ABI, ethers.provider);
  const usdgToken = new ethers.Contract(USDG, ERC20_ABI, ethers.provider);
  const base = new ethers.Contract(TSLA_USDG_ORACLE, ORACLE_ABI, ethers.provider);

  console.log("Setup: ReserveProof on real TSLA, wrapper on the real TSLA/USDG oracle, market on real Morpho Blue");
  const f = await deployFixture({ stockAddress: TSLA });
  await setBalance(TSLA, tslaSlot(f.wallet1.address), ethers.parseEther("1000"));
  await commitAndSample(f, twoLeaves(f.userA.address, f.userB.address));

  const Wrapper = await ethers.getContractFactory("SolvencyGatedMorphoOracle");
  const wrapper = await Wrapper.deploy(
    TSLA_USDG_ORACLE, await f.oracle.getAddress(), f.custodianId, TSLA, MAX_FREEZE, POKE_GAP, Number(POST_CAP_BPS)
  );
  const wrapperAddr = await wrapper.getAddress();
  const mp = [USDG, TSLA, wrapperAddr, ADAPTIVE_IRM, LLTV];
  const liveMp = [USDG, TSLA, TSLA_USDG_ORACLE, ADAPTIVE_IRM, LLTV];
  const idOf = (p: unknown[]) => ethers.keccak256(coder.encode(["address", "address", "address", "address", "uint256"], p));
  const id = idOf(mp);
  const liveId = idOf(liveMp);

  const m = (s: typeof lender) => morpho.connect(s) as Contract;
  await send(m(lender).createMarket(mp));
  await setBalance(USDG, usdgSlot(lender.address), 100_000n * 10n ** 6n);
  await setBalance(USDG, usdgSlot(borrower.address), 1_000n * 10n ** 6n);
  await setBalance(USDG, usdgSlot(liquidator.address), 10_000n * 10n ** 6n);
  await setBalance(TSLA, tslaSlot(borrower.address), ethers.parseEther("20"));
  for (const s of [lender, borrower, liquidator]) {
    await send((usdgToken.connect(s) as Contract).approve(MORPHO, ethers.MaxUint256));
  }
  await send((tslaToken.connect(borrower) as Contract).approve(MORPHO, ethers.MaxUint256));
  await send(m(lender).supply(mp, 100_000n * 10n ** 6n, 0n, lender.address, "0x"));
  await send(m(borrower).supplyCollateral(mp, ethers.parseEther("10"), borrower.address, "0x"));

  const live = await morpho.market(liveId);
  const basePrice: bigint = await base.price();
  console.log(`  Morpho Blue       ${MORPHO}`);
  console.log(`  gated market id   ${id}`);
  console.log(`  live TSLA/USDG id ${liveId} (same params, ungated oracle; ${usdg(live.totalSupplyAssets)} supplied, ${usdg(live.totalBorrowAssets)} borrowed)`);
  console.log(`  base oracle       ${TSLA_USDG_ORACLE} = ${perTsla(basePrice)}`);
  console.log(`  wrapper           ${wrapperAddr} (freeze 72h, poke gap 6h, then 50%)`);
  console.log(`  reserves 1000 TSLA vs liabilities 300 TSLA, floor 103%; lender 100k USDG; borrower 10 TSLA collateral\n`);

  // 1. Healthy
  let step = "1 healthy";
  console.log("Step 1: healthy proof");
  const s1 = await f.oracle.status(f.custodianId, TSLA);
  record(step, "SolvencyOracle.status(TSLA) is OK", s1.ok, REASONS[Number(s1.reason)]);
  const p1: bigint = await wrapper.price();
  record(step, "wrapper price == real oracle price", p1 === basePrice, perTsla(p1));
  await expectOk(step, "borrow 2,500 USDG (~70% LTV) succeeds", async () => {
    await send(m(borrower).borrow(mp, 2_500n * 10n ** 6n, 0n, borrower.address, borrower.address));
    return `borrower holds ${usdg(await usdgToken.balanceOf(borrower.address))}`;
  });

  // 2. Drain
  step = "2 drained";
  console.log("\nStep 2: custodian drains 990 of 1000 TSLA from the reserve wallet");
  await send((tslaToken.connect(f.wallet1) as Contract).transfer(sink.address, ethers.parseEther("990")));
  const s2 = await f.oracle.status(f.custodianId, TSLA);
  record(step, "status reason is LIVE_SHORT (6)", !s2.ok && Number(s2.reason) === 6, REASONS[Number(s2.reason)]);
  await expectInsolvent(step, "wrapper.price() reverts", () => wrapper.price(), 6);
  await expectInsolvent(step, "Morpho borrow(1 USDG) reverts", () =>
    m(borrower).borrow(mp, 10n ** 6n, 0n, borrower.address, borrower.address), 6);
  await expectInsolvent(step, "Morpho indebted withdrawCollateral reverts", () =>
    m(borrower).withdrawCollateral(mp, ethers.parseEther("1"), borrower.address, borrower.address), 6);
  await expectInsolvent(step, "Morpho liquidate reverts (no liquidation at a fake price)", () =>
    m(liquidator).liquidate(mp, borrower.address, ethers.parseEther("1"), 0n, "0x"), 6);

  // 3. Exits
  step = "3 exits";
  console.log("\nStep 3: exits that need no price keep working");
  await expectOk(step, "borrower repay(100 USDG)", async () => {
    await send(m(borrower).repay(mp, 100n * 10n ** 6n, 0n, borrower.address, "0x"));
  });
  await expectOk(step, "borrower supplyCollateral(1 TSLA)", async () => {
    await send(m(borrower).supplyCollateral(mp, ethers.parseEther("1"), borrower.address, "0x"));
  });
  await expectOk(step, "lender withdraw(10,000 USDG)", async () => {
    await send(m(lender).withdraw(mp, 10_000n * 10n ** 6n, 0n, lender.address, lender.address));
  });

  // 4. Keeper pokes through the freeze
  step = "4 keeper";
  console.log("\nStep 4: a keeper pokes every 5h through the 72h freeze");
  console.log("  the fork has no feed transmitters and the real oracle rejects answers older than 26h,");
  console.log("  so the feed's last real answer is replayed with fresh timestamps while time is warped:");
  const priceBeforeReplay: bigint = await base.price();
  console.log(`  ${await replayBaseFeed()}`);
  const priceAfterReplay: bigint = await base.price();
  record(step, "real oracle price unchanged by the replay", priceAfterReplay === priceBeforeReplay, perTsla(priceAfterReplay));
  await send(wrapper.poke());
  const [, startedAt, capEndsAt] = await wrapper.freezeState();
  const start = Number(startedAt);
  record(step, "first failing poke starts the incident clock", start > 0, `cap at ${new Date(Number(capEndsAt) * 1000).toISOString()}`);
  let pokes = 1;
  while ((await time.latest()) + 5 * HOUR < start + 71 * HOUR) {
    await time.increase(5 * HOUR);
    await send(wrapper.poke());
    pokes++;
  }
  await time.increaseTo(start + 71 * HOUR);
  await send(wrapper.poke());
  pokes++;
  await expectInsolvent(step, `price() still reverts at 71h (${pokes} pokes)`, () => wrapper.price(), 6);
  await time.increaseTo(start + 72 * HOUR);
  await send(wrapper.poke());
  const want = ((await base.price()) * POST_CAP_BPS) / 10_000n;
  let p4 = 0n;
  try {
    p4 = await wrapper.price();
  } catch {
    /* recorded below */
  }
  record(step, "price() at 72h == 50% of the real oracle price", p4 === want, perTsla(p4));

  // 5. Liquidation at the discounted price
  step = "5 liquidation";
  console.log("\nStep 5: liquidation clears at the discounted price");
  const pos = await morpho.position(id, borrower.address);
  const mk = await morpho.market(id);
  const debt = (BigInt(pos.borrowShares) * BigInt(mk.totalBorrowAssets)) / BigInt(mk.totalBorrowShares);
  const ltv = Number((debt * 10n ** 36n * 10_000n) / (BigInt(pos.collateral) * p4)) / 100;
  console.log(`  borrower: ${tsla(pos.collateral)} collateral, ~${usdg(debt)} debt, LTV ${ltv}% at the discounted price (LLTV 77%)`);
  await expectOk(step, "liquidator seizes 1 TSLA", async () => {
    const before: bigint = await tslaToken.balanceOf(liquidator.address);
    const usdgBefore: bigint = await usdgToken.balanceOf(liquidator.address);
    await send(m(liquidator).liquidate(mp, borrower.address, ethers.parseEther("1"), 0n, "0x"));
    const got = (await tslaToken.balanceOf(liquidator.address)) - before;
    const paid = usdgBefore - (await usdgToken.balanceOf(liquidator.address));
    return `received ${tsla(got)} for ${usdg(paid)}`;
  });

  // 6. Restore
  step = "6 restore";
  console.log("\nStep 6: custodian restores reserves; a healthy poke clears the clock");
  await send((tslaToken.connect(sink) as Contract).transfer(f.wallet1.address, ethers.parseEther("990")));
  for (let i = 0; i < 2; i++) {
    await time.increase(2);
    await send((f.sampler.connect(f.operator) as Contract).recordSample(f.custodianId, TSLA));
  }
  const s6 = await f.oracle.status(f.custodianId, TSLA);
  record(step, "status is OK again", s6.ok, REASONS[Number(s6.reason)]);
  const rc = await (await wrapper.poke()).wait();
  const cleared = rc!.logs.some((l: Log) => l.topics[0] === wrapper.interface.getEvent("FreezeCleared")!.topicHash);
  record(step, "healthy poke emits FreezeCleared", cleared);
  const p6: bigint = await wrapper.price();
  const b6: bigint = await base.price();
  record(step, "price() back to the full real oracle price", p6 === b6, perTsla(p6));
  await expectOk(step, "borrow(1 USDG) works again", async () => {
    await send(m(borrower).borrow(mp, 10n ** 6n, 0n, borrower.address, borrower.address));
  });

  const failed = results.filter((r) => !r.ok);
  console.log("\nSummary");
  for (const s of [...new Set(results.map((r) => r.step))]) {
    const rs = results.filter((r) => r.step === s);
    console.log(`  ${rs.every((r) => r.ok) ? "PASS" : "FAIL"}  ${s.padEnd(14)} ${rs.filter((r) => r.ok).length}/${rs.length} checks`);
  }
  console.log(`\n${failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`}: ${results.length} checks on a Robinhood Chain mainnet fork against the real Morpho Blue`);
  if (FORK_JSON) {
    const out = {
      ranAt: new Date().toISOString(),
      forkBlock: forkBlock!.number - 1,
      rpcHost: new URL(FORK_RPC).host,
      morpho: MORPHO,
      token: TSLA,
      baseOracle: TSLA_USDG_ORACLE,
      passed: results.length - failed.length,
      total: results.length,
      checks: results,
    };
    fs.mkdirSync(path.dirname(path.resolve(FORK_JSON)), { recursive: true });
    fs.writeFileSync(FORK_JSON, JSON.stringify(out, null, 2) + "\n");
    console.log(`wrote ${FORK_JSON}`);
  }
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
