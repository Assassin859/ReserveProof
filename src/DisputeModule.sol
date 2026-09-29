// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CustodianRegistry} from "./CustodianRegistry.sol";
import {LiabilityLedger} from "./LiabilityLedger.sol";
import {MerkleSumVerifier} from "./libraries/MerkleSumVerifier.sol";
import {RPTypes} from "./libraries/RPTypes.sol";

/// @title DisputeModule
/// @notice FIFO bonded challenges (O(1) overdue on head), pull refunds, permanent equivocation.
contract DisputeModule is EIP712 {
    using SafeERC20 for IERC20;

    bytes32 public constant BALANCE_TYPEHASH =
        keccak256(
            "BalanceStatement(bytes32 custodianId,address asset,uint64 epochId,address user,uint256 amount)"
        );

    uint8 public constant KIND_NONE = 0;
    uint8 public constant KIND_CLEARABLE = 1;
    uint8 public constant KIND_EQUIVOCATION = 2;
    /// @dev Queue entries settled inline by openEquivocationDispute; the rest via settleChallengesAfterEquivocation.
    uint256 public constant SETTLE_BATCH = 64;

    CustodianRegistry public immutable registry;
    LiabilityLedger public immutable ledger;
    IERC20 public immutable bondToken;
    uint256 public immutable challengeBond;
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
        bool bonded; // true while bond held for this challenge
        bytes32 stmtHash;
        uint64 seq;
    }

    /// @dev A user can re-challenge after closing, leaving an older entry for the same address
    ///      in the queue; `seq` ties each entry to exactly one challenge so stale slots are skipped.
    struct QueueEntry {
        address user;
        uint64 seq;
    }

    mapping(bytes32 => mapping(address => mapping(address => Dispute))) public disputes;
    mapping(bytes32 => mapping(address => uint256)) public openDisputeCount;
    mapping(bytes32 => mapping(address => bool)) public equivocationPermanent;

    mapping(bytes32 => mapping(address => mapping(address => Challenge))) public challenges;
    /// @dev Append-only FIFO of challenges; head skips closed or superseded entries.
    mapping(bytes32 => mapping(address => QueueEntry[])) internal _challengeQueue;
    mapping(bytes32 => mapping(address => uint256)) public challengeHead;
    uint64 public challengeSeq;

    mapping(bytes32 => bool) public usedStatements;
    mapping(bytes32 => bool) public usedEvidence;
    mapping(address => uint256) public challengeRefunds;

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
    event ChallengeBondWithdrawn(address indexed user, uint256 amount);
    event ChallengesSettled(bytes32 indexed custodianId, address indexed asset, uint256 fromIndex, uint256 toIndex);

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
    error ZeroBond();
    error NoRefund();
    error NotPermanent();

    constructor(
        CustodianRegistry registry_,
        LiabilityLedger ledger_,
        address bondToken_,
        uint256 challengeBond_,
        uint64 clearTimelock_,
        uint64 challengeWindow_
    ) EIP712("ReserveProof", "1") {
        if (bondToken_ == address(0) || challengeBond_ == 0) revert ZeroBond();
        registry = registry_;
        ledger = ledger_;
        bondToken = IERC20(bondToken_);
        challengeBond = challengeBond_;
        clearTimelock = clearTimelock_;
        challengeWindow = challengeWindow_;
    }

    function isDisputed(bytes32 custodianId, address asset) public view returns (bool) {
        return equivocationPermanent[custodianId][asset] || openDisputeCount[custodianId][asset] > 0;
    }

    /// @notice O(1): insolvent if the FIFO head challenge is past its deadline.
    function hasOverdueChallenge(bytes32 custodianId, address asset) public view returns (bool) {
        QueueEntry[] storage q = _challengeQueue[custodianId][asset];
        uint256 head = challengeHead[custodianId][asset];
        // Head should be live after write-path advances; skip dead entries defensively.
        while (head < q.length) {
            Challenge storage c = challenges[custodianId][asset][q[head].user];
            if (_isLive(c, q[head])) return block.timestamp > c.deadline;
            head++;
        }
        return false;
    }

    function challengeQueueLength(bytes32 custodianId, address asset) external view returns (uint256) {
        return _challengeQueue[custodianId][asset].length;
    }

    function openChallengeCount(bytes32 custodianId, address asset) external view returns (uint256) {
        QueueEntry[] storage q = _challengeQueue[custodianId][asset];
        uint256 head = challengeHead[custodianId][asset];
        uint256 n;
        for (uint256 i = head; i < q.length; i++) {
            if (_isLive(challenges[custodianId][asset][q[i].user], q[i])) n++;
        }
        return n;
    }

    function withdrawChallengeBond() external {
        uint256 amount = challengeRefunds[msg.sender];
        if (amount == 0) revert NoRefund();
        challengeRefunds[msg.sender] = 0;
        bondToken.safeTransfer(msg.sender, amount);
        emit ChallengeBondWithdrawn(msg.sender, amount);
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
        _settleOpenChallenges(custodianId, asset, SETTLE_BATCH);
        emit DisputeOpened(custodianId, asset, address(0), epochId);
    }

    /// @notice Permissionless: refunds the bonds of challenges still queued after an equivocation proof,
    ///         scanning at most `maxCount` queue entries per call so no queue length can exceed the gas limit.
    function settleChallengesAfterEquivocation(bytes32 custodianId, address asset, uint256 maxCount)
        external
        returns (uint256 settled, bool done)
    {
        if (!equivocationPermanent[custodianId][asset]) revert NotPermanent();
        return _settleOpenChallenges(custodianId, asset, maxCount);
    }

    /// @notice Only the subject user may open. Pulls challengeBond; refund credited on close (pull withdraw).
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

        bondToken.safeTransferFrom(msg.sender, address(this), challengeBond);

        uint64 seq = ++challengeSeq;
        _challengeQueue[custodianId][asset].push(QueueEntry({user: user, seq: seq}));

        uint64 deadline = uint64(block.timestamp) + challengeWindow;
        challenges[custodianId][asset][user] = Challenge({
            epochId: epochId,
            amount: amount,
            deadline: deadline,
            open: true,
            bonded: true,
            stmtHash: stmtHash,
            seq: seq
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

        usedStatements[c.stmtHash] = true;
        _closeChallenge(custodianId, asset, user);
        emit ChallengeAnswered(custodianId, asset, user);
    }

    function expireChallenge(bytes32 custodianId, address asset, address user) external {
        Challenge storage c = challenges[custodianId][asset][user];
        if (!c.open) revert NoChallenge();
        if (block.timestamp <= c.deadline) revert ChallengePending();

        // After equivocation: unlock bond only (no clearable dispute).
        if (equivocationPermanent[custodianId][asset]) {
            usedStatements[c.stmtHash] = true;
            _closeChallenge(custodianId, asset, user);
            emit ChallengeExpired(custodianId, asset, user);
            return;
        }

        if (disputes[custodianId][asset][user].open) revert AlreadyDisputed();

        bytes32 stmtHash = c.stmtHash;
        uint64 epochId = c.epochId;
        uint256 amount = c.amount;
        usedStatements[stmtHash] = true;
        _closeChallenge(custodianId, asset, user);
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

    function _closeChallenge(bytes32 custodianId, address asset, address user) internal {
        Challenge storage c = challenges[custodianId][asset][user];
        c.open = false;
        if (c.bonded) {
            c.bonded = false;
            challengeRefunds[user] += challengeBond;
        }
        _advanceHead(custodianId, asset);
    }

    function _settleOpenChallenges(bytes32 custodianId, address asset, uint256 maxCount)
        internal
        returns (uint256 settled, bool done)
    {
        QueueEntry[] storage q = _challengeQueue[custodianId][asset];
        uint256 from = challengeHead[custodianId][asset];
        uint256 end = q.length;
        if (maxCount < end - from) end = from + maxCount;
        for (uint256 i = from; i < end; i++) {
            address user = q[i].user;
            Challenge storage c = challenges[custodianId][asset][user];
            if (_isLive(c, q[i])) {
                c.open = false;
                if (c.bonded) {
                    c.bonded = false;
                    challengeRefunds[user] += challengeBond;
                }
                settled++;
            }
        }
        challengeHead[custodianId][asset] = end;
        done = end == q.length;
        emit ChallengesSettled(custodianId, asset, from, end);
    }

    function _advanceHead(bytes32 custodianId, address asset) internal {
        QueueEntry[] storage q = _challengeQueue[custodianId][asset];
        uint256 head = challengeHead[custodianId][asset];
        while (head < q.length && !_isLive(challenges[custodianId][asset][q[head].user], q[head])) {
            head++;
        }
        challengeHead[custodianId][asset] = head;
    }

    function _isLive(Challenge storage c, QueueEntry storage e) internal view returns (bool) {
        return c.open && c.seq == e.seq;
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
