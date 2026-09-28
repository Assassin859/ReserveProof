// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISolvencyOracle} from "../interfaces/ISolvencyOracle.sol";

/// @title SolvencyGuard — drop-in modifier that fails closed when a custodian's proof of reserves fails.
/// @notice Inherit, pass the oracle and custodian, and put `onlySolvent(asset)` on any function that
///         should stop while the custodian is stale, disputed, short or otherwise not provably solvent.
///         The revert carries the oracle's reason code (RPTypes.REASON_*).
abstract contract SolvencyGuard {
    ISolvencyOracle public immutable solvencyOracle;
    bytes32 public immutable custodianId;

    error Insolvent(uint8 reason);
    error ZeroOracle();

    constructor(ISolvencyOracle oracle_, bytes32 custodianId_) {
        if (address(oracle_) == address(0)) revert ZeroOracle();
        solvencyOracle = oracle_;
        custodianId = custodianId_;
    }

    modifier onlySolvent(address asset) {
        _requireSolvent(asset);
        _;
    }

    function _requireSolvent(address asset) internal view {
        ISolvencyOracle.SolvencyStatus memory s = solvencyOracle.status(custodianId, asset);
        if (!s.ok) revert Insolvent(s.reason);
    }
}
