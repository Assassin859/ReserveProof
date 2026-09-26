// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {CustodianRegistry} from "./CustodianRegistry.sol";
import {LiabilityLedger} from "./LiabilityLedger.sol";
import {MerkleSumVerifier} from "./libraries/MerkleSumVerifier.sol";
import {RPTypes} from "./libraries/RPTypes.sol";

/// @title DisputeModule
/// @notice Per-user challenges/disputes; inclusion-only challenge answers; permanent equivocation.
contract DisputeModule is EIP712 {
    bytes32 public constant BALANCE_TYPEHASH =
        keccak256(
            "BalanceStatement(bytes32 custodianId,address asset,uint64 epochId,address user,uint256 amount)"
        );

    uint8 public constant KIND_NONE = 0;
    uint8 public constant KIND_CLEARABLE = 1;
    uint8 public constant KIND_EQUIVOCATION = 2;
    uint256 public constant MAX_OPEN_CHALLENGES = 32;

    CustodianRegistry public immutable registry;
    LiabilityLedger public immutable ledger;
    uint64 public clearTimelock;
    uint64 public challengeWindow;

    struct Dispute {
        address user;
        uint64 epochId;
        uint256 amount;
        uint64 openedAt;
        bool open;
        uint64 clearableAfter;
        uint64 matchingEpochId;
        uint8 kind;
    }

    struct Challenge {
        uint64 epochId;
        uint256 amount;
        uint64 deadline;
        bool open;
        bytes32 stmtHash; // burned only when dispute opens
    }

    /// @dev Per-user clearable disputes. Equivocation uses equivocationPermanent instead.
    mapping(bytes32 => mapping(address => mapping(address => Dispute))) public disputes;
    mapping(bytes32 => mapping(address => uint256)) public openDisputeCount;
    mapping(bytes32 => mapping(address => bool)) public equivocationPermanent;

    mapping(bytes32 => mapping(address => mapping(address => Challenge))) public challenges;
    mapping(bytes32 => mapping(address => address[])) internal _challengeUsers;

    mapping(bytes32 => bool) public usedStatements;
    mapping(bytes32 => bool) public usedEvidence;

    event DisputeOpened(bytes32 indexed custodianId, address indexed asset, address user, uint64 epochId);
    event DisputeClearable(
        bytes32 indexed custodianId,
        address indexed asset,
        address user,
        uint64 matchingEpochId,
        uint64 clearableAfter
    );
    event DisputeCleared(bytes32 indexed custodianId, address indexed asset, address user);
    event ChallengeOpened(
        bytes32 indexed custodianId, address indexed asset, address user, uint64 epochId, uint64 deadline
    );
    event ChallengeAnswered(bytes32 indexed custodianId, address indexed asset, address user);
    event ChallengeExpired(bytes32 indexed custodianId, address indexed asset, address user);

    error NotOperator();
    error NotUser();
    error BadSignature();
    error BadProof();
    error AlreadyDisputed();
    error NoDispute();
    error NotClearable();
    error BadBounds();
    error StatementUsed();
    error EvidenceUsed();
    error NotNewerEpoch();
    error PermanentDispute();
    error ChallengeOpen();
    error NoChallenge();
    error ChallengePending();
    error ChallengeExpiredErr();
    error TooManyChallenges();

    constructor(
        CustodianRegistry registry_,
        LiabilityLedger ledger_,
        uint64 clearTimelock_,
        uint64 challengeWindow_
    ) EIP712("ReserveProof", "1") {
        registry = registry_;
        ledger = ledger_;
        clearTimelock = clearTimelock_;
        challengeWindow = challengeWindow_;
    }

    function isDisputed(bytes32 custodianId, address asset) public view returns (bool) {
        return equivocationPermanent[custodianId][asset] || openDisputeCount[custodianId][asset] > 0;
    }

    function hasOverdueChallenge(bytes32 custodianId, address asset) public view returns (bool) {
        address[] storage users = _challengeUsers[custodianId][asset];
        for (uint256 i = 0; i < users.length; i++) {
            Challenge storage c = challenges[custodianId][asset][users[i]];
            if (c.open && block.timestamp > c.deadline) return true;
        }
        return false;
    }

    function challengeUsers(bytes32 custodianId, address asset) external view returns (address[] memory) {
        return _challengeUsers[custodianId][asset];
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
        if (equivocationPermanent[custodianId][asset]) revert PermanentDispute();
        if (disputes[custodianId][asset][user].open) revert AlreadyDisputed();
        if (provedAmount == statedAmount) revert BadProof();

        bytes32 stmtHash = _assertStatement(custodianId, asset, epochId, user, statedAmount, statementSig);

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
                ep.leafCount,
                siblings
            )
        ) revert BadProof();

        usedStatements[stmtHash] = true;
        _open(custodianId, asset, user, epochId, statedAmount, KIND_CLEARABLE);
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
        if (equivocationPermanent[custodianId][asset]) revert PermanentDispute();
        if (disputes[custodianId][asset][user].open) revert AlreadyDisputed();
        bytes32 stmtHash = _assertStatement(custodianId, asset, epochId, user, statedAmount, statementSig);

        RPTypes.Epoch memory ep = ledger.getEpoch(custodianId, asset, epochId);
        if (!ep.exists) revert BadProof();
        _assertOmission(
            custodianId, asset, epochId, user, ep, leftUser, leftAmount, leftSiblings, rightUser, rightAmount, rightSiblings
        );

        usedStatements[stmtHash] = true;
        _open(custodianId, asset, user, epochId, statedAmount, KIND_CLEARABLE);
    }

    function openMalformedTreeDispute(
        bytes32 custodianId,
        address asset,
        uint64 epochId,
        address user,
        uint256 amount,
        MerkleSumVerifier.ProofNode[] calldata siblings
    ) external {
        if (equivocationPermanent[custodianId][asset]) revert PermanentDispute();
        if (disputes[custodianId][asset][user].open) revert AlreadyDisputed();
        RPTypes.Epoch memory ep = ledger.getEpoch(custodianId, asset, epochId);
        if (!ep.exists) revert BadProof();

        uint8 expectedDepth = MerkleSumVerifier.treeDepthFromLeafCount(ep.leafCount);
        if (siblings.length == expectedDepth) revert BadProof();

        if (
            !MerkleSumVerifier.verifyInclusionAnyDepth(
                custodianId,
                asset,
                epochId,
                user,
                amount,
                ep.liabilityRoot,
                ep.totalLiability,
                ep.leafCount,
                siblings
            )
        ) revert BadProof();

        bytes32 evidence = keccak256(
            abi.encode(custodianId, asset, epochId, user, amount, ep.liabilityRoot, siblings)
        );
        if (usedEvidence[evidence]) revert EvidenceUsed();
        usedEvidence[evidence] = true;

        _open(custodianId, asset, user, epochId, amount, KIND_CLEARABLE);
    }

    function openEquivocationDispute(
        bytes32 custodianId,
        address asset,
        uint64 epochId,
        bytes32 otherRoot,
        uint256 otherTotal,
        bytes32 otherAllocCommitment,
        uint32 otherLeafCount,
        bytes calldata otherSig
    ) external {
        if (equivocationPermanent[custodianId][asset]) revert PermanentDispute();
        RPTypes.Epoch memory ep = ledger.getEpoch(custodianId, asset, epochId);
        if (!ep.exists) revert BadProof();

        bool differs = otherRoot != ep.liabilityRoot || otherTotal != ep.totalLiability
            || otherAllocCommitment != ep.allocationCommitment || otherLeafCount != ep.leafCount;
        if (!differs) revert BadProof();

        bytes32 otherDigest = ledger.commitmentDigest(
            custodianId, asset, epochId, otherRoot, otherTotal, otherAllocCommitment, otherLeafCount
        );
        if (usedEvidence[otherDigest]) revert EvidenceUsed();

        (address op, , ) = registry.custodians(custodianId);
        if (ECDSA.recover(otherDigest, otherSig) != op) revert BadSignature();

        usedEvidence[otherDigest] = true;
        equivocationPermanent[custodianId][asset] = true;
        emit DisputeOpened(custodianId, asset, address(0), epochId);
    }

    /// @notice Only the subject user may open. Statement burned only if challenge expires to a dispute.
    function challengeInclusion(
        bytes32 custodianId,
        address asset,
        uint64 epochId,
        address user,
        uint256 amount,
        bytes calldata statementSig
    ) external {
        if (msg.sender != user) revert NotUser();
        if (equivocationPermanent[custodianId][asset]) revert PermanentDispute();
        if (challenges[custodianId][asset][user].open) revert ChallengeOpen();

        RPTypes.Epoch memory ep = ledger.getEpoch(custodianId, asset, epochId);
        if (!ep.exists) revert BadProof();

        bytes32 stmtHash = _assertStatement(custodianId, asset, epochId, user, amount, statementSig);

        address[] storage users = _challengeUsers[custodianId][asset];
        if (!challenges[custodianId][asset][user].open) {
            // Count currently open
            uint256 openCount;
            for (uint256 i = 0; i < users.length; i++) {
                if (challenges[custodianId][asset][users[i]].open) openCount++;
            }
            if (openCount >= MAX_OPEN_CHALLENGES) revert TooManyChallenges();
            bool listed;
            for (uint256 i = 0; i < users.length; i++) {
                if (users[i] == user) {
                    listed = true;
                    break;
                }
            }
            if (!listed) users.push(user);
        }

        uint64 deadline = uint64(block.timestamp) + challengeWindow;
        challenges[custodianId][asset][user] = Challenge({
            epochId: epochId,
            amount: amount,
            deadline: deadline,
            open: true,
            stmtHash: stmtHash
        });
        emit ChallengeOpened(custodianId, asset, user, epochId, deadline);
    }

    function answerInclusion(
        bytes32 custodianId,
        address asset,
        address user,
        MerkleSumVerifier.ProofNode[] calldata siblings
    ) external {
        (address op, , ) = registry.custodians(custodianId);
        if (msg.sender != op) revert NotOperator();
        Challenge storage c = challenges[custodianId][asset][user];
        if (!c.open) revert NoChallenge();
        if (block.timestamp > c.deadline) revert ChallengeExpiredErr();

        RPTypes.Epoch memory ep = ledger.getEpoch(custodianId, asset, c.epochId);
        if (!ep.exists) revert BadProof();
        if (
            !MerkleSumVerifier.verifyInclusion(
                custodianId,
                asset,
                c.epochId,
                user,
                c.amount,
                ep.liabilityRoot,
                ep.totalLiability,
                ep.leafCount,
                siblings
            )
        ) revert BadProof();

        c.open = false;
        emit ChallengeAnswered(custodianId, asset, user);
    }

    function expireChallenge(bytes32 custodianId, address asset, address user) external {
        Challenge storage c = challenges[custodianId][asset][user];
        if (!c.open) revert NoChallenge();
        if (block.timestamp <= c.deadline) revert ChallengePending();
        if (disputes[custodianId][asset][user].open) revert AlreadyDisputed();
        if (equivocationPermanent[custodianId][asset]) revert PermanentDispute();

        bytes32 stmtHash = c.stmtHash;
        uint64 epochId = c.epochId;
        uint256 amount = c.amount;
        c.open = false;
        usedStatements[stmtHash] = true;
        emit ChallengeExpired(custodianId, asset, user);
        _open(custodianId, asset, user, epochId, amount, KIND_CLEARABLE);
    }

    function markMatchingEpoch(
        bytes32 custodianId,
        address asset,
        address user,
        uint64 matchingEpochId,
        MerkleSumVerifier.ProofNode[] calldata siblings
    ) external {
        (address op, , ) = registry.custodians(custodianId);
        if (msg.sender != op) revert NotOperator();
        Dispute storage d = disputes[custodianId][asset][user];
        if (!d.open) revert NoDispute();
        if (d.kind == KIND_EQUIVOCATION) revert PermanentDispute();
        if (matchingEpochId <= d.epochId) revert NotNewerEpoch();

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
                ep.leafCount,
                siblings
            )
        ) revert BadProof();

        d.matchingEpochId = matchingEpochId;
        d.clearableAfter = uint64(block.timestamp) + clearTimelock;
        emit DisputeClearable(custodianId, asset, user, matchingEpochId, d.clearableAfter);
    }

    function clearDispute(bytes32 custodianId, address asset, address user) external {
        Dispute storage d = disputes[custodianId][asset][user];
        if (!d.open) revert NoDispute();
        if (d.kind == KIND_EQUIVOCATION) revert PermanentDispute();
        if (d.clearableAfter == 0 || block.timestamp < d.clearableAfter) revert NotClearable();
        d.open = false;
        openDisputeCount[custodianId][asset] -= 1;
        emit DisputeCleared(custodianId, asset, user);
    }

    function _assertOmission(
        bytes32 custodianId,
        address asset,
        uint64 epochId,
        address user,
        RPTypes.Epoch memory ep,
        address leftUser,
        uint256 leftAmount,
        MerkleSumVerifier.ProofNode[] calldata leftSiblings,
        address rightUser,
        uint256 rightAmount,
        MerkleSumVerifier.ProofNode[] calldata rightSiblings
    ) internal pure {
        if (!MerkleSumVerifier.verifyOmissionBounds(user, leftUser, rightUser)) revert BadBounds();

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
                    ep.leafCount,
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
                    ep.leafCount,
                    rightSiblings
                )
            ) revert BadProof();
        }

        if (
            !MerkleSumVerifier.verifyOmissionAdjacency(
                leftUser, leftSiblings, rightUser, rightSiblings, ep.leafCount
            )
        ) revert BadBounds();
    }

    function _open(
        bytes32 custodianId,
        address asset,
        address user,
        uint64 epochId,
        uint256 amount,
        uint8 kind
    ) internal {
        disputes[custodianId][asset][user] = Dispute({
            user: user,
            epochId: epochId,
            amount: amount,
            openedAt: uint64(block.timestamp),
            open: true,
            clearableAfter: 0,
            matchingEpochId: 0,
            kind: kind
        });
        openDisputeCount[custodianId][asset] += 1;
        emit DisputeOpened(custodianId, asset, user, epochId);
    }

    function _assertStatement(
        bytes32 custodianId,
        address asset,
        uint64 epochId,
        address user,
        uint256 amount,
        bytes calldata sig
    ) internal view returns (bytes32 structHash) {
        (address op, , ) = registry.custodians(custodianId);
        structHash = keccak256(abi.encode(BALANCE_TYPEHASH, custodianId, asset, epochId, user, amount));
        if (usedStatements[structHash]) revert StatementUsed();
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), sig);
        if (signer != op) revert BadSignature();
    }
}
