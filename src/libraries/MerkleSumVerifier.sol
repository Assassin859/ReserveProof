// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MerkleSumVerifier
/// @notice Sorted Merkle-sum tree with domain prefixes 0x00 (leaf) / 0x01 (node).
library MerkleSumVerifier {
    bytes32 internal constant DOMAIN =
        keccak256("ReserveProof.MerkleSum.v1");

    struct ProofNode {
        bytes32 hash;
        uint256 sum;
        bool isLeft; // sibling is on the left of the computed node
    }

    function leafHash(
        bytes32 custodianId,
        address asset,
        uint64 epochId,
        address user,
        uint256 amount
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    bytes1(0x00),
                    DOMAIN,
                    custodianId,
                    asset,
                    epochId,
                    user,
                    amount
                )
            );
    }

    function nodeHash(
        bytes32 leftHash,
        uint256 leftSum,
        bytes32 rightHash,
        uint256 rightSum
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    bytes1(0x01),
                    leftHash,
                    rightHash,
                    leftSum,
                    rightSum
                )
            );
    }

    function treeDepthFromLeafCount(uint32 leafCount) internal pure returns (uint8) {
        uint8 d;
        uint32 n = leafCount;
        while (n > 1) {
            n >>= 1;
            d++;
        }
        return d;
    }

    /// @notice Verify inclusion; proof length must equal committed tree depth.
    function verifyInclusion(
        bytes32 custodianId,
        address asset,
        uint64 epochId,
        address user,
        uint256 amount,
        bytes32 root,
        uint256 totalSum,
        uint32 leafCount,
        ProofNode[] memory siblings
    ) internal pure returns (bool) {
        if (leafCount < 2 || (leafCount & (leafCount - 1)) != 0) return false;
        if (siblings.length != treeDepthFromLeafCount(leafCount)) return false;

        bytes32 computed = leafHash(custodianId, asset, epochId, user, amount);
        uint256 computedSum = amount;

        for (uint256 i = 0; i < siblings.length; i++) {
            ProofNode memory s = siblings[i];
            if (s.isLeft) {
                computed = nodeHash(s.hash, s.sum, computed, computedSum);
            } else {
                computed = nodeHash(computed, computedSum, s.hash, s.sum);
            }
            computedSum += s.sum;
        }

        return computed == root && computedSum == totalSum;
    }

    function leafIndexFromProof(ProofNode[] memory siblings) internal pure returns (uint256 index) {
        for (uint256 i = 0; i < siblings.length; i++) {
            if (siblings[i].isLeft) {
                index |= (uint256(1) << i);
            }
        }
    }

    function verifyOmissionBounds(
        address missing,
        address leftUser,
        address rightUser
    ) internal pure returns (bool) {
        if (leftUser == address(0) && rightUser == address(0)) return false;
        if (leftUser != address(0) && !(leftUser < missing)) return false;
        if (rightUser != address(0) && !(missing < rightUser)) return false;
        return true;
    }

    /// @notice Index-based adjacency using committed leafCount (not proof-derived).
    function verifyOmissionAdjacency(
        address leftUser,
        ProofNode[] memory leftSiblings,
        address rightUser,
        ProofNode[] memory rightSiblings,
        uint32 leafCount
    ) internal pure returns (bool) {
        if (leafCount < 2 || (leafCount & (leafCount - 1)) != 0) return false;
        uint8 depth = treeDepthFromLeafCount(leafCount);
        if (leftUser == address(0) && rightUser == address(0)) return false;

        if (leftUser != address(0) && rightUser != address(0)) {
            if (leftSiblings.length != depth || rightSiblings.length != depth) return false;
            uint256 leftIdx = leafIndexFromProof(leftSiblings);
            uint256 rightIdx = leafIndexFromProof(rightSiblings);
            if (leftIdx >= leafCount || rightIdx >= leafCount) return false;
            return rightIdx == leftIdx + 1;
        }

        if (leftUser == address(0)) {
            if (rightSiblings.length != depth) return false;
            uint256 rightIdx = leafIndexFromProof(rightSiblings);
            return rightIdx == 0;
        }

        if (leftSiblings.length != depth) return false;
        uint256 leftIdx = leafIndexFromProof(leftSiblings);
        return leftIdx == uint256(leafCount) - 1;
    }
}
