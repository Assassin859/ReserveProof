// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Shared enums / reason codes for ReserveProof.
library RPTypes {
    uint8 internal constant UNIT_RAW = 0;
    uint8 internal constant UNIT_ECONOMIC = 1;

    uint8 internal constant REASON_OK = 0;
    uint8 internal constant REASON_NO_EPOCH = 1;
    uint8 internal constant REASON_STALE = 2;
    uint8 internal constant REASON_DISPUTED = 3;
    uint8 internal constant REASON_INSUFFICIENT_SAMPLES = 4;
    uint8 internal constant REASON_UNDERCOLLATERALIZED = 5;
    uint8 internal constant REASON_LIVE_SHORT = 6;
    uint8 internal constant REASON_MULTIPLIER_DRIFT = 7;
    uint8 internal constant REASON_EXIT_DEFAULT = 8;
    uint8 internal constant REASON_INACTIVE = 9;

    struct SolvencyStatus {
        bool ok;
        uint64 epochId;
        uint64 updatedAt;
        uint8 reason;
    }

    struct Epoch {
        bytes32 liabilityRoot;
        uint256 totalLiability;
        uint256 allocation;
        uint256 multiplierSnapshot;
        uint64 committedAt;
        uint8 unitMode;
        bool exists;
        uint32 leafCount;
        bytes32 allocationCommitment;
    }
}
