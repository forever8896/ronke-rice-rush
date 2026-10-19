// The slice of RonkeTournament (contracts/src/RonkeTournament.sol) the
// server reads. Human-readable so it can be checked against the source
// at a glance.

import { parseAbi } from 'viem';

export const TOURNAMENT_ABI = parseAbi([
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function feeRecipient() view returns (address)',
  'function rakeBps() view returns (uint256)',
  'function split() view returns (uint16[])',
  'function price(address token) view returns (uint256)',
  'function pool(uint256 week, address token) view returns (uint256)',
  'function settled(uint256 week) view returns (bool)',
  'function entriesPaused() view returns (bool)',
  'event Entered(uint256 indexed week, address indexed player, address indexed token, uint256 count, uint256 amount)',
  'event Settled(uint256 indexed week, address[] winners, uint256[] scores)',
  'event Prize(uint256 indexed week, address indexed winner, address indexed token, uint256 place, uint256 amount)',
  'event Rake(uint256 indexed week, address indexed token, address to, uint256 amount)',
]);
