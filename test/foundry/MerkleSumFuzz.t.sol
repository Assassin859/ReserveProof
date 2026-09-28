// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MerkleSumVerifier} from "../../src/libraries/MerkleSumVerifier.sol";

/// @notice Property tests for MerkleSumVerifier over fuzzed 2–16 leaf trees.
contract MerkleSumFuzzTest is Test {
    bytes32 internal constant CUSTODIAN = keccak256("kopi");
    address internal constant ASSET = address(0xA55E7);
    uint64 internal constant EPOCH = 7;
    uint256 internal constant MAX_AMOUNT = 1e30;

    struct Tree {
        uint32 leafCount;
        uint8 depth;
        address[] users;
        uint256[] amounts;
        bytes32[][] hashes;
        uint256[][] sums;
    }

    function _build(uint256 seed, uint256 depthRaw) internal pure returns (Tree memory t) {
        t.depth = uint8(bound(depthRaw, 1, 4));
        t.leafCount = uint32(1) << t.depth;
        t.users = new address[](t.leafCount);
        t.amounts = new uint256[](t.leafCount);
        t.hashes = new bytes32[][](t.depth + 1);
        t.sums = new uint256[][](t.depth + 1);
        t.hashes[0] = new bytes32[](t.leafCount);
        t.sums[0] = new uint256[](t.leafCount);

        for (uint256 i = 0; i < t.leafCount; i++) {
            t.users[i] = address(uint160(uint256(keccak256(abi.encode(seed, "user", i)))));
            t.amounts[i] = uint256(keccak256(abi.encode(seed, "amount", i))) % MAX_AMOUNT;
            t.hashes[0][i] =
                MerkleSumVerifier.leafHash(CUSTODIAN, ASSET, EPOCH, t.leafCount, t.users[i], t.amounts[i]);
            t.sums[0][i] = t.amounts[i];
        }
        for (uint256 l = 0; l < t.depth; l++) {
            uint256 width = t.leafCount >> (l + 1);
            t.hashes[l + 1] = new bytes32[](width);
            t.sums[l + 1] = new uint256[](width);
            for (uint256 j = 0; j < width; j++) {
                (bytes32 lh, uint256 ls) = (t.hashes[l][2 * j], t.sums[l][2 * j]);
                (bytes32 rh, uint256 rs) = (t.hashes[l][2 * j + 1], t.sums[l][2 * j + 1]);
                t.hashes[l + 1][j] = MerkleSumVerifier.nodeHash(lh, ls, rh, rs);
                t.sums[l + 1][j] = ls + rs;
            }
        }
    }

    function _proof(Tree memory t, uint256 index) internal pure returns (MerkleSumVerifier.ProofNode[] memory p) {
        p = new MerkleSumVerifier.ProofNode[](t.depth);
        for (uint256 l = 0; l < t.depth; l++) {
            uint256 sib = index ^ 1;
            p[l] = MerkleSumVerifier.ProofNode({hash: t.hashes[l][sib], sum: t.sums[l][sib], isLeft: index & 1 == 1});
            index >>= 1;
        }
    }

    function _root(Tree memory t) internal pure returns (bytes32, uint256) {
        return (t.hashes[t.depth][0], t.sums[t.depth][0]);
    }

    function _verify(Tree memory t, uint256 i, uint256 amount, MerkleSumVerifier.ProofNode[] memory p)
        internal
        pure
        returns (bool)
    {
        (bytes32 root, uint256 total) = _root(t);
        return MerkleSumVerifier.verifyInclusion(CUSTODIAN, ASSET, EPOCH, t.users[i], amount, root, total, t.leafCount, p);
    }

    function testFuzz_everyLeafVerifies(uint256 seed, uint256 depthRaw) public pure {
        Tree memory t = _build(seed, depthRaw);
        uint256 expectedTotal;
        for (uint256 i = 0; i < t.leafCount; i++) {
            expectedTotal += t.amounts[i];
            assertTrue(_verify(t, i, t.amounts[i], _proof(t, i)), "honest proof rejected");
        }
        (, uint256 total) = _root(t);
        assertEq(total, expectedTotal, "root sum != sum of leaves");
    }

    function testFuzz_tamperedAmountFails(uint256 seed, uint256 depthRaw, uint256 idxRaw, uint256 delta) public pure {
        Tree memory t = _build(seed, depthRaw);
        uint256 i = bound(idxRaw, 0, t.leafCount - 1);
        delta = bound(delta, 1, MAX_AMOUNT);
        assertFalse(_verify(t, i, t.amounts[i] + delta, _proof(t, i)), "inflated amount accepted");
        if (t.amounts[i] >= delta) {
            assertFalse(_verify(t, i, t.amounts[i] - delta, _proof(t, i)), "deflated amount accepted");
        }
    }

    function testFuzz_tamperedSiblingFails(
        uint256 seed,
        uint256 depthRaw,
        uint256 idxRaw,
        uint256 levelRaw,
        bytes32 flip,
        uint256 sumDelta
    ) public pure {
        Tree memory t = _build(seed, depthRaw);
        uint256 i = bound(idxRaw, 0, t.leafCount - 1);
        uint256 level = bound(levelRaw, 0, t.depth - 1);
        vm.assume(flip != bytes32(0));
        sumDelta = bound(sumDelta, 1, MAX_AMOUNT);

        MerkleSumVerifier.ProofNode[] memory p = _proof(t, i);
        p[level].hash ^= flip;
        assertFalse(_verify(t, i, t.amounts[i], p), "tampered sibling hash accepted");

        p = _proof(t, i);
        p[level].sum += sumDelta;
        assertFalse(_verify(t, i, t.amounts[i], p), "inflated sibling sum accepted");

        p = _proof(t, i);
        p[level].isLeft = !p[level].isLeft;
        assertFalse(_verify(t, i, t.amounts[i], p), "flipped sibling side accepted");
    }

    function testFuzz_wrongDepthOrLeafCountFails(uint256 seed, uint256 depthRaw, uint256 idxRaw, uint32 badCount)
        public
        pure
    {
        Tree memory t = _build(seed, depthRaw);
        uint256 i = bound(idxRaw, 0, t.leafCount - 1);
        (bytes32 root, uint256 total) = _root(t);
        MerkleSumVerifier.ProofNode[] memory p = _proof(t, i);

        MerkleSumVerifier.ProofNode[] memory shortP = new MerkleSumVerifier.ProofNode[](t.depth - 1);
        for (uint256 l = 0; l + 1 < t.depth; l++) shortP[l] = p[l];
        assertFalse(_verify(t, i, t.amounts[i], shortP), "truncated proof accepted");

        // A deeper claimed tree needs one more sibling; padding it still fails because leafCount is in the leaf.
        MerkleSumVerifier.ProofNode[] memory longP = new MerkleSumVerifier.ProofNode[](t.depth + 1);
        for (uint256 l = 0; l < t.depth; l++) longP[l] = p[l];
        longP[t.depth] = MerkleSumVerifier.ProofNode({hash: bytes32(0), sum: 0, isLeft: false});
        assertFalse(
            MerkleSumVerifier.verifyInclusion(
                CUSTODIAN, ASSET, EPOCH, t.users[i], t.amounts[i], root, total, t.leafCount * 2, longP
            ),
            "proof accepted under doubled leafCount"
        );

        vm.assume(badCount != t.leafCount);
        assertFalse(
            MerkleSumVerifier.verifyInclusion(
                CUSTODIAN, ASSET, EPOCH, t.users[i], t.amounts[i], root, total, badCount, p
            ),
            "proof accepted under wrong leafCount"
        );
    }

    function testFuzz_wrongContextFails(uint256 seed, uint256 depthRaw, uint256 idxRaw, address otherUser) public pure {
        Tree memory t = _build(seed, depthRaw);
        uint256 i = bound(idxRaw, 0, t.leafCount - 1);
        (bytes32 root, uint256 total) = _root(t);
        MerkleSumVerifier.ProofNode[] memory p = _proof(t, i);
        vm.assume(otherUser != t.users[i]);

        assertFalse(
            MerkleSumVerifier.verifyInclusion(CUSTODIAN, ASSET, EPOCH, otherUser, t.amounts[i], root, total, t.leafCount, p),
            "proof accepted for another user"
        );
        assertFalse(
            MerkleSumVerifier.verifyInclusion(CUSTODIAN, ASSET, EPOCH + 1, t.users[i], t.amounts[i], root, total, t.leafCount, p),
            "proof replayed into another epoch"
        );
        assertFalse(
            MerkleSumVerifier.verifyInclusion(CUSTODIAN, address(0xBEEF), EPOCH, t.users[i], t.amounts[i], root, total, t.leafCount, p),
            "proof replayed onto another asset"
        );
        assertFalse(
            MerkleSumVerifier.verifyInclusion(keccak256("other"), ASSET, EPOCH, t.users[i], t.amounts[i], root, total, t.leafCount, p),
            "proof replayed for another custodian"
        );
        assertFalse(
            MerkleSumVerifier.verifyInclusion(CUSTODIAN, ASSET, EPOCH, t.users[i], t.amounts[i], root, total + 1, t.leafCount, p),
            "proof accepted against wrong total"
        );
    }

    function testFuzz_proofDoesNotTransferBetweenLeaves(uint256 seed, uint256 depthRaw, uint256 a, uint256 b) public pure {
        Tree memory t = _build(seed, depthRaw);
        uint256 i = bound(a, 0, t.leafCount - 1);
        uint256 j = bound(b, 0, t.leafCount - 1);
        vm.assume(i != j);
        assertFalse(_verify(t, j, t.amounts[j], _proof(t, i)), "leaf j verified with leaf i's path");
    }

    function testFuzz_leafIndexRecoveredFromProof(uint256 seed, uint256 depthRaw, uint256 idxRaw) public pure {
        Tree memory t = _build(seed, depthRaw);
        uint256 i = bound(idxRaw, 0, t.leafCount - 1);
        assertEq(MerkleSumVerifier.leafIndexFromProof(_proof(t, i)), i);
    }

    function testFuzz_treeDepthIsLog2(uint8 d) public pure {
        d = uint8(bound(d, 1, 31));
        assertEq(MerkleSumVerifier.treeDepthFromLeafCount(uint32(1) << d), d);
    }

    function testFuzz_anyDepthAcceptsHonestProof(uint256 seed, uint256 depthRaw, uint256 idxRaw) public pure {
        Tree memory t = _build(seed, depthRaw);
        uint256 i = bound(idxRaw, 0, t.leafCount - 1);
        (bytes32 root, uint256 total) = _root(t);
        assertTrue(
            MerkleSumVerifier.verifyInclusionAnyDepth(
                CUSTODIAN, ASSET, EPOCH, t.users[i], t.amounts[i], root, total, t.leafCount, _proof(t, i)
            )
        );
        MerkleSumVerifier.ProofNode[] memory empty;
        assertFalse(
            MerkleSumVerifier.verifyInclusionAnyDepth(CUSTODIAN, ASSET, EPOCH, t.users[i], t.amounts[i], root, total, t.leafCount, empty),
            "empty proof accepted"
        );
    }

    function testFuzz_nodeHashIsOrderedAndSumBound(bytes32 l, uint256 ls, bytes32 r, uint256 rs, uint256 d) public pure {
        vm.assume(l != r || ls != rs);
        assertTrue(MerkleSumVerifier.nodeHash(l, ls, r, rs) != MerkleSumVerifier.nodeHash(r, rs, l, ls), "swap not detected");
        d = bound(d, 1, type(uint128).max);
        vm.assume(ls <= type(uint256).max - d);
        assertTrue(MerkleSumVerifier.nodeHash(l, ls, r, rs) != MerkleSumVerifier.nodeHash(l, ls + d, r, rs), "sum not bound");
    }

    function testFuzz_leafAndNodeDomainsSeparated(address user, uint256 amount, bytes32 l, uint256 ls, bytes32 r, uint256 rs)
        public
        pure
    {
        assertTrue(
            MerkleSumVerifier.leafHash(CUSTODIAN, ASSET, EPOCH, 4, user, amount) != MerkleSumVerifier.nodeHash(l, ls, r, rs)
        );
    }

    function testFuzz_omissionBoundsIffStrictlyBetween(address missing, address left, address right) public pure {
        bool expected = !(left == address(0) && right == address(0)) && (left == address(0) || left < missing)
            && (right == address(0) || missing < right);
        assertEq(MerkleSumVerifier.verifyOmissionBounds(missing, left, right), expected);
    }

    function testFuzz_omissionAdjacencyOnlyForNeighbours(uint256 seed, uint256 depthRaw, uint256 a, uint256 b) public pure {
        Tree memory t = _build(seed, depthRaw);
        uint256 i = bound(a, 0, t.leafCount - 1);
        uint256 j = bound(b, 0, t.leafCount - 1);
        MerkleSumVerifier.ProofNode[] memory pi = _proof(t, i);
        MerkleSumVerifier.ProofNode[] memory pj = _proof(t, j);
        assertEq(
            MerkleSumVerifier.verifyOmissionAdjacency(t.users[i], pi, t.users[j], pj, t.leafCount), j == i + 1, "neighbour check"
        );
        assertEq(
            MerkleSumVerifier.verifyOmissionAdjacency(address(0), pi, t.users[i], pi, t.leafCount), i == 0, "left edge"
        );
        assertEq(
            MerkleSumVerifier.verifyOmissionAdjacency(t.users[i], pi, address(0), pi, t.leafCount),
            i == t.leafCount - 1,
            "right edge"
        );
    }
}
