// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {CustodianRegistry} from "./CustodianRegistry.sol";
import {AssetConfig} from "./AssetConfig.sol";
import {RPTypes} from "./libraries/RPTypes.sol";
import {IERC8056} from "./interfaces/IToken.sol";

/// @title LiabilityLedger
/// @notice Epoch commits require an EIP-712 EpochCommitment signature (cross-chain equivocation detectability).
contract LiabilityLedger {
    using ECDSA for bytes32;

    bytes32 public constant EPOCH_COMMITMENT_TYPEHASH = keccak256(
        "EpochCommitment(bytes32 custodianId,address asset,uint64 epochId,bytes32 liabilityRoot,uint256 totalLiability,bytes32 allocationCommitment,uint32 leafCount)"
    );
    /// @dev Cross-chain domain (chainId=0, verifyingContract=0) so one sig works on every deployment.
    bytes32 private constant CROSS_CHAIN_DOMAIN_SEPARATOR = keccak256(
        abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("ReserveProof")),
            keccak256(bytes("1")),
            uint256(0),
            address(0)
        )
    );

    CustodianRegistry public immutable registry;
    AssetConfig public immutable assetConfig;

    mapping(bytes32 => mapping(address => uint64)) public latestEpochId;
    mapping(bytes32 => mapping(address => mapping(uint64 => RPTypes.Epoch))) public epochs;

    event EpochCommitted(
        bytes32 indexed custodianId,
        address indexed asset,
        uint64 epochId,
        bytes32 liabilityRoot,
        uint256 totalLiability,
        uint256 allocation,
        bytes32 allocationCommitment,
        uint32 leafCount,
        bytes32 commitmentDigest
    );

    error NotOperator();
    error Inactive();
    error NoConfig();
    error BadEpoch();
    error BadAllocation();
    error BadLeafCount();
    error BadCommitmentSig();
    error MultiplierRequired();
    error PendingMultiplier();

    constructor(CustodianRegistry registry_, AssetConfig assetConfig_) {
        registry = registry_;
        assetConfig = assetConfig_;
    }

    /// @notice Commit an epoch. Operator must sign EpochCommitment (same bytes on every chain).
    function commitEpoch(
        bytes32 custodianId,
        address asset,
        uint64 epochId,
        bytes32 liabilityRoot,
        uint256 totalLiability,
        uint64[] calldata allocationChainIds,
        uint256[] calldata allocations,
        uint256 multiplierSnapshot,
        uint8 unitMode,
        uint32 leafCount,
        bytes calldata commitmentSig
    ) external {
        (address op, bool active, ) = registry.custodians(custodianId);
        if (msg.sender != op) revert NotOperator();
        if (!active) revert Inactive();

        AssetConfig.Config memory cfg = assetConfig.getConfig(custodianId, asset);
        if (!cfg.exists) revert NoConfig();
        if (epochId == 0 || epochId <= latestEpochId[custodianId][asset]) revert BadEpoch();
        if (unitMode != cfg.unitMode) revert BadEpoch();
        if (leafCount < 2 || (leafCount & (leafCount - 1)) != 0) revert BadLeafCount();

        (uint256 allocation, bytes32 commitment) =
            _localAllocation(custodianId, asset, cfg.chainId, totalLiability, allocationChainIds, allocations);

        bytes32 digest = _commitmentDigest(
            custodianId, asset, epochId, liabilityRoot, totalLiability, commitment, leafCount
        );
        address signer = digest.recover(commitmentSig);
        if (signer != op) revert BadCommitmentSig();

        if (cfg.isStockToken) {
            uint256 liveMul = IERC8056(cfg.token).uiMultiplier();
            uint256 pendingAt = IERC8056(cfg.token).effectiveAt();
            if (unitMode == RPTypes.UNIT_ECONOMIC) {
                if (multiplierSnapshot == 0) revert MultiplierRequired();
                if (multiplierSnapshot != liveMul) revert MultiplierRequired();
            }
            if (multiplierSnapshot == 0) multiplierSnapshot = liveMul;
            else if (multiplierSnapshot != liveMul) revert MultiplierRequired();

            uint256 newMul = IERC8056(cfg.token).newUIMultiplier();
            if (pendingAt > block.timestamp && newMul != liveMul) revert PendingMultiplier();
        } else if (multiplierSnapshot == 0) {
            multiplierSnapshot = 1e18;
        }

        epochs[custodianId][asset][epochId] = RPTypes.Epoch({
            liabilityRoot: liabilityRoot,
            totalLiability: totalLiability,
            allocation: allocation,
            multiplierSnapshot: multiplierSnapshot,
            committedAt: uint64(block.timestamp),
            unitMode: unitMode,
            exists: true,
            leafCount: leafCount,
            allocationCommitment: commitment,
            commitmentDigest: digest
        });
        latestEpochId[custodianId][asset] = epochId;
        emit EpochCommitted(
            custodianId, asset, epochId, liabilityRoot, totalLiability, allocation, commitment, leafCount, digest
        );
    }

    function commitmentDigest(
        bytes32 custodianId,
        address asset,
        uint64 epochId,
        bytes32 liabilityRoot,
        uint256 totalLiability,
        bytes32 allocationCommitment,
        uint32 leafCount
    ) external pure returns (bytes32) {
        return _commitmentDigest(
            custodianId, asset, epochId, liabilityRoot, totalLiability, allocationCommitment, leafCount
        );
    }

    function getEpoch(
        bytes32 custodianId,
        address asset,
        uint64 epochId
    ) external view returns (RPTypes.Epoch memory) {
        return epochs[custodianId][asset][epochId];
    }

    function treeDepth(uint32 leafCount) public pure returns (uint8) {
        uint8 d;
        uint32 n = leafCount;
        while (n > 1) {
            n >>= 1;
            d++;
        }
        return d;
    }

    function _commitmentDigest(
        bytes32 custodianId,
        address asset,
        uint64 epochId,
        bytes32 liabilityRoot,
        uint256 totalLiability,
        bytes32 allocationCommitment,
        uint32 leafCount
    ) internal pure returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                EPOCH_COMMITMENT_TYPEHASH,
                custodianId,
                asset,
                epochId,
                liabilityRoot,
                totalLiability,
                allocationCommitment,
                leafCount
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", CROSS_CHAIN_DOMAIN_SEPARATOR, structHash));
    }

    function _localAllocation(
        bytes32 custodianId,
        address asset,
        uint64 localChainId,
        uint256 totalLiability,
        uint64[] calldata allocationChainIds,
        uint256[] calldata allocations
    ) internal view returns (uint256 local, bytes32 commitment) {
        uint64[] memory allowed = assetConfig.getAllocationChains(custodianId, asset);
        if (allowed.length == 0 || allocationChainIds.length != allowed.length) revert BadAllocation();
        if (allocationChainIds.length != allocations.length) revert BadAllocation();

        uint256 sum;
        for (uint256 i = 0; i < allowed.length; i++) {
            if (allocationChainIds[i] != allowed[i]) revert BadAllocation();
            if (allocations[i] == 0) revert BadAllocation();
            sum += allocations[i];
            if (allocationChainIds[i] == localChainId) {
                local = allocations[i];
            }
        }
        if (local == 0 || sum != totalLiability) revert BadAllocation();
        commitment = keccak256(abi.encode(allocationChainIds, allocations));
    }
}
