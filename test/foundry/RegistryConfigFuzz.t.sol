// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RPFull} from "./helpers/RPFull.sol";
import {CustodianRegistry} from "../../src/CustodianRegistry.sol";
import {AssetConfig} from "../../src/AssetConfig.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Access control and policy ratchets on CustodianRegistry and AssetConfig.
contract RegistryConfigFuzzTest is RPFull {
    uint256 internal constant SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function setUp() public {
        _deployFull();
    }

    function _pk(uint256 seed) internal pure returns (uint256) {
        return bound(seed, 1, SECP_N - 1);
    }

    function testFuzz_onlyOwnerRegistersCustodians(address caller, bytes32 id) public {
        vm.assume(caller != address(this));
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller));
        registry.registerCustodian(id, caller, 1);
    }

    function testFuzz_custodianIdCannotBeTakenOver(address newOperator) public {
        vm.expectRevert(CustodianRegistry.AlreadyRegistered.selector);
        registry.registerCustodian(CID, newOperator, 1);
        (address op,,) = registry.custodians(CID);
        assertEq(op, operator);
    }

    function testFuzz_ownershipProofMustComeFromWallet(uint256 walletSeed, uint256 signerSeed) public {
        uint256 walletPk = _pk(walletSeed);
        uint256 signerPk = _pk(signerSeed);
        vm.assume(walletPk != signerPk && walletPk != RESERVE_PK);
        address wallet = vm.addr(walletPk);
        vm.prank(operator);
        vm.expectRevert(CustodianRegistry.BadOwnershipProof.selector);
        registry.addReserveWallet(CID, uint64(block.chainid), wallet, _ownershipSig(signerPk, wallet));
    }

    function testFuzz_walletIsExclusiveToOneCustodian(bytes32 otherId) public {
        vm.assume(otherId != CID);
        address otherOp = makeAddr("otherOp");
        registry.registerCustodian(otherId, otherOp, 1);
        bytes32 inner = keccak256(abi.encode(otherId, uint64(block.chainid), block.chainid, reserve, address(registry)));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(RESERVE_PK, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner)));
        vm.prank(otherOp);
        vm.expectRevert(CustodianRegistry.WalletTaken.selector);
        registry.addReserveWallet(otherId, uint64(block.chainid), reserve, abi.encodePacked(r, s, v));
    }

    function testFuzz_reserveWalletBoundToExecutionChain(uint64 chainId, uint256 walletSeed) public {
        vm.assume(chainId != uint64(block.chainid));
        uint256 pk = _pk(walletSeed);
        vm.assume(pk != RESERVE_PK);
        address wallet = vm.addr(pk);
        vm.prank(operator);
        vm.expectRevert(CustodianRegistry.WrongChain.selector);
        registry.addReserveWallet(CID, chainId, wallet, _ownershipSig(pk, wallet));
    }

    function testFuzz_walletRemovalWaitsForDelay(uint256 dt) public {
        dt = bound(dt, 0, 2 hours);
        vm.startPrank(operator);
        registry.initiateWalletRemoval(CID, uint64(block.chainid), reserve);
        vm.warp(vm.getBlockTimestamp() + dt);
        if (dt < 3600) vm.expectRevert(CustodianRegistry.RemovalNotReady.selector);
        registry.finalizeWalletRemoval(CID, uint64(block.chainid), reserve);
        vm.stopPrank();
        assertEq(registry.isReserveWallet(CID, uint64(block.chainid), reserve), dt < 3600);
    }

    function testFuzz_policyOnlyTightens(uint16 bps, uint64 age, uint8 samples, uint64 gap) public {
        bps = uint16(bound(bps, 10_000, 40_000));
        age = uint64(bound(age, 1 hours, 30 days));
        samples = uint8(bound(samples, 1, 10));
        gap = uint64(bound(gap, 0, 1 days));
        bool weaker = bps < 10300 || age > 7 days || samples < 1 || gap < 1;
        if (weaker) vm.expectRevert(AssetConfig.PolicyWeakened.selector);
        assetConfig.setAssetConfig(
            CID, address(asset), address(asset), uint64(block.chainid), false, 0, bps, age, samples, gap, bytes32(0), new uint64[](0)
        );
    }

    function testFuzz_identityFieldsAreFrozen(address token, bool isStock, uint8 unitMode) public {
        unitMode = uint8(bound(unitMode, 0, 1));
        vm.assume(token != address(0));
        vm.assume(token != address(asset) || isStock || unitMode != 0);
        vm.expectRevert(AssetConfig.ImmutableField.selector);
        assetConfig.setAssetConfig(
            CID, address(asset), token, uint64(block.chainid), isStock, unitMode, 10300, 7 days, 1, 1, bytes32(0), new uint64[](0)
        );
    }

    function testFuzz_badParamsRejected(uint16 bps, uint64 age, bool zeroSamples) public {
        bps = uint16(bound(bps, 0, 20_000));
        age = uint64(bound(age, 0, 2 hours));
        vm.assume(bps < 10_000 || age < 1 hours || zeroSamples);
        vm.expectRevert(AssetConfig.BadParams.selector);
        assetConfig.setAssetConfig(
            CID, address(0xA11), address(0xA11), uint64(block.chainid), false, 0, bps, age, zeroSamples ? 0 : 1, 1, keccak256("X"), _chains()
        );
    }

    function testFuzz_operatorCannotPickAssetId(bytes32 frozenId, bytes32 wantedId) public {
        vm.assume(frozenId != bytes32(0) && wantedId != frozenId);
        address token = address(0xC0FFEE);
        assetConfig.setAllocationChains(CID, token, uint64(block.chainid), frozenId, _chains());
        vm.prank(operator);
        assetConfig.setAssetConfig(
            CID, token, token, uint64(block.chainid), false, 0, 10300, 7 days, 1, 1, wantedId, new uint64[](0)
        );
        assertEq(assetConfig.getConfig(CID, token).assetId, frozenId, "operator overrode the frozen assetId");
    }
}
