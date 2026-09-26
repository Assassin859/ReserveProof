// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CustodianRegistry} from "./CustodianRegistry.sol";
import {LiabilityLedger} from "./LiabilityLedger.sol";
import {MerkleSumVerifier} from "./libraries/MerkleSumVerifier.sol";
import {RPTypes} from "./libraries/RPTypes.sol";
import {IERC20Minimal} from "./interfaces/IToken.sol";

/// @title ExitRight
/// @notice Bonded withdrawal claims against the latest epoch; payout via settle() only (same asset).
contract ExitRight is ReentrancyGuard {
    CustodianRegistry public immutable registry;
    LiabilityLedger public immutable ledger;
    IERC20Minimal public immutable bondToken; // USDG

    struct BondConfig {
        uint256 bondAmount;
        uint64 maxPayoutDelay;
        uint256 maxBondPerClaim;
        uint256 maxBondTotalInFlight;
        bool set;
    }

    struct Claim {
        bytes32 custodianId;
        address user;
        address asset;
        uint64 epochId;
        uint256 amount;
        uint256 bondReserved;
        uint64 deadline;
        bool open;
        bool settled;
        bool slashed;
    }

    mapping(bytes32 => BondConfig) public bondConfigs;
    mapping(bytes32 => uint256) public bondBalance;
    mapping(bytes32 => uint256) public bondInFlight;
    mapping(bytes32 => mapping(address => bool)) public exitDefault;
    mapping(bytes32 => mapping(address => mapping(address => mapping(uint64 => bool)))) public claimed;
    mapping(uint256 => Claim) public claims;
    uint256 public nextClaimId;

    event BondPosted(bytes32 indexed custodianId, uint256 amount);
    event BondConfigSet(bytes32 indexed custodianId);
    event ClaimOpened(uint256 indexed claimId, bytes32 custodianId, address user, address asset, uint256 amount);
    event ClaimSettled(uint256 indexed claimId);
    event ClaimSlashed(uint256 indexed claimId, uint256 bondPaid);

    error NotOperator();
    error BadConfig();
    error NoEpoch();
    error AlreadyClaimed();
    error BadProof();
    error BondCap();
    error NotOpen();
    error TooEarly();
    error TransferFailed();
    error WrongCustodian();

    constructor(CustodianRegistry registry_, LiabilityLedger ledger_, address bondToken_) {
        registry = registry_;
        ledger = ledger_;
        bondToken = IERC20Minimal(bondToken_);
    }

    function setBondConfig(
        bytes32 custodianId,
        uint64 maxPayoutDelay,
        uint256 maxBondPerClaim,
        uint256 maxBondTotalInFlight
    ) external {
        (address op, , ) = registry.custodians(custodianId);
        if (msg.sender != op) revert NotOperator();
        if (maxPayoutDelay == 0 || maxBondPerClaim == 0) revert BadConfig();
        // Do not allow shrinking per-claim cap while bond is in flight (open claims use frozen reserved).
        BondConfig memory prev = bondConfigs[custodianId];
        if (prev.set && bondInFlight[custodianId] > 0 && maxBondPerClaim < prev.maxBondPerClaim) {
            revert BadConfig();
        }
        bondConfigs[custodianId] = BondConfig({
            bondAmount: bondBalance[custodianId],
            maxPayoutDelay: maxPayoutDelay,
            maxBondPerClaim: maxBondPerClaim,
            maxBondTotalInFlight: maxBondTotalInFlight,
            set: true
        });
        emit BondConfigSet(custodianId);
    }

    function postBond(bytes32 custodianId, uint256 amount) external nonReentrant {
        (address op, , ) = registry.custodians(custodianId);
        if (msg.sender != op) revert NotOperator();
        if (!bondToken.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        bondBalance[custodianId] += amount;
        bondConfigs[custodianId].bondAmount = bondBalance[custodianId];
        emit BondPosted(custodianId, amount);
    }

    function openClaim(
        bytes32 custodianId,
        address asset,
        uint256 amount,
        MerkleSumVerifier.ProofNode[] calldata siblings
    ) external nonReentrant returns (uint256 claimId) {
        BondConfig memory bc = bondConfigs[custodianId];
        if (!bc.set || bc.maxBondPerClaim == 0) revert BadConfig();

        uint64 epochId = ledger.latestEpochId(custodianId, asset);
        if (epochId == 0) revert NoEpoch();
        if (claimed[custodianId][asset][msg.sender][epochId]) revert AlreadyClaimed();

        RPTypes.Epoch memory ep = ledger.getEpoch(custodianId, asset, epochId);
        if (
            !MerkleSumVerifier.verifyInclusion(
                custodianId,
                asset,
                epochId,
                msg.sender,
                amount,
                ep.liabilityRoot,
                ep.totalLiability,
                siblings
            )
        ) revert BadProof();

        uint256 bondNeed = bc.maxBondPerClaim;
        if (bondInFlight[custodianId] + bondNeed > bc.maxBondTotalInFlight) revert BondCap();
        if (bondNeed > bondBalance[custodianId]) revert BondCap();

        claimed[custodianId][asset][msg.sender][epochId] = true;
        bondInFlight[custodianId] += bondNeed;

        claimId = nextClaimId++;
        claims[claimId] = Claim({
            custodianId: custodianId,
            user: msg.sender,
            asset: asset,
            epochId: epochId,
            amount: amount,
            bondReserved: bondNeed,
            deadline: uint64(block.timestamp) + bc.maxPayoutDelay,
            open: true,
            settled: false,
            slashed: false
        });
        emit ClaimOpened(claimId, custodianId, msg.sender, asset, amount);
    }

    /// @notice Custodian pays the claim asset to the user through this contract.
    function settle(bytes32 custodianId, uint256 claimId) external nonReentrant {
        (address op, , ) = registry.custodians(custodianId);
        if (msg.sender != op) revert NotOperator();
        Claim storage c = claims[claimId];
        if (!c.open || c.settled || c.slashed) revert NotOpen();
        if (c.custodianId != custodianId) revert WrongCustodian();

        IERC20Minimal token = IERC20Minimal(c.asset);
        if (!token.transferFrom(msg.sender, c.user, c.amount)) revert TransferFailed();

        c.open = false;
        c.settled = true;
        uint256 reserved = c.bondReserved;
        if (bondInFlight[custodianId] >= reserved) bondInFlight[custodianId] -= reserved;
        else bondInFlight[custodianId] = 0;
        emit ClaimSettled(claimId);
    }

    function slash(uint256 claimId) external nonReentrant {
        Claim storage c = claims[claimId];
        if (!c.open || c.settled || c.slashed) revert NotOpen();
        if (block.timestamp < c.deadline) revert TooEarly();

        bytes32 custodianId = c.custodianId;
        uint256 pay = c.bondReserved;
        if (pay > bondBalance[custodianId]) pay = bondBalance[custodianId];

        c.open = false;
        c.slashed = true;
        exitDefault[custodianId][c.asset] = true;
        bondBalance[custodianId] -= pay;
        if (bondInFlight[custodianId] >= c.bondReserved) {
            bondInFlight[custodianId] -= c.bondReserved;
        } else {
            bondInFlight[custodianId] = 0;
        }
        if (pay > 0) {
            if (!bondToken.transfer(c.user, pay)) revert TransferFailed();
        }
        emit ClaimSlashed(claimId, pay);
    }

    function hasExitDefault(bytes32 custodianId, address asset) external view returns (bool) {
        return exitDefault[custodianId][asset];
    }
}
