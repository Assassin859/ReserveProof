// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SolvencyGuard} from "../guards/SolvencyGuard.sol";
import {ISolvencyOracle} from "../interfaces/ISolvencyOracle.sol";

/// @title GuardedLendingVault — example money market that trusts a custodial stock token only while
///        its custodian is provably solvent.
/// @notice Lenders supply the loan token (USDG). Borrowers post the custodial stock token as collateral
///         and borrow up to `ltvBps` of its value at a fixed demo price. `borrow` is gated by
///         `onlySolvent(collateral)`, and `withdrawCollateral` is gated only while the caller has debt.
///         Repaying, adding collateral and withdrawing debt-free collateral never are, so a failing proof
///         freezes new risk without trapping anyone who wants to de-risk.
///         No interest and no liquidations: this is an integration example, not a production market.
contract GuardedLendingVault is SolvencyGuard, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;

    IERC20 public immutable collateral;
    IERC20 public immutable loanToken;
    /// @notice Loan-token base units per 1e18 base units of collateral.
    uint256 public immutable collateralPrice;
    uint16 public immutable ltvBps;

    mapping(address => uint256) public supplied;
    mapping(address => uint256) public collateralOf;
    mapping(address => uint256) public debtOf;
    uint256 public totalSupplied;
    uint256 public totalBorrowed;

    event Supplied(address indexed lender, uint256 amount);
    event SupplyWithdrawn(address indexed lender, uint256 amount);
    event CollateralDeposited(address indexed borrower, uint256 amount);
    event CollateralWithdrawn(address indexed borrower, uint256 amount);
    event Borrowed(address indexed borrower, uint256 amount);
    event Repaid(address indexed borrower, uint256 amount);

    error ZeroAmount();
    error BadConfig();
    error ExceedsLtv(uint256 maxDebt, uint256 debtAfter);
    error InsufficientLiquidity(uint256 available, uint256 requested);
    error InsufficientBalance();

    constructor(
        ISolvencyOracle oracle_,
        bytes32 custodianId_,
        address collateral_,
        address loanToken_,
        uint256 collateralPrice_,
        uint16 ltvBps_
    ) SolvencyGuard(oracle_, custodianId_) {
        if (
            collateral_ == address(0) ||
            loanToken_ == address(0) ||
            collateral_ == loanToken_ ||
            collateralPrice_ == 0 ||
            ltvBps_ == 0 ||
            ltvBps_ >= BPS
        ) revert BadConfig();
        collateral = IERC20(collateral_);
        loanToken = IERC20(loanToken_);
        collateralPrice = collateralPrice_;
        ltvBps = ltvBps_;
    }

    // ── Lenders ─────────────────────────────────────────────────────────────

    function supply(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        supplied[msg.sender] += amount;
        totalSupplied += amount;
        loanToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Supplied(msg.sender, amount);
    }

    function withdrawSupply(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (supplied[msg.sender] < amount) revert InsufficientBalance();
        uint256 available = availableLiquidity();
        if (amount > available) revert InsufficientLiquidity(available, amount);
        supplied[msg.sender] -= amount;
        totalSupplied -= amount;
        loanToken.safeTransfer(msg.sender, amount);
        emit SupplyWithdrawn(msg.sender, amount);
    }

    // ── Borrowers ───────────────────────────────────────────────────────────

    function depositCollateral(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        collateralOf[msg.sender] += amount;
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        emit CollateralDeposited(msg.sender, amount);
    }

    /// @notice Gated only while the caller owes something: a debt-free borrower can always exit, even
    ///         if the custodian's proof stays failed indefinitely (e.g. an unresolved dispute).
    function withdrawCollateral(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (collateralOf[msg.sender] < amount) revert InsufficientBalance();
        if (debtOf[msg.sender] > 0) _requireSolvent(address(collateral));
        collateralOf[msg.sender] -= amount;
        uint256 maxDebt = maxBorrow(msg.sender);
        if (debtOf[msg.sender] > maxDebt) revert ExceedsLtv(maxDebt, debtOf[msg.sender]);
        collateral.safeTransfer(msg.sender, amount);
        emit CollateralWithdrawn(msg.sender, amount);
    }

    function borrow(uint256 amount) external onlySolvent(address(collateral)) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 available = availableLiquidity();
        if (amount > available) revert InsufficientLiquidity(available, amount);
        uint256 debtAfter = debtOf[msg.sender] + amount;
        uint256 maxDebt = maxBorrow(msg.sender);
        if (debtAfter > maxDebt) revert ExceedsLtv(maxDebt, debtAfter);
        debtOf[msg.sender] = debtAfter;
        totalBorrowed += amount;
        loanToken.safeTransfer(msg.sender, amount);
        emit Borrowed(msg.sender, amount);
    }

    /// @notice Never gated. Repays up to the caller's outstanding debt.
    function repay(uint256 amount) external nonReentrant returns (uint256 paid) {
        if (amount == 0) revert ZeroAmount();
        uint256 debt = debtOf[msg.sender];
        paid = amount < debt ? amount : debt;
        if (paid == 0) revert ZeroAmount();
        debtOf[msg.sender] = debt - paid;
        totalBorrowed -= paid;
        loanToken.safeTransferFrom(msg.sender, address(this), paid);
        emit Repaid(msg.sender, paid);
    }

    // ── Views ───────────────────────────────────────────────────────────────

    function maxBorrow(address borrower) public view returns (uint256) {
        return (collateralOf[borrower] * collateralPrice * ltvBps) / (1e18 * BPS);
    }

    function availableLiquidity() public view returns (uint256) {
        return totalSupplied - totalBorrowed;
    }
}
