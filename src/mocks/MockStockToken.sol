// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockStockToken — ERC-20 + ERC-8056 uiMultiplier surface.
contract MockStockToken is ERC20, Ownable {
    uint256 private _uiMultiplier = 1e18;
    uint256 private _newUIMultiplier = 1e18;
    uint256 private _effectiveAt;

    event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp);

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) Ownable(msg.sender) {}

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function uiMultiplier() external view returns (uint256) {
        if (_effectiveAt != 0 && block.timestamp >= _effectiveAt) {
            return _newUIMultiplier;
        }
        return _uiMultiplier;
    }

    function newUIMultiplier() external view returns (uint256) {
        return _newUIMultiplier;
    }

    function effectiveAt() external view returns (uint256) {
        return _effectiveAt;
    }

    /// @notice Immediately set multiplier (and clear pending).
    function setUIMultiplierNow(uint256 newMultiplier) external onlyOwner {
        uint256 old = this.uiMultiplier();
        _uiMultiplier = newMultiplier;
        _newUIMultiplier = newMultiplier;
        _effectiveAt = 0;
        emit UIMultiplierUpdated(old, newMultiplier, block.timestamp);
    }

    /// @notice Schedule a pending multiplier update.
    function scheduleUIMultiplier(uint256 newMultiplier, uint256 effectiveAtTimestamp) external onlyOwner {
        require(effectiveAtTimestamp > block.timestamp, "future");
        uint256 old = this.uiMultiplier();
        _uiMultiplier = old;
        _newUIMultiplier = newMultiplier;
        _effectiveAt = effectiveAtTimestamp;
        emit UIMultiplierUpdated(old, newMultiplier, effectiveAtTimestamp);
    }

    /// @notice Apply pending if due (also happens automatically in uiMultiplier view).
    function applyPending() external {
        if (_effectiveAt != 0 && block.timestamp >= _effectiveAt) {
            _uiMultiplier = _newUIMultiplier;
            _effectiveAt = 0;
        }
    }
}
