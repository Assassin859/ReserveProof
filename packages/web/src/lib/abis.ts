import type { Abi } from "viem";
import registryAbi from "../abi/CustodianRegistry.json";
import oracleAbi from "../abi/SolvencyOracle.json";
import ledgerAbi from "../abi/LiabilityLedger.json";
import gatedAbi from "../abi/GatedPayout.json";
import disputesAbi from "../abi/DisputeModule.json";
import stockAbi from "../abi/MockStockToken.json";
import exitAbi from "../abi/ExitRight.json";

export const custodianRegistryAbi = registryAbi.abi as Abi;
export const solvencyOracleAbi = oracleAbi.abi as Abi;
export const liabilityLedgerAbi = ledgerAbi.abi as Abi;
export const gatedPayoutAbi = gatedAbi.abi as Abi;
export const disputeModuleAbi = disputesAbi.abi as Abi;
export const mockStockAbi = stockAbi.abi as Abi;
export const exitRightAbi = exitAbi.abi as Abi;
