// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMorphoOracle} from "./SolvencyGatedMorphoOracle.sol";

/// @title FixedPriceMorphoOracle — constant Morpho-scaled price for testnets and tests.
/// @notice Stands in for a real feed where none exists (e.g. mock TSLA on testnet). Not for production.
contract FixedPriceMorphoOracle is IMorphoOracle {
    uint256 public immutable fixedPrice;

    error ZeroPrice();

    /// @param price_ 1 collateral asset in loan asset, scaled by 1e36 * 10^(loanDecimals - collateralDecimals).
    constructor(uint256 price_) {
        if (price_ == 0) revert ZeroPrice();
        fixedPrice = price_;
    }

    function price() external view returns (uint256) {
        return fixedPrice;
    }
}
