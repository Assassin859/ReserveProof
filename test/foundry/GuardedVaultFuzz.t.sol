// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RPFull} from "./helpers/RPFull.sol";
import {GuardedLendingVault} from "../../src/examples/GuardedLendingVault.sol";
import {SolvencyGuard} from "../../src/guards/SolvencyGuard.sol";
import {ISolvencyOracle} from "../../src/interfaces/ISolvencyOracle.sol";
import {RPTypes} from "../../src/libraries/RPTypes.sol";

/// @dev Vault fixture: collateral is the custodial book asset, loan token is a separate USDG mock.
///      collateralPrice = 1e18 makes 1 collateral unit worth 1 loan unit, so maxBorrow = coll * LTV.
abstract contract VaultBase is RPFull {
    uint16 internal constant LTV = 5000;
    GuardedLendingVault internal vault;
    address internal lender = makeAddr("lender");
    address internal borrower = makeAddr("borrower");

    function _deployVault() internal {
        _deployFull();
        vault = new GuardedLendingVault(
            ISolvencyOracle(address(oracle)), CID, address(asset), address(bondToken), 1e18, LTV
        );
        bondToken.mint(lender, 1e30);
        vm.prank(lender);
        bondToken.approve(address(vault), type(uint256).max);
        vm.prank(lender);
        vault.supply(1e24);
        vm.startPrank(borrower);
        asset.approve(address(vault), type(uint256).max);
        bondToken.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    function _deposit(address who, uint256 amount) internal {
        asset.mint(who, amount);
        vm.prank(who);
        vault.depositCollateral(amount);
    }

    /// @dev Break solvency one of three ways; returns the reason the oracle should report.
    function _breakSolvency(uint256 how) internal returns (uint8) {
        how = how % 3;
        if (how == 0) {
            _setReserve(0);
            return RPTypes.REASON_LIVE_SHORT;
        }
        if (how == 1) {
            vm.warp(vm.getBlockTimestamp() + 8 days);
            return RPTypes.REASON_STALE;
        }
        _challenge(0, amounts[0]);
        vm.warp(vm.getBlockTimestamp() + WINDOW + 1);
        return RPTypes.REASON_DISPUTED;
    }
}

contract GuardedVaultFuzzTest is VaultBase {
    function setUp() public {
        _deployVault();
        _publish(2 * NEED);
    }

    function testFuzz_borrowWithinLtvWhenSolvent(uint256 coll, uint256 amt) public {
        coll = bound(coll, 2, 1e24);
        amt = bound(amt, 1, (coll * LTV) / 10_000);
        _deposit(borrower, coll);
        vm.prank(borrower);
        vault.borrow(amt);
        assertEq(vault.debtOf(borrower), amt);
        assertEq(bondToken.balanceOf(borrower), amt);
    }

    function testFuzz_borrowAboveLtvReverts(uint256 coll, uint256 extra) public {
        coll = bound(coll, 2, 1e24);
        uint256 max = (coll * LTV) / 10_000;
        uint256 amt = max + bound(extra, 1, 1e18);
        vm.assume(amt <= vault.availableLiquidity());
        _deposit(borrower, coll);
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(GuardedLendingVault.ExceedsLtv.selector, max, amt));
        vault.borrow(amt);
    }

    function testFuzz_borrowBlockedWithReasonWhenInsolvent(uint256 how, uint256 coll) public {
        coll = bound(coll, 2, 1e24);
        _deposit(borrower, coll);
        uint8 reason = _breakSolvency(how);
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(SolvencyGuard.Insolvent.selector, reason));
        vault.borrow(1);
    }

    function testFuzz_repayNeverBlocked(uint256 how, uint256 coll, uint256 repayAmt) public {
        coll = bound(coll, 4, 1e24);
        uint256 debt = (coll * LTV) / 10_000;
        _deposit(borrower, coll);
        vm.prank(borrower);
        vault.borrow(debt);
        _breakSolvency(how);
        repayAmt = bound(repayAmt, 1, 2 * debt);
        vm.prank(borrower);
        uint256 paid = vault.repay(repayAmt);
        assertEq(paid, repayAmt < debt ? repayAmt : debt, "repay caps at outstanding debt");
        assertEq(vault.debtOf(borrower), debt - paid);
    }

    function testFuzz_debtFreeWithdrawNeverBlocked(uint256 how, uint256 coll, uint256 out) public {
        coll = bound(coll, 1, 1e24);
        out = bound(out, 1, coll);
        _deposit(borrower, coll);
        _breakSolvency(how);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        vm.prank(borrower);
        vault.withdrawCollateral(out);
        assertEq(asset.balanceOf(borrower), out);
    }

    function testFuzz_indebtedWithdrawBlockedWhileInsolvent(uint256 how, uint256 coll) public {
        coll = bound(coll, 4, 1e24);
        _deposit(borrower, coll);
        vm.prank(borrower);
        vault.borrow(1);
        uint8 reason = _breakSolvency(how);
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(SolvencyGuard.Insolvent.selector, reason));
        vault.withdrawCollateral(1);
    }

    function testFuzz_deRiskPathWhileInsolvent(uint256 how, uint256 coll) public {
        coll = bound(coll, 4, 1e24);
        uint256 debt = (coll * LTV) / 10_000;
        _deposit(borrower, coll);
        vm.prank(borrower);
        vault.borrow(debt);
        _breakSolvency(how);
        vm.startPrank(borrower);
        vault.repay(debt);
        vault.withdrawCollateral(coll);
        vm.stopPrank();
        assertEq(asset.balanceOf(borrower), coll, "repay then exit returns all collateral");
    }

    function testFuzz_withdrawCannotBreakLtv(uint256 coll, uint256 out) public {
        coll = bound(coll, 4, 1e24);
        uint256 debt = (coll * LTV) / 10_000;
        _deposit(borrower, coll);
        vm.prank(borrower);
        vault.borrow(debt);
        out = bound(out, 1, coll);
        uint256 maxAfter = ((coll - out) * LTV) / 10_000;
        vm.prank(borrower);
        if (debt > maxAfter) {
            vm.expectRevert(abi.encodeWithSelector(GuardedLendingVault.ExceedsLtv.selector, maxAfter, debt));
        }
        vault.withdrawCollateral(out);
    }

    function testFuzz_recoveryReopensBorrowing(uint256 coll) public {
        coll = bound(coll, 4, 1e24);
        _deposit(borrower, coll);
        _setReserve(0);
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(SolvencyGuard.Insolvent.selector, RPTypes.REASON_LIVE_SHORT));
        vault.borrow(1);
        _setReserve(2 * NEED);
        _commit(2);
        _sample(address(asset));
        vm.prank(borrower);
        vault.borrow(1);
        assertEq(vault.debtOf(borrower), 1);
    }

    function testFuzz_depositNeverBlocked(uint256 how, uint256 coll) public {
        coll = bound(coll, 1, 1e24);
        _breakSolvency(how);
        _deposit(borrower, coll);
        assertEq(vault.collateralOf(borrower), coll);
    }

    function testFuzz_supplyWithdrawBoundedByLiquidity(uint256 coll, uint256 ask) public {
        coll = bound(coll, 4, 1e24);
        uint256 debt = (coll * LTV) / 10_000;
        _deposit(borrower, coll);
        vm.prank(borrower);
        vault.borrow(debt);
        uint256 avail = vault.availableLiquidity();
        assertEq(avail, 1e24 - debt);
        ask = bound(ask, 1, 1e24);
        vm.prank(lender);
        if (ask > avail) {
            vm.expectRevert(abi.encodeWithSelector(GuardedLendingVault.InsufficientLiquidity.selector, avail, ask));
        }
        vault.withdrawSupply(ask);
    }

    function test_zeroAmountsRevert() public {
        vm.startPrank(borrower);
        vm.expectRevert(GuardedLendingVault.ZeroAmount.selector);
        vault.depositCollateral(0);
        vm.expectRevert(GuardedLendingVault.ZeroAmount.selector);
        vault.withdrawCollateral(0);
        vm.expectRevert(GuardedLendingVault.ZeroAmount.selector);
        vault.borrow(0);
        vm.expectRevert(GuardedLendingVault.ZeroAmount.selector);
        vault.repay(0);
        vm.expectRevert(GuardedLendingVault.ZeroAmount.selector);
        vault.supply(0);
        vm.expectRevert(GuardedLendingVault.ZeroAmount.selector);
        vault.withdrawSupply(0);
        vm.stopPrank();
    }
}

/// @notice Three borrowers and one lender act on the vault while the custodian's reserves swing above
///         and below the floor, epochs are re-published and time passes.
contract VaultHandler is VaultBase {
    address[3] internal actors;
    uint64 public epoch = 1;
    uint256 public ghostBorrowWhileInsolvent;
    uint256 public ghostDebtFreeWithdrawBlocked;
    uint256 public ghostRepayBlocked;
    mapping(bytes32 => uint256) public calls;

    constructor() {
        _deployVault();
        _publish(2 * NEED);
        for (uint256 i = 0; i < 3; i++) {
            actors[i] = makeAddr(string(abi.encodePacked("actor", vm.toString(i))));
            vm.startPrank(actors[i]);
            asset.approve(address(vault), type(uint256).max);
            bondToken.approve(address(vault), type(uint256).max);
            vm.stopPrank();
            bondToken.mint(actors[i], 1e24);
        }
    }

    function deposit(uint256 who, uint256 amt) external useClock {
        address a = actors[who % 3];
        amt = bound(amt, 1, 1e22);
        asset.mint(a, amt);
        vm.prank(a);
        vault.depositCollateral(amt);
        calls["deposit"]++;
    }

    function borrow(uint256 who, uint256 amt) external useClock {
        address a = actors[who % 3];
        uint256 room = vault.maxBorrow(a) - vault.debtOf(a);
        uint256 liq = vault.availableLiquidity();
        if (room == 0 || liq == 0) return;
        amt = bound(amt, 1, room < liq ? room : liq);
        bool solvent = oracle.status(CID, address(asset)).ok;
        vm.prank(a);
        try vault.borrow(amt) {
            if (!solvent) ghostBorrowWhileInsolvent++;
            calls["borrow"]++;
        } catch (bytes memory err) {
            require(!solvent && bytes4(err) == SolvencyGuard.Insolvent.selector, "unexpected borrow revert");
            calls["borrowBlocked"]++;
        }
    }

    function repay(uint256 who, uint256 amt) external useClock {
        address a = actors[who % 3];
        uint256 debt = vault.debtOf(a);
        if (debt == 0) return;
        amt = bound(amt, 1, 2 * debt);
        vm.prank(a);
        try vault.repay(amt) {
            calls["repay"]++;
        } catch {
            ghostRepayBlocked++;
        }
    }

    function withdrawCollateral(uint256 who, uint256 amt) external useClock {
        address a = actors[who % 3];
        uint256 coll = vault.collateralOf(a);
        if (coll == 0) return;
        amt = bound(amt, 1, coll);
        uint256 debt = vault.debtOf(a);
        bool solvent = oracle.status(CID, address(asset)).ok;
        uint256 maxAfter = ((coll - amt) * LTV) / 10_000;
        vm.prank(a);
        try vault.withdrawCollateral(amt) {
            calls["withdraw"]++;
        } catch (bytes memory err) {
            if (debt == 0) ghostDebtFreeWithdrawBlocked++;
            bytes4 sel = bytes4(err);
            require(
                (sel == SolvencyGuard.Insolvent.selector && !solvent)
                    || (sel == GuardedLendingVault.ExceedsLtv.selector && debt > maxAfter),
                "unexpected withdraw revert"
            );
            calls["withdrawBlocked"]++;
        }
    }

    function withdrawSupply(uint256 amt) external useClock {
        uint256 liq = vault.availableLiquidity();
        uint256 mine = vault.supplied(lender);
        uint256 cap = liq < mine ? liq : mine;
        if (cap == 0) return;
        vm.prank(lender);
        vault.withdrawSupply(bound(amt, 1, cap));
    }

    function swingReserves(uint256 amt) external useClock {
        _setReserve(bound(amt, 0, 2 * NEED));
        calls["swing"]++;
    }

    function republish() external useClock {
        if (epoch >= 20) return;
        epoch++;
        _commit(epoch);
        _sample(address(asset));
        clock = vm.getBlockTimestamp();
    }

    function warp(uint256 secs) external useClock {
        _advance(bound(secs, 1, 3 days));
    }

    function actor(uint256 i) external view returns (address) {
        return actors[i];
    }

    function vaultAddr() external view returns (address) {
        return address(vault);
    }

    function collateralAddr() external view returns (address) {
        return address(asset);
    }

    function loanAddr() external view returns (address) {
        return address(bondToken);
    }
}

interface IBal {
    function balanceOf(address) external view returns (uint256);
}

contract GuardedVaultInvariantsTest is Test {
    VaultHandler internal h;
    GuardedLendingVault internal v;

    function setUp() public {
        h = new VaultHandler();
        v = GuardedLendingVault(h.vaultAddr());
        targetContract(address(h));
        bytes4[] memory s = new bytes4[](8);
        s[0] = VaultHandler.deposit.selector;
        s[1] = VaultHandler.borrow.selector;
        s[2] = VaultHandler.repay.selector;
        s[3] = VaultHandler.withdrawCollateral.selector;
        s[4] = VaultHandler.withdrawSupply.selector;
        s[5] = VaultHandler.swingReserves.selector;
        s[6] = VaultHandler.republish.selector;
        s[7] = VaultHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: s}));
    }

    function invariant_loanTokenAccounting() public view {
        assertEq(IBal(h.loanAddr()).balanceOf(address(v)), v.totalSupplied() - v.totalBorrowed());
    }

    function invariant_collateralAndDebtSums() public view {
        uint256 coll;
        uint256 debt;
        for (uint256 i = 0; i < 3; i++) {
            coll += v.collateralOf(h.actor(i));
            debt += v.debtOf(h.actor(i));
        }
        assertEq(IBal(h.collateralAddr()).balanceOf(address(v)), coll, "vault collateral != sum of positions");
        assertEq(v.totalBorrowed(), debt, "totalBorrowed != sum of debts");
    }

    function invariant_noPositionAboveLtv() public view {
        for (uint256 i = 0; i < 3; i++) {
            assertLe(v.debtOf(h.actor(i)), v.maxBorrow(h.actor(i)), "position above LTV");
        }
    }

    function invariant_noBorrowWhileInsolvent() public view {
        assertEq(h.ghostBorrowWhileInsolvent(), 0, "borrow succeeded while the oracle was failing");
    }

    function invariant_exitPathsNeverBlocked() public view {
        assertEq(h.ghostRepayBlocked(), 0, "repay reverted");
        assertEq(h.ghostDebtFreeWithdrawBlocked(), 0, "debt-free withdraw reverted");
    }
}

contract VaultHandlerSmokeTest is Test {
    function test_handlerReachesBlockedAndOpenPaths() public {
        VaultHandler h = new VaultHandler();
        h.deposit(0, 1e20);
        h.borrow(0, 1e18);
        assertEq(h.calls("borrow"), 1);
        h.swingReserves(0);
        h.borrow(0, 1e18);
        assertEq(h.calls("borrowBlocked"), 1, "borrow blocked once reserves fall short");
        h.withdrawCollateral(0, 1);
        assertEq(h.calls("withdrawBlocked"), 1, "indebted withdraw blocked while insolvent");
        h.repay(0, type(uint256).max);
        h.withdrawCollateral(0, 1e20);
        assertEq(h.calls("withdraw"), 1, "debt-free exit while insolvent");
        h.swingReserves(2 * 1030e6);
        h.republish();
        h.deposit(1, 1e20);
        h.borrow(1, 1e18);
        assertEq(h.calls("borrow"), 2, "borrowing resumes after recovery");
    }
}
