// ═════════════════════════════════════════════════════════════
// Everything the server learns from Ronin.
//
// Entry fees never pass through the operator: a player calls enter()
// on the RonkeTournament escrow, and we credit ranked voyages only from
// an `Entered` event that:
//   • was emitted by the configured tournament contract,
//   • names the signed-in wallet as the player (so nobody can claim an
//     entry someone else bought),
//   • is in a successful tx with enough confirmations on top.
// The tx hash is then burned in Redis so it can't be credited twice.
//
// Pools, prices, rake and split are read from the contract itself —
// the page can only ever show what the escrow will actually pay.
// ═════════════════════════════════════════════════════════════

import { createPublicClient, decodeEventLog, http } from 'viem';
import { TOURNAMENT_ABI } from './abi.js';
import type { Config, EntryToken } from './config.js';

export interface ReceiptLike {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  logs: Array<{ address: string; topics: readonly string[]; data: string }>;
}

export interface OnChainRules {
  owner: string;
  pendingOwner: string;
  feeRecipient: string;
  rakeBps: number;
  split: number[];
  paused: boolean;
  /** Fixed entry price per configured token, base units (0 = not fixed-priced). */
  prices: Record<string, bigint>;
  /** Tokens priced by signed market-rate quote. */
  quoted: Record<string, boolean>;
  quoter: string;
}

/** What the server needs from a node — tests pass a fake. */
export interface ChainReader {
  receipt(hash: `0x${string}`): Promise<ReceiptLike | null>;
  blockNumber(): Promise<bigint>;
  /**
   * A smart-account signature, which can't be recovered from — the
   * account answers for itself (ERC-1271), or for an account not yet
   * deployed, the wrapped signature carries its own deployment (ERC-6492).
   */
  contractSignatureValid(address: `0x${string}`, message: string, signature: `0x${string}`): Promise<boolean>;
  rules(): Promise<OnChainRules>;
  pools(week: number): Promise<Record<string, bigint>>;
  settled(week: number): Promise<boolean>;
}

let reader: ChainReader | null = null;

export function getChain(cfg: Config): ChainReader {
  if (reader) return reader;
  const client = createPublicClient({ transport: http(cfg.rpcUrl, { timeout: 8000 }) });
  const at = { address: cfg.tournament, abi: TOURNAMENT_ABI } as const;
  reader = {
    async receipt(hash) {
      try {
        return (await client.getTransactionReceipt({ hash })) as unknown as ReceiptLike;
      } catch (e) {
        if ((e as Error).name === 'TransactionReceiptNotFoundError') return null;
        throw e;
      }
    },
    blockNumber: () => client.getBlockNumber(),
    async contractSignatureValid(address, message, signature) {
      try {
        return await client.verifyMessage({ address, message, signature });
      } catch {
        return false;
      }
    },
    async rules() {
      const n = cfg.tokens.length;
      const [owner, pendingOwner, feeRecipient, rakeBps, split, paused, quoter, ...perToken] = await Promise.all([
        client.readContract({ ...at, functionName: 'owner' }),
        client.readContract({ ...at, functionName: 'pendingOwner' }),
        client.readContract({ ...at, functionName: 'feeRecipient' }),
        client.readContract({ ...at, functionName: 'rakeBps' }),
        client.readContract({ ...at, functionName: 'split' }),
        client.readContract({ ...at, functionName: 'entriesPaused' }),
        client.readContract({ ...at, functionName: 'quoter' }),
        ...cfg.tokens.map((t) => client.readContract({ ...at, functionName: 'price', args: [t.address] })),
        ...cfg.tokens.map((t) => client.readContract({ ...at, functionName: 'quoted', args: [t.address] })),
      ]);
      const prices = perToken.slice(0, n);
      const quoted = perToken.slice(n);
      return {
        owner: String(owner).toLowerCase(),
        pendingOwner: String(pendingOwner).toLowerCase(),
        feeRecipient: String(feeRecipient).toLowerCase(),
        rakeBps: Number(rakeBps),
        split: (split as readonly number[]).map(Number),
        paused: Boolean(paused),
        prices: Object.fromEntries(cfg.tokens.map((t, i) => [t.symbol, prices[i] as bigint])),
        quoted: Object.fromEntries(cfg.tokens.map((t, i) => [t.symbol, Boolean(quoted[i])])),
        quoter: String(quoter).toLowerCase(),
      };
    },
    async pools(week) {
      const vals = await Promise.all(cfg.tokens.map((t) =>
        client.readContract({ ...at, functionName: 'pool', args: [BigInt(week), t.address] })));
      return Object.fromEntries(cfg.tokens.map((t, i) => [t.symbol, vals[i] as bigint]));
    },
    settled: (week) => client.readContract({ ...at, functionName: 'settled', args: [BigInt(week)] }) as Promise<boolean>,
  };
  return reader;
}

export function setChain(c: ChainReader): void {
  reader = c;
}

/** The tournament's own events in a receipt, decoded; anything else skipped. */
function tournamentEvents(cfg: Config, r: ReceiptLike) {
  const out = [];
  for (const log of r.logs) {
    if (log.address.toLowerCase() !== cfg.tournament) continue;
    try {
      out.push(decodeEventLog({
        abi: TOURNAMENT_ABI,
        data: log.data as `0x${string}`,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      }));
    } catch {
      // An event this ABI doesn't describe (PriceSet, ownership, …).
    }
  }
  return out;
}

export type EntryCheck =
  | { kind: 'pending' }
  | { kind: 'rejected'; reason: string }
  | { kind: 'ok'; week: number; entries: Array<{ token: EntryToken; count: number; amount: bigint }> };

export async function checkEntry(
  chain: ChainReader, cfg: Config, hash: `0x${string}`, player: string,
): Promise<EntryCheck> {
  const r = await chain.receipt(hash);
  if (!r) return { kind: 'pending' };
  if (r.status !== 'success') return { kind: 'rejected', reason: 'transaction reverted' };
  const head = await chain.blockNumber();
  if (head - r.blockNumber + 1n < BigInt(cfg.confirmations)) return { kind: 'pending' };

  let week = -1;
  const entries: Array<{ token: EntryToken; count: number; amount: bigint }> = [];
  for (const ev of tournamentEvents(cfg, r)) {
    if (ev.eventName !== 'Entered') continue;
    const a = ev.args as { week: bigint; player: string; token: string; count: bigint; amount: bigint };
    if (a.player.toLowerCase() !== player) continue;
    const token = cfg.tokens.find((t) => t.address === a.token.toLowerCase());
    if (!token) continue;
    week = Number(a.week);
    entries.push({ token, count: Number(a.count), amount: a.amount });
  }
  if (!entries.length) return { kind: 'rejected', reason: 'no tournament entry by your wallet in that transaction' };
  return { kind: 'ok', week, entries };
}

export interface Settlement {
  week: number;
  winners: string[];
  scores: number[];
  prizes: Array<{ place: number; winner: string; token: string; amount: bigint }>;
  rake: Array<{ token: string; amount: bigint }>;
}

/** Read a settle() transaction back out of its receipt. */
export async function readSettlement(chain: ChainReader, cfg: Config, hash: `0x${string}`): Promise<Settlement | null> {
  const r = await chain.receipt(hash);
  if (!r || r.status !== 'success') return null;
  let s: Settlement | null = null;
  const prizes: Settlement['prizes'] = [];
  const rake: Settlement['rake'] = [];
  for (const ev of tournamentEvents(cfg, r)) {
    if (ev.eventName === 'Settled') {
      const a = ev.args as { week: bigint; winners: readonly string[]; scores: readonly bigint[] };
      s = { week: Number(a.week), winners: a.winners.map((w) => w.toLowerCase()), scores: a.scores.map(Number), prizes, rake };
    } else if (ev.eventName === 'Prize') {
      const a = ev.args as { winner: string; token: string; place: bigint; amount: bigint };
      prizes.push({ place: Number(a.place), winner: a.winner.toLowerCase(), token: a.token.toLowerCase(), amount: a.amount });
    } else if (ev.eventName === 'Rake') {
      const a = ev.args as { token: string; amount: bigint };
      rake.push({ token: a.token.toLowerCase(), amount: a.amount });
    }
  }
  return s;
}
