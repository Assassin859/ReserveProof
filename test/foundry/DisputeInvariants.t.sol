// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DisputeModule} from "../../src/DisputeModule.sol";
import {RPBase} from "./helpers/RPBase.sol";

/// @notice Drives DisputeModule with random users challenging honest or inflated balances across
///         epochs, the operator answering what it can prove, anyone expiring overdue challenges,
///         matching-epoch clears, bond withdrawals and time warps.
contract DisputeHandler is RPBase {
    uint256 public constant BOND = 1e6;
    uint64 public constant WINDOW = 1 hours;
    uint64 public constant TIMELOCK = 1 hours;
    uint64 public constant MAX_EPOCH = 12;

    DisputeModule public disputes;
    uint64 public latestEpoch;
    mapping(bytes32 => uint256) public calls;

    constructor() {
        _deployCore();
        disputes = new DisputeModule(registry, ledger, address(bondToken), BOND, TIMELOCK, WINDOW);
        latestEpoch = 1;
        _commit(1);
    }

    // ── actions ─────────────────────────────────────────────────────────────

    function challenge(uint256 userSeed, uint256 epochSeed, bool honest, uint256 skew) external useClock {
        uint256 i = bound(userSeed, 0, LEAVES - 1);
        address u = users[i];
        uint64 epoch = uint64(bound(epochSeed, 1, latestEpoch));
        uint256 amount = honest ? amounts[i] : amounts[i] + bound(skew, 1, 1e12);
        if (_challengeOpen(u) || disputes.equivocationPermanent(CID, address(asset))) return;

        bytes memory sig = _statementSig(epoch, u, amount);
        bondToken.mint(u, BOND);
        vm.startPrank(u);
        bondToken.approve(address(disputes), BOND);
        try disputes.challengeInclusion(CID, address(asset), epoch, u, amount, sig) {
            calls["challenge"]++;
        } catch (bytes memory err) {
            // A statement answered or expired once is burned and cannot be replayed.
            require(bytes4(err) == DisputeModule.StatementUsed.selector, "unexpected challenge revert");
        }
        vm.stopPrank();
    }

    function answer(uint256 userSeed) external useClock {
        uint256 i = bound(userSeed, 0, LEAVES - 1);
        (uint64 epoch, uint256 amount, uint64 deadline, bool open,,,) = disputes.challenges(CID, address(asset), users[i]);
        if (!open || block.timestamp > deadline || amount != amounts[i]) return;
        vm.prank(operator);
        disputes.answerInclusion(CID, address(asset), users[i], _proof(epoch, i));
        calls["answer"]++;
    }

    function expire(uint256 userSeed) external useClock {
        address u = users[bound(userSeed, 0, LEAVES - 1)];
        (,, uint64 deadline, bool open,,,) = disputes.challenges(CID, address(asset), u);
        if (!open || block.timestamp <= deadline || _disputeOpen(u)) return;
        disputes.expireChallenge(CID, address(asset), u);
        calls["expire"]++;
    }

    function markMatching(uint256 userSeed) external useClock {
        uint256 i = bound(userSeed, 0, LEAVES - 1);
        (, uint64 dEpoch, uint256 dAmount,, bool dOpen, uint64 clearableAfter,,) =
            disputes.disputes(CID, address(asset), users[i]);
        // Only an honest balance can be proven in a newer epoch; inflated claims stay disputed.
        if (!dOpen || clearableAfter != 0 || dAmount != amounts[i] || dEpoch >= latestEpoch) return;
        vm.prank(operator);
        disputes.markMatchingEpoch(CID, address(asset), users[i], latestEpoch, _proof(latestEpoch, i));
        calls["mark"]++;
    }

    function clear(uint256 userSeed) external useClock {
        address u = users[bound(userSeed, 0, LEAVES - 1)];
        (,,,, bool dOpen, uint64 clearableAfter,,) = disputes.disputes(CID, address(asset), u);
        if (!dOpen || clearableAfter == 0 || block.timestamp < clearableAfter) return;
        disputes.clearDispute(CID, address(asset), u);
        calls["clear"]++;
    }

    function withdrawBond(uint256 userSeed) external useClock {
        address u = users[bound(userSeed, 0, LEAVES - 1)];
        if (disputes.challengeRefunds(u) == 0) return;
        vm.prank(u);
        disputes.withdrawChallengeBond();
        calls["withdraw"]++;
    }

    /// @dev Terminal for the market, so it only fires on 1 seed in 8 to leave most runs exercising
    ///      the clearable paths first.
    function equivocate(uint256 seed) external useClock {
        if (seed % 8 != 0 || disputes.equivocationPermanent(CID, address(asset))) return;
        uint64 epoch = uint64(bound(seed >> 8, 1, latestEpoch));
        (, uint256 total) = _root(epoch);
        uint256[] memory allocs = new uint256[](1);
        allocs[0] = total;
        bytes32 allocCmt = keccak256(abi.encode(_chains(), allocs));
        bytes32 otherRoot = keccak256(abi.encode("forked book", epoch));
        bytes32 digest = ledger.commitmentDigest(CID, address(asset), epoch, otherRoot, total, allocCmt, LEAVES);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OP_PK, digest);
        disputes.openEquivocationDispute(
            CID, address(asset), epoch, otherRoot, total, allocCmt, LEAVES, abi.encodePacked(r, s, v)
        );
        calls["equivocate"]++;
    }

    function settle(uint256 maxSeed) external useClock {
        if (!disputes.equivocationPermanent(CID, address(asset))) return;
        disputes.settleChallengesAfterEquivocation(CID, address(asset), bound(maxSeed, 0, 3));
        calls["settle"]++;
    }

    function commitNext() external useClock {
        if (latestEpoch >= MAX_EPOCH) return;
        latestEpoch++;
        _commit(latestEpoch);
    }

    function warp(uint256 secs) external useClock {
        _advance(bound(secs, 1, 3 hours));
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    function _statementSig(uint64 epoch, address who, uint256 amount) internal view returns (bytes memory) {
        bytes32 structHash =
            keccak256(abi.encode(disputes.BALANCE_TYPEHASH(), CID, address(asset), epoch, who, amount));
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ReserveProof"),
                keccak256("1"),
                block.chainid,
                address(disputes)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OP_PK, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _challengeOpen(address u) internal view returns (bool open) {
        (,,, open,,,) = disputes.challenges(CID, address(asset), u);
    }

    function _disputeOpen(address u) internal view returns (bool open) {
        (,,,, open,,,) = disputes.disputes(CID, address(asset), u);
    }

    // ── brute-force views for the invariants ───────────────────────────────

    function user(uint256 i) external view returns (address) {
        return users[i];
    }

    function assetAddr() external view returns (address) {
        return address(asset);
    }

    function bondTokenAddr() external view returns (address) {
        return address(bondToken);
    }
}

contract DisputeInvariantsTest is Test {
    bytes32 internal constant CID = keccak256("kopi");
    DisputeHandler internal h;
    DisputeModule internal d;
    address internal asset;

    function setUp() public {
        h = new DisputeHandler();
        d = h.disputes();
        asset = h.assetAddr();
        targetContract(address(h));
        // `challenge` is listed three times to weight it: with 8 equal selectors a 64-call run has no
        // successful challenge often enough (~2% of full sessions) to trip afterInvariant's guard.
        bytes4[] memory actions = new bytes4[](12);
        actions[0] = DisputeHandler.challenge.selector;
        actions[1] = DisputeHandler.answer.selector;
        actions[2] = DisputeHandler.expire.selector;
        actions[3] = DisputeHandler.markMatching.selector;
        actions[4] = DisputeHandler.clear.selector;
        actions[5] = DisputeHandler.withdrawBond.selector;
        actions[6] = DisputeHandler.commitNext.selector;
        actions[7] = DisputeHandler.warp.selector;
        actions[8] = DisputeHandler.challenge.selector;
        actions[9] = DisputeHandler.challenge.selector;
        actions[10] = DisputeHandler.equivocate.selector;
        actions[11] = DisputeHandler.settle.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: actions}));
    }

    function invariant_headWithinQueue() public view {
        assertLe(d.challengeHead(CID, asset), d.challengeQueueLength(CID, asset));
    }

    function invariant_openCountMatchesBruteForce() public view {
        uint256 n;
        for (uint256 i = 0; i < 4; i++) {
            (,,, bool open,,,) = d.challenges(CID, asset, h.user(i));
            if (open) n++;
        }
        assertEq(d.openChallengeCount(CID, asset), n, "openChallengeCount != open challenges");
    }

    /// @dev Deadlines are opened-at + a constant window, so the FIFO head is always the earliest
    ///      deadline and the O(1) head check must agree with a scan of every open challenge.
    function invariant_overdueMatchesBruteForce() public view {
        bool overdue;
        for (uint256 i = 0; i < 4; i++) {
            (,, uint64 deadline, bool open,,,) = d.challenges(CID, asset, h.user(i));
            if (open && block.timestamp > deadline) overdue = true;
        }
        assertEq(d.hasOverdueChallenge(CID, asset), overdue, "hasOverdueChallenge disagrees with scan");
    }

    function invariant_disputeCountMatchesBruteForce() public view {
        uint256 n;
        for (uint256 i = 0; i < 4; i++) {
            (,,,, bool open,,,) = d.disputes(CID, asset, h.user(i));
            if (open) n++;
        }
        assertEq(d.openDisputeCount(CID, asset), n, "openDisputeCount drifted");
        assertEq(
            d.isDisputed(CID, asset),
            n > 0 || d.equivocationPermanent(CID, asset),
            "isDisputed disagrees with open disputes"
        );
    }

    /// @dev Every bond the module holds is either locked in an open challenge or owed as a refund.
    function invariant_bondsFullyBacked() public view {
        uint256 owed;
        for (uint256 i = 0; i < 4; i++) {
            address u = h.user(i);
            (,,,, bool bonded,,) = d.challenges(CID, asset, u);
            if (bonded) owed += d.challengeBond();
            owed += d.challengeRefunds(u);
        }
        assertEq(DisputeHandlerToken(h.bondTokenAddr()).balanceOf(address(d)), owed, "bond accounting mismatch");
    }
}

/// @notice Deterministic walk through every handler path, so the invariant suite is known to reach
///         challenge, answer, expire, matching-epoch clear and bond withdrawal rather than passing
///         vacuously. A per-run `afterInvariant` guard can't do this reliably: with 8 actions at
///         depth 64, about 1 run in 5,000 never picks `challenge`.
contract DisputeHandlerSmokeTest is Test {
    bytes32 internal constant CID = keccak256("kopi");
    DisputeHandler internal h;

    function setUp() public {
        h = new DisputeHandler();
    }

    function test_answerAndWithdraw() public {
        h.challenge(0, 1, true, 0);
        h.answer(0);
        assertEq(h.calls("answer"), 1, "honest challenge answered");
        h.withdrawBond(0);
        assertEq(h.calls("withdraw"), 1);
    }

    function test_expireMatchAndClear() public {
        h.challenge(1, 1, false, 5);
        h.challenge(2, 1, true, 0);
        h.warp(3 hours);
        assertTrue(h.disputes().hasOverdueChallenge(CID, h.assetAddr()));
        h.expire(1);
        h.expire(2);
        assertEq(h.calls("expire"), 2);
        assertEq(h.disputes().openDisputeCount(CID, h.assetAddr()), 2);

        h.commitNext();
        h.markMatching(1); // inflated balance: cannot be matched
        h.markMatching(2);
        assertEq(h.calls("mark"), 1);
        h.warp(3 hours);
        h.clear(1);
        h.clear(2);
        assertEq(h.calls("clear"), 1);
        assertEq(h.disputes().openDisputeCount(CID, h.assetAddr()), 1, "inflated dispute stays open");
    }

    function test_equivocationSettlesAndRefunds() public {
        h.challenge(0, 1, true, 0);
        h.challenge(3, 1, false, 7);
        h.equivocate(0);
        assertEq(h.calls("equivocate"), 1);
        DisputeModule d = h.disputes();
        assertEq(d.openChallengeCount(CID, h.assetAddr()), 0, "inline batch settles a short queue");
        h.settle(3);
        assertEq(h.calls("settle"), 1);
        h.withdrawBond(0);
        h.withdrawBond(3);
        assertEq(h.calls("withdraw"), 2);
        assertEq(DisputeHandlerToken(h.bondTokenAddr()).balanceOf(address(d)), 0, "every bond returned");
    }
}

interface DisputeHandlerToken {
    function balanceOf(address) external view returns (uint256);
}
