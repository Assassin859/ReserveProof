// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ISolvencyOracle — the read surface integrators need to gate on a custodian's solvency.
/// @notice `SolvencyStatus` is ABI-identical to `RPTypes.SolvencyStatus`, so this interface can be
///         pointed at a deployed `SolvencyOracle` without importing the rest of ReserveProof.
interface ISolvencyOracle {
    struct SolvencyStatus {
        bool ok;
        uint64 epochId;
        uint64 updatedAt;
        uint8 reason;
    }

    function isSolvent(
        bytes32 custodianId,
        address asset
    ) external view returns (bool ok, uint64 epochId, uint64 updatedAt);

    function status(bytes32 custodianId, address asset) external view returns (SolvencyStatus memory);
}
