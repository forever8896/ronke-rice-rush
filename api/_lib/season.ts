// ═════════════════════════════════════════════════════════════
// Weekly seasons, counted exactly as RonkeTournament counts them.
//
// A week ends every Sunday 15:00 UTC (4 PM Central European winter time;
// a fixed UTC time, so 5 PM during summer time). Entry fees sit
// in the escrow contract; settle() can't run until GRACE_MS after the
// bell, which is also the last moment a ranked voyage dealt before the
// bell may be finished here — so a settled week's board is final.
// ═════════════════════════════════════════════════════════════

import { P, type Store } from './store.js';

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Sunday 1970-01-04 15:00 UTC — the contract's EPOCH. */
const EPOCH_MS = (3 * 24 + 15) * 60 * 60 * 1000;
/** = the contract's SETTLE_DELAY. */
export const GRACE_MS = 70 * 60 * 1000;

export function seasonOf(ms: number): number {
  return Math.floor((ms - EPOCH_MS) / WEEK_MS);
}

export function seasonStart(season: number): number {
  return EPOCH_MS + season * WEEK_MS;
}

export function seasonEnd(season: number): number {
  return seasonStart(season + 1);
}

/**
 * Board score: points first, then whoever got there EARLIER wins the
 * tie (a later identical score sorts below). Points × 1e6 plus the
 * seconds remaining in the week stays well inside a double's 2^53.
 */
export function composite(score: number, at: number, season: number): number {
  const secs = Math.floor((at - seasonStart(season)) / 1000);
  return score * 1e6 + (999_999 - Math.max(0, Math.min(999_999, secs)));
}

export function scoreOf(composite: number): number {
  return Math.floor(composite / 1e6);
}

/**
 * The contract's payout arithmetic, line for line (RonkeTournament.settle):
 * rake off the gross, the net split over the places actually filled in
 * proportion to their share, rounding dust to first place.
 */
export function splitPool(gross: bigint, rakeBps: number, split: number[], filled = split.length): { rake: bigint; places: bigint[] } {
  const rake = (gross * BigInt(rakeBps)) / 10_000n;
  const net = gross - rake;
  const shares = split.slice(0, Math.max(1, Math.min(filled, split.length)));
  const sum = BigInt(shares.reduce((a, b) => a + b, 0));
  const places = shares.map((s) => (net * BigInt(s)) / sum);
  places[0] += net - places.reduce((a, b) => a + b, 0n);
  return { rake, places };
}

export interface BoardRow {
  rank: number;
  address: string;
  score: number;
}

export async function board(store: Store, season: number, n: number): Promise<BoardRow[]> {
  const raw = (await store.zrange(`${P}lb:${season}`, 0, n - 1, { rev: true, withScores: true })) as Array<string | number>;
  const rows: BoardRow[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    rows.push({ rank: rows.length + 1, address: String(raw[i]), score: scoreOf(Number(raw[i + 1])) });
  }
  return rows;
}
