/**
 * Asserts the web what-if simulator's overrides still flip the live oracle to the expected
 * reasons and that GatedPayout fails closed under each. Read-only (eth_call), no gas.
 *
 * Usage: npx hardhat run scripts/whatif-check.ts --network robinhoodTestnet
 */
import hre from "hardhat";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import {
  SCENARIO_EXPECTED_REASON,
  SKIP_SECONDS,
  SPLIT_MULTIPLIER,
  WHATIF_SLOTS,
  type ScenarioId,
} from "../packages/web/src/lib/whatif-slots";

const coder = ethers.AbiCoder.defaultAbiCoder();
const word = (v: bigint) => ethers.zeroPadValue(ethers.toBeHex(v), 32);

async function main() {
  const net = hre.network.name;
  const dep = JSON.parse(fs.readFileSync(path.resolve(`deployments/${net}.json`), "utf8"));
  const c = dep.contracts;
  const oracle = await ethers.getContractAt("SolvencyOracle", c.SolvencyOracle);
  const payout = await ethers.getContractAt("GatedPayout", c.GatedPayout);
  const statusData = oracle.interface.encodeFunctionData("status", [dep.custodianId, c.MockStockToken]);
  const payoutData = payout.interface.encodeFunctionData("payout", [dep.reserveWallet, 0]);
  const insolventSel = payout.interface.getError("Insolvent")!.selector;
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);

  const overrides = (id: ScenarioId): { state?: object; block?: object } => {
    switch (id) {
      case "drain": {
        const slot = ethers.keccak256(coder.encode(["address", "uint256"], [dep.reserveWallet, WHATIF_SLOTS.stockBalances]));
        return { state: { [c.MockStockToken]: { stateDiff: { [slot]: word(0n) } } } };
      }
      case "skip8d":
        return { block: { time: ethers.toQuantity(now + BigInt(SKIP_SECONDS)) } };
      case "split":
        return {
          state: { [c.MockStockToken]: { stateDiff: { [word(BigInt(WHATIF_SLOTS.stockUiMultiplier))]: word(SPLIT_MULTIPLIER) } } },
        };
      case "dispute": {
        const inner = ethers.keccak256(coder.encode(["bytes32", "uint256"], [dep.custodianId, WHATIF_SLOTS.disputeOpenCount]));
        const slot = ethers.keccak256(coder.encode(["address", "bytes32"], [c.MockStockToken, inner]));
        return { state: { [c.DisputeModule]: { stateDiff: { [slot]: word(1n) } } } };
      }
    }
  };

  const call = async (to: string, data: string, o: { state?: object; block?: object }, from?: string) => {
    const params: unknown[] = [{ to, data, ...(from ? { from } : {}) }, "latest", o.state ?? {}];
    if (o.block) params.push(o.block);
    return (await ethers.provider.send("eth_call", params)) as string;
  };
  const reasonOf = async (o: { state?: object; block?: object }) => {
    const [s] = oracle.interface.decodeFunctionResult("status", await call(c.SolvencyOracle, statusData, o));
    return Number(s.reason);
  };
  const payoutResult = async (o: { state?: object; block?: object }) => {
    try {
      await call(c.GatedPayout, payoutData, o, dep.deployer);
      return "allowed";
    } catch (e) {
      const data = JSON.stringify(e);
      return data.includes(insolventSel.slice(2)) ? "Insolvent" : `reverted (${(e as Error).message.slice(0, 80)})`;
    }
  };

  let failed = 0;
  const base = await reasonOf({});
  console.log(`${net} baseline: reason=${base} payout=${await payoutResult({})}`);
  if (base !== 0) console.log("  note: live oracle is not OK, so scenario results below may be masked");

  for (const id of Object.keys(SCENARIO_EXPECTED_REASON) as ScenarioId[]) {
    const o = overrides(id);
    let reason: number | string;
    let pay: string;
    try {
      reason = await reasonOf(o);
      pay = await payoutResult(o);
    } catch (e) {
      reason = `ERR ${(e as Error).message.slice(0, 100)}`;
      pay = "-";
    }
    const ok = reason === SCENARIO_EXPECTED_REASON[id] && pay === "Insolvent";
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"} ${id}: reason=${reason} (want ${SCENARIO_EXPECTED_REASON[id]}) payout=${pay}`);
  }
  if (failed) {
    console.error(`${failed} scenario(s) failed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
