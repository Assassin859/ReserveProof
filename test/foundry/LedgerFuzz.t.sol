// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RPFull} from "./helpers/RPFull.sol";
import {LiabilityLedger} from "../../src/LiabilityLedger.sol";

/// @notice Epoch commits: who may commit, monotonic ids, leaf-count shape, allocation arithmetic and
///         the operator signature binding every committed field.
contract LedgerFuzzTest is RPFull {
    uint256 internal constant SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function setUp() public {
        _deployFull();
    }

    function _sign(uint256 pk, uint64 epoch, bytes32 root, uint256 total, uint256 alloc, uint32 leafCount)
        internal
        view
        returns (bytes memory)
    {
        uint256[] memory allocs = new uint256[](1);
        allocs[0] = alloc;
        bytes32 digest = ledger.commitmentDigest(
            CID, address(asset), epoch, root, total, keccak256(abi.encode(_chains(), allocs)), leafCount
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _try(address caller, uint64 epoch, bytes32 root, uint256 total, uint256 alloc, uint32 leafCount, bytes memory sig)
        internal
    {
        uint256[] memory allocs = new uint256[](1);
        allocs[0] = alloc;
        vm.prank(caller);
        ledger.commitEpoch(CID, address(asset), epoch, root, total, _chains(), allocs, 0, 0, leafCount, sig);
    }

    function testFuzz_onlyOperatorCommits(address caller) public {
        vm.assume(caller != operator);
        bytes memory sig = _sign(OP_PK, 1, bytes32(uint256(1)), 100, 100, 4);
        vm.expectRevert(LiabilityLedger.NotOperator.selector);
        _try(caller, 1, bytes32(uint256(1)), 100, 100, 4, sig);
    }

    function testFuzz_epochIdsStrictlyIncrease(uint64 first, uint64 next) public {
        first = uint64(bound(first, 1, type(uint64).max - 1));
        _try(operator, first, bytes32(uint256(1)), 100, 100, 4, _sign(OP_PK, first, bytes32(uint256(1)), 100, 100, 4));
        bytes memory sig = _sign(OP_PK, next, bytes32(uint256(2)), 100, 100, 4);
        if (next <= first) vm.expectRevert(LiabilityLedger.BadEpoch.selector);
        _try(operator, next, bytes32(uint256(2)), 100, 100, 4, sig);
    }

    function testFuzz_leafCountMustBePowerOfTwo(uint32 leafCount) public {
        bytes memory sig = _sign(OP_PK, 1, bytes32(uint256(1)), 100, 100, leafCount);
        bool pow2 = leafCount >= 2 && (leafCount & (leafCount - 1)) == 0;
        if (!pow2) vm.expectRevert(LiabilityLedger.BadLeafCount.selector);
        _try(operator, 1, bytes32(uint256(1)), 100, 100, leafCount, sig);
    }

    function testFuzz_otherSignerRejected(uint256 pkSeed) public {
        uint256 pk = bound(pkSeed, 1, SECP_N - 1);
        vm.assume(pk != OP_PK);
        bytes memory sig = _sign(pk, 1, bytes32(uint256(1)), 100, 100, 4);
        vm.expectRevert(LiabilityLedger.BadCommitmentSig.selector);
        _try(operator, 1, bytes32(uint256(1)), 100, 100, 4, sig);
    }

    function testFuzz_allocationMustEqualTotal(uint256 total, uint256 alloc) public {
        total = bound(total, 1, 1e30);
        alloc = bound(alloc, 1, 1e30);
        bytes memory sig = _sign(OP_PK, 1, bytes32(uint256(1)), total, alloc, 4);
        if (alloc != total) vm.expectRevert(LiabilityLedger.BadAllocation.selector);
        _try(operator, 1, bytes32(uint256(1)), total, alloc, 4, sig);
    }

    function testFuzz_signatureBindsRootTotalAndLeafCount(bytes32 root, bytes32 otherRoot, uint256 total, uint8 which) public {
        vm.assume(root != otherRoot);
        total = bound(total, 1, 1e30);
        bytes memory sig = _sign(OP_PK, 1, root, total, total, 4);
        vm.expectRevert(LiabilityLedger.BadCommitmentSig.selector);
        which = which % 3;
        if (which == 0) _try(operator, 1, otherRoot, total, total, 4, sig);
        else if (which == 1) _try(operator, 1, root, total + 1, total + 1, 4, sig);
        else _try(operator, 1, root, total, total, 8, sig);
    }

    function testFuzz_pendingSplitBlocksStockCommit(uint256 newMul, uint256 delay) public {
        newMul = bound(newMul, 1, 100e18);
        vm.assume(newMul != 1e18);
        stock.scheduleUIMultiplier(newMul, vm.getBlockTimestamp() + bound(delay, 1, 30 days));
        bytes32 root = keccak256("r");
        uint256[] memory allocs = new uint256[](1);
        allocs[0] = 100;
        bytes32 digest = ledger.commitmentDigest(CID, address(stock), 1, root, 100, keccak256(abi.encode(_chains(), allocs)), 4);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OP_PK, digest);
        vm.prank(operator);
        vm.expectRevert(LiabilityLedger.PendingMultiplier.selector);
        ledger.commitEpoch(CID, address(stock), 1, root, 100, _chains(), allocs, 0, 0, 4, abi.encodePacked(r, s, v));
    }
}
