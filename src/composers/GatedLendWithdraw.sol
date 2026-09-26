// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SolvencyOracle} from "../SolvencyOracle.sol";
import {IERC20Minimal} from "../interfaces/IToken.sol";

/// @title GatedLendWithdraw — minimal stub that freezes withdrawals when insolvent.
contract GatedLendWithdraw is ReentrancyGuard {
    SolvencyOracle public immutable oracle;
    bytes32 public immutable custodianId;
    address public immutable asset;

    mapping(address => uint256) public deposits;

    error Insolvent();
    error TransferFailed();

    constructor(SolvencyOracle oracle_, bytes32 custodianId_, address asset_) {
        oracle = oracle_;
        custodianId = custodianId_;
        asset = asset_;
    }

    function deposit(uint256 amount) external nonReentrant {
        if (!IERC20Minimal(asset).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        deposits[msg.sender] += amount;
    }

    function withdraw(uint256 amount) external nonReentrant {
        (bool ok, , ) = oracle.isSolvent(custodianId, asset);
        if (!ok) revert Insolvent();
        deposits[msg.sender] -= amount;
        if (!IERC20Minimal(asset).transfer(msg.sender, amount)) revert TransferFailed();
    }
}
