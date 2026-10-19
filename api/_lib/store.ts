// ═════════════════════════════════════════════════════════════
// Redis keys and the handful of operations the tournament needs.
//
// Everything lives under rbb:t: so it can never collide with the old
// free leaderboard (rbb:lb) or the Lick'em keys sharing this store.
//
// Money is NOT here: fees, pools and payouts live in the RonkeTournament
// escrow on chain. Redis only remembers what the chain already proved.
//
//   nonce:<n>              sign-in challenge, 10 min
//   entries:<week>:<addr>  unspent ranked voyages bought for that week
//   tx:<hash>              enter() already credited (never expires)
//   run:<id>               dealt voyage: who, seed, when — single use
//   lb:<season>            zset addr → composite score (best per wallet)
//   best:<season>:<addr>   that best run's details + review flags
//   log:<runId>            input log of a run that set a best, 90 days
//   name:<addr>            display name
//   dq:<season>:<addr>     disqualification note (admin script)
//   closed:<season>        payout read back from the settle() tx
// ═════════════════════════════════════════════════════════════

import { Redis } from '@upstash/redis';

export const P = 'rbb:t:';

/** The subset of the Upstash client the handlers use — tests pass a fake. */
export type Store = Pick<Redis,
  'get' | 'set' | 'del' | 'getdel' | 'incrby' | 'decr' | 'incr'
  | 'hset' | 'hgetall' | 'zadd' | 'zrange' | 'zcount' | 'zscore' | 'zrem' | 'mget'>;

let store: Store | null = null;

export function getStore(): Store {
  if (!store) {
    store = new Redis({
      url: process.env.KV_REST_API_URL ?? '',
      token: process.env.KV_REST_API_TOKEN ?? '',
    });
  }
  return store;
}

export function setStore(s: Store): void {
  store = s;
}

export interface RunTicket {
  addr: string;
  seed: number;
  season: number;
  startedAt: number;
  v: number;
}

export interface BestRun {
  score: number;
  runId: string;
  at: number;
  steps: number;
  flags: string[];
  stats: Record<string, number>;
}

export interface StoredLog {
  seed: number;
  addr: string;
  season: number;
  score: number;
  log: unknown;
}

export interface ClosedSeason {
  season: number;
  closedAt: number;
  /** The settle() transaction everything below was read from. */
  tx: string;
  payouts: Array<{ rank: number; address: string; symbol: string; amount: string; paidTx?: string }>;
  operator: Record<string, string>;
}
