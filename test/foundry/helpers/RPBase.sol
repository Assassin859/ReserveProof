// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CustodianRegistry} from "../../../src/CustodianRegistry.sol";
import {AssetConfig} from "../../../src/AssetConfig.sol";
import {LiabilityLedger} from "../../../src/LiabilityLedger.sol";
import {MerkleSumVerifier} from "../../../src/libraries/MerkleSumVerifier.sol";
import {MockUSDG} from "../../../src/mocks/MockUSDG.sol";

/// @notice Core ReserveProof deployment for invariant suites: one custodian, one non-stock asset,
///         a fixed 4-leaf book that can be re-committed at any epoch, operator-signed commitments.
abstract contract RPBase is Test {
    bytes32 internal constant CID = keccak256("kopi");
    bytes32 internal constant SALT = keccak256("ReserveProof.invariants");
    bytes32 internal constant ASSET_ID = keccak256("TSLA");
    uint256 internal constant OP_PK = 0xA11CE;
    uint32 internal constant LEAVES = 4;

    address internal operator;
    CustodianRegistry internal registry;
    AssetConfig internal assetConfig;
    LiabilityLedger internal ledger;
    MockUSDG internal bondToken;
    MockUSDG internal asset;

    address[LEAVES] internal users;
    uint256[LEAVES] internal amounts;

    /// @dev Handler-owned clock: re-applied before every action so time advances monotonically
    ///      across invariant calls regardless of how the runner treats block env between calls.
    uint256 public clock;

    modifier useClock() {
        if (clock == 0) clock = block.timestamp;
        vm.warp(clock);
        _;
    }

    function _advance(uint256 secs) internal {
        clock += secs;
        vm.warp(clock);
    }

    function _deployCore() internal {
        operator = vm.addr(OP_PK);
        registry = new CustodianRegistry(address(this));
        assetConfig = new AssetConfig(address(this), registry);
        ledger = new LiabilityLedger(registry, assetConfig, SALT);
        bondToken = new MockUSDG();
        asset = new MockUSDG();
        registry.registerCustodian(CID, operator, 3600);
        assetConfig.setAssetConfig(
            CID, address(asset), address(asset), uint64(block.chainid), false, 0, 10300, 7 days, 1, 1, ASSET_ID, _chains()
        );
        for (uint256 i = 0; i < LEAVES; i++) {
            users[i] = makeAddr(string(abi.encodePacked("user", vm.toString(i))));
            amounts[i] = (i + 1) * 100e6;
        }
    }

    function _chains() internal view returns (uint64[] memory c) {
        c = new uint64[](1);
        c[0] = uint64(block.chainid);
    }

    function _leaf(uint64 epoch, uint256 i) internal view returns (bytes32) {
        return MerkleSumVerifier.leafHash(CID, address(asset), epoch, LEAVES, users[i], amounts[i]);
    }

    function _pair(uint64 epoch, uint256 j) internal view returns (bytes32) {
        return MerkleSumVerifier.nodeHash(_leaf(epoch, 2 * j), amounts[2 * j], _leaf(epoch, 2 * j + 1), amounts[2 * j + 1]);
    }

    function _root(uint64 epoch) internal view returns (bytes32 root, uint256 total) {
        uint256 left = amounts[0] + amounts[1];
        uint256 right = amounts[2] + amounts[3];
        root = MerkleSumVerifier.nodeHash(_pair(epoch, 0), left, _pair(epoch, 1), right);
        total = left + right;
    }

    function _proof(uint64 epoch, uint256 i) internal view returns (MerkleSumVerifier.ProofNode[] memory p) {
        p = new MerkleSumVerifier.ProofNode[](2);
        uint256 sib = i ^ 1;
        p[0] = MerkleSumVerifier.ProofNode({hash: _leaf(epoch, sib), sum: amounts[sib], isLeft: i & 1 == 1});
        uint256 pairSib = (i >> 1) ^ 1;
        p[1] = MerkleSumVerifier.ProofNode({
            hash: _pair(epoch, pairSib),
            sum: amounts[2 * pairSib] + amounts[2 * pairSib + 1],
            isLeft: (i >> 1) & 1 == 1
        });
    }

    function _commit(uint64 epoch) internal {
        (bytes32 root, uint256 total) = _root(epoch);
        uint256[] memory allocs = new uint256[](1);
        allocs[0] = total;
        bytes32 allocCmt = keccak256(abi.encode(_chains(), allocs));
        bytes32 digest = ledger.commitmentDigest(CID, address(asset), epoch, root, total, allocCmt, LEAVES);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OP_PK, digest);
        vm.prank(operator);
        ledger.commitEpoch(CID, address(asset), epoch, root, total, _chains(), allocs, 0, 0, LEAVES, abi.encodePacked(r, s, v));
    }
}
