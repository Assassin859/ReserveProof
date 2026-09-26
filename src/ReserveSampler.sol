// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CustodianRegistry} from "./CustodianRegistry.sol";
import {AssetConfig} from "./AssetConfig.sol";
import {LiabilityLedger} from "./LiabilityLedger.sol";
import {ArbBlock} from "./libraries/ArbBlock.sol";
import {RPTypes} from "./libraries/RPTypes.sol";
import {IERC20Minimal, IERC8056} from "./interfaces/IToken.sol";

/// @title ReserveSampler
/// @notice Epoch-tied multi-sample reserves using arbBlockNumber + time gap; live reads separate.
contract ReserveSampler {
    CustodianRegistry public immutable registry;
    AssetConfig public immutable assetConfig;
    LiabilityLedger public immutable ledger;

    struct Sample {
        uint256 arbBlock;
        uint64 timestamp;
        uint256 reserves;
    }

    // custodian => asset => epoch => samples
    mapping(bytes32 => mapping(address => mapping(uint64 => Sample[]))) internal _samples;

    // operator-maintained list of wallets to sample for (custodian, asset) on this chain
    mapping(bytes32 => mapping(address => address[])) public sampleWallets;

    event SampleRecorded(bytes32 indexed custodianId, address indexed asset, uint64 epochId, uint256 reserves);
    event SampleWalletsSet(bytes32 indexed custodianId, address indexed asset, uint256 count);

    error NotOperator();
    error NoEpoch();
    error TooEarly();
    error SameBlock();
    error BadWallet();

    constructor(CustodianRegistry registry_, AssetConfig assetConfig_, LiabilityLedger ledger_) {
        registry = registry_;
        assetConfig = assetConfig_;
        ledger = ledger_;
    }

    function setSampleWallets(bytes32 custodianId, address asset, address[] calldata wallets) external {
        (address op, , ) = registry.custodians(custodianId);
        if (msg.sender != op) revert NotOperator();
        AssetConfig.Config memory cfg = assetConfig.getConfig(custodianId, asset);
        for (uint256 i = 0; i < wallets.length; i++) {
            if (!registry.isReserveWallet(custodianId, cfg.chainId, wallets[i])) revert BadWallet();
        }
        sampleWallets[custodianId][asset] = wallets;
        emit SampleWalletsSet(custodianId, asset, wallets.length);
    }

    function recordSample(bytes32 custodianId, address asset) external {
        (address op, , ) = registry.custodians(custodianId);
        if (msg.sender != op) revert NotOperator();

        uint64 epochId = ledger.latestEpochId(custodianId, asset);
        if (epochId == 0) revert NoEpoch();
        RPTypes.Epoch memory ep = ledger.getEpoch(custodianId, asset, epochId);
        if (!ep.exists) revert NoEpoch();

        AssetConfig.Config memory cfg = assetConfig.getConfig(custodianId, asset);
        Sample[] storage list = _samples[custodianId][asset][epochId];

        uint256 arb = ArbBlock.current();
        if (list.length > 0) {
            Sample storage last = list[list.length - 1];
            if (arb == last.arbBlock) revert SameBlock();
            if (block.timestamp < uint256(last.timestamp) + cfg.minSampleGap) revert TooEarly();
        }
        // Samples only count after commit — enforced by using current latest epoch committedAt implicitly
        // (recording only allowed for latest epoch which exists post-commit).
        if (block.timestamp < ep.committedAt) revert TooEarly();

        uint256 reserves = _sumReserves(custodianId, asset, cfg, ep.unitMode);
        list.push(Sample({arbBlock: arb, timestamp: uint64(block.timestamp), reserves: reserves}));
        emit SampleRecorded(custodianId, asset, epochId, reserves);
    }

    function sampleCount(bytes32 custodianId, address asset, uint64 epochId) external view returns (uint256) {
        return _samples[custodianId][asset][epochId].length;
    }

    function sampleMin(bytes32 custodianId, address asset, uint64 epochId) public view returns (uint256 minVal, uint256 count) {
        Sample[] storage list = _samples[custodianId][asset][epochId];
        count = list.length;
        if (count == 0) return (0, 0);
        minVal = type(uint256).max;
        for (uint256 i = 0; i < count; i++) {
            if (list[i].reserves < minVal) minVal = list[i].reserves;
        }
    }

    function liveReserves(bytes32 custodianId, address asset) public view returns (uint256) {
        AssetConfig.Config memory cfg = assetConfig.getConfig(custodianId, asset);
        uint64 epochId = ledger.latestEpochId(custodianId, asset);
        uint8 unitMode = cfg.unitMode;
        if (epochId != 0) {
            RPTypes.Epoch memory ep = ledger.getEpoch(custodianId, asset, epochId);
            unitMode = ep.unitMode;
        }
        return _sumReserves(custodianId, asset, cfg, unitMode);
    }

    function effectiveReserves(
        bytes32 custodianId,
        address asset,
        uint64 epochId
    ) external view returns (uint256) {
        (uint256 sMin, uint256 count) = sampleMin(custodianId, asset, epochId);
        uint256 live = liveReserves(custodianId, asset);
        if (count == 0) return live; // oracle will still fail on insufficient samples
        return sMin < live ? sMin : live;
    }

    function _sumReserves(
        bytes32 custodianId,
        address asset,
        AssetConfig.Config memory cfg,
        uint8 unitMode
    ) internal view returns (uint256 total) {
        address[] storage wallets = sampleWallets[custodianId][asset];
        uint256 m = 1e18;
        if (cfg.isStockToken) {
            m = IERC8056(cfg.token).uiMultiplier();
        }
        for (uint256 i = 0; i < wallets.length; i++) {
            uint256 raw = IERC20Minimal(cfg.token).balanceOf(wallets[i]);
            if (unitMode == RPTypes.UNIT_ECONOMIC && cfg.isStockToken) {
                total += (raw * m) / 1e18;
            } else {
                total += raw;
            }
        }
    }
}
