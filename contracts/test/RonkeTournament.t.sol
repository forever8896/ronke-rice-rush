// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RonkeTournament} from "../src/RonkeTournament.sol";
import {TestToken} from "../src/TestToken.sol";

/// Takes 2% of every transfer — checks the pool counts what arrived, not what was asked.
contract FeeToken is ERC20 {
    constructor() ERC20("Fee", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 50;
            super._update(from, address(0xdead), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

contract RonkeTournamentTest is Test {
    RonkeTournament t;
    TestToken ronke;
    TestToken ronka;
    TestToken horske;
    address quoter;
    uint256 quoterKey;

    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");

    uint256 constant PRICE = 1_000 ether;
    // A Wednesday in week 2963 (Sun 2026-10-18 15:00 → Sun 2026-10-25 15:00 UTC).
    uint256 constant WED = 1_792_540_800;

    function setUp() public {
        vm.warp(WED);
        uint16[] memory s = new uint16[](3);
        (s[0], s[1], s[2]) = (5_000, 3_000, 2_000);
        t = new RonkeTournament(owner, treasury, 1_000, s);
        ronke = new TestToken("Test Ronke", "tRONKE");
        ronka = new TestToken("Test Ronka", "tRONKA");
        horske = new TestToken("Test Horske", "tHORSKE");
        (quoter, quoterKey) = makeAddrAndKey("quoter");
        vm.startPrank(owner);
        t.setPrice(address(ronke), PRICE);
        t.setPrice(address(ronka), 500 ether);
        t.setQuoted(address(horske), true);
        t.setQuoter(quoter);
        vm.stopPrank();
        for (uint256 i; i < 4; ++i) {
            address p = [alice, bob, carol, dave][i];
            ronke.mint(p, 100_000 ether);
            ronka.mint(p, 100_000 ether);
            horske.mint(p, 10_000_000 ether);
            vm.startPrank(p);
            ronke.approve(address(t), type(uint256).max);
            ronka.approve(address(t), type(uint256).max);
            horske.approve(address(t), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _enter(address p, uint256 n) internal {
        vm.prank(p);
        t.enter(address(ronke), n);
    }

    function _winners(address a, address b, address c) internal pure returns (address[] memory w, uint256[] memory s) {
        uint256 n = c != address(0) ? 3 : b != address(0) ? 2 : 1;
        w = new address[](n);
        s = new uint256[](n);
        w[0] = a;
        if (n > 1) w[1] = b;
        if (n > 2) w[2] = c;
    }

    function _afterBell() internal {
        vm.warp(t.weekEnd(t.currentWeek()) + t.SETTLE_DELAY());
    }

    // ── Calendar matches the game server ──

    function test_weekNumberMatchesServer() public view {
        assertEq(t.currentWeek(), 2963);
        assertEq(t.weekEnd(2963), 1_792_940_400); // Sun 2026-10-25 15:00 UTC
    }

    // ── Entering ──

    function test_enterEscrowsFee() public {
        _enter(alice, 2);
        uint256 w = t.currentWeek();
        assertEq(ronke.balanceOf(address(t)), 2 * PRICE);
        assertEq(t.pool(w, address(ronke)), 2 * PRICE);
        assertEq(t.entries(w, alice), 2);
        assertEq(t.paid(w, address(ronke), alice), 2 * PRICE);
        assertEq(ronke.balanceOf(treasury), 0, "operator holds nothing until settlement");
    }

    function test_enterRejectsUnknownTokenZeroCountAndPause() public {
        vm.prank(alice);
        vm.expectRevert(RonkeTournament.NotAccepted.selector);
        t.enter(address(0xbeef), 1);
        vm.prank(alice);
        vm.expectRevert(RonkeTournament.BadCount.selector);
        t.enter(address(ronke), 0);
        vm.prank(owner);
        t.setEntriesPaused(true);
        vm.prank(alice);
        vm.expectRevert(RonkeTournament.Paused.selector);
        t.enter(address(ronke), 1);
    }

    function test_feeOnTransferPoolCountsWhatArrived() public {
        FeeToken f = new FeeToken();
        vm.prank(owner);
        t.setPrice(address(f), PRICE);
        f.mint(alice, PRICE);
        vm.startPrank(alice);
        f.approve(address(t), PRICE);
        t.enter(address(f), 1);
        vm.stopPrank();
        assertEq(t.pool(t.currentWeek(), address(f)), PRICE - PRICE / 50);
        assertEq(f.balanceOf(address(t)), t.liabilities(address(f)));
    }

    // ── Settling ──

    function test_settlePaysRakeAndSplit() public {
        _enter(alice, 1);
        _enter(bob, 1);
        _enter(carol, 1);
        _enter(dave, 1);
        uint256 w = t.currentWeek();
        uint256 a0 = ronke.balanceOf(alice);
        _afterBell();
        (address[] memory win, uint256[] memory sc) = _winners(alice, bob, carol);
        vm.prank(owner);
        t.settle(w, win, sc);
        // 4000 gross → 400 rake → 3600 net → 1800 / 1080 / 720
        assertEq(ronke.balanceOf(treasury), 400 ether);
        assertEq(ronke.balanceOf(alice) - a0, 1_800 ether);
        assertEq(ronke.balanceOf(bob), 100_000 ether - PRICE + 1_080 ether);
        assertEq(ronke.balanceOf(carol), 100_000 ether - PRICE + 720 ether);
        assertEq(ronke.balanceOf(address(t)), 0);
        assertEq(t.liabilities(address(ronke)), 0);
    }

    function test_settlePaysEveryTokenPool() public {
        _enter(alice, 1);
        vm.prank(bob);
        t.enter(address(ronka), 2);
        uint256 w = t.currentWeek();
        _afterBell();
        (address[] memory win, uint256[] memory sc) = _winners(bob, alice, address(0));
        vm.prank(owner);
        t.settle(w, win, sc);
        // RONKE 1000 → 100 rake, 900 net split 50:30 → 562.5 / 337.5
        assertEq(ronke.balanceOf(treasury), 100 ether);
        assertEq(ronka.balanceOf(treasury), 100 ether);
        assertEq(ronke.balanceOf(address(t)), 0);
        assertEq(ronka.balanceOf(address(t)), 0);
    }

    function test_fewerWinnersShareTheWholeNetPool() public {
        _enter(alice, 1);
        _enter(bob, 1);
        uint256 w = t.currentWeek();
        _afterBell();
        (address[] memory win, uint256[] memory sc) = _winners(alice, bob, address(0));
        vm.prank(owner);
        t.settle(w, win, sc);
        // 2000 → 200 rake → 1800 net in 50:30 → 1125 / 675
        assertEq(ronke.balanceOf(alice), 100_000 ether - PRICE + 1_125 ether);
        assertEq(ronke.balanceOf(bob), 100_000 ether - PRICE + 675 ether);
        assertEq(ronke.balanceOf(address(t)), 0);
    }

    function test_onlyOwnerSettles() public {
        _enter(alice, 1);
        uint256 w = t.currentWeek();
        _afterBell();
        (address[] memory win, uint256[] memory sc) = _winners(alice, address(0), address(0));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        t.settle(w, win, sc);
    }

    function test_cannotSettleBeforeBellPlusDelay() public {
        _enter(alice, 1);
        uint256 w = t.currentWeek();
        vm.warp(t.weekEnd(w) + t.SETTLE_DELAY() - 1);
        (address[] memory win, uint256[] memory sc) = _winners(alice, address(0), address(0));
        vm.prank(owner);
        vm.expectRevert(RonkeTournament.TooEarly.selector);
        t.settle(w, win, sc);
    }

    function test_winnersMustHaveEnteredThatWeek() public {
        _enter(alice, 1);
        uint256 w = t.currentWeek();
        _afterBell();
        (address[] memory win, uint256[] memory sc) = _winners(alice, owner, address(0));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(RonkeTournament.NotEntrant.selector, owner));
        t.settle(w, win, sc);
    }

    function test_noDuplicateWinnersOrTooMany() public {
        _enter(alice, 1);
        _enter(bob, 1);
        uint256 w = t.currentWeek();
        _afterBell();
        (address[] memory win, uint256[] memory sc) = _winners(alice, alice, address(0));
        vm.prank(owner);
        vm.expectRevert(RonkeTournament.BadWinners.selector);
        t.settle(w, win, sc);

        address[] memory four = new address[](4);
        uint256[] memory s4 = new uint256[](4);
        vm.prank(owner);
        vm.expectRevert(RonkeTournament.BadWinners.selector);
        t.settle(w, four, s4);
    }

    function test_settleOnce() public {
        _enter(alice, 1);
        uint256 w = t.currentWeek();
        _afterBell();
        (address[] memory win, uint256[] memory sc) = _winners(alice, address(0), address(0));
        vm.startPrank(owner);
        t.settle(w, win, sc);
        vm.expectRevert(RonkeTournament.AlreadySettled.selector);
        t.settle(w, win, sc);
        vm.stopPrank();
    }

    function test_nextWeeksPoolUntouchedBySettle() public {
        _enter(alice, 1);
        uint256 w = t.currentWeek();
        _afterBell();
        _enter(bob, 1); // lands in week w+1
        (address[] memory win, uint256[] memory sc) = _winners(alice, address(0), address(0));
        vm.prank(owner);
        t.settle(w, win, sc);
        assertEq(t.pool(w + 1, address(ronke)), PRICE);
        assertEq(ronke.balanceOf(address(t)), PRICE);
    }

    // ── The operator can never just take the pool ──

    function test_rescueCannotTouchPools() public {
        _enter(alice, 3);
        vm.prank(owner);
        vm.expectRevert(RonkeTournament.NotSurplus.selector);
        t.rescue(address(ronke), owner, 1);
    }

    function test_rescueReturnsOnlyStrayTransfers() public {
        _enter(alice, 1);
        vm.prank(bob);
        ronke.transfer(address(t), 7 ether); // sent by mistake
        vm.prank(owner);
        t.rescue(address(ronke), bob, 7 ether);
        assertEq(ronke.balanceOf(address(t)), PRICE);
    }

    function test_cannotRenounce() public {
        vm.prank(owner);
        vm.expectRevert(RonkeTournament.BadConfig.selector);
        t.renounceOwnership();
    }

    function test_ownershipTransferIsTwoStep() public {
        address next = makeAddr("next");
        vm.prank(owner);
        t.transferOwnership(next);
        assertEq(t.owner(), owner);
        vm.prank(next);
        t.acceptOwnership();
        assertEq(t.owner(), next);
    }

    // ── Abandoned weeks refund ──

    function test_unsettledWeekRefundsEveryEntrant() public {
        _enter(alice, 2);
        _enter(bob, 1);
        uint256 w = t.currentWeek();
        vm.warp(t.weekEnd(w) + t.REFUND_AFTER());
        vm.prank(alice);
        t.refund(w, address(ronke));
        vm.prank(bob);
        t.refund(w, address(ronke));
        assertEq(ronke.balanceOf(alice), 100_000 ether);
        assertEq(ronke.balanceOf(bob), 100_000 ether);
        vm.prank(alice);
        vm.expectRevert(RonkeTournament.NothingToRefund.selector);
        t.refund(w, address(ronke));
    }

    function test_refundWindowLocksOutLateSettle() public {
        _enter(alice, 1);
        uint256 w = t.currentWeek();
        vm.warp(t.weekEnd(w) + t.REFUND_AFTER());
        (address[] memory win, uint256[] memory sc) = _winners(alice, address(0), address(0));
        vm.prank(owner);
        vm.expectRevert(RonkeTournament.TooLate.selector);
        t.settle(w, win, sc);
    }

    function test_noRefundBeforeDeadlineOrAfterSettle() public {
        _enter(alice, 1);
        uint256 w = t.currentWeek();
        vm.warp(t.weekEnd(w) + t.REFUND_AFTER() - 1);
        vm.prank(alice);
        vm.expectRevert(RonkeTournament.TooEarly.selector);
        t.refund(w, address(ronke));

        (address[] memory win, uint256[] memory sc) = _winners(alice, address(0), address(0));
        vm.prank(owner);
        t.settle(w, win, sc);
        vm.warp(t.weekEnd(w) + t.REFUND_AFTER());
        vm.prank(alice);
        vm.expectRevert(RonkeTournament.AlreadySettled.selector);
        t.refund(w, address(ronke));
    }

    // ── Config ──

    function test_rakeCappedAtTenPercentAndSplitMustSumTo100() public {
        uint16[] memory s = new uint16[](3);
        (s[0], s[1], s[2]) = (5_000, 3_000, 2_000);
        vm.expectRevert(RonkeTournament.BadConfig.selector);
        new RonkeTournament(owner, treasury, 1_001, s);
        s[2] = 1_999;
        vm.expectRevert(RonkeTournament.BadConfig.selector);
        new RonkeTournament(owner, treasury, 1_000, s);
    }

    function test_priceChangeAffectsOnlyFutureEntries() public {
        _enter(alice, 1);
        vm.prank(owner);
        t.setPrice(address(ronke), 5 * PRICE);
        assertEq(t.pool(t.currentWeek(), address(ronke)), PRICE);
        _enter(bob, 1);
        assertEq(t.pool(t.currentWeek(), address(ronke)), 6 * PRICE);
    }

    // ── Quoted entries (market-rate price, signed by the quote key) ──

    function _quote(uint256 key, RonkeTournament on, address player, address token, uint256 unitPrice, uint256 expiry)
        internal
        view
        returns (bytes memory)
    {
        bytes32 h = on.quoteHash(player, token, unitPrice, expiry);
        (uint8 v, bytes32 r, bytes32 sg) =
            vm.sign(key, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h)));
        return abi.encodePacked(r, sg, v);
    }

    function test_enterQuotedAtSignedPrice() public {
        uint256 unit = 132_850 ether;
        uint256 exp = block.timestamp + 10 minutes;
        bytes memory sig = _quote(quoterKey, t, alice, address(horske), unit, exp);
        vm.prank(alice);
        t.enterQuoted(address(horske), 1, unit, exp, sig);
        uint256 w = t.currentWeek();
        assertEq(t.pool(w, address(horske)), unit);
        assertEq(t.entries(w, alice), 1);
        assertEq(horske.balanceOf(address(t)), unit);
    }

    function test_quoteFromWrongKeyRejected() public {
        (, uint256 fakeKey) = makeAddrAndKey("not-the-quoter");
        uint256 exp = block.timestamp + 10 minutes;
        bytes memory sig = _quote(fakeKey, t, alice, address(horske), 1 ether, exp);
        vm.prank(alice);
        vm.expectRevert(RonkeTournament.BadQuote.selector);
        t.enterQuoted(address(horske), 1, 1 ether, exp, sig);
    }

    function test_quoteIsBoundToItsPlayer() public {
        uint256 exp = block.timestamp + 10 minutes;
        bytes memory sig = _quote(quoterKey, t, alice, address(horske), 1 ether, exp);
        vm.prank(bob);
        vm.expectRevert(RonkeTournament.BadQuote.selector);
        t.enterQuoted(address(horske), 1, 1 ether, exp, sig);
    }

    function test_quotedPriceCannotBeEdited() public {
        uint256 exp = block.timestamp + 10 minutes;
        bytes memory sig = _quote(quoterKey, t, alice, address(horske), 100_000 ether, exp);
        vm.prank(alice);
        vm.expectRevert(RonkeTournament.BadQuote.selector);
        t.enterQuoted(address(horske), 1, 1 ether, exp, sig);
    }

    function test_quoteForOneTokenCannotBuyAnother() public {
        vm.prank(owner);
        t.setQuoted(address(ronka), true);
        uint256 exp = block.timestamp + 10 minutes;
        bytes memory sig = _quote(quoterKey, t, alice, address(horske), 1 ether, exp);
        vm.prank(alice);
        vm.expectRevert(RonkeTournament.BadQuote.selector);
        t.enterQuoted(address(ronka), 1, 1 ether, exp, sig);
    }

    function test_expiredOrOverlongQuotesRejected() public {
        uint256 exp = block.timestamp + 10 minutes;
        bytes memory sig = _quote(quoterKey, t, alice, address(horske), 1 ether, exp);
        vm.warp(exp + 1);
        vm.prank(alice);
        vm.expectRevert(RonkeTournament.BadQuote.selector);
        t.enterQuoted(address(horske), 1, 1 ether, exp, sig);

        uint256 far = block.timestamp + t.MAX_QUOTE_TTL() + 1;
        bytes memory longSig = _quote(quoterKey, t, alice, address(horske), 1 ether, far);
        vm.prank(alice);
        vm.expectRevert(RonkeTournament.BadQuote.selector);
        t.enterQuoted(address(horske), 1, 1 ether, far, longSig);
    }

    function test_quoteForAnotherTournamentRejected() public {
        uint16[] memory s = new uint16[](1);
        s[0] = 10_000;
        RonkeTournament other = new RonkeTournament(owner, treasury, 1_000, s);
        uint256 exp = block.timestamp + 10 minutes;
        bytes memory sig = _quote(quoterKey, other, alice, address(horske), 1 ether, exp);
        vm.prank(alice);
        vm.expectRevert(RonkeTournament.BadQuote.selector);
        t.enterQuoted(address(horske), 1, 1 ether, exp, sig);
    }

    function test_rotatingTheQuoterKillsOldQuotes() public {
        uint256 exp = block.timestamp + 10 minutes;
        bytes memory sig = _quote(quoterKey, t, alice, address(horske), 1 ether, exp);
        vm.prank(owner);
        t.setQuoter(makeAddr("new-quoter"));
        vm.prank(alice);
        vm.expectRevert(RonkeTournament.BadQuote.selector);
        t.enterQuoted(address(horske), 1, 1 ether, exp, sig);
    }

    function test_quotedPathOnlyForQuotedTokens() public {
        uint256 exp = block.timestamp + 10 minutes;
        bytes memory sig = _quote(quoterKey, t, alice, address(ronke), 1 ether, exp);
        vm.prank(alice);
        vm.expectRevert(RonkeTournament.NotAccepted.selector);
        t.enterQuoted(address(ronke), 1, 1 ether, exp, sig);
        // …and a quoted token has no fixed price to buy at.
        vm.prank(alice);
        vm.expectRevert(RonkeTournament.NotAccepted.selector);
        t.enter(address(horske), 1);
    }

    function test_onlyOwnerManagesQuoting() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        t.setQuoter(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        t.setQuoted(address(ronke), true);
        vm.stopPrank();
    }

    function test_settlePaysQuotedPoolsToo() public {
        _enter(alice, 1);
        uint256 unit = 132_850 ether;
        uint256 exp = block.timestamp + 10 minutes;
        bytes memory sig = _quote(quoterKey, t, bob, address(horske), unit, exp);
        vm.prank(bob);
        t.enterQuoted(address(horske), 1, unit, exp, sig);
        uint256 w = t.currentWeek();
        _afterBell();
        (address[] memory win, uint256[] memory sc) = _winners(alice, bob, address(0));
        vm.prank(owner);
        t.settle(w, win, sc);
        assertEq(horske.balanceOf(treasury), unit / 10);
        assertEq(horske.balanceOf(address(t)), 0);
        assertEq(ronke.balanceOf(address(t)), 0);
    }

    // ── Fuzz: settle always empties the pool exactly, and never overpays ──

    function testFuzz_settleConservesPool(uint8 players, uint8 winnersN, uint96 priceSeed) public {
        players = uint8(bound(players, 1, 4));
        winnersN = uint8(bound(winnersN, 1, players < 3 ? players : 3));
        uint256 p = bound(priceSeed, 1, 10_000 ether);
        vm.prank(owner);
        t.setPrice(address(ronke), p);
        address[4] memory ps = [alice, bob, carol, dave];
        for (uint256 i; i < players; ++i) _enter(ps[i], 1 + i);
        uint256 w = t.currentWeek();
        uint256 gross = t.pool(w, address(ronke));
        uint256 before;
        for (uint256 i; i < 4; ++i) before += ronke.balanceOf(ps[i]);

        address[] memory win = new address[](winnersN);
        uint256[] memory sc = new uint256[](winnersN);
        for (uint256 i; i < winnersN; ++i) win[i] = ps[i];
        _afterBell();
        vm.prank(owner);
        t.settle(w, win, sc);

        uint256 afterBal;
        for (uint256 i; i < 4; ++i) afterBal += ronke.balanceOf(ps[i]);
        assertEq(ronke.balanceOf(address(t)), 0, "pool fully paid out");
        assertEq(ronke.balanceOf(treasury), (gross * 1_000) / 10_000, "rake is exactly 10%");
        assertEq(afterBal - before, gross - ronke.balanceOf(treasury), "winners get everything else");
    }
}
