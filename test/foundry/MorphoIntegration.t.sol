// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IMorpho, MarketParams, Id, Position} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {IrmMock} from "morpho-blue/mocks/IrmMock.sol";
import {OracleMock} from "morpho-blue/mocks/OracleMock.sol";
import {RPFull} from "./helpers/RPFull.sol";
import {SolvencyGatedMorphoOracle, IMorphoOracle} from "../../src/integrations/SolvencyGatedMorphoOracle.sol";
import {FixedPriceMorphoOracle} from "../../src/integrations/FixedPriceMorphoOracle.sol";
import {SolvencyGuard} from "../../src/guards/SolvencyGuard.sol";
import {ISolvencyOracle} from "../../src/interfaces/ISolvencyOracle.sol";
import {RPTypes} from "../../src/libraries/RPTypes.sol";

/// @notice The gated oracle in front of a real Morpho Blue v1.0.0 market whose collateral is the
///         custodial asset. While the proof fails for any reason, every path that prices collateral
///         (borrow, indebted withdrawCollateral, liquidate) reverts, and every path that does not
///         (supply, withdraw, supplyCollateral, repay, debt-free withdrawCollateral) keeps working.
///         Once one continuous, poked incident lasts maxFreeze, the price comes back discounted.
contract MorphoIntegrationTest is RPFull {
    using MarketParamsLib for MarketParams;

    uint256 internal constant LLTV = 0.8e18;
    /// @dev Collateral and loan token both have 6 decimals and trade 1:1, so the Morpho price is 1e36.
    uint256 internal constant PRICE = 1e36;
    uint32 internal constant MAX_FREEZE = 72 hours;
    uint32 internal constant POKE_GAP = 6 hours;
    uint16 internal constant POST_CAP_BPS = 5000;

    IMorpho internal morpho;
    OracleMock internal base;
    SolvencyGatedMorphoOracle internal gated;
    MarketParams internal mp;
    Id internal id;

    address internal lender = makeAddr("lender");
    address internal borrower = makeAddr("borrower");
    address internal liquidator = makeAddr("liquidator");

    function setUp() public {
        _deployFull();
        _publish(2 * NEED);

        morpho = IMorpho(deployCode("Morpho.sol:Morpho", abi.encode(address(this))));
        address irm = address(new IrmMock());
        morpho.enableIrm(irm);
        morpho.enableLltv(LLTV);

        base = new OracleMock();
        base.setPrice(PRICE);
        gated = _gated(IMorphoOracle(address(base)), address(oracle), address(asset));

        mp = MarketParams({
            loanToken: address(bondToken),
            collateralToken: address(asset),
            oracle: address(gated),
            irm: irm,
            lltv: LLTV
        });
        morpho.createMarket(mp);
        id = mp.id();

        bondToken.mint(lender, 1e12);
        vm.startPrank(lender);
        bondToken.approve(address(morpho), type(uint256).max);
        morpho.supply(mp, 1e12, 0, lender, "");
        vm.stopPrank();

        asset.mint(borrower, 1e12);
        vm.startPrank(borrower);
        asset.approve(address(morpho), type(uint256).max);
        bondToken.approve(address(morpho), type(uint256).max);
        morpho.supplyCollateral(mp, 1000e6, borrower, "");
        vm.stopPrank();

        bondToken.mint(liquidator, 1e12);
        vm.prank(liquidator);
        bondToken.approve(address(morpho), type(uint256).max);
    }

    function _gated(IMorphoOracle b, address o, address a) internal returns (SolvencyGatedMorphoOracle) {
        return new SolvencyGatedMorphoOracle(b, ISolvencyOracle(o), CID, a, MAX_FREEZE, POKE_GAP, POST_CAP_BPS);
    }

    /// @dev A keeper pokes every 5 hours (inside the 6-hour gap) until `until`, then once more at `until`.
    function _pokeUntil(uint256 until) internal {
        while (vm.getBlockTimestamp() + 5 hours < until) {
            vm.warp(vm.getBlockTimestamp() + 5 hours);
            assertTrue(gated.poke());
        }
        vm.warp(until);
        assertTrue(gated.poke());
    }

    function _insolvent() internal {
        _setReserve(0);
    }

    /// @dev Make the solvency oracle report `reason` for the market's asset.
    function _mockReason(uint8 reason) internal {
        vm.mockCall(
            address(oracle),
            abi.encodeWithSelector(ISolvencyOracle.status.selector, CID, address(asset)),
            abi.encode(
                ISolvencyOracle.SolvencyStatus({
                    ok: reason == RPTypes.REASON_OK,
                    epochId: 1,
                    updatedAt: uint64(vm.getBlockTimestamp()),
                    reason: reason
                })
            )
        );
    }

    /// @dev Borrower at 800 of 1000 collateral, then the base price halves: far past LLTV.
    function _underwater() internal {
        _borrow(800e6);
        base.setPrice(PRICE / 2);
    }

    function _borrow(uint256 amount) internal {
        vm.prank(borrower);
        morpho.borrow(mp, amount, 0, borrower, borrower);
    }

    function _expectInsolvent(uint8 reason) internal {
        vm.expectRevert(abi.encodeWithSelector(SolvencyGuard.Insolvent.selector, reason));
    }

    // ── the wrapper on its own ─────────────────────────────────────────────

    function testFuzz_priceForwardsBaseWhileSolvent(uint256 p) public {
        base.setPrice(p);
        assertEq(gated.price(), p);
    }

    function testFuzz_priceRevertsOnRealShortfall(uint256 how) public {
        uint8 reason;
        if (how % 2 == 0) {
            _setReserve(0);
            reason = RPTypes.REASON_LIVE_SHORT;
        } else {
            _challenge(1, amounts[1]);
            vm.warp(vm.getBlockTimestamp() + WINDOW + 1);
            reason = RPTypes.REASON_DISPUTED;
        }
        _expectInsolvent(reason);
        gated.price();
    }

    function testFuzz_everyFailureReasonBlocks(uint8 reason) public {
        reason = uint8(bound(reason, 1, 9));
        _mockReason(reason);
        _expectInsolvent(reason);
        gated.price();
    }

    function test_constructorsRejectBadParams() public {
        IMorphoOracle b = IMorphoOracle(address(base));
        ISolvencyOracle o = ISolvencyOracle(address(oracle));
        address a = address(asset);
        vm.expectRevert(SolvencyGatedMorphoOracle.ZeroAddress.selector);
        new SolvencyGatedMorphoOracle(IMorphoOracle(address(0)), o, CID, a, MAX_FREEZE, POKE_GAP, POST_CAP_BPS);
        vm.expectRevert(SolvencyGatedMorphoOracle.ZeroAddress.selector);
        new SolvencyGatedMorphoOracle(b, o, CID, address(0), MAX_FREEZE, POKE_GAP, POST_CAP_BPS);
        vm.expectRevert(SolvencyGuard.ZeroOracle.selector);
        new SolvencyGatedMorphoOracle(b, ISolvencyOracle(address(0)), CID, a, MAX_FREEZE, POKE_GAP, POST_CAP_BPS);
        vm.expectRevert(SolvencyGatedMorphoOracle.ZeroMaxFreeze.selector);
        new SolvencyGatedMorphoOracle(b, o, CID, a, 0, POKE_GAP, POST_CAP_BPS);
        vm.expectRevert(SolvencyGatedMorphoOracle.BadPokeGap.selector);
        new SolvencyGatedMorphoOracle(b, o, CID, a, MAX_FREEZE, 0, POST_CAP_BPS);
        vm.expectRevert(SolvencyGatedMorphoOracle.BadPokeGap.selector);
        new SolvencyGatedMorphoOracle(b, o, CID, a, MAX_FREEZE, MAX_FREEZE, POST_CAP_BPS);
        vm.expectRevert(SolvencyGatedMorphoOracle.BadPostCapBps.selector);
        new SolvencyGatedMorphoOracle(b, o, CID, a, MAX_FREEZE, POKE_GAP, 0);
        vm.expectRevert(SolvencyGatedMorphoOracle.BadPostCapBps.selector);
        new SolvencyGatedMorphoOracle(b, o, CID, a, MAX_FREEZE, POKE_GAP, 10_001);
        vm.expectRevert(FixedPriceMorphoOracle.ZeroPrice.selector);
        new FixedPriceMorphoOracle(0);
        assertEq(new FixedPriceMorphoOracle(PRICE).price(), PRICE);
    }

    // ── a shortfall hidden behind an earlier status() reason still blocks ──

    function test_attack_freshEpochWithoutSamplesThenDrain() public {
        _commit(2);
        _setReserve(0);
        (, uint8 reason) = _status(address(asset));
        assertEq(reason, RPTypes.REASON_INSUFFICIENT_SAMPLES);
        _expectInsolvent(RPTypes.REASON_INSUFFICIENT_SAMPLES);
        gated.price();
        _expectInsolvent(RPTypes.REASON_INSUFFICIENT_SAMPLES);
        _borrow(1e6);
        assertTrue(gated.poke(), "the freeze clock must start");
    }

    function test_attack_staleThenDrain() public {
        vm.warp(vm.getBlockTimestamp() + 8 days);
        _setReserve(0);
        (, uint8 reason) = _status(address(asset));
        assertEq(reason, RPTypes.REASON_STALE);
        _expectInsolvent(RPTypes.REASON_STALE);
        _borrow(1e6);
    }

    function test_attack_deactivatedCustodian() public {
        registry.deactivateCustodian(CID);
        _setReserve(0);
        (, uint8 reason) = _status(address(asset));
        assertEq(reason, RPTypes.REASON_INACTIVE);
        _expectInsolvent(RPTypes.REASON_INACTIVE);
        _borrow(1e6);
    }

    // ── the freeze clock belongs to one continuous incident ─────────────────

    function test_attack_preStartedClockDoesNotPrepayTheNextFreeze() public {
        _setReserve(0);
        assertTrue(gated.poke());
        _setReserve(2 * NEED);
        (bool ok,) = _status(address(asset));
        assertTrue(ok);

        vm.warp(vm.getBlockTimestamp() + MAX_FREEZE + 1);
        _setReserve(0);
        (bool running,,,) = gated.freezeState();
        assertFalse(running, "an old clock must be void");
        _expectInsolvent(RPTypes.REASON_LIVE_SHORT);
        gated.price();
        _expectInsolvent(RPTypes.REASON_LIVE_SHORT);
        _borrow(1e6);

        gated.poke();
        assertEq(gated.freezeStartedAt(), vm.getBlockTimestamp(), "the next poke starts a new incident");
    }

    function test_continuousIncidentPricesAtDiscountAfterCap() public {
        _borrow(500e6);
        _insolvent();
        assertTrue(gated.poke());
        uint256 started = vm.getBlockTimestamp();

        _pokeUntil(started + MAX_FREEZE - 1);
        vm.prank(liquidator);
        _expectInsolvent(RPTypes.REASON_LIVE_SHORT);
        morpho.liquidate(mp, borrower, 100e6, 0, "");

        vm.warp(started + MAX_FREEZE);
        assertEq(gated.price(), (PRICE * POST_CAP_BPS) / 10_000, "discounted, not full price");
        (bool running, uint64 s, uint64 capEndsAt,) = gated.freezeState();
        assertTrue(running);
        assertEq(s, started);
        assertEq(capEndsAt, started + MAX_FREEZE);

        vm.expectRevert(bytes("insufficient collateral"));
        _borrow(1e6);

        vm.prank(liquidator);
        morpho.liquidate(mp, borrower, 100e6, 0, "");
        assertLt(morpho.position(id, borrower).collateral, 1000e6, "the underwater loan must clear");
    }

    function test_capWithoutARecentPokeStillReverts() public {
        _insolvent();
        gated.poke();
        uint256 started = vm.getBlockTimestamp();
        vm.warp(started + MAX_FREEZE);
        _expectInsolvent(RPTypes.REASON_LIVE_SHORT);
        gated.price();

        gated.poke();
        assertEq(gated.freezeStartedAt(), vm.getBlockTimestamp(), "a lapsed incident restarts");
    }

    // ── inside Morpho Blue ─────────────────────────────────────────────────

    function testFuzz_borrowWorksWhileSolvent(uint256 amount) public {
        amount = bound(amount, 1, 800e6);
        _borrow(amount);
        assertEq(bondToken.balanceOf(borrower), amount);
    }

    function testFuzz_borrowRevertsWhileInsolvent(uint256 amount) public {
        amount = bound(amount, 1, 800e6);
        _insolvent();
        _expectInsolvent(RPTypes.REASON_LIVE_SHORT);
        _borrow(amount);
    }

    function test_insolventBorrowerCanRepayThenExit() public {
        _borrow(500e6);
        _insolvent();

        vm.startPrank(borrower);
        _expectInsolvent(RPTypes.REASON_LIVE_SHORT);
        morpho.withdrawCollateral(mp, 1, borrower, borrower);

        Position memory pos = morpho.position(id, borrower);
        morpho.repay(mp, 0, pos.borrowShares, borrower, "");
        morpho.withdrawCollateral(mp, 1000e6, borrower, borrower);
        vm.stopPrank();

        assertEq(morpho.position(id, borrower).collateral, 0, "debt-free exit must not need a price");
    }

    function test_lendersAndDepositorsUnaffectedWhileInsolvent() public {
        _borrow(100e6);
        _insolvent();

        vm.prank(lender);
        morpho.withdraw(mp, 500e6, 0, lender, lender);

        address other = makeAddr("other");
        asset.mint(other, 10e6);
        vm.startPrank(other);
        asset.approve(address(morpho), 10e6);
        morpho.supplyCollateral(mp, 10e6, other, "");
        vm.stopPrank();
        assertEq(morpho.position(id, other).collateral, 10e6);
    }

    function test_noLiquidationAtAFakePriceWhileInsolvent() public {
        _underwater();
        _insolvent();
        vm.prank(liquidator);
        _expectInsolvent(RPTypes.REASON_LIVE_SHORT);
        morpho.liquidate(mp, borrower, 1e6, 0, "");
        assertEq(morpho.position(id, borrower).collateral, 1000e6, "collateral seized while unpriced");
    }

    function test_unpokedFreezeHoldsAndPokeIsIdempotent() public {
        _insolvent();
        vm.warp(vm.getBlockTimestamp() + MAX_FREEZE + 1);
        _expectInsolvent(RPTypes.REASON_LIVE_SHORT);
        gated.price();

        gated.poke();
        uint64 started = gated.freezeStartedAt();
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        assertTrue(gated.poke());
        assertEq(gated.freezeStartedAt(), started, "a second poke must not restart the clock");
    }

    function test_recoveryAndPokeClearTheClock() public {
        _insolvent();
        gated.poke();
        _setReserve(2 * NEED);
        assertFalse(gated.poke());
        assertEq(gated.freezeStartedAt(), 0);
        assertEq(gated.lastFailSeenAt(), 0);

        vm.warp(vm.getBlockTimestamp() + MAX_FREEZE + 1);
        _setReserve(2 * NEED);
        _commit(2);
        _sample(address(asset));
        _insolvent();
        _expectInsolvent(RPTypes.REASON_LIVE_SHORT);
        gated.price();
    }

    function test_liquidationWorksOnceProofRecovers() public {
        _underwater();
        _insolvent();
        _setReserve(2 * NEED);
        _commit(2);
        _sample(address(asset));
        vm.prank(liquidator);
        morpho.liquidate(mp, borrower, 100e6, 0, "");
        assertEq(morpho.position(id, borrower).collateral, 900e6);
    }

    function test_borrowResumesAfterRecovery() public {
        _insolvent();
        _expectInsolvent(RPTypes.REASON_LIVE_SHORT);
        _borrow(1e6);
        _setReserve(2 * NEED);
        _commit(2);
        _sample(address(asset));
        _borrow(1e6);
        assertEq(bondToken.balanceOf(borrower), 1e6);
    }
}
