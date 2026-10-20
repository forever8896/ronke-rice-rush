// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {RonkeTournament} from "../src/RonkeTournament.sol";

/// Ronin mainnet: the escrow alone, against the real RONKE / RONKA.
/// The rake and split are FIXED by this deployment and can never change.
///   DEPLOYER_PRIVATE_KEY  deployer (pays gas, owns until handed over)
///   FEE_RECIPIENT         receives the rake
///   FINAL_OWNER           offered ownership; accepts it from the game's owner panel
///   SPLIT_BPS             e.g. "5000,3000,2000" — must sum to 10000
///   QUOTER_ADDRESS        the game server's quote key (address only)
/// Pricing: RONKE is the fixed anchor at ENTRY_RONKE whole tokens (default
/// 10 000); RONKA and HORSKE enter at the same USD value via signed quotes.
contract DeployMainnet is Script {
    // Verified on mainnet: symbol() / decimals() — see README.
    address constant RONKE = 0xf988f63bf26C3Ed3fBf39922149E3E7b1e5c27cB;
    address constant RONKA = 0x885C4e7C864a632cE741AeBA2c688B139Bbbf835;
    address constant HORSKE = 0xc0Ca45c2e9448D3876Ca86220B2418C719298396;
    uint256 constant RAKE_BPS = 1_000;

    function run() external {
        require(block.chainid == 2020, "Ronin mainnet only");
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        address finalOwner = vm.envAddress("FINAL_OWNER");
        uint256[] memory raw = vm.envUint("SPLIT_BPS", ",");
        uint16[] memory split = new uint16[](raw.length);
        for (uint256 i; i < raw.length; ++i) split[i] = uint16(raw[i]);
        address quoter = vm.envAddress("QUOTER_ADDRESS");
        uint256 entryRonke = vm.envOr("ENTRY_RONKE", uint256(10_000));

        vm.startBroadcast(key);
        RonkeTournament t = new RonkeTournament(deployer, feeRecipient, RAKE_BPS, split);
        t.setPrice(RONKE, entryRonke * 1 ether);
        t.setQuoted(RONKA, true);
        t.setQuoted(HORSKE, true);
        t.setQuoter(quoter);
        if (finalOwner != deployer) t.transferOwnership(finalOwner);
        vm.stopBroadcast();

        console.log("tournament   ", address(t));
        console.log("owner (now)  ", t.owner());
        console.log("pending owner", t.pendingOwner());
    }
}
