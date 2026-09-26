// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title CustodianRegistry
contract CustodianRegistry is Ownable {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    struct Custodian {
        address operator;
        bool active;
        uint64 removalDelay;
    }

    struct WalletKey {
        uint64 chainId;
        address wallet;
    }

    mapping(bytes32 => Custodian) public custodians;
    mapping(bytes32 => mapping(uint64 => mapping(address => bool))) public isReserveWallet;
    mapping(uint64 => mapping(address => bytes32)) public walletOwner; // exclusive
    mapping(bytes32 => mapping(uint64 => mapping(address => uint64))) public removalReadyAt;

    event CustodianRegistered(bytes32 indexed id, address operator);
    event CustodianDeactivated(bytes32 indexed id);
    event ReserveWalletAdded(bytes32 indexed id, uint64 chainId, address wallet);
    event ReserveWalletRemovalInitiated(bytes32 indexed id, uint64 chainId, address wallet, uint64 readyAt);
    event ReserveWalletRemoved(bytes32 indexed id, uint64 chainId, address wallet);

    error NotOperator();
    error AlreadyRegistered();
    error Inactive();
    error WalletTaken();
    error BadOwnershipProof();
    error NotReserveWallet();
    error RemovalNotReady();
    error WrongChain();

    constructor(address initialOwner) Ownable(initialOwner) {}

    modifier onlyOperator(bytes32 id) {
        if (msg.sender != custodians[id].operator) revert NotOperator();
        _;
    }

    function registerCustodian(bytes32 id, address operator, uint64 removalDelay) external onlyOwner {
        if (custodians[id].operator != address(0)) revert AlreadyRegistered();
        custodians[id] = Custodian({operator: operator, active: true, removalDelay: removalDelay});
        emit CustodianRegistered(id, operator);
    }

    function deactivateCustodian(bytes32 id) external onlyOwner {
        custodians[id].active = false;
        emit CustodianDeactivated(id);
    }

    function addReserveWallet(
        bytes32 id,
        uint64 chainId,
        address wallet,
        bytes calldata ownershipProof
    ) external onlyOperator(id) {
        if (!custodians[id].active) revert Inactive();
        if (chainId != uint64(block.chainid)) revert WrongChain();
        if (walletOwner[chainId][wallet] != bytes32(0)) revert WalletTaken();

        // Digest binds custodian, chain (must match execution chain), wallet, and registry.
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n32",
                keccak256(abi.encode(id, chainId, block.chainid, wallet, address(this)))
            )
        );
        address signer = ECDSA.recover(digest, ownershipProof);
        if (signer != wallet) revert BadOwnershipProof();

        walletOwner[chainId][wallet] = id;
        isReserveWallet[id][chainId][wallet] = true;
        emit ReserveWalletAdded(id, chainId, wallet);
    }

    function initiateWalletRemoval(bytes32 id, uint64 chainId, address wallet) external onlyOperator(id) {
        if (!isReserveWallet[id][chainId][wallet]) revert NotReserveWallet();
        uint64 readyAt = uint64(block.timestamp) + custodians[id].removalDelay;
        removalReadyAt[id][chainId][wallet] = readyAt;
        emit ReserveWalletRemovalInitiated(id, chainId, wallet, readyAt);
    }

    function finalizeWalletRemoval(bytes32 id, uint64 chainId, address wallet) external onlyOperator(id) {
        if (!isReserveWallet[id][chainId][wallet]) revert NotReserveWallet();
        uint64 readyAt = removalReadyAt[id][chainId][wallet];
        if (readyAt == 0 || block.timestamp < readyAt) revert RemovalNotReady();
        isReserveWallet[id][chainId][wallet] = false;
        delete walletOwner[chainId][wallet];
        delete removalReadyAt[id][chainId][wallet];
        emit ReserveWalletRemoved(id, chainId, wallet);
    }
}
