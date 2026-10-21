// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @notice Deliberately prevents this unaudited prototype from deploying to mainnet.
abstract contract TestNetworkOnly {
    error UnsupportedNetwork();
    constructor() {
        if (block.chainid != 31337 && block.chainid != 11155111) revert UnsupportedNetwork();
    }
}
