// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ExitRight} from "../../src/ExitRight.sol";
import {RPBase} from "./helpers/RPBase.sol";

/// @notice Drives ExitRight with users opening claims against the latest epoch, the operator settling
///         some, anyone slashing overdue ones, extra bond top-ups, new epochs and time warps.
contract ExitHandler is RPBase {
    uint256 public constant PER_CLAIM = 10e6;
    uint256 public constant TOTAL_IN_FLIGHT = 30e6;
    uint64 public constant DELAY = 1 days;
    uint64 public constant MAX_EPOCH = 12;

    ExitRight public exitRight;
    uint64 public latestEpoch;

    uint256 public ghostPosted;
    uint256 public ghostSlashPaid;
    bool public ghostDefaultSeen;
    mapping(bytes32 => uint256) public calls;

    modifier trackDefault() {
        if (clock == 0) clock = block.timestamp;
        vm.warp(clock);
        _;
        if (exitRight.exitDefault(CID, address(asset))) ghostDefaultSeen = true;
    }

    constructor() {
        _deployCore();
        exitRight = new ExitRight(registry, ledger, address(bondToken));
        latestEpoch = 1;
        _commit(1);
        _post(30e6);
        vm.prank(operator);
        exitRight.setBondConfig(CID, DELAY, PER_CLAIM, TOTAL_IN_FLIGHT);
        asset.mint(operator, 1e30);
        vm.prank(operator);
        asset.approve(address(exitRight), type(uint256).max);
    }

    // ── actions ─────────────────────────────────────────────────────────────

    function openClaim(uint256 userSeed) external trackDefault {
        uint256 i = bound(userSeed, 0, LEAVES - 1);
        address u = users[i];
        if (exitRight.claimed(CID, address(asset), u, latestEpoch)) return;
        vm.prank(u);
        try exitRight.openClaim(CID, address(asset), amounts[i], _proof(latestEpoch, i)) {
            calls["open"]++;
        } catch (bytes memory err) {
            require(bytes4(err) == ExitRight.BondCap.selector, "unexpected openClaim revert");
        }
    }

    function settle(uint256 claimSeed) external trackDefault {
        (uint256 id, bool ok) = _pickOpen(claimSeed);
        if (!ok) return;
        vm.prank(operator);
        exitRight.settle(CID, id);
        calls["settle"]++;
    }

    function slash(uint256 claimSeed) external trackDefault {
        (uint256 id, bool ok) = _pickOpen(claimSeed);
        if (!ok) return;
        (, address u,,,,, uint64 deadline,,,) = exitRight.claims(id);
        if (block.timestamp < deadline) return;
        uint256 before = bondToken.balanceOf(u);
        exitRight.slash(id);
        ghostSlashPaid += bondToken.balanceOf(u) - before;
        calls["slash"]++;
    }

    function postBond(uint256 amount) external trackDefault {
        _post(bound(amount, 1, 50e6));
    }

    function commitNext() external trackDefault {
        if (latestEpoch >= MAX_EPOCH) return;
        latestEpoch++;
        _commit(latestEpoch);
    }

    function warp(uint256 secs) external trackDefault {
        _advance(bound(secs, 1 hours, 2 days));
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    function _post(uint256 amount) internal {
        bondToken.mint(operator, amount);
        vm.startPrank(operator);
        bondToken.approve(address(exitRight), amount);
        exitRight.postBond(CID, amount);
        vm.stopPrank();
        ghostPosted += amount;
    }

    function _pickOpen(uint256 seed) internal view returns (uint256 id, bool ok) {
        uint256 n = exitRight.nextClaimId();
        if (n == 0) return (0, false);
        uint256 start = bound(seed, 0, n - 1);
        for (uint256 k = 0; k < n; k++) {
            id = (start + k) % n;
            (,,,,,,, bool open,,) = exitRight.claims(id);
            if (open) return (id, true);
        }
        return (0, false);
    }

    function assetAddr() external view returns (address) {
        return address(asset);
    }

    function bondTokenAddr() external view returns (address) {
        return address(bondToken);
    }
}

interface IBalance {
    function balanceOf(address) external view returns (uint256);
}

contract ExitRightInvariantsTest is Test {
    bytes32 internal constant CID = keccak256("kopi");
    ExitHandler internal h;
    ExitRight internal x;
    address internal asset;

    function setUp() public {
        h = new ExitHandler();
        x = h.exitRight();
        asset = h.assetAddr();
        targetContract(address(h));
        bytes4[] memory actions = new bytes4[](6);
        actions[0] = ExitHandler.openClaim.selector;
        actions[1] = ExitHandler.settle.selector;
        actions[2] = ExitHandler.slash.selector;
        actions[3] = ExitHandler.postBond.selector;
        actions[4] = ExitHandler.commitNext.selector;
        actions[5] = ExitHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: actions}));
    }

    /// @dev Bond only enters via postBond and only leaves via slash, so the contract's USDG always
    ///      equals the recorded bond balance: slashes can never pay out more than was posted.
    function invariant_bondTokenBacksBondBalance() public view {
        assertEq(IBalance(h.bondTokenAddr()).balanceOf(address(x)), x.bondBalance(CID), "bond token != bondBalance");
        assertEq(h.ghostPosted(), x.bondBalance(CID) + h.ghostSlashPaid(), "posted != balance + slashed");
    }

    function invariant_inFlightEqualsOpenReservations() public view {
        uint256 reserved;
        uint256 n = x.nextClaimId();
        for (uint256 id = 0; id < n; id++) {
            (,,,,, uint256 bondReserved,, bool open,,) = x.claims(id);
            if (open) reserved += bondReserved;
        }
        assertEq(x.bondInFlight(CID), reserved, "bondInFlight != sum of open reservations");
        assertLe(x.bondInFlight(CID), h.TOTAL_IN_FLIGHT(), "in-flight cap exceeded");
    }

    function invariant_claimStatesExclusive() public view {
        uint256 n = x.nextClaimId();
        for (uint256 id = 0; id < n; id++) {
            (,,,,,,, bool open, bool settled, bool slashed) = x.claims(id);
            uint256 states = (open ? 1 : 0) + (settled ? 1 : 0) + (slashed ? 1 : 0);
            assertEq(states, 1, "claim must be exactly one of open / settled / slashed");
        }
    }

    function invariant_exitDefaultStickyAndOnlyFromSlash() public view {
        bool def = x.exitDefault(CID, asset);
        if (h.ghostDefaultSeen()) assertTrue(def, "exitDefault was cleared");
        assertEq(def, h.calls("slash") > 0, "exitDefault set without a slash (or slash without default)");
    }

    function afterInvariant() external view {
        assertGt(h.calls("open"), 0, "no claim was ever opened");
    }
}

contract ExitHandlerSmokeTest is Test {
    function test_handlerReachesEveryPath() public {
        ExitHandler h = new ExitHandler();
        h.openClaim(0);
        h.openClaim(1);
        h.settle(0);
        assertEq(h.calls("settle"), 1);
        h.warp(2 days);
        h.slash(0);
        assertEq(h.calls("slash"), 1);
        assertTrue(h.exitRight().exitDefault(keccak256("kopi"), h.assetAddr()));
        h.commitNext();
        h.openClaim(0);
        assertEq(h.calls("open"), 3, "user can claim again in a new epoch");
    }
}

/// @notice Pins down the documented residual risk: the in-flight cap allows claims to reserve more
///         than the posted bond, and slashes then pay out first-come, capped at what is left.
contract ExitRightOversubscriptionTest is RPBase {
    ExitRight internal x;

    function setUp() public {
        _deployCore();
        x = new ExitRight(registry, ledger, address(bondToken));
        _commit(1);
        bondToken.mint(operator, 10e6);
        vm.startPrank(operator);
        bondToken.approve(address(x), 10e6);
        x.postBond(CID, 10e6);
        x.setBondConfig(CID, 1 days, 10e6, 30e6);
        vm.stopPrank();
    }

    function test_inFlightMayExceedBondAndSlashPaysWhatIsLeft() public {
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(users[i]);
            x.openClaim(CID, address(asset), amounts[i], _proof(1, i));
        }
        assertEq(x.bondInFlight(CID), 30e6);
        assertEq(x.bondBalance(CID), 10e6);

        vm.warp(block.timestamp + 1 days);
        x.slash(0);
        x.slash(1);
        x.slash(2);
        assertEq(bondToken.balanceOf(users[0]), 10e6, "first slasher is paid in full");
        assertEq(bondToken.balanceOf(users[1]), 0, "later slashers get what is left");
        assertEq(x.bondBalance(CID), 0);
        assertEq(x.bondInFlight(CID), 0);
        assertTrue(x.exitDefault(CID, address(asset)));
    }
}
