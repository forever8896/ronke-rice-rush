// ═════════════════════════════════════════════════════════════
// Weekly seasons and the money maths.
//
// A season runs Monday 00:00 UTC → next Monday 00:00 UTC. Fees land in
// the pool of the week the payment's block was mined. Prizes are the
// gross pool minus the operator's rake, split by place; places nobody
// filled roll into next week's pool rather than to the operator.
// ═════════════════════════════════════════════════════════════

import type { Config } from './config.js';
import { P, type Store } from './store.js';

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Monday 1970-01-05 00:00 UTC. */
const EPOCH_MS = 4 * 24 * 60 * 60 * 1000;
/** A voyage dealt before the bell may still be finished this long after it. */
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

/** Gross base units paid into each token's pool this season. */
export async function pools(store: Store, cfg: Config, season: number): Promise<Record<string, bigint>> {
  const out: Record<string, bigint> = {};
  for (const t of cfg.tokens) {
    const h = (await store.hgetall<Record<string, string | number>>(`${P}pool:${season}:${t.symbol}`)) ?? {};
    let sum = 0n;
    for (const v of Object.values(h)) sum += BigInt(String(v));
    out[t.symbol] = sum;
  }
  return out;
}

export interface Split {
  operator: bigint;
  /** Prize per place, same order as cfg.split. */
  places: bigint[];
}

/** Rake first, then the net split by place. Dust from rounding goes to 1st. */
export function splitPool(gross: bigint, cfg: Config): Split {
  const operator = (gross * BigInt(cfg.rakePercent)) / 100n;
  const net = gross - operator;
  const places = cfg.split.map((pct) => (net * BigInt(pct)) / 100n);
  const dust = net - places.reduce((a, b) => a + b, 0n);
  if (places.length) places[0] += dust;
  return { operator, places };
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
