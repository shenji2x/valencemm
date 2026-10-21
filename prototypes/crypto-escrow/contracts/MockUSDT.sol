// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TestNetworkOnly} from "./TestNetworkOnly.sol";

/// @notice A valueless six-decimal test token. This is NOT Tether USDt.
contract MockUSDT is ERC20, TestNetworkOnly {
    constructor() ERC20("Valence test dollar (NOT USDT)", "TESTUSD") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}
