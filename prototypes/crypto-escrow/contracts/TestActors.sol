// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {MockUSDT} from "./MockUSDT.sol";
import {ValenceTestEscrow} from "./ValenceTestEscrow.sol";

/// @dev Adversarial fixtures for local tests, not deployment targets.
contract RejectEther {
    receive() external payable { revert("reject ether"); }
    function redirect(ValenceTestEscrow escrow, bytes32 id, address payable to) external {
        escrow.claim(id, to);
    }
}

contract ReentrantReceiver {
    ValenceTestEscrow public escrow;
    bytes32 public dealId;
    bool public blocked;
    function configure(ValenceTestEscrow escrow_, bytes32 id_) external {
        escrow = escrow_; dealId = id_;
    }
    receive() external payable {
        try escrow.claimFor(dealId, address(this)) {} catch { blocked = true; }
    }
}

contract TaxToken is MockUSDT {
    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 tax = amount / 100;
            super._update(from, to, amount - tax);
            super._update(from, address(0), tax);
        } else super._update(from, to, amount);
    }
}

contract BlockingToken is MockUSDT {
    mapping(address => bool) public blocked;
    function setBlocked(address to, bool blocked_) external { blocked[to] = blocked_; }
    function transfer(address to, uint256 amount) public override returns (bool) {
        if (blocked[to]) return false;
        return super.transfer(to, amount);
    }
}
