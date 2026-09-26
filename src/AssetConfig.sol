// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CustodianRegistry} from "./CustodianRegistry.sol";
import {RPTypes} from "./libraries/RPTypes.sol";

/// @title AssetConfig
/// @notice Allocation allowlist and cross-chain assetId are owner-only and frozen together.
contract AssetConfig is Ownable {
    uint64 public constant MIN_ORACLE_AGE = 1 hours;

    struct Config {
        address token;
        uint64 chainId;
        bool isStockToken;
        uint8 unitMode;
        uint16 coverageFloorBps;
        uint64 maxOracleAge;
        uint8 minSamples;
        uint64 minSampleGap;
        bool exists;
        bytes32 assetId;
    }

    CustodianRegistry public immutable registry;
    mapping(bytes32 => mapping(address => Config)) public configs;
    mapping(bytes32 => mapping(address => uint64[])) internal _allocationChains;
    mapping(bytes32 => mapping(address => mapping(uint64 => bool))) public isAllocationChain;
    mapping(bytes32 => mapping(address => bool)) public allocationChainsSet;
    mapping(bytes32 => mapping(address => bytes32)) public assetIds;
    mapping(bytes32 => mapping(address => bool)) public assetIdSet;

    event AssetConfigured(bytes32 indexed custodianId, address indexed asset, bytes32 assetId);
    event AllocationChainsSet(
        bytes32 indexed custodianId, address indexed asset, bytes32 assetId, uint64[] chainIds
    );

    error NotOperator();
    error BadParams();
    error ImmutableField();
    error PolicyWeakened();
    error AssetIdNotSet();

    constructor(address initialOwner, CustodianRegistry registry_) Ownable(initialOwner) {
        registry = registry_;
    }

    /// @notice Owner-only. Sets allowlist + assetId together; frozen after set.
    function setAllocationChains(
        bytes32 custodianId,
        address asset,
        uint64 homeChainId,
        bytes32 assetId,
        uint64[] calldata allocationChainIds
    ) external onlyOwner {
        if (allocationChainsSet[custodianId][asset]) revert ImmutableField();
        if (assetId == bytes32(0)) revert BadParams();
        _setAllocationChains(custodianId, asset, homeChainId, allocationChainIds);
        assetIds[custodianId][asset] = assetId;
        assetIdSet[custodianId][asset] = true;
        emit AllocationChainsSet(custodianId, asset, assetId, allocationChainIds);
    }

    /// @param assetId Required only when owner sets allowlist inline on first config.
    ///        After allowlist/assetId are frozen, stored assetId is always used (calldata ignored).
    /// @param allocationChainIds Owner may pass once with assetId on first config; else empty.
    function setAssetConfig(
        bytes32 custodianId,
        address asset,
        address token,
        uint64 chainId,
        bool isStockToken,
        uint8 unitMode,
        uint16 coverageFloorBps,
        uint64 maxOracleAge,
        uint8 minSamples,
        uint64 minSampleGap,
        bytes32 assetId,
        uint64[] calldata allocationChainIds
    ) external {
        (address op, bool active, ) = _custodian(custodianId);
        if (!active) revert NotOperator();
        if (token == address(0) || coverageFloorBps < 10_000 || minSamples == 0) revert BadParams();
        if (unitMode > RPTypes.UNIT_ECONOMIC) revert BadParams();
        if (maxOracleAge < MIN_ORACLE_AGE) revert BadParams();

        Config storage cur = configs[custodianId][asset];
        bytes32 resolvedId;

        if (!cur.exists) {
            if (msg.sender != op && msg.sender != owner()) revert NotOperator();
            if (!allocationChainsSet[custodianId][asset]) {
                // Owner must set allowlist + assetId together (inline).
                if (msg.sender != owner()) revert NotOperator();
                if (allocationChainIds.length == 0 || assetId == bytes32(0)) revert BadParams();
                _setAllocationChains(custodianId, asset, chainId, allocationChainIds);
                assetIds[custodianId][asset] = assetId;
                assetIdSet[custodianId][asset] = true;
                resolvedId = assetId;
            } else {
                if (allocationChainIds.length != 0) revert ImmutableField();
                if (!isAllocationChain[custodianId][asset][chainId]) revert BadParams();
                if (!assetIdSet[custodianId][asset]) revert AssetIdNotSet();
                // Operator cannot choose assetId — always use owner-frozen id.
                resolvedId = assetIds[custodianId][asset];
            }
        } else {
            if (msg.sender != owner()) revert NotOperator();
            resolvedId = cur.assetId;
            if (
                token != cur.token || chainId != cur.chainId || isStockToken != cur.isStockToken
                    || unitMode != cur.unitMode
            ) {
                revert ImmutableField();
            }
            if (allocationChainIds.length != 0) revert ImmutableField();
            if (assetId != bytes32(0) && assetId != resolvedId) revert ImmutableField();
            if (coverageFloorBps < cur.coverageFloorBps) revert PolicyWeakened();
            if (minSamples < cur.minSamples) revert PolicyWeakened();
            if (minSampleGap < cur.minSampleGap) revert PolicyWeakened();
            if (maxOracleAge > cur.maxOracleAge) revert PolicyWeakened();
        }

        configs[custodianId][asset] = Config({
            token: token,
            chainId: chainId,
            isStockToken: isStockToken,
            unitMode: unitMode,
            coverageFloorBps: coverageFloorBps,
            maxOracleAge: maxOracleAge,
            minSamples: minSamples,
            minSampleGap: minSampleGap,
            exists: true,
            assetId: resolvedId
        });
        emit AssetConfigured(custodianId, asset, resolvedId);
    }

    function getConfig(bytes32 custodianId, address asset) external view returns (Config memory) {
        return configs[custodianId][asset];
    }

    function getAllocationChains(bytes32 custodianId, address asset) external view returns (uint64[] memory) {
        return _allocationChains[custodianId][asset];
    }

    function _setAllocationChains(
        bytes32 custodianId,
        address asset,
        uint64 homeChainId,
        uint64[] calldata allocationChainIds
    ) internal {
        if (allocationChainIds.length == 0) revert BadParams();
        bool homeFound;
        for (uint256 i = 0; i < allocationChainIds.length; i++) {
            uint64 id = allocationChainIds[i];
            if (id == 0) revert BadParams();
            for (uint256 j = 0; j < i; j++) {
                if (allocationChainIds[j] == id) revert BadParams();
            }
            if (id == homeChainId) homeFound = true;
            isAllocationChain[custodianId][asset][id] = true;
            _allocationChains[custodianId][asset].push(id);
        }
        if (!homeFound) revert BadParams();
        allocationChainsSet[custodianId][asset] = true;
    }

    function _custodian(bytes32 id) internal view returns (address op, bool active, uint64 delay) {
        (op, active, delay) = registry.custodians(id);
    }
}
