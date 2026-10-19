// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Saigon-only stand-in for RONKE / RONKA. Anyone can mint — it has
///         no value and must never be deployed to mainnet.
contract TestToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        require(block.chainid != 2020, "testnet only");
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
