// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

// Pulls the unmodified Morpho Blue v1.0.0 core into the build (it pins solc 0.8.19) so tests can
// deployCode("Morpho.sol:Morpho") without mixing compiler versions in one file.
import {Morpho} from "morpho-blue/Morpho.sol";
