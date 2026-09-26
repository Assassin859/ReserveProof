// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CustodianRegistry} from "./CustodianRegistry.sol";
import {RPTypes} from "./libraries/RPTypes.sol";

/// @title AssetConfig
contract AssetConfig is Ownable {
    struct Config {
        address token;
        uint64 chainId;
        bool isStockToken;
        uint8 unitMode; // RAW / ECONOMIC
        uint16 coverageFloorBps; // e.g. 10300 = 103%
        uint64 maxOracleAge;
        uint8 minSamples;
        uint64 minSampleGap; // seconds
        bool exists;
    }

    CustodianRegistry public immutable registry;
    mapping(bytes32 => mapping(address => Config)) public configs;

    event AssetConfigured(bytes32 indexed custodianId, address indexed asset);

    error NotOperator();
    error BadParams();

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
        if (msg.sender != op && msg.sender != owner()) revert NotOperator();
        if (!active) revert NotOperator();
        if (token == address(0) || coverageFloorBps < 10_000 || minSamples == 0) revert BadParams();
        if (unitMode > RPTypes.UNIT_ECONOMIC) revert BadParams();

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
