// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DisputeModule} from "../../src/DisputeModule.sol";
import {RPBase} from "./helpers/RPBase.sol";

/// @notice SETTLE-1 regression: settling every open challenge in one loop ran out of block gas at
///         roughly 909 challenges, so an equivocation proof could not be submitted. Settlement is now
///         a bounded inline batch plus a permissionless resumable cursor.
contract EquivocationSettlementTest is RPBase {
    uint256 internal constant BOND = 1e6;
    uint256 internal constant N = 2_000;
    uint256 internal constant BLOCK_GAS_LIMIT = 30_000_000;

    DisputeModule internal disputes;
    address[] internal subjects;

    function setUp() public {
        _deployCore();
        disputes = new DisputeModule(registry, ledger, address(bondToken), BOND, 1 hours, 1 hours);
        _commit(1);
    }

    function _statementSig(address who, uint256 amount) internal view returns (bytes memory) {
        bytes32 structHash =
            keccak256(abi.encode(disputes.BALANCE_TYPEHASH(), CID, address(asset), uint64(1), who, amount));
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

    function _openChallenges(uint256 n) internal {
        for (uint256 i = 0; i < n; i++) {
            address u = address(uint160(0x100000 + i));
            subjects.push(u);
            bytes memory sig = _statementSig(u, 1e6);
            bondToken.mint(u, BOND);
            vm.startPrank(u);
            bondToken.approve(address(disputes), BOND);
            disputes.challengeInclusion(CID, address(asset), 1, u, 1e6, sig);
            vm.stopPrank();
        }
    }

    function _equivocate() internal {
        (, uint256 total) = _root(1);
        uint256[] memory allocs = new uint256[](1);
        allocs[0] = total;
        bytes32 allocCmt = keccak256(abi.encode(_chains(), allocs));
        bytes32 otherRoot = keccak256("forked book");
        bytes32 digest = ledger.commitmentDigest(CID, address(asset), 1, otherRoot, total, allocCmt, LEAVES);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OP_PK, digest);
        disputes.openEquivocationDispute(CID, address(asset), 1, otherRoot, total, allocCmt, LEAVES, abi.encodePacked(r, s, v));
    }

    function test_equivocationWith2000OpenChallengesStaysUnderGasLimit() public {
        _openChallenges(N);
        assertEq(disputes.openChallengeCount(CID, address(asset)), N);

        uint256 g = gasleft();
        _equivocate();
        uint256 used = g - gasleft();
        // ~36k gas per inline refund (cold refund slot) x SETTLE_BATCH, independent of queue length.
        assertLt(used, BLOCK_GAS_LIMIT / 10, "equivocation proof must not scale with the queue");
        assertTrue(disputes.equivocationPermanent(CID, address(asset)));
        assertEq(disputes.challengeHead(CID, address(asset)), disputes.SETTLE_BATCH());
        assertTrue(disputes.isDisputed(CID, address(asset)));

        bool done;
        uint256 settled = disputes.SETTLE_BATCH();
        address keeper = makeAddr("keeper");
        while (!done) {
            vm.prank(keeper);
            g = gasleft();
            (uint256 s, bool d) = disputes.settleChallengesAfterEquivocation(CID, address(asset), 250);
            assertLt(g - gasleft(), BLOCK_GAS_LIMIT / 2, "one page fits comfortably in a block");
            settled += s;
            done = d;
        }
        assertEq(settled, N, "every challenge settled exactly once");
        assertEq(disputes.openChallengeCount(CID, address(asset)), 0);
        assertEq(disputes.challengeHead(CID, address(asset)), N);

        for (uint256 i = 0; i < N; i += 97) {
            (,,, bool open, bool bonded,,) = disputes.challenges(CID, address(asset), subjects[i]);
            assertFalse(open);
            assertFalse(bonded);
            assertEq(disputes.challengeRefunds(subjects[i]), BOND);
        }
        vm.prank(subjects[N - 1]);
        disputes.withdrawChallengeBond();
        assertEq(bondToken.balanceOf(subjects[N - 1]), BOND);
        assertEq(bondToken.balanceOf(address(disputes)), (N - 1) * BOND, "remaining bonds all owed as refunds");
    }

    function test_settleRevertsBeforeEquivocation() public {
        _openChallenges(3);
        vm.expectRevert(DisputeModule.NotPermanent.selector);
        disputes.settleChallengesAfterEquivocation(CID, address(asset), 10);
    }

    function test_expireStillWorksPastTheCursor() public {
        _openChallenges(70);
        _equivocate();
        assertEq(disputes.openChallengeCount(CID, address(asset)), 6);
        vm.warp(block.timestamp + 2 hours);
        disputes.expireChallenge(CID, address(asset), subjects[69]);
        assertEq(disputes.challengeRefunds(subjects[69]), BOND);
        (uint256 s, bool done) = disputes.settleChallengesAfterEquivocation(CID, address(asset), 100);
        assertEq(s, 5, "the already-expired challenge is skipped, not refunded twice");
        assertTrue(done);
        assertEq(disputes.challengeRefunds(subjects[69]), BOND);
    }
}
