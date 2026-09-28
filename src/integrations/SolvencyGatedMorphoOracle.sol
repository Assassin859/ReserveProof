// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SolvencyGuard} from "../guards/SolvencyGuard.sol";
import {ISolvencyOracle} from "../interfaces/ISolvencyOracle.sol";
import {RPTypes} from "../libraries/RPTypes.sol";

/// @notice Morpho Blue's oracle interface (morpho-blue/src/interfaces/IOracle.sol), redeclared so this
///         contract compiles without the Morpho sources.
interface IMorphoOracle {
    /// @return Price of 1 collateral asset in loan asset, scaled by 1e36 (adjusted for decimals).
    function price() external view returns (uint256);
}

/// @title SolvencyGatedMorphoOracle — a Morpho Blue oracle that stops pricing custodial collateral
///        while there is evidence its custodian is short, for a bounded time.
/// @notice Wraps an existing Morpho oracle. `price()` forwards the base price unless the custodian's
///         proof fails with one of `blockingReasons`, in which case it reverts `Insolvent(reason)`.
///         The default mask blocks on evidence of a shortfall (LIVE_SHORT, UNDERCOLLATERALIZED,
///         DISPUTED, EXIT_DEFAULT). A missed publish (STALE), an unaccounted split (MULTIPLIER_DRIFT),
///         missing samples, no epoch yet, or a deactivated custodian keep forwarding the price: they
///         are not evidence the collateral is unbacked, and freezing on them would only put lenders at
///         risk.
/// @dev Why revert rather than return 0: a price of 0 makes every position liquidatable and lets
///      liquidators seize collateral for nothing. Why the freeze is bounded: Morpho calls `price()`
///      in `borrow`, indebted `withdrawCollateral` and `liquidate` alike and cannot tell them apart,
///      so while `price()` reverts, underwater loans cannot be liquidated either. Left unbounded, a
///      custodian could shield a borrower, and lenders could end up with bad debt. So a freeze lasts
///      at most `maxFreeze` after anyone calls `poke()` during a blocking failure (liquidators have
///      every reason to); after that `price()` forwards the base price again and liquidations clear.
///      The freeze is a circuit breaker that buys vault curators time to pull liquidity or set caps to
///      zero, not a permanent halt. Morpho skips the oracle for positions without debt, so `supply`,
///      `withdraw`, `supplyCollateral`, `repay` and debt-free `withdrawCollateral` always work.
///      A `freezeStartedAt` left over from an earlier incident (nobody poked after recovery) can only
///      shorten the next freeze, which errs toward lenders.
contract SolvencyGatedMorphoOracle is IMorphoOracle, SolvencyGuard {
    uint16 public constant DEFAULT_BLOCKING_REASONS = uint16(
        (1 << RPTypes.REASON_LIVE_SHORT) |
            (1 << RPTypes.REASON_UNDERCOLLATERALIZED) |
            (1 << RPTypes.REASON_DISPUTED) |
            (1 << RPTypes.REASON_EXIT_DEFAULT)
    );

    IMorphoOracle public immutable baseOracle;
    /// @notice The custodial token whose solvency gates pricing (usually the market's collateral).
    address public immutable asset;
    /// @notice Bit `r` set means oracle reason `r` stops pricing.
    uint16 public immutable blockingReasons;
    /// @notice Longest a blocking failure can freeze pricing, counted from the first `poke()`.
    uint32 public immutable maxFreeze;

    /// @notice When the current freeze was first poked (0 = no freeze clock running).
    uint64 public freezeStartedAt;

    event FreezeStarted(uint8 reason, uint256 at);
    event FreezeCleared(uint256 at);

    error ZeroAddress();
    error ZeroMaxFreeze();

    constructor(
        IMorphoOracle baseOracle_,
        ISolvencyOracle solvencyOracle_,
        bytes32 custodianId_,
        address asset_,
        uint16 blockingReasons_,
        uint32 maxFreeze_
    ) SolvencyGuard(solvencyOracle_, custodianId_) {
        if (address(baseOracle_) == address(0) || asset_ == address(0)) revert ZeroAddress();
        if (maxFreeze_ == 0) revert ZeroMaxFreeze();
        baseOracle = baseOracle_;
        asset = asset_;
        blockingReasons = blockingReasons_;
        maxFreeze = maxFreeze_;
    }

    /// @notice Whether oracle reason `reason` stops pricing (before the freeze cap).
    function blocks(uint8 reason) public view returns (bool) {
        return reason != RPTypes.REASON_OK && reason < 16 && ((blockingReasons >> reason) & 1) == 1;
    }

    function price() external view returns (uint256) {
        ISolvencyOracle.SolvencyStatus memory s = solvencyOracle.status(custodianId, asset);
        if (s.ok || !blocks(s.reason)) return baseOracle.price();
        uint256 t = freezeStartedAt;
        if (t != 0 && block.timestamp >= t + maxFreeze) return baseOracle.price();
        revert Insolvent(s.reason);
    }

    /// @notice Start the freeze clock during a blocking failure, or clear it once the proof is healthy
    ///         (or failing only for a non-blocking reason). Permissionless.
    /// @return frozen True while a blocking failure is in progress.
    function poke() external returns (bool frozen) {
        ISolvencyOracle.SolvencyStatus memory s = solvencyOracle.status(custodianId, asset);
        if (!s.ok && blocks(s.reason)) {
            if (freezeStartedAt == 0) {
                freezeStartedAt = uint64(block.timestamp);
                emit FreezeStarted(s.reason, block.timestamp);
            }
            return true;
        }
        if (freezeStartedAt != 0) {
            freezeStartedAt = 0;
            emit FreezeCleared(block.timestamp);
        }
        return false;
    }
}
