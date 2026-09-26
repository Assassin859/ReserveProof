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

    /// @notice Verify inclusion of (user, amount) under root with totalSum.
    function verifyInclusion(
        bytes32 custodianId,
        address asset,
        uint64 epochId,
        address user,
        uint256 amount,
        bytes32 root,
        uint256 totalSum,
        ProofNode[] memory siblings
    ) internal pure returns (bool) {
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

    /// @notice Recover leaf index from inclusion proof path bits.
    /// @dev `isLeft == true` means sibling is on the left ⇒ current node is right child ⇒ bit 1.
    function leafIndexFromProof(ProofNode[] memory siblings) internal pure returns (uint256 index) {
        for (uint256 i = 0; i < siblings.length; i++) {
            if (siblings[i].isLeft) {
                index |= (uint256(1) << i);
            }
        }
    }

    function leafCountFromProof(ProofNode[] memory siblings) internal pure returns (uint256) {
        return uint256(1) << siblings.length;
    }

    /// @notice Verify that `missing` sorts strictly between leftUser and rightUser.
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

    /// @notice Index-based adjacency for omission neighbours (works across subtree boundaries).
    /// @dev Interior requires both neighbours with |leftIdx - rightIdx| == 1.
    ///      Left edge: leftUser == 0 and rightIdx == 0.
    ///      Right edge: rightUser == 0 and leftIdx == leafCount - 1.
    function verifyOmissionAdjacency(
        address leftUser,
        ProofNode[] memory leftSiblings,
        address rightUser,
        ProofNode[] memory rightSiblings
    ) internal pure returns (bool) {
        if (leftUser == address(0) && rightUser == address(0)) return false;

        if (leftUser != address(0) && rightUser != address(0)) {
            if (leftSiblings.length == 0 || leftSiblings.length != rightSiblings.length) return false;
            uint256 leftIdx = leafIndexFromProof(leftSiblings);
            uint256 rightIdx = leafIndexFromProof(rightSiblings);
            return rightIdx == leftIdx + 1;
        }

        if (leftUser == address(0)) {
            if (rightSiblings.length == 0) return false;
            return leafIndexFromProof(rightSiblings) == 0;
        }

        // rightUser == 0
        if (leftSiblings.length == 0) return false;
        uint256 leafCount = leafCountFromProof(leftSiblings);
        return leafIndexFromProof(leftSiblings) == leafCount - 1;
    }
}
