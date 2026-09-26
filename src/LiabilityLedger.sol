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

    /// @notice Commit an epoch. `allocationChainIds` / `allocations` must cover every chain slice
    ///         and sum exactly to `totalLiability`. Local `allocation` is the entry for this chain.
    function commitEpoch(
        bytes32 custodianId,
        address asset,
        uint64 epochId,
        bytes32 liabilityRoot,
        uint256 totalLiability,
        uint64[] calldata allocationChainIds,
        uint256[] calldata allocations,
        uint256 multiplierSnapshot,
        uint8 unitMode
    ) external {
        (address op, bool active, ) = registry.custodians(custodianId);
        if (msg.sender != op) revert NotOperator();
        if (!active) revert Inactive();

        AssetConfig.Config memory cfg = assetConfig.getConfig(custodianId, asset);
        if (!cfg.exists) revert NoConfig();
        if (epochId == 0 || epochId <= latestEpochId[custodianId][asset]) revert BadEpoch();
        if (unitMode != cfg.unitMode) revert BadEpoch();

        uint256 allocation = _localAllocation(cfg.chainId, totalLiability, allocationChainIds, allocations);

        if (cfg.isStockToken) {
            uint256 liveMul = IERC8056(cfg.token).uiMultiplier();
            uint256 pendingAt = IERC8056(cfg.token).effectiveAt();
            if (unitMode == RPTypes.UNIT_ECONOMIC) {
                if (multiplierSnapshot == 0) revert MultiplierRequired();
                if (multiplierSnapshot != liveMul) revert MultiplierRequired();
            }
            if (multiplierSnapshot == 0) multiplierSnapshot = liveMul;
            else if (multiplierSnapshot != liveMul) revert MultiplierRequired();

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

    function _localAllocation(
        uint64 localChainId,
        uint256 totalLiability,
        uint64[] calldata allocationChainIds,
        uint256[] calldata allocations
    ) internal pure returns (uint256 local) {
        if (allocationChainIds.length == 0 || allocationChainIds.length != allocations.length) {
            revert BadAllocation();
        }
        uint256 sum;
        bool found;
        for (uint256 i = 0; i < allocations.length; i++) {
            if (allocations[i] == 0) revert BadAllocation();
            // Reject duplicate chain ids.
            for (uint256 j = 0; j < i; j++) {
                if (allocationChainIds[j] == allocationChainIds[i]) revert BadAllocation();
            }
            sum += allocations[i];
            if (allocationChainIds[i] == localChainId) {
                local = allocations[i];
                found = true;
            }
        }
        if (!found || sum != totalLiability) revert BadAllocation();
    }
}
