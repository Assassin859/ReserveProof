// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {CustodianRegistry} from "./CustodianRegistry.sol";
import {LiabilityLedger} from "./LiabilityLedger.sol";
import {MerkleSumVerifier} from "./libraries/MerkleSumVerifier.sol";
import {RPTypes} from "./libraries/RPTypes.sol";

/// @title DisputeModule
contract DisputeModule is EIP712 {
    bytes32 public constant BALANCE_TYPEHASH =
        keccak256(
            "BalanceStatement(bytes32 custodianId,address asset,uint64 epochId,address user,uint256 amount)"
        );

    CustodianRegistry public immutable registry;
    LiabilityLedger public immutable ledger;
    uint64 public clearTimelock;

    struct Dispute {
        address user;
        uint64 epochId;
        uint256 amount;
        uint64 openedAt;
        bool open;
        uint64 clearableAfter;
        uint64 matchingEpochId;
    }

    mapping(bytes32 => mapping(address => Dispute)) public disputes;
    mapping(bytes32 => mapping(address => bool)) public isDisputed;

    event DisputeOpened(bytes32 indexed custodianId, address indexed asset, address user, uint64 epochId);
    event DisputeClearable(
        bytes32 indexed custodianId,
        address indexed asset,
        uint64 matchingEpochId,
        uint64 clearableAfter
    );
    event DisputeCleared(bytes32 indexed custodianId, address indexed asset);

    error NotOperator();
    error BadSignature();
    error BadProof();
    error AlreadyDisputed();
    error NoDispute();
    error NotClearable();
    error BadBounds();

    constructor(
        CustodianRegistry registry_,
        LiabilityLedger ledger_,
        uint64 clearTimelock_
    ) EIP712("ReserveProof", "1") {
        registry = registry_;
        ledger = ledger_;
        clearTimelock = clearTimelock_;
    }

    function openMismatchDispute(
        bytes32 custodianId,
        address asset,
        uint64 epochId,
        address user,
        uint256 provedAmount,
        uint256 statedAmount,
        bytes calldata statementSig,
        MerkleSumVerifier.ProofNode[] calldata siblings
    ) external {
        if (isDisputed[custodianId][asset]) revert AlreadyDisputed();
        if (provedAmount == statedAmount) revert BadProof();

        _assertStatement(custodianId, asset, epochId, user, statedAmount, statementSig);

        RPTypes.Epoch memory ep = ledger.getEpoch(custodianId, asset, epochId);
        if (!ep.exists) revert BadProof();
        if (
            !MerkleSumVerifier.verifyInclusion(
                custodianId,
                asset,
                epochId,
                user,
                provedAmount,
                ep.liabilityRoot,
                ep.totalLiability,
                siblings
            )
        ) revert BadProof();

        _open(custodianId, asset, user, epochId, statedAmount);
    }

    function openOmissionDispute(
        bytes32 custodianId,
        address asset,
        uint64 epochId,
        address user,
        uint256 statedAmount,
        bytes calldata statementSig,
        address leftUser,
        uint256 leftAmount,
        MerkleSumVerifier.ProofNode[] calldata leftSiblings,
        address rightUser,
        uint256 rightAmount,
        MerkleSumVerifier.ProofNode[] calldata rightSiblings
    ) external {
        if (isDisputed[custodianId][asset]) revert AlreadyDisputed();
        _assertStatement(custodianId, asset, epochId, user, statedAmount, statementSig);
        if (!MerkleSumVerifier.verifyOmissionBounds(user, leftUser, rightUser)) revert BadBounds();

        RPTypes.Epoch memory ep = ledger.getEpoch(custodianId, asset, epochId);
        if (!ep.exists) revert BadProof();

        if (leftUser != address(0)) {
            if (
                !MerkleSumVerifier.verifyInclusion(
                    custodianId,
                    asset,
                    epochId,
                    leftUser,
                    leftAmount,
                    ep.liabilityRoot,
                    ep.totalLiability,
                    leftSiblings
                )
            ) revert BadProof();
        }
        if (rightUser != address(0)) {
            if (
                !MerkleSumVerifier.verifyInclusion(
                    custodianId,
                    asset,
                    epochId,
                    rightUser,
                    rightAmount,
                    ep.liabilityRoot,
                    ep.totalLiability,
                    rightSiblings
                )
            ) revert BadProof();
        }

        _open(custodianId, asset, user, epochId, statedAmount);
    }

    function markMatchingEpoch(
        bytes32 custodianId,
        address asset,
        uint64 matchingEpochId,
        MerkleSumVerifier.ProofNode[] calldata siblings
    ) external {
        (address op, , ) = registry.custodians(custodianId);
        if (msg.sender != op) revert NotOperator();
        Dispute storage d = disputes[custodianId][asset];
        if (!d.open) revert NoDispute();

        RPTypes.Epoch memory ep = ledger.getEpoch(custodianId, asset, matchingEpochId);
        if (!ep.exists) revert BadProof();
        if (
            !MerkleSumVerifier.verifyInclusion(
                custodianId,
                asset,
                matchingEpochId,
                d.user,
                d.amount,
                ep.liabilityRoot,
                ep.totalLiability,
                siblings
            )
        ) revert BadProof();

        d.matchingEpochId = matchingEpochId;
        d.clearableAfter = uint64(block.timestamp) + clearTimelock;
        emit DisputeClearable(custodianId, asset, matchingEpochId, d.clearableAfter);
    }

    function clearDispute(bytes32 custodianId, address asset) external {
        Dispute storage d = disputes[custodianId][asset];
        if (!d.open) revert NoDispute();
        if (d.clearableAfter == 0 || block.timestamp < d.clearableAfter) revert NotClearable();
        d.open = false;
        isDisputed[custodianId][asset] = false;
        emit DisputeCleared(custodianId, asset);
    }

    function _open(
        bytes32 custodianId,
        address asset,
        address user,
        uint64 epochId,
        uint256 amount
    ) internal {
        disputes[custodianId][asset] = Dispute({
            user: user,
            epochId: epochId,
            amount: amount,
            openedAt: uint64(block.timestamp),
            open: true,
            clearableAfter: 0,
            matchingEpochId: 0
        });
        isDisputed[custodianId][asset] = true;
        emit DisputeOpened(custodianId, asset, user, epochId);
    }

    function _assertStatement(
        bytes32 custodianId,
        address asset,
        uint64 epochId,
        address user,
        uint256 amount,
        bytes calldata sig
    ) internal view {
        (address op, , ) = registry.custodians(custodianId);
        bytes32 structHash = keccak256(
            abi.encode(BALANCE_TYPEHASH, custodianId, asset, epochId, user, amount)
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), sig);
        if (signer != op) revert BadSignature();
    }
}
