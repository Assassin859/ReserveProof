/**
 * Robinhood Chain mainnet: core contracts only, against the official USDG and Robinhood's real TSLA
 * stock token. No mocks, no demo consumers. Resumable: each step is saved to
 * deployments/robinhoodMainnet.json as it lands, so a rerun skips what is already on chain.
 *
 *   npx ts-node scripts/make-mainnet-wallets.ts        # once; fund the printed addresses
 *   npm run deploy:rhmain                              # contracts, custodian, reserve wallet, books
 *   npm run ops:cycle:rhmain                           # epoch 1 + samples
 *   npm run verify:rhmain && npm run status:rhmain
 *
 * Env: INCLUDE_TSLA=0 to skip TSLA even if the reserve wallet holds some; BOOK_BPS (default 8000):
 * the demo book covers this share of the reserve balance, so coverage starts at 1e4/BOOK_BPS.
 */
import hre from "hardhat";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const TSLA = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d";
const CUSTODIAN_NAME = "reserveproof-mainnet";
const SALT = process.env.DEPLOYMENT_SALT_MAINNET || "ReserveProof.robinhoodMainnet.v1";
const ASSET_ID_USDG = ethers.id("USDG-MAIN");
const ASSET_ID_TSLA = ethers.id("TSLA-MAIN");
const CHALLENGE_BOND = 1_000_000n; // 1 USDG
const CLEAR_TIMELOCK = 3600;
const CHALLENGE_WINDOW = 3600;
const REMOVAL_DELAY = 3600;
const COVERAGE_BPS = 10300;
const MAX_ORACLE_AGE = 7 * 24 * 3600;
const MIN_SAMPLES = 2;
const MIN_SAMPLE_GAP = 60;
const BOOK_BPS = BigInt(process.env.BOOK_BPS || "8000");
/** Demo book: one real demo user (key in the gitignored wallets file) plus three placeholder accounts. */
const PLACEHOLDERS = [
  "0x1111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222",
  "0x3333333333333333333333333333333333333333",
];
const SPLIT_BPS = [4000n, 3000n, 1000n, 2000n];

const ROOT = path.join(__dirname, "..");
const DEP_FILE = path.join(ROOT, "deployments", "robinhoodMainnet.json");
const WALLETS_FILE = path.join(ROOT, "deployments", "wallets.mainnet.local.json");
const BOOK_DIR = path.join(ROOT, "packages", "cli", "examples");

const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function uiMultiplier() view returns (uint256)",
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dep = any;

function save(dep: Dep) {
  fs.writeFileSync(DEP_FILE, JSON.stringify(dep, null, 2));
}

/** Split `total` across the book leaves, rounded down to `unit`, with the remainder on the last leaf. */
function writeBook(file: string, users: string[], total: bigint, unit: bigint) {
  const amounts = SPLIT_BPS.map((bps) => ((total * bps) / 10000n / unit) * unit);
  const used = amounts.slice(0, -1).reduce((a, b) => a + b, 0n);
  amounts[amounts.length - 1] = ((total - used) / unit) * unit;
  if (amounts.some((a) => a === 0n)) throw new Error(`book ${file}: reserve too small to split`);
  const rows = users.map((u, i) => `${u},${amounts[i]}`);
  fs.writeFileSync(file, ["user,amount", ...rows].join("\n") + "\n");
  return amounts.reduce((a, b) => a + b, 0n);
}

async function main() {
  if (hre.network.name !== "robinhoodMainnet") throw new Error("run with --network robinhoodMainnet");
  if (!fs.existsSync(WALLETS_FILE)) throw new Error("run scripts/make-mainnet-wallets.ts first");
  const wallets = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8"));
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("MAINNET_PRIVATE_KEY is not set in .env");
  if (deployer.address !== wallets.deployer.address) {
    throw new Error(`MAINNET_PRIVATE_KEY (${deployer.address}) != wallets file deployer (${wallets.deployer.address})`);
  }
  const reserve = new ethers.Wallet(wallets.reserve.privateKey, ethers.provider);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (chainId !== 4663) throw new Error(`unexpected chainId ${chainId}`);

  const eth = await ethers.provider.getBalance(deployer.address);
  const usdg = new ethers.Contract(USDG, ERC20, ethers.provider);
  const tsla = new ethers.Contract(TSLA, ERC20, ethers.provider);
  const usdgBal: bigint = await usdg.balanceOf(reserve.address);
  const tslaBal: bigint = await tsla.balanceOf(reserve.address);
  console.log(`Deployer ${deployer.address}: ${ethers.formatEther(eth)} ETH`);
  console.log(`Reserve  ${reserve.address}: ${ethers.formatUnits(usdgBal, 6)} USDG, ${ethers.formatEther(tslaBal)} TSLA`);
  if (eth < ethers.parseEther("0.0005")) throw new Error("deployer needs at least 0.0005 ETH for gas");
  if (usdgBal === 0n) throw new Error("reserve wallet holds no USDG yet; send ~5 USDG first");
  const withTsla = process.env.INCLUDE_TSLA !== "0" && tslaBal > 0n;

  const dep: Dep = fs.existsSync(DEP_FILE)
    ? JSON.parse(fs.readFileSync(DEP_FILE, "utf8"))
    : {
        network: "robinhoodMainnet",
        chainId,
        deployedAt: new Date().toISOString(),
        deployer: deployer.address,
        reserveWallet: reserve.address,
        demoUser: wallets.demoUser.address,
        custodianName: CUSTODIAN_NAME,
        custodianId: ethers.id(CUSTODIAN_NAME),
        deploymentSalt: ethers.id(SALT),
        assetIds: { usdg: ASSET_ID_USDG },
        contracts: { USDG },
        steps: {},
      };
  const c = dep.contracts;

  async function deploy(name: string, args: unknown[]) {
    if (c[name]) {
      console.log(`${name}: ${c[name]} (already deployed)`);
      return c[name] as string;
    }
    const f = await ethers.getContractFactory(name);
    const k = await f.deploy(...args);
    await k.waitForDeployment();
    c[name] = await k.getAddress();
    save(dep);
    console.log(`${name}: ${c[name]}`);
    return c[name] as string;
  }
  async function step(key: string, run: () => Promise<{ hash: string; wait: () => Promise<unknown> }>) {
    if (dep.steps[key]) return console.log(`${key}: done (${dep.steps[key]})`);
    const tx = await run();
    await tx.wait();
    dep.steps[key] = tx.hash;
    save(dep);
    console.log(`${key}: ${tx.hash}`);
  }

  await deploy("CustodianRegistry", [deployer.address]);
  await deploy("AssetConfig", [deployer.address, c.CustodianRegistry]);
  await deploy("LiabilityLedger", [c.CustodianRegistry, c.AssetConfig, dep.deploymentSalt]);
  await deploy("ReserveSampler", [c.CustodianRegistry, c.AssetConfig, c.LiabilityLedger]);
  await deploy("DisputeModule", [
    c.CustodianRegistry,
    c.LiabilityLedger,
    USDG,
    CHALLENGE_BOND,
    CLEAR_TIMELOCK,
    CHALLENGE_WINDOW,
  ]);
  await deploy("SolvencyOracle", [
    c.CustodianRegistry,
    c.AssetConfig,
    c.LiabilityLedger,
    c.ReserveSampler,
    c.DisputeModule,
    deployer.address,
  ]);
  await deploy("ExitRight", [c.CustodianRegistry, c.LiabilityLedger, USDG]);

  const registry = await ethers.getContractAt("CustodianRegistry", c.CustodianRegistry);
  const assetConfig = await ethers.getContractAt("AssetConfig", c.AssetConfig);
  const oracle = await ethers.getContractAt("SolvencyOracle", c.SolvencyOracle);

  await step("linkExitRight", () => oracle.setExitRight(c.ExitRight));
  await step("registerCustodian", () =>
    registry.registerCustodian(dep.custodianId, deployer.address, REMOVAL_DELAY)
  );
  await step("addReserveWallet", async () => {
    const msgHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "uint64", "uint256", "address", "address"],
        [dep.custodianId, chainId, chainId, reserve.address, c.CustodianRegistry]
      )
    );
    const sig = await reserve.signMessage(ethers.getBytes(msgHash));
    return registry.addReserveWallet(dep.custodianId, chainId, reserve.address, sig);
  });
  await step("configUSDG", () =>
    assetConfig.setAssetConfig(
      dep.custodianId, USDG, USDG, chainId, false, 0, COVERAGE_BPS, MAX_ORACLE_AGE,
      MIN_SAMPLES, MIN_SAMPLE_GAP, ASSET_ID_USDG, [chainId]
    )
  );

  const users = [wallets.demoUser.address, ...PLACEHOLDERS];
  const usdgBook = path.join(BOOK_DIR, "mainnet-usdg.csv");
  if (!fs.existsSync(usdgBook) || process.env.FORCE_BOOKS === "1") {
    const total = writeBook(usdgBook, users, (usdgBal * BOOK_BPS) / 10000n, 10_000n);
    console.log(`Book ${path.relative(ROOT, usdgBook)}: ${ethers.formatUnits(total, 6)} USDG across 4 leaves`);
  }

  if (withTsla) {
    console.log(`TSLA uiMultiplier ${ethers.formatEther(await tsla.uiMultiplier())}`);
    await step("configTSLA", () =>
      assetConfig.setAssetConfig(
        dep.custodianId, TSLA, TSLA, chainId, true, 0, COVERAGE_BPS, MAX_ORACLE_AGE,
        MIN_SAMPLES, MIN_SAMPLE_GAP, ASSET_ID_TSLA, [chainId]
      )
    );
    c.TSLA = TSLA;
    dep.assetIds.tsla = ASSET_ID_TSLA;
    save(dep);
    const tslaBook = path.join(BOOK_DIR, "mainnet-tsla.csv");
    if (!fs.existsSync(tslaBook) || process.env.FORCE_BOOKS === "1") {
      const total = writeBook(tslaBook, users, (tslaBal * BOOK_BPS) / 10000n, 10n ** 12n);
      console.log(`Book ${path.relative(ROOT, tslaBook)}: ${ethers.formatEther(total)} TSLA across 4 leaves`);
    }
  } else {
    console.log("TSLA: skipped (reserve wallet holds none, or INCLUDE_TSLA=0)");
  }

  console.log(`\nWrote ${path.relative(ROOT, DEP_FILE)}. Next: npm run ops:cycle:rhmain`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
