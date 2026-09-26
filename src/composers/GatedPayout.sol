// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SolvencyOracle} from "../SolvencyOracle.sol";

/// @title GatedPayout
contract GatedPayout is ReentrancyGuard {
    using SafeERC20 for IERC20;

    SolvencyOracle public immutable oracle;
    bytes32 public immutable custodianId;
    IERC20 public immutable asset;

    mapping(address => uint256) public credit;

    error Insolvent();

    constructor(SolvencyOracle oracle_, bytes32 custodianId_, address asset_) {
        oracle = oracle_;
        custodianId = custodianId_;
        asset = IERC20(asset_);
    }

    function deposit(uint256 amount) external nonReentrant {
        asset.safeTransferFrom(msg.sender, address(this), amount);
        credit[msg.sender] += amount;
    }

    function payout(address to, uint256 amount) external nonReentrant {
        (bool ok, , ) = oracle.isSolvent(custodianId, address(asset));
        if (!ok) revert Insolvent();
        credit[msg.sender] -= amount;
        asset.safeTransfer(to, amount);
    }
}
