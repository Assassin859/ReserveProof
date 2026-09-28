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
///         custodial asset. While the proof fails for a blocking reason, every path that prices
///         collateral (borrow, indebted withdrawCollateral, liquidate) reverts, and every path that does
///         not (supply, withdraw, supplyCollateral, repay, debt-free withdrawCollateral) keeps working.
///         Non-blocking reasons keep pricing, and a poked freeze ends after maxFreeze.
contract MorphoIntegrationTest is RPFull {
    using MarketParamsLib for MarketParams;

    uint256 internal constant LLTV = 0.8e18;
    /// @dev Collateral and loan token both have 6 decimals and trade 1:1, so the Morpho price is 1e36.
    uint256 internal constant PRICE = 1e36;
    uint32 internal constant MAX_FREEZE = 72 hours;

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

    uint16 internal constant DEFAULT_MASK = uint16(
        (1 << RPTypes.REASON_LIVE_SHORT) | (1 << RPTypes.REASON_UNDERCOLLATERALIZED)
            | (1 << RPTypes.REASON_DISPUTED) | (1 << RPTypes.REASON_EXIT_DEFAULT)
    );

    function _gated(IMorphoOracle b, address o, address a) internal returns (SolvencyGatedMorphoOracle) {
        return new SolvencyGatedMorphoOracle(b, ISolvencyOracle(o), CID, a, DEFAULT_MASK, MAX_FREEZE);
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

    function testFuzz_priceFollowsTheBlockingMask(uint8 reason) public {
        reason = uint8(bound(reason, 0, 9));
        _mockReason(reason);
        bool blocked = reason != RPTypes.REASON_OK && ((DEFAULT_MASK >> reason) & 1) == 1;
        assertEq(gated.blocks(reason), blocked);
        if (blocked) {
            _expectInsolvent(reason);
            gated.price();
        } else {
            assertEq(gated.price(), PRICE);
        }
    }

    function test_defaultMaskBlocksOnlyShortfallEvidence() public view {
        assertEq(gated.blockingReasons(), gated.DEFAULT_BLOCKING_REASONS());
        assertTrue(gated.blocks(RPTypes.REASON_LIVE_SHORT));
        assertTrue(gated.blocks(RPTypes.REASON_UNDERCOLLATERALIZED));
        assertTrue(gated.blocks(RPTypes.REASON_DISPUTED));
        assertTrue(gated.blocks(RPTypes.REASON_EXIT_DEFAULT));
        assertFalse(gated.blocks(RPTypes.REASON_STALE));
        assertFalse(gated.blocks(RPTypes.REASON_MULTIPLIER_DRIFT));
        assertFalse(gated.blocks(RPTypes.REASON_INSUFFICIENT_SAMPLES));
        assertFalse(gated.blocks(RPTypes.REASON_NO_EPOCH));
        assertFalse(gated.blocks(RPTypes.REASON_INACTIVE));
        assertFalse(gated.blocks(RPTypes.REASON_OK));
    }

    function test_constructorsRejectZero() public {
        IMorphoOracle b = IMorphoOracle(address(base));
        ISolvencyOracle o = ISolvencyOracle(address(oracle));
        vm.expectRevert(SolvencyGatedMorphoOracle.ZeroAddress.selector);
        new SolvencyGatedMorphoOracle(IMorphoOracle(address(0)), o, CID, address(asset), DEFAULT_MASK, MAX_FREEZE);
        vm.expectRevert(SolvencyGatedMorphoOracle.ZeroAddress.selector);
        new SolvencyGatedMorphoOracle(b, o, CID, address(0), DEFAULT_MASK, MAX_FREEZE);
        vm.expectRevert(SolvencyGuard.ZeroOracle.selector);
        new SolvencyGatedMorphoOracle(b, ISolvencyOracle(address(0)), CID, address(asset), DEFAULT_MASK, MAX_FREEZE);
        vm.expectRevert(SolvencyGatedMorphoOracle.ZeroMaxFreeze.selector);
        new SolvencyGatedMorphoOracle(b, o, CID, address(asset), DEFAULT_MASK, 0);
        vm.expectRevert(FixedPriceMorphoOracle.ZeroPrice.selector);
        new FixedPriceMorphoOracle(0);
        assertEq(new FixedPriceMorphoOracle(PRICE).price(), PRICE);
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

    function test_staleKeepsBorrowAndLiquidationWorking() public {
        vm.warp(vm.getBlockTimestamp() + 8 days);
        (bool ok, uint8 reason) = _status(address(asset));
        assertFalse(ok);
        assertEq(reason, RPTypes.REASON_STALE);

        _underwater();
        vm.prank(liquidator);
        morpho.liquidate(mp, borrower, 100e6, 0, "");
        assertEq(morpho.position(id, borrower).collateral, 900e6, "a missed publish must not shield a bad loan");
    }

    function test_splitDriftKeepsPricing() public {
        _mockReason(RPTypes.REASON_MULTIPLIER_DRIFT);
        _borrow(1e6);
        assertEq(bondToken.balanceOf(borrower), 1e6);
    }

    function test_freezeEndsAfterMaxFreezeSoLiquidationsClear() public {
        _underwater();
        _insolvent();
        assertTrue(gated.poke());
        uint256 started = vm.getBlockTimestamp();
        assertEq(gated.freezeStartedAt(), started);

        vm.warp(started + MAX_FREEZE - 1);
        vm.prank(liquidator);
        _expectInsolvent(RPTypes.REASON_LIVE_SHORT);
        morpho.liquidate(mp, borrower, 100e6, 0, "");

        vm.warp(started + MAX_FREEZE);
        vm.prank(liquidator);
        morpho.liquidate(mp, borrower, 100e6, 0, "");
        assertEq(morpho.position(id, borrower).collateral, 900e6, "freeze must not outlast maxFreeze");
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
