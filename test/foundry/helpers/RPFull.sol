// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RPBase} from "./RPBase.sol";
import {ReserveSampler} from "../../../src/ReserveSampler.sol";
import {DisputeModule} from "../../../src/DisputeModule.sol";
import {SolvencyOracle} from "../../../src/SolvencyOracle.sol";
import {ExitRight} from "../../../src/ExitRight.sol";
import {MockStockToken} from "../../../src/mocks/MockStockToken.sol";
import {RPTypes} from "../../../src/libraries/RPTypes.sol";

/// @notice Full ReserveProof stack on top of RPBase: sampler, disputes, oracle and ExitRight wired as in
///         production, one registered reserve wallet sampled for both assets, and a second asset that is
///         an ERC-8056 stock token. Book total is 1000e6, so the 103% floor needs 1030e6 in reserve.
abstract contract RPFull is RPBase {
    uint256 internal constant RESERVE_PK = 0xB0B;
    uint64 internal constant WINDOW = 1 hours;
    uint256 internal constant BOOK_TOTAL = 1000e6;
    uint256 internal constant NEED = 1030e6;
    bytes32 internal constant STOCK_ID = keccak256("STOCK");

    address internal reserve;
    ReserveSampler internal sampler;
    DisputeModule internal disputes;
    SolvencyOracle internal oracle;
    ExitRight internal exitRight;
    MockStockToken internal stock;

    function _deployFull() internal {
        _deployCore();
        sampler = new ReserveSampler(registry, assetConfig, ledger);
        disputes = new DisputeModule(registry, ledger, address(bondToken), 1e6, 1 hours, WINDOW);
        oracle = new SolvencyOracle(registry, assetConfig, ledger, sampler, disputes, address(this));
        exitRight = new ExitRight(registry, ledger, address(bondToken));
        oracle.setExitRight(address(exitRight));

        stock = new MockStockToken("Stock", "STK");
        assetConfig.setAssetConfig(
            CID, address(stock), address(stock), uint64(block.chainid), true, 0, 10300, 7 days, 1, 1, STOCK_ID, _chains()
        );

        reserve = vm.addr(RESERVE_PK);
        vm.prank(operator);
        registry.addReserveWallet(CID, uint64(block.chainid), reserve, _ownershipSig(RESERVE_PK, reserve));
        address[] memory w = new address[](1);
        w[0] = reserve;
        vm.startPrank(operator);
        sampler.setSampleWallets(CID, address(asset), w);
        sampler.setSampleWallets(CID, address(stock), w);
        vm.stopPrank();
    }

    function _ownershipSig(uint256 pk, address wallet) internal view returns (bytes memory) {
        bytes32 inner = keccak256(abi.encode(CID, uint64(block.chainid), block.chainid, wallet, address(registry)));
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", inner));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Commit any asset with an opaque root: the ledger only checks the operator signature,
    ///      allocation and leaf count, so oracle tests do not need a real tree.
    function _commitRaw(address token, uint64 epoch, uint256 total) internal {
        bytes32 root = keccak256(abi.encode(token, epoch));
        uint256[] memory allocs = new uint256[](1);
        allocs[0] = total;
        bytes32 allocCmt = keccak256(abi.encode(_chains(), allocs));
        bytes32 digest = ledger.commitmentDigest(CID, token, epoch, root, total, allocCmt, LEAVES);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OP_PK, digest);
        vm.prank(operator);
        ledger.commitEpoch(CID, token, epoch, root, total, _chains(), allocs, 0, 0, LEAVES, abi.encodePacked(r, s, v));
    }

    function _sample(address token) internal {
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 2);
        vm.prank(operator);
        sampler.recordSample(CID, token);
    }

    /// @dev Reserve holds exactly `amount` of the book asset.
    function _setReserve(uint256 amount) internal {
        uint256 bal = asset.balanceOf(reserve);
        if (amount > bal) {
            asset.mint(reserve, amount - bal);
        } else if (bal > amount) {
            vm.prank(reserve);
            asset.transfer(address(0xdead), bal - amount);
        }
    }

    /// @dev Epoch 1 over the real 4-leaf book, reserve at `amount`, one sample.
    function _publish(uint256 amount) internal {
        _setReserve(amount);
        _commit(1);
        _sample(address(asset));
    }

    function _status(address token) internal view returns (bool ok, uint8 reason) {
        RPTypes.SolvencyStatus memory s = oracle.status(CID, token);
        return (s.ok, s.reason);
    }

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

    function _challenge(uint256 i, uint256 amount) internal {
        address u = users[i];
        bytes memory sig = _statementSig(1, u, amount);
        bondToken.mint(u, 1e6);
        vm.startPrank(u);
        bondToken.approve(address(disputes), 1e6);
        disputes.challengeInclusion(CID, address(asset), 1, u, amount, sig);
        vm.stopPrank();
    }
}
