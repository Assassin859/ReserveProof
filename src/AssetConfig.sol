// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CustodianRegistry} from "./CustodianRegistry.sol";
import {RPTypes} from "./libraries/RPTypes.sol";

/// @title AssetConfig
/// @notice After first set, identity fields are frozen; only owner may tighten policy further.
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

    event AssetConfigured(bytes32 indexed custodianId, address indexed asset);

    error NotOperator();
    error BadParams();
    error ImmutableField();
    error PolicyWeakened();

    constructor(address initialOwner, CustodianRegistry registry_) Ownable(initialOwner) {
        registry = registry_;
    }

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
        uint64 minSampleGap
    ) external {
        (address op, bool active, ) = _custodian(custodianId);
        if (!active) revert NotOperator();
        if (token == address(0) || coverageFloorBps < 10_000 || minSamples == 0) revert BadParams();
        if (unitMode > RPTypes.UNIT_ECONOMIC) revert BadParams();
        if (maxOracleAge != 0 && maxOracleAge < MIN_ORACLE_AGE) revert BadParams();

        Config storage cur = configs[custodianId][asset];
        if (!cur.exists) {
            // Initial configuration: operator or owner.
            if (msg.sender != op && msg.sender != owner()) revert NotOperator();
        } else {
            // Updates: owner only; identity frozen; policy may only tighten.
            if (msg.sender != owner()) revert NotOperator();
            if (token != cur.token || chainId != cur.chainId || isStockToken != cur.isStockToken || unitMode != cur.unitMode) {
                revert ImmutableField();
            }
            if (coverageFloorBps < cur.coverageFloorBps) revert PolicyWeakened();
            if (minSamples < cur.minSamples) revert PolicyWeakened();
            if (minSampleGap < cur.minSampleGap) revert PolicyWeakened();
            // Cannot disable staleness once enabled; cannot shorten age.
            if (cur.maxOracleAge > 0) {
                if (maxOracleAge == 0 || maxOracleAge < cur.maxOracleAge) revert PolicyWeakened();
            }
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

    function _custodian(bytes32 id) internal view returns (address op, bool active, uint64 delay) {
        (op, active, delay) = registry.custodians(id);
    }
}
