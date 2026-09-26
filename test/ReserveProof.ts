import { expect } from "chai";
import { ethers } from "hardhat";
import { buildSortedTree } from "./helpers/merkle";

describe("ReserveProof", function () {
  async function deployFixture() {
    const [owner, operator, userA, userB, wallet1] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("CustodianRegistry");
    const registry = await Registry.deploy(owner.address);

    const AssetConfig = await ethers.getContractFactory("AssetConfig");
    const assetConfig = await AssetConfig.deploy(owner.address, await registry.getAddress());

    const Ledger = await ethers.getContractFactory("LiabilityLedger");
    const ledger = await Ledger.deploy(await registry.getAddress(), await assetConfig.getAddress());

    const Sampler = await ethers.getContractFactory("ReserveSampler");
    const sampler = await Sampler.deploy(
      await registry.getAddress(),
      await assetConfig.getAddress(),
      await ledger.getAddress()
    );

    const Disputes = await ethers.getContractFactory("DisputeModule");
    const disputes = await Disputes.deploy(await registry.getAddress(), await ledger.getAddress(), 3600);

    const Oracle = await ethers.getContractFactory("SolvencyOracle");
    const oracle = await Oracle.deploy(
      await registry.getAddress(),
      await assetConfig.getAddress(),
      await ledger.getAddress(),
      await sampler.getAddress(),
      await disputes.getAddress()
    );

    const USDG = await ethers.getContractFactory("MockUSDG");
    const usdg = await USDG.deploy();

    const ExitRight = await ethers.getContractFactory("ExitRight");
    const exitRight = await ExitRight.deploy(
      await registry.getAddress(),
      await ledger.getAddress(),
      await usdg.getAddress()
    );
    await oracle.setExitRight(await exitRight.getAddress());

    const Stock = await ethers.getContractFactory("MockStockToken");
    const stock = await Stock.deploy("Mock TSLA", "mTSLA");

    const custodianId = ethers.id("kopi");
    await registry.registerCustodian(custodianId, operator.address, 3600);

    // ownership proof: wallet1 signs binding
    const network = await ethers.provider.getNetwork();
    const chainId = Number(network.chainId);
    const msgHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "uint64", "address", "address"],
        [custodianId, chainId, wallet1.address, await registry.getAddress()]
      )
    );
    const sig = await wallet1.signMessage(ethers.getBytes(msgHash));
    await registry.connect(operator).addReserveWallet(custodianId, chainId, wallet1.address, sig);

    await assetConfig.connect(operator).setAssetConfig(
      custodianId,
      await stock.getAddress(),
      await stock.getAddress(),
      chainId,
      true,
      0, // RAW
      10300,
      7 * 24 * 3600,
      2,
      1 // minSampleGap 1s for tests
    );

    await stock.mint(wallet1.address, ethers.parseEther("1000"));
    await usdg.mint(operator.address, 1_000_000n * 1_000_000n);

    return {
      owner,
      operator,
      userA,
      userB,
      wallet1,
      registry,
      assetConfig,
      ledger,
      sampler,
      disputes,
      oracle,
      exitRight,
      usdg,
      stock,
      custodianId,
      chainId,
    };
  }

  it("is solvent when samples + live cover allocation", async function () {
    const { operator, userA, userB, wallet1, ledger, sampler, oracle, stock, custodianId } =
      await deployFixture();

    const asset = await stock.getAddress();
    const epochId = 1;
    const leaves = [
      { user: userA.address, amount: ethers.parseEther("100") },
      { user: userB.address, amount: ethers.parseEther("200") },
    ];
    const { root, total, proofs } = buildSortedTree(custodianId, asset, epochId, leaves);
    expect(total).to.equal(ethers.parseEther("300"));

    // allocation = full total on this chain
    await ledger
      .connect(operator)
      .commitEpoch(custodianId, asset, epochId, root, total, total, ethers.parseEther("1"), 0);

    await sampler.connect(operator).setSampleWallets(custodianId, asset, [wallet1.address]);

    await sampler.connect(operator).recordSample(custodianId, asset);
    await ethers.provider.send("evm_increaseTime", [2]);
    await ethers.provider.send("evm_mine", []);
    await sampler.connect(operator).recordSample(custodianId, asset);

    const [ok, eid] = await oracle.isSolvent(custodianId, asset);
    expect(ok).to.equal(true);
    expect(eid).to.equal(epochId);

    // inclusion proof sanity for userA
    const proof = proofs.get(userA.address.toLowerCase())!;
    expect(proof.length).to.be.greaterThan(0);
  });

  it("fails closed when live reserves drained", async function () {
    const { operator, userA, userB, wallet1, ledger, sampler, oracle, stock, custodianId } =
      await deployFixture();

    const asset = await stock.getAddress();
    const epochId = 1;
    const leaves = [
      { user: userA.address, amount: ethers.parseEther("100") },
      { user: userB.address, amount: ethers.parseEther("200") },
    ];
    const { root, total } = buildSortedTree(custodianId, asset, epochId, leaves);

    await ledger
      .connect(operator)
      .commitEpoch(custodianId, asset, epochId, root, total, total, ethers.parseEther("1"), 0);
    await sampler.connect(operator).setSampleWallets(custodianId, asset, [wallet1.address]);
    await sampler.connect(operator).recordSample(custodianId, asset);
    await ethers.provider.send("evm_increaseTime", [2]);
    await ethers.provider.send("evm_mine", []);
    await sampler.connect(operator).recordSample(custodianId, asset);

    // drain wallet
    await stock.connect(wallet1).transfer(operator.address, await stock.balanceOf(wallet1.address));

    const status = await oracle.status(custodianId, asset);
    expect(status.ok).to.equal(false);
    expect(status.reason).to.equal(6); // LIVE_SHORT
  });

  it("gated payout reverts while insolvent", async function () {
    const { operator, userA, userB, wallet1, ledger, sampler, oracle, stock, custodianId } =
      await deployFixture();

    const asset = await stock.getAddress();
    const Gated = await ethers.getContractFactory("GatedPayout");
    const gated = await Gated.deploy(await oracle.getAddress(), custodianId, asset);

    // no epoch => insolvent
    await stock.mint(userA.address, ethers.parseEther("10"));
    await stock.connect(userA).approve(await gated.getAddress(), ethers.parseEther("10"));
    await gated.connect(userA).deposit(ethers.parseEther("10"));
    await expect(gated.connect(userA).payout(userB.address, ethers.parseEther("1"))).to.be.revertedWithCustomError(
      gated,
      "Insolvent"
    );

    // silence unused
    void operator;
    void wallet1;
    void ledger;
    void sampler;
  });

  it("multiplier drift fails closed", async function () {
    const { operator, userA, userB, wallet1, ledger, sampler, oracle, stock, custodianId } =
      await deployFixture();

    const asset = await stock.getAddress();
    const epochId = 1;
    const leaves = [
      { user: userA.address, amount: ethers.parseEther("100") },
      { user: userB.address, amount: ethers.parseEther("200") },
    ];
    const { root, total } = buildSortedTree(custodianId, asset, epochId, leaves);
    await ledger
      .connect(operator)
      .commitEpoch(custodianId, asset, epochId, root, total, total, ethers.parseEther("1"), 0);
    await sampler.connect(operator).setSampleWallets(custodianId, asset, [wallet1.address]);
    await sampler.connect(operator).recordSample(custodianId, asset);
    await ethers.provider.send("evm_increaseTime", [2]);
    await ethers.provider.send("evm_mine", []);
    await sampler.connect(operator).recordSample(custodianId, asset);

    await stock.setUIMultiplierNow(ethers.parseEther("1.05"));
    const status = await oracle.status(custodianId, asset);
    expect(status.ok).to.equal(false);
    expect(status.reason).to.equal(7); // MULTIPLIER_DRIFT
  });
});
