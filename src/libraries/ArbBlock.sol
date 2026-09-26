// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Arbitrum L2 block number precompile (address 0x64).
interface IArbSys {
    function arbBlockNumber() external view returns (uint256);
}

library ArbBlock {
    address internal constant ARB_SYS = address(100);

    /// @dev Prefer ArbSys on Orbit/Arbitrum; fall back to block.number on vanilla EVM (tests).
    function current() internal view returns (uint256) {
        if (ARB_SYS.code.length > 0) {
            try IArbSys(ARB_SYS).arbBlockNumber() returns (uint256 n) {
                return n;
            } catch {}
        }
        return block.number;
    }
}
