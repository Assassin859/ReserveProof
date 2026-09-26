// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CustodianRegistry} from "./CustodianRegistry.sol";
import {AssetConfig} from "./AssetConfig.sol";
import {LiabilityLedger} from "./LiabilityLedger.sol";
import {ReserveSampler} from "./ReserveSampler.sol";
import {DisputeModule} from "./DisputeModule.sol";
import {RPTypes} from "./libraries/RPTypes.sol";
import {IERC8056} from "./interfaces/IToken.sol";

interface IExitRightFlag {
    function hasExitDefault(bytes32 custodianId, address asset) external view returns (bool);
}

/// @title SolvencyOracle
contract SolvencyOracle {
    CustodianRegistry public immutable registry;
    AssetConfig public immutable assetConfig;
    LiabilityLedger public immutable ledger;
    ReserveSampler public immutable sampler;
    DisputeModule public immutable disputes;
    IExitRightFlag public exitRight;

    event ExitRightSet(address exitRight);

    error ExitRightAlreadySet();

    constructor(
        CustodianRegistry registry_,
        AssetConfig assetConfig_,
        LiabilityLedger ledger_,
        ReserveSampler sampler_,
        DisputeModule disputes_
    ) {
        registry = registry_;
        assetConfig = assetConfig_;
        ledger = ledger_;
        sampler = sampler_;
        disputes = disputes_;
    }

    function setExitRight(address exitRight_) external {
        if (address(exitRight) != address(0)) revert ExitRightAlreadySet();
        exitRight = IExitRightFlag(exitRight_);
        emit ExitRightSet(exitRight_);
    }

    function isSolvent(
        bytes32 custodianId,
        address asset
    ) external view returns (bool ok, uint64 epochId, uint64 updatedAt) {
        RPTypes.SolvencyStatus memory s = status(custodianId, asset);
        return (s.ok, s.epochId, s.updatedAt);
    }

    function status(
        bytes32 custodianId,
        address asset
    ) public view returns (RPTypes.SolvencyStatus memory s) {
        (, bool active, ) = registry.custodians(custodianId);
        if (!active) {
            return RPTypes.SolvencyStatus(false, 0, 0, RPTypes.REASON_INACTIVE);
        }

        uint64 epochId = ledger.latestEpochId(custodianId, asset);
        if (epochId == 0) {
            return RPTypes.SolvencyStatus(false, 0, 0, RPTypes.REASON_NO_EPOCH);
        }

        RPTypes.Epoch memory ep = ledger.getEpoch(custodianId, asset, epochId);
        AssetConfig.Config memory cfg = assetConfig.getConfig(custodianId, asset);

        if (disputes.isDisputed(custodianId, asset)) {
            return RPTypes.SolvencyStatus(false, epochId, ep.committedAt, RPTypes.REASON_DISPUTED);
        }

        if (address(exitRight) != address(0) && exitRight.hasExitDefault(custodianId, asset)) {
            return RPTypes.SolvencyStatus(false, epochId, ep.committedAt, RPTypes.REASON_EXIT_DEFAULT);
        }

        if (cfg.maxOracleAge > 0 && block.timestamp > uint256(ep.committedAt) + cfg.maxOracleAge) {
            return RPTypes.SolvencyStatus(false, epochId, ep.committedAt, RPTypes.REASON_STALE);
        }

        if (cfg.isStockToken) {
            uint256 liveMul = IERC8056(cfg.token).uiMultiplier();
            if (liveMul != ep.multiplierSnapshot) {
                return RPTypes.SolvencyStatus(false, epochId, ep.committedAt, RPTypes.REASON_MULTIPLIER_DRIFT);
            }
            uint256 pendingAt = IERC8056(cfg.token).effectiveAt();
            uint256 newMul = IERC8056(cfg.token).newUIMultiplier();
            if (pendingAt > block.timestamp && newMul != 0 && newMul != liveMul) {
                return RPTypes.SolvencyStatus(false, epochId, ep.committedAt, RPTypes.REASON_MULTIPLIER_DRIFT);
            }
        }

        (uint256 sampleMinimum, uint256 sampleCount_) = sampler.sampleMin(custodianId, asset, epochId);
        if (sampleCount_ < cfg.minSamples) {
            return
                RPTypes.SolvencyStatus(false, epochId, ep.committedAt, RPTypes.REASON_INSUFFICIENT_SAMPLES);
        }

        uint256 live = sampler.liveReserves(custodianId, asset);
        uint256 effective = sampleMinimum < live ? sampleMinimum : live;
        uint256 need = (ep.allocation * uint256(cfg.coverageFloorBps)) / 10_000;

        if (live < need) {
            return RPTypes.SolvencyStatus(false, epochId, ep.committedAt, RPTypes.REASON_LIVE_SHORT);
        }
        if (effective < need) {
            return RPTypes.SolvencyStatus(false, epochId, ep.committedAt, RPTypes.REASON_UNDERCOLLATERALIZED);
        }

        return RPTypes.SolvencyStatus(true, epochId, ep.committedAt, RPTypes.REASON_OK);
    }
}
