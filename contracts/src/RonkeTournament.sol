// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Ronke Boat Battle — weekly tournament escrow
/// @notice Entry fees are held here, never by the operator. A week's pool can
///         leave this contract in exactly two ways:
///           1. `settle` — the operator names that week's winners; the contract
///              pays its fixed rake to the fee recipient and the rest to the
///              winners by a fixed split.
///           2. `refund` — if a week is still unsettled REFUND_AFTER past its
///              end, every entrant takes back exactly what they paid in.
///         The rake and split are fixed at deployment. There is no withdraw.
/// @dev    Scoring happens off-chain (the game server replays each voyage), so
///         the operator chooses the winners — but only from wallets that
///         entered that week, and every ranked run is publicly replayable.
contract RonkeTournament is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Calendar ──
    // Weeks run Monday 00:00 UTC → Monday 00:00 UTC, numbered from the Monday
    // 1970-01-05, exactly as the game server counts them.
    uint256 public constant EPOCH = 4 days;
    uint256 public constant WEEK = 7 days;
    /// @notice Voyages dealt before the bell may finish this long after it.
    uint256 public constant SETTLE_DELAY = 70 minutes;
    /// @notice Unsettled this long after a week ends, its fees become refundable.
    uint256 public constant REFUND_AFTER = 30 days;

    uint256 public constant MAX_RAKE_BPS = 1_000; // 10%
    uint256 public constant MAX_ENTRIES_PER_TX = 100;

    /// @notice Operator's cut of each gross pool, in basis points. Immutable.
    uint256 public immutable rakeBps;
    /// @notice Share of the net pool per place, in basis points, summing to 10 000.
    uint16[] private _split;

    /// @notice Receives the rake. Changeable; it never receives anything else.
    address public feeRecipient;
    /// @notice Pauses NEW entries only. Settling and refunds are never paused.
    bool public entriesPaused;

    /// @notice Entry price per token, in base units. 0 = not accepted.
    mapping(address token => uint256) public price;
    /// @notice Every token ever accepted, so settle can sweep each one's pool.
    address[] public tokens;
    mapping(address token => bool) private _known;

    mapping(uint256 week => mapping(address token => uint256)) public pool;
    mapping(uint256 week => mapping(address token => mapping(address player => uint256))) public paid;
    mapping(uint256 week => mapping(address player => uint256)) public entries;
    mapping(uint256 week => bool) public settled;
    /// @notice Sum of every live pool per token — what this contract owes.
    mapping(address token => uint256) public liabilities;

    event Entered(uint256 indexed week, address indexed player, address indexed token, uint256 count, uint256 amount);
    event Settled(uint256 indexed week, address[] winners, uint256[] scores);
    event Prize(uint256 indexed week, address indexed winner, address indexed token, uint256 place, uint256 amount);
    event Rake(uint256 indexed week, address indexed token, address to, uint256 amount);
    event Refunded(uint256 indexed week, address indexed player, address indexed token, uint256 amount);
    event PriceSet(address indexed token, uint256 price);
    event FeeRecipientSet(address recipient);
    event EntriesPaused(bool paused);

    error BadConfig();
    error NotAccepted();
    error Paused();
    error BadCount();
    error NothingReceived();
    error TooEarly();
    error TooLate();
    error AlreadySettled();
    error BadWinners();
    error NotEntrant(address who);
    error NothingToRefund();
    error NotSurplus();

    constructor(address owner_, address feeRecipient_, uint256 rakeBps_, uint16[] memory split_) Ownable(owner_) {
        if (feeRecipient_ == address(0) || rakeBps_ > MAX_RAKE_BPS) revert BadConfig();
        if (split_.length == 0 || split_.length > 10) revert BadConfig();
        uint256 sum;
        for (uint256 i; i < split_.length; ++i) {
            if (split_[i] == 0) revert BadConfig();
            sum += split_[i];
        }
        if (sum != 10_000) revert BadConfig();
        rakeBps = rakeBps_;
        _split = split_;
        feeRecipient = feeRecipient_;
    }

    // ── Views ──

    function currentWeek() public view returns (uint256) {
        return (block.timestamp - EPOCH) / WEEK;
    }

    function weekEnd(uint256 week) public pure returns (uint256) {
        return EPOCH + (week + 1) * WEEK;
    }

    function split() external view returns (uint16[] memory) {
        return _split;
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    // ── Playing ──

    /// @notice Buy `count` ranked voyages for this week, paid in `token`.
    ///         Needs an ERC-20 approval of price × count first.
    function enter(address token, uint256 count) external nonReentrant {
        if (entriesPaused) revert Paused();
        uint256 p = price[token];
        if (p == 0) revert NotAccepted();
        if (count == 0 || count > MAX_ENTRIES_PER_TX) revert BadCount();

        // Count what actually arrived, so a fee-on-transfer token can never
        // leave the pool owing more than it holds.
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), p * count);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received == 0) revert NothingReceived();

        uint256 week = currentWeek();
        pool[week][token] += received;
        paid[week][token][msg.sender] += received;
        entries[week][msg.sender] += count;
        liabilities[token] += received;
        emit Entered(week, msg.sender, token, count, received);
    }

    /// @notice Take back your fees for a week that was never settled.
    function refund(uint256 week, address token) external nonReentrant {
        if (settled[week]) revert AlreadySettled();
        if (block.timestamp < weekEnd(week) + REFUND_AFTER) revert TooEarly();
        uint256 amount = paid[week][token][msg.sender];
        if (amount == 0) revert NothingToRefund();
        paid[week][token][msg.sender] = 0;
        pool[week][token] -= amount;
        liabilities[token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Refunded(week, msg.sender, token, amount);
    }

    // ── Operator ──

    /// @notice Pay out a finished week. `winners` in finishing order, at most
    ///         one per place; every one must have entered that week. With fewer
    ///         winners than places, the filled places share the whole net pool
    ///         in proportion to their split. `scores` is recorded for audit.
    function settle(uint256 week, address[] calldata winners, uint256[] calldata scores)
        external
        onlyOwner
        nonReentrant
    {
        if (settled[week]) revert AlreadySettled();
        uint256 end = weekEnd(week);
        if (block.timestamp < end + SETTLE_DELAY) revert TooEarly();
        if (block.timestamp >= end + REFUND_AFTER) revert TooLate();
        uint256 n = winners.length;
        if (n == 0 || n > _split.length || scores.length != n) revert BadWinners();
        for (uint256 i; i < n; ++i) {
            address w = winners[i];
            if (entries[week][w] == 0) revert NotEntrant(w);
            for (uint256 j; j < i; ++j) if (winners[j] == w) revert BadWinners();
        }

        settled[week] = true;
        uint256 shareSum;
        for (uint256 i; i < n; ++i) shareSum += _split[i];

        for (uint256 t; t < tokens.length; ++t) {
            address token = tokens[t];
            uint256 gross = pool[week][token];
            if (gross == 0) continue;
            pool[week][token] = 0;
            liabilities[token] -= gross;

            uint256 rake = (gross * rakeBps) / 10_000;
            uint256 net = gross - rake;
            uint256 paidOut;
            uint256[] memory prizes = new uint256[](n);
            for (uint256 i; i < n; ++i) {
                prizes[i] = (net * _split[i]) / shareSum;
                paidOut += prizes[i];
            }
            prizes[0] += net - paidOut; // rounding dust to first place

            if (rake > 0) {
                IERC20(token).safeTransfer(feeRecipient, rake);
                emit Rake(week, token, feeRecipient, rake);
            }
            for (uint256 i; i < n; ++i) {
                if (prizes[i] == 0) continue;
                IERC20(token).safeTransfer(winners[i], prizes[i]);
                emit Prize(week, winners[i], token, i + 1, prizes[i]);
            }
        }
        emit Settled(week, winners, scores);
    }

    /// @notice Set (or with 0, stop accepting) a token's entry price. Affects
    ///         future entries only; nothing already paid in can be touched.
    function setPrice(address token, uint256 newPrice) external onlyOwner {
        if (token == address(0)) revert BadConfig();
        if (!_known[token]) {
            if (newPrice == 0) revert BadConfig();
            if (tokens.length >= 8) revert BadConfig(); // keeps settle's loop bounded
            _known[token] = true;
            tokens.push(token);
        }
        price[token] = newPrice;
        emit PriceSet(token, newPrice);
    }

    function setFeeRecipient(address recipient) external onlyOwner {
        if (recipient == address(0)) revert BadConfig();
        feeRecipient = recipient;
        emit FeeRecipientSet(recipient);
    }

    function setEntriesPaused(bool paused) external onlyOwner {
        entriesPaused = paused;
        emit EntriesPaused(paused);
    }

    /// @notice Return tokens sent here by mistake (a plain transfer instead of
    ///         `enter`). Only ever the surplus above what the pools are owed.
    function rescue(address token, address to, uint256 amount) external onlyOwner {
        uint256 surplus = IERC20(token).balanceOf(address(this)) - liabilities[token];
        if (amount > surplus) revert NotSurplus();
        IERC20(token).safeTransfer(to, amount);
    }

    /// @dev Ownership can be handed on (two-step) but never thrown away: a
    ///      tournament with no owner could never settle, and every week would
    ///      fall through to refunds.
    function renounceOwnership() public pure override {
        revert BadConfig();
    }
}
