// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {RonkeTournament} from "../src/RonkeTournament.sol";
import {TestToken} from "../src/TestToken.sol";

/// Saigon rehearsal: test RONKE/RONKA, the escrow, prices, test balances.
///   DEPLOYER_PRIVATE_KEY  throwaway deployer (needs a little testnet RON)
///   FEE_RECIPIENT         receives the 10% rake
///   FINAL_OWNER           offered ownership; accepts it from the game's owner panel
///   MINT_TO               comma-separated wallets to fund with test tokens
contract DeploySaigon is Script {
    uint256 constant RAKE_BPS = 1_000;
    uint256 constant MINT = 1_000_000 ether;

    function run() external {
        require(block.chainid == 202601, "Saigon only");
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        address finalOwner = vm.envAddress("FINAL_OWNER");
        address[] memory mintTo = vm.envAddress("MINT_TO", ",");

        uint16[] memory split = new uint16[](3);
        (split[0], split[1], split[2]) = (5_000, 3_000, 2_000);

        vm.startBroadcast(key);
        TestToken ronke = new TestToken("Test Ronke", "tRONKE");
        TestToken ronka = new TestToken("Test Ronka", "tRONKA");
        RonkeTournament t = new RonkeTournament(deployer, feeRecipient, RAKE_BPS, split);
        t.setPrice(address(ronke), 1_000 ether);
        t.setPrice(address(ronka), 500 ether);
        for (uint256 i; i < mintTo.length; ++i) {
            ronke.mint(mintTo[i], MINT);
            ronka.mint(mintTo[i], MINT);
        }
        if (finalOwner != deployer) t.transferOwnership(finalOwner);
        vm.stopBroadcast();

        console.log("tRONKE       ", address(ronke));
        console.log("tRONKA       ", address(ronka));
        console.log("tournament   ", address(t));
        console.log("owner (now)  ", t.owner());
        console.log("pending owner", t.pendingOwner());
    }
}
