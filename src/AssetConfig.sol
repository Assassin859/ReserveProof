// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CustodianRegistry} from "./CustodianRegistry.sol";
import {RPTypes} from "./libraries/RPTypes.sol";

/// @title AssetConfig
/// @notice After first set, identity + allocation allowlist are frozen; only owner may tighten policy.
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
    }

    CustodianRegistry public immutable registry;
    mapping(bytes32 => mapping(address => Config)) public configs;
    /// @dev Immutable after first configure: chains allowed in commitEpoch allocation vectors.
    mapping(bytes32 => mapping(address => uint64[])) internal _allocationChains;
    mapping(bytes32 => mapping(address => mapping(uint64 => bool))) public isAllocationChain;

    event AssetConfigured(bytes32 indexed custodianId, address indexed asset);

    error NotOperator();
    error BadParams();
    error ImmutableField();
    error PolicyWeakened();

    constructor(address initialOwner, CustodianRegistry registry_) Ownable(initialOwner) {
        registry = registry_;
    }

    /// @param allocationChainIds Must include `chainId`. Frozen after first set.
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
        uint64[] calldata allocationChainIds
    ) external {
        (address op, bool active, ) = _custodian(custodianId);
        if (!active) revert NotOperator();
        if (token == address(0) || coverageFloorBps < 10_000 || minSamples == 0) revert BadParams();
        if (unitMode > RPTypes.UNIT_ECONOMIC) revert BadParams();
        // Staleness always required (cannot disable with 0).
        if (maxOracleAge < MIN_ORACLE_AGE) revert BadParams();

        Config storage cur = configs[custodianId][asset];
        if (!cur.exists) {
            if (msg.sender != op && msg.sender != owner()) revert NotOperator();
            _setAllocationChains(custodianId, asset, chainId, allocationChainIds);
        } else {
            if (msg.sender != owner()) revert NotOperator();
            if (token != cur.token || chainId != cur.chainId || isStockToken != cur.isStockToken || unitMode != cur.unitMode) {
                revert ImmutableField();
            }
            if (allocationChainIds.length != 0) revert ImmutableField();
            if (coverageFloorBps < cur.coverageFloorBps) revert PolicyWeakened();
            if (minSamples < cur.minSamples) revert PolicyWeakened();
            if (minSampleGap < cur.minSampleGap) revert PolicyWeakened();
            // Tightening = fresher data = shorter maxOracleAge (still >= MIN).
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
            exists: true
        });
        emit AssetConfigured(custodianId, asset);
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
    }

    function _custodian(bytes32 id) internal view returns (address op, bool active, uint64 delay) {
        (op, active, delay) = registry.custodians(id);
    }
}
