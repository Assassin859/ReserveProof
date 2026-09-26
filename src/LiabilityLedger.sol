// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CustodianRegistry} from "./CustodianRegistry.sol";
import {AssetConfig} from "./AssetConfig.sol";
import {RPTypes} from "./libraries/RPTypes.sol";
import {IERC8056} from "./interfaces/IToken.sol";

/// @title LiabilityLedger
contract LiabilityLedger {
    CustodianRegistry public immutable registry;
    AssetConfig public immutable assetConfig;

    mapping(bytes32 => mapping(address => uint64)) public latestEpochId;
    mapping(bytes32 => mapping(address => mapping(uint64 => RPTypes.Epoch))) public epochs;

    event EpochCommitted(
        bytes32 indexed custodianId,
        address indexed asset,
        uint64 epochId,
        bytes32 liabilityRoot,
        uint256 totalLiability,
        uint256 allocation
    );

    error NotOperator();
    error Inactive();
    error NoConfig();
    error BadEpoch();
    error BadAllocation();
    error MultiplierRequired();
    error PendingMultiplier();

    constructor(CustodianRegistry registry_, AssetConfig assetConfig_) {
        registry = registry_;
        assetConfig = assetConfig_;
    }

    function commitEpoch(
        bytes32 custodianId,
        address asset,
        uint64 epochId,
        bytes32 liabilityRoot,
        uint256 totalLiability,
        uint256 allocation,
        uint256 multiplierSnapshot,
        uint8 unitMode
    ) external {
        (address op, bool active, ) = registry.custodians(custodianId);
        if (msg.sender != op) revert NotOperator();
        if (!active) revert Inactive();

        AssetConfig.Config memory cfg = assetConfig.getConfig(custodianId, asset);
        if (!cfg.exists) revert NoConfig();
        if (epochId == 0 || epochId <= latestEpochId[custodianId][asset]) revert BadEpoch();
        if (allocation == 0 || allocation > totalLiability) revert BadAllocation();
        if (unitMode != cfg.unitMode) revert BadEpoch();

        if (cfg.isStockToken) {
            uint256 liveMul = IERC8056(cfg.token).uiMultiplier();
            uint256 pendingAt = IERC8056(cfg.token).effectiveAt();
            if (pendingAt != 0 && pendingAt > block.timestamp) {
                // pending scheduled — allow commit only if snapshot matches current live mul
            }
            if (pendingAt != 0 && pendingAt <= block.timestamp) {
                // pending already effective path handled by uiMultiplier()
            }
            if (unitMode == RPTypes.UNIT_ECONOMIC) {
                if (multiplierSnapshot == 0) revert MultiplierRequired();
                if (multiplierSnapshot != liveMul) revert MultiplierRequired();
            }
            // Always store live multiplier for drift detection in RAW mode too.
            if (multiplierSnapshot == 0) multiplierSnapshot = liveMul;
            else if (multiplierSnapshot != liveMul) revert MultiplierRequired();

            // Reject commit if a future pending update is already scheduled (forces clear schedule).
            uint256 newMul = IERC8056(cfg.token).newUIMultiplier();
            if (pendingAt > block.timestamp && newMul != liveMul) revert PendingMultiplier();
        } else if (multiplierSnapshot == 0) {
            multiplierSnapshot = 1e18;
        }

        epochs[custodianId][asset][epochId] = RPTypes.Epoch({
            liabilityRoot: liabilityRoot,
            totalLiability: totalLiability,
            allocation: allocation,
            multiplierSnapshot: multiplierSnapshot,
            committedAt: uint64(block.timestamp),
            unitMode: unitMode,
            exists: true
        });
        latestEpochId[custodianId][asset] = epochId;
        emit EpochCommitted(custodianId, asset, epochId, liabilityRoot, totalLiability, allocation);
    }

    function getEpoch(
        bytes32 custodianId,
        address asset,
        uint64 epochId
    ) external view returns (RPTypes.Epoch memory) {
        return epochs[custodianId][asset][epochId];
    }
}
