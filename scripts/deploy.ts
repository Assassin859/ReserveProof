import hre from "hardhat";
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/** Official Paxos USDG test tokens (6 decimals). */
const USDG: Record<string, string> = {
  robinhoodTestnet: "0x7E955252E15c84f5768B83c41a71F9eba181802F",
  arbitrumSepolia: "0xFFC95faa3d63Cde504a05B567C600B78C0b41892",
};

const CLEAR_TIMELOCK = 3600;
const CHALLENGE_WINDOW = 3600;
const REMOVAL_DELAY = 3600;
const CUSTODIAN_NAME = process.env.CUSTODIAN_NAME || "kopi";
const DEPLOYMENT_SALT = ethers.id(process.env.DEPLOYMENT_SALT || "ReserveProof.v1");
const ASSET_ID_STOCK = ethers.id(process.env.ASSET_ID || "TSLA");
const ASSET_ID_USDG = ethers.id(process.env.ASSET_ID_USDG || "USDG");

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  let reserveWallet = signers[1];
  // Single-key testnets: derive an ephemeral reserve wallet and fund it.
  let ephemeralKey: string | undefined;
  if (!reserveWallet) {
    const funded = ethers.Wallet.createRandom().connect(ethers.provider);
    ephemeralKey = funded.privateKey;
    const fundTx = await deployer.sendTransaction({
      to: funded.address,
      value: ethers.parseEther("0.005"),
    });
    await fundTx.wait();
    reserveWallet = funded as typeof deployer;
    console.log(`Ephemeral reserve wallet funded: ${reserveWallet.address}`);
  }
  const network = await ethers.provider.getNetwork();
  const networkName = hre.network.name;
  const chainId = Number(network.chainId);

  console.log(`Deployer: ${deployer.address}`);
  console.log(`Reserve wallet: ${reserveWallet.address}`);
  console.log(`Network:  ${networkName} (chainId ${chainId})`);
  console.log(
    `Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`
  );

  let usdgAddress = USDG[networkName] || "";
  if (!usdgAddress) {
    const MockUSDG = await ethers.getContractFactory("MockUSDG");
    const usdg = await MockUSDG.deploy();
    await usdg.waitForDeployment();
    usdgAddress = await usdg.getAddress();
    console.log(`MockUSDG: ${usdgAddress}`);
  } else {
    console.log(`USDG (official): ${usdgAddress}`);
  }

  const Registry = await ethers.getContractFactory("CustodianRegistry");
  const registry = await Registry.deploy(deployer.address);
  await registry.waitForDeployment();
  console.log(`CustodianRegistry: ${await registry.getAddress()}`);

  const AssetConfig = await ethers.getContractFactory("AssetConfig");
  const assetConfig = await AssetConfig.deploy(deployer.address, await registry.getAddress());
  await assetConfig.waitForDeployment();
  console.log(`AssetConfig: ${await assetConfig.getAddress()}`);

  const Ledger = await ethers.getContractFactory("LiabilityLedger");
  const ledger = await Ledger.deploy(
    await registry.getAddress(),
    await assetConfig.getAddress(),
    DEPLOYMENT_SALT
  );
  await ledger.waitForDeployment();
  console.log(`LiabilityLedger: ${await ledger.getAddress()}`);
  console.log(`Deployment salt: ${DEPLOYMENT_SALT}`);

  const Sampler = await ethers.getContractFactory("ReserveSampler");
  const sampler = await Sampler.deploy(
    await registry.getAddress(),
    await assetConfig.getAddress(),
    await ledger.getAddress()
  );
  await sampler.waitForDeployment();
  console.log(`ReserveSampler: ${await sampler.getAddress()}`);

  const Disputes = await ethers.getContractFactory("DisputeModule");
  const disputes = await Disputes.deploy(
    await registry.getAddress(),
    await ledger.getAddress(),
    CLEAR_TIMELOCK,
    CHALLENGE_WINDOW
  );
  await disputes.waitForDeployment();
  console.log(`DisputeModule: ${await disputes.getAddress()}`);

  const Oracle = await ethers.getContractFactory("SolvencyOracle");
  const oracle = await Oracle.deploy(
    await registry.getAddress(),
    await assetConfig.getAddress(),
    await ledger.getAddress(),
    await sampler.getAddress(),
    await disputes.getAddress(),
    deployer.address
  );
  await oracle.waitForDeployment();
  console.log(`SolvencyOracle: ${await oracle.getAddress()}`);

  const ExitRight = await ethers.getContractFactory("ExitRight");
  const exitRight = await ExitRight.deploy(
    await registry.getAddress(),
    await ledger.getAddress(),
    usdgAddress
  );
  await exitRight.waitForDeployment();
  console.log(`ExitRight: ${await exitRight.getAddress()}`);

  await (await oracle.setExitRight(await exitRight.getAddress())).wait();
  console.log("Oracle ← ExitRight linked");

  const Stock = await ethers.getContractFactory("MockStockToken");
  const stock = await Stock.deploy("Mock TSLA", "mTSLA");
  await stock.waitForDeployment();
  console.log(`MockStockToken: ${await stock.getAddress()}`);

  const custodianId = ethers.id(CUSTODIAN_NAME);
  await (await registry.registerCustodian(custodianId, deployer.address, REMOVAL_DELAY)).wait();
  console.log(`Custodian registered: ${CUSTODIAN_NAME} → ${custodianId}`);

  // Ownership proof: keccak(custodianId, chainId, block.chainid, wallet, registry)
  const msgHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint64", "uint256", "address", "address"],
      [custodianId, chainId, network.chainId, reserveWallet.address, await registry.getAddress()]
    )
  );
  const sig = await reserveWallet.signMessage(ethers.getBytes(msgHash));
  await (await registry.addReserveWallet(custodianId, chainId, reserveWallet.address, sig)).wait();
  console.log(`Reserve wallet registered: ${reserveWallet.address}`);

  // Seed reserves well above 103% of example liabilities (500e18 total in CLI sample CSV)
  const seedAmount = ethers.parseEther("1000");
  await (await stock.mint(reserveWallet.address, seedAmount)).wait();
  console.log(`Minted ${ethers.formatEther(seedAmount)} mTSLA to reserve wallet`);

  // Dual-chain USDG allowlist when on RH / Arb Sepolia; else local-only.
  const dualChains = [46630, 421614];
  const usdgAllocChains =
    chainId === 46630 || chainId === 421614 ? dualChains : [chainId];
  const stockAllocChains = [chainId];

  await (
    await assetConfig.setAssetConfig(
      custodianId,
      await stock.getAddress(),
      await stock.getAddress(),
      chainId,
      true,
      0,
      10300,
      7 * 24 * 3600,
      2,
      60,
      ASSET_ID_STOCK,
      stockAllocChains
    )
  ).wait();
  console.log("AssetConfig: mock stock configured");

  await (
    await assetConfig.setAssetConfig(
      custodianId,
      usdgAddress,
      usdgAddress,
      chainId,
      false,
      0,
      10300,
      7 * 24 * 3600,
      2,
      60,
      ASSET_ID_USDG,
      usdgAllocChains
    )
  ).wait();
  console.log("AssetConfig: USDG configured");

  const GatedPayout = await ethers.getContractFactory("GatedPayout");
  const gatedPayout = await GatedPayout.deploy(
    await oracle.getAddress(),
    custodianId,
    await stock.getAddress()
  );
  await gatedPayout.waitForDeployment();
  console.log(`GatedPayout: ${await gatedPayout.getAddress()}`);

  const GatedLend = await ethers.getContractFactory("GatedLendWithdraw");
  const gatedLend = await GatedLend.deploy(
    await oracle.getAddress(),
    custodianId,
    await stock.getAddress()
  );
  await gatedLend.waitForDeployment();
  console.log(`GatedLendWithdraw: ${await gatedLend.getAddress()}`);

  const deployment = {
    network: networkName,
    chainId,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    reserveWallet: reserveWallet.address,
    custodianName: CUSTODIAN_NAME,
    custodianId,
    deploymentSalt: DEPLOYMENT_SALT,
    assetIds: {
      stock: ASSET_ID_STOCK,
      usdg: ASSET_ID_USDG,
    },
    contracts: {
      CustodianRegistry: await registry.getAddress(),
      AssetConfig: await assetConfig.getAddress(),
      LiabilityLedger: await ledger.getAddress(),
      ReserveSampler: await sampler.getAddress(),
      DisputeModule: await disputes.getAddress(),
      SolvencyOracle: await oracle.getAddress(),
      ExitRight: await exitRight.getAddress(),
      GatedPayout: await gatedPayout.getAddress(),
      GatedLendWithdraw: await gatedLend.getAddress(),
      MockStockToken: await stock.getAddress(),
      USDG: usdgAddress,
    },
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${networkName}.json`);
  fs.writeFileSync(outFile, JSON.stringify(deployment, null, 2));
  console.log(`\nWrote ${outFile}`);

  // Never commit private keys — write secrets only to gitignored *.local.json
  if (ephemeralKey) {
    const localFile = path.join(outDir, `${networkName}.local.json`);
    fs.writeFileSync(
      localFile,
      JSON.stringify(
        {
          network: networkName,
          reserveWallet: reserveWallet.address,
          reserveWalletPrivateKey: ephemeralKey,
        },
        null,
        2
      )
    );
    console.log(`Wrote reserve key to ${localFile} (gitignored — do not commit)`);
  }

  console.log(JSON.stringify(deployment.contracts, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
