// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RPFull} from "./helpers/RPFull.sol";
import {RPTypes} from "../../src/libraries/RPTypes.sol";

/// @notice Property tests for SolvencyOracle.status over the full stack: coverage, sample minimum vs
///         live balance, staleness, disputes, ExitRight defaults, multiplier drift and reason priority.
contract SolvencyOracleFuzzTest is RPFull {
    uint256 internal constant MAX_RESERVE = 1e30;

    function setUp() public {
        _deployFull();
    }

    function testFuzz_okIffLiveCoversFloor(uint256 amount) public {
        amount = bound(amount, 0, MAX_RESERVE);
        _publish(amount);
        (bool ok, uint8 reason) = _status(address(asset));
        assertEq(ok, amount >= NEED, "ok must equal reserve >= 103% of book");
        assertEq(reason, ok ? RPTypes.REASON_OK : RPTypes.REASON_LIVE_SHORT);
    }

    function testFuzz_liveDropAfterSampleFlipsToLiveShort(uint256 start, uint256 drop) public {
        start = bound(start, NEED, MAX_RESERVE);
        drop = bound(drop, 0, start);
        _publish(start);
        _setReserve(start - drop);
        (bool ok, uint8 reason) = _status(address(asset));
        assertEq(ok, start - drop >= NEED, "a live drop below the floor must fail at once, without a new sample");
        if (!ok) assertEq(reason, RPTypes.REASON_LIVE_SHORT);
    }

    function testFuzz_sampleDipIsNotHiddenByTopUp(uint256 dip, uint256 topUp) public {
        dip = bound(dip, 0, NEED - 1);
        topUp = bound(topUp, NEED, MAX_RESERVE);
        _publish(dip);
        _setReserve(topUp);
        _sample(address(asset));
        (bool ok, uint8 reason) = _status(address(asset));
        assertFalse(ok, "window-dressing after a low sample must not pass");
        assertEq(reason, RPTypes.REASON_UNDERCOLLATERALIZED);
        assertEq(sampler.effectiveReserves(CID, address(asset), 1), dip, "effective = min(samples, live)");
    }

    function testFuzz_staleExactlyAfterMaxAge(uint256 dt) public {
        dt = bound(dt, 0, 30 days);
        _publish(NEED);
        uint256 committedAt = ledger.getEpoch(CID, address(asset), 1).committedAt;
        vm.warp(committedAt + dt);
        (bool ok, uint8 reason) = _status(address(asset));
        assertEq(ok, dt <= 7 days, "fresh iff within maxOracleAge");
        if (!ok) assertEq(reason, RPTypes.REASON_STALE);
    }

    function testFuzz_newEpochNeedsItsOwnSamples(uint256 amount) public {
        amount = bound(amount, NEED, MAX_RESERVE);
        _publish(amount);
        _commit(2);
        (bool ok, uint8 reason) = _status(address(asset));
        assertFalse(ok, "samples from epoch 1 must not carry over");
        assertEq(reason, RPTypes.REASON_INSUFFICIENT_SAMPLES);
        _sample(address(asset));
        (ok,) = _status(address(asset));
        assertTrue(ok);
    }

    function testFuzz_coverageFloorBoundary(uint16 bps, uint256 amount) public {
        bps = uint16(bound(bps, 10300, 30000));
        amount = bound(amount, 0, 4 * BOOK_TOTAL);
        assetConfig.setAssetConfig(
            CID, address(asset), address(asset), uint64(block.chainid), false, 0, bps, 7 days, 1, 1, bytes32(0), new uint64[](0)
        );
        _publish(amount);
        (bool ok,) = _status(address(asset));
        assertEq(ok, amount >= (BOOK_TOTAL * bps) / 10_000, "floor applied exactly");
    }

    function testFuzz_inactiveCustodianAlwaysFails(uint256 amount) public {
        amount = bound(amount, 0, MAX_RESERVE);
        _publish(amount);
        registry.deactivateCustodian(CID);
        (bool ok, uint8 reason) = _status(address(asset));
        assertFalse(ok);
        assertEq(reason, RPTypes.REASON_INACTIVE);
    }

    function testFuzz_unknownAssetHasNoEpoch(address other) public {
        vm.assume(other != address(asset) && other != address(stock));
        _publish(NEED);
        (bool ok, uint8 reason) = _status(other);
        assertFalse(ok);
        assertEq(reason, RPTypes.REASON_NO_EPOCH);
    }

    function testFuzz_unansweredChallengeFailsAfterWindow(uint256 userSeed, uint256 dt) public {
        uint256 i = bound(userSeed, 0, LEAVES - 1);
        dt = bound(dt, 0, 3 * WINDOW);
        _publish(2 * NEED);
        _challenge(i, amounts[i]);
        vm.warp(vm.getBlockTimestamp() + dt);
        (bool ok, uint8 reason) = _status(address(asset));
        assertEq(ok, dt <= WINDOW, "an open challenge only fails the oracle once overdue");
        if (!ok) assertEq(reason, RPTypes.REASON_DISPUTED);
    }

    function testFuzz_answeredChallengeNeverFails(uint256 userSeed, uint256 dt) public {
        uint256 i = bound(userSeed, 0, LEAVES - 1);
        dt = bound(dt, WINDOW + 1, 6 days);
        _publish(2 * NEED);
        _challenge(i, amounts[i]);
        vm.prank(operator);
        disputes.answerInclusion(CID, address(asset), users[i], _proof(1, i));
        vm.warp(vm.getBlockTimestamp() + dt);
        (bool ok,) = _status(address(asset));
        assertTrue(ok, "a proven balance must not leave the custodian disputed");
    }

    function testFuzz_removedWalletStopsCounting(uint256 amount) public {
        amount = bound(amount, NEED, MAX_RESERVE);
        _publish(amount);
        vm.startPrank(operator);
        registry.initiateWalletRemoval(CID, uint64(block.chainid), reserve);
        vm.warp(vm.getBlockTimestamp() + 3600);
        registry.finalizeWalletRemoval(CID, uint64(block.chainid), reserve);
        vm.stopPrank();
        assertEq(sampler.liveReserves(CID, address(asset)), 0, "removed wallet still counted");
        (bool ok, uint8 reason) = _status(address(asset));
        assertFalse(ok);
        assertEq(reason, RPTypes.REASON_LIVE_SHORT);
    }

    function testFuzz_isSolventAgreesWithStatus(uint256 amount, uint256 dt) public {
        amount = bound(amount, 0, MAX_RESERVE);
        dt = bound(dt, 0, 10 days);
        _publish(amount);
        vm.warp(vm.getBlockTimestamp() + dt);
        RPTypes.SolvencyStatus memory s = oracle.status(CID, address(asset));
        (bool ok, uint64 epochId, uint64 updatedAt) = oracle.isSolvent(CID, address(asset));
        assertEq(ok, s.ok);
        assertEq(epochId, s.epochId);
        assertEq(updatedAt, s.updatedAt);
        assertEq(s.ok, s.reason == RPTypes.REASON_OK, "ok iff reason OK");
    }

    function testFuzz_multiplierDriftFailsClosed(uint256 newMul, bool scheduled, uint256 delay) public {
        newMul = bound(newMul, 1, 100e18);
        stock.mint(reserve, 10 * BOOK_TOTAL);
        _commitRaw(address(stock), 1, BOOK_TOTAL);
        _sample(address(stock));
        (bool ok,) = _status(address(stock));
        assertTrue(ok, "baseline");

        if (scheduled) {
            stock.scheduleUIMultiplier(newMul, vm.getBlockTimestamp() + bound(delay, 1, 30 days));
        } else {
            stock.setUIMultiplierNow(newMul);
        }
        uint8 reason;
        (ok, reason) = _status(address(stock));
        assertEq(ok, newMul == 1e18, "any live or pending split/merge must fail until re-committed");
        if (!ok) assertEq(reason, RPTypes.REASON_MULTIPLIER_DRIFT);
    }

    function testFuzz_exitDefaultIsPermanent(uint256 userSeed, uint64 laterEpochs) public {
        uint256 i = bound(userSeed, 0, LEAVES - 1);
        laterEpochs = uint64(bound(laterEpochs, 1, 5));
        _publish(2 * NEED);
        bondToken.mint(operator, 10e6);
        vm.startPrank(operator);
        bondToken.approve(address(exitRight), 10e6);
        exitRight.postBond(CID, 10e6);
        exitRight.setBondConfig(CID, 1 days, 1e6, 3e6);
        vm.stopPrank();
        vm.prank(users[i]);
        uint256 id = exitRight.openClaim(CID, address(asset), amounts[i], _proof(1, i));
        vm.warp(vm.getBlockTimestamp() + 1 days);
        exitRight.slash(id);

        for (uint64 e = 2; e < 2 + laterEpochs; e++) {
            _commit(e);
            _sample(address(asset));
        }
        (bool ok, uint8 reason) = _status(address(asset));
        assertFalse(ok, "fresh epochs must not clear an ExitRight default");
        assertEq(reason, RPTypes.REASON_EXIT_DEFAULT);
    }

    function testFuzz_reasonPriorityStaleBeforeShort(uint256 amount, uint256 dt) public {
        amount = bound(amount, 0, NEED - 1);
        dt = bound(dt, 7 days + 1, 60 days);
        _publish(amount);
        vm.warp(vm.getBlockTimestamp() + dt);
        (, uint8 reason) = _status(address(asset));
        assertEq(reason, RPTypes.REASON_STALE, "staleness is reported before balance checks");
    }
}
