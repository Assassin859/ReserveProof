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
///        while its custodian's proof of reserves fails, for a bounded time.
/// @notice Wraps an existing Morpho oracle. `price()` forwards the base price while the proof is OK
///         and reverts `Insolvent(reason)` on every failure reason. Every reason blocks because
///         `SolvencyOracle.status()` reports only the first failing check: INACTIVE, NO_EPOCH, STALE
///         and INSUFFICIENT_SAMPLES are checked before LIVE_SHORT, so a wrapper that ignored any of
///         them could keep quoting full price while the reserves are drained.
/// @dev Why revert rather than return 0: a price of 0 makes every position liquidatable and lets
///      liquidators seize collateral for nothing. Why the freeze is bounded: Morpho calls `price()`
///      in `borrow`, indebted `withdrawCollateral` and `liquidate` alike and cannot tell them apart,
///      so while `price()` reverts, underwater loans cannot be liquidated either. Left unbounded, a
///      custodian could shield a borrower and lenders could end up with bad debt.
///
///      The freeze clock belongs to one continuous incident. `poke()` (permissionless) starts it on a
///      failure and refreshes `lastFailSeenAt` on every later failing poke; if no failing poke lands
///      within `maxPokeGap`, the clock is void and the next failing poke starts a new incident. So a
///      clock started during an earlier, since-restored incident cannot pre-pay the next freeze: the
///      most it can shave off is `maxPokeGap`. A healthy poke clears the clock.
///
///      Once an incident has lasted `maxFreeze`, `price()` returns the base price discounted to
///      `postCapBps`, not full value: liquidations can clear, and new borrowing reopens only at the
///      discounted value. Liquidators keep the clock alive by poking (they can bundle `poke()` with
///      `liquidate`). Residual risk, stated plainly: a custodian can hold a visible failure for
///      `maxFreeze` while someone keeps poking, then drain; by then the market has been frozen for
///      that long and prices the collateral at the discount. The freeze is a circuit breaker that buys
///      vault curators time to pull liquidity or set caps to zero, not a permanent halt. Morpho skips
///      the oracle for positions without debt, so `supply`, `withdraw`, `supplyCollateral`, `repay`
///      and debt-free `withdrawCollateral` always work.
contract SolvencyGatedMorphoOracle is IMorphoOracle, SolvencyGuard {
    uint16 internal constant BPS = 10_000;

    IMorphoOracle public immutable baseOracle;
    /// @notice The custodial token whose solvency gates pricing (usually the market's collateral).
    address public immutable asset;
    /// @notice How long one continuous failure blocks pricing before the discounted price applies.
    uint32 public immutable maxFreeze;
    /// @notice Longest gap between failing pokes before the incident clock is void.
    uint32 public immutable maxPokeGap;
    /// @notice Share of the base price quoted once an incident has lasted `maxFreeze` (bps, > 0).
    uint16 public immutable postCapBps;

    /// @notice When the current incident was first poked (0 = no clock).
    uint64 public freezeStartedAt;
    /// @notice The latest failing poke of the current incident.
    uint64 public lastFailSeenAt;

    event FreezeStarted(uint8 reason, uint256 at);
    event FreezeExtended(uint8 reason, uint256 at);
    event FreezeCleared(uint256 at);

    error ZeroAddress();
    error ZeroMaxFreeze();
    error BadPokeGap();
    error BadPostCapBps();

    constructor(
        IMorphoOracle baseOracle_,
        ISolvencyOracle solvencyOracle_,
        bytes32 custodianId_,
        address asset_,
        uint32 maxFreeze_,
        uint32 maxPokeGap_,
        uint16 postCapBps_
    ) SolvencyGuard(solvencyOracle_, custodianId_) {
        if (address(baseOracle_) == address(0) || asset_ == address(0)) revert ZeroAddress();
        if (maxFreeze_ == 0) revert ZeroMaxFreeze();
        if (maxPokeGap_ == 0 || maxPokeGap_ >= maxFreeze_) revert BadPokeGap();
        if (postCapBps_ == 0 || postCapBps_ > BPS) revert BadPostCapBps();
        baseOracle = baseOracle_;
        asset = asset_;
        maxFreeze = maxFreeze_;
        maxPokeGap = maxPokeGap_;
        postCapBps = postCapBps_;
    }

    function price() external view returns (uint256) {
        ISolvencyOracle.SolvencyStatus memory s = solvencyOracle.status(custodianId, asset);
        if (s.ok) return baseOracle.price();
        if (_clockValid() && block.timestamp >= uint256(freezeStartedAt) + maxFreeze) {
            return (baseOracle.price() * postCapBps) / BPS;
        }
        revert Insolvent(s.reason);
    }

    /// @notice Start or keep alive the incident clock while the proof fails; clear it once healthy.
    ///         Permissionless.
    /// @return failing True while the proof fails.
    function poke() external returns (bool failing) {
        ISolvencyOracle.SolvencyStatus memory s = solvencyOracle.status(custodianId, asset);
        if (!s.ok) {
            if (!_clockValid()) {
                freezeStartedAt = uint64(block.timestamp);
                emit FreezeStarted(s.reason, block.timestamp);
            } else {
                emit FreezeExtended(s.reason, block.timestamp);
            }
            lastFailSeenAt = uint64(block.timestamp);
            return true;
        }
        if (freezeStartedAt != 0) {
            freezeStartedAt = 0;
            lastFailSeenAt = 0;
            emit FreezeCleared(block.timestamp);
        }
        return false;
    }

    /// @notice The incident clock as `price()` sees it.
    /// @return running Whether a valid (not voided) incident clock exists.
    /// @return startedAt When the incident was first poked (0 if not running).
    /// @return capEndsAt When the discounted price applies (0 if not running).
    /// @return voidAt When the clock is void unless poked again (0 if not running).
    function freezeState() external view returns (bool running, uint64 startedAt, uint64 capEndsAt, uint64 voidAt) {
        if (!_clockValid()) return (false, 0, 0, 0);
        return (true, freezeStartedAt, freezeStartedAt + maxFreeze, lastFailSeenAt + maxPokeGap);
    }

    function _clockValid() internal view returns (bool) {
        return freezeStartedAt != 0 && block.timestamp <= uint256(lastFailSeenAt) + maxPokeGap;
    }
}
