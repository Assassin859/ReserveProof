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

    /// @notice True if left and right leaves are direct siblings under the tree
    ///         (required for interior omission so a present user cannot fake a gap).
    function verifyAdjacentSiblings(
        bytes32 leftLeaf,
        uint256 leftAmount,
        ProofNode[] memory leftSiblings,
        bytes32 rightLeaf,
        uint256 rightAmount,
        ProofNode[] memory rightSiblings
    ) internal pure returns (bool) {
        if (leftSiblings.length == 0 || leftSiblings.length != rightSiblings.length) return false;
        ProofNode memory ls0 = leftSiblings[0];
        ProofNode memory rs0 = rightSiblings[0];
        // Left child sees right sibling (isLeft=false); right child sees left sibling (isLeft=true).
        if (ls0.isLeft || !rs0.isLeft) return false;
        if (ls0.hash != rightLeaf || ls0.sum != rightAmount) return false;
        if (rs0.hash != leftLeaf || rs0.sum != leftAmount) return false;
        for (uint256 i = 1; i < leftSiblings.length; i++) {
            if (
                leftSiblings[i].hash != rightSiblings[i].hash ||
                leftSiblings[i].sum != rightSiblings[i].sum ||
                leftSiblings[i].isLeft != rightSiblings[i].isLeft
            ) return false;
        }
        return true;
    }
}
