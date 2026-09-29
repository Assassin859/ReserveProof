// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ReplayFeed — fork-only stand-in for a Chainlink aggregator.
/// @notice A forked chain has no transmitters, so a real feed goes stale once time is warped. This
///         replays one captured answer as if it were published every block. Deploy it, then copy its
///         runtime code over the aggregator with `hardhat_setCode` (the values below are immutables,
///         so they travel with the code).
contract ReplayFeed {
    uint80 public immutable roundId;
    int256 public immutable answer;
    uint8 public immutable decimals;

    constructor(uint80 roundId_, int256 answer_, uint8 decimals_) {
        roundId = roundId_;
        answer = answer_;
        decimals = decimals_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, block.timestamp, block.timestamp, roundId);
    }
}
