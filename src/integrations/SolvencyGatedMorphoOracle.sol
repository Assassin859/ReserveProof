// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SolvencyGuard} from "../guards/SolvencyGuard.sol";
import {ISolvencyOracle} from "../interfaces/ISolvencyOracle.sol";

/// @notice Morpho Blue's oracle interface (morpho-blue/src/interfaces/IOracle.sol), redeclared so this
///         contract compiles without the Morpho sources.
interface IMorphoOracle {
    /// @return Price of 1 collateral asset in loan asset, scaled by 1e36 (adjusted for decimals).
    function price() external view returns (uint256);
}

/// @title SolvencyGatedMorphoOracle — a Morpho Blue oracle that stops pricing custodial collateral
///        while its custodian's proof of reserves fails.
/// @notice Wraps an existing Morpho oracle. `price()` forwards the base price while the custodian is
///         provably solvent for `asset`, and reverts `Insolvent(reason)` otherwise.
/// @dev Reverting, not returning 0, is deliberate. Morpho calls `price()` in `borrow`,
///      `withdrawCollateral` (with debt) and `liquidate`. A price of 0 would make every position
///      liquidatable and let liquidators seize collateral for nothing; a revert freezes those paths
///      instead. Morpho skips the oracle for positions without debt, so `supply`, `withdraw`,
///      `supplyCollateral`, `repay` and debt-free `withdrawCollateral` keep working: lenders and
///      borrowers can always de-risk. When the proof recovers, pricing resumes on its own.
contract SolvencyGatedMorphoOracle is IMorphoOracle, SolvencyGuard {
    IMorphoOracle public immutable baseOracle;
    /// @notice The custodial token whose solvency gates pricing (usually the market's collateral).
    address public immutable asset;

    error ZeroAddress();

    constructor(
        IMorphoOracle baseOracle_,
        ISolvencyOracle solvencyOracle_,
        bytes32 custodianId_,
        address asset_
    ) SolvencyGuard(solvencyOracle_, custodianId_) {
        if (address(baseOracle_) == address(0) || asset_ == address(0)) revert ZeroAddress();
        baseOracle = baseOracle_;
        asset = asset_;
    }

    function price() external view onlySolvent(asset) returns (uint256) {
        return baseOracle.price();
    }
}
