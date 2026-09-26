// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SolvencyOracle} from "../SolvencyOracle.sol";
import {IERC20Minimal} from "../interfaces/IToken.sol";

/// @title GatedPayout
contract GatedPayout is ReentrancyGuard {
    SolvencyOracle public immutable oracle;
    bytes32 public immutable custodianId;
    address public immutable asset;

    mapping(address => uint256) public credit;

    error Insolvent();
    error TransferFailed();

    constructor(SolvencyOracle oracle_, bytes32 custodianId_, address asset_) {
        oracle = oracle_;
        custodianId = custodianId_;
        asset = asset_;
    }

    function deposit(uint256 amount) external nonReentrant {
        if (!IERC20Minimal(asset).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        credit[msg.sender] += amount;
    }

    function payout(address to, uint256 amount) external nonReentrant {
        (bool ok, , ) = oracle.isSolvent(custodianId, asset);
        if (!ok) revert Insolvent();
        credit[msg.sender] -= amount;
        if (!IERC20Minimal(asset).transfer(to, amount)) revert TransferFailed();
    }
}
