/**
 * Keep the gated Morpho oracle's incident clock in sync: every poke during a failure starts or
 * extends it, and a poke after recovery clears it. Shared by ops-cycle and the watchtower.
 */
import { ethers } from "hardhat";
import type { Contract } from "ethers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function pokeGatedOracle(dep: any, oracle: Contract, net: string): Promise<void> {
  if (!dep.contracts.SolvencyGatedMorphoOracle) return;
  const gated = await ethers.getContractAt("SolvencyGatedMorphoOracle", dep.contracts.SolvencyGatedMorphoOracle);
  const s = await oracle.status(dep.custodianId, await gated.asset());
  const started = await gated.freezeStartedAt();
  if (s.ok && started === 0n) {
    console.log(`${net} morpho oracle: healthy, no clock, no poke needed`);
    return;
  }
  await (await gated.poke()).wait();
  const [running, startedAt, capEndsAt] = await gated.freezeState();
  console.log(
    `${net} morpho oracle: poked (${running ? `incident since ${startedAt}, discount from ${capEndsAt}` : "clock cleared"})`
  );
}
