// ═════════════════════════════════════════════════════════════
// Entry quotes: the same dollar value in any accepted token.
//
// The anchor is the tournament's fixed-price token (10 000 RONKE). A
// quoted token (RONKA, HORSKE) costs whatever amount of it is worth the
// same in USD right now. Prices come from GeckoTerminal's Ronin DEX
// prices — the same source the casino indexer and the Horske backend
// use — cached for a minute. If a price is missing or stale, no quote
// is given: better to refuse an entry than to misprice one.
//
// A quote is signed by the quote key and the escrow checks it: bound to
// this chain, this contract, this player, this token, this unit price,
// and a short expiry. The key can sign entry prices and nothing else.
// ═════════════════════════════════════════════════════════════

import { encodeAbiParameters, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Config, EntryToken } from './config.js';

const CACHE_MS = 60_000;
/** Never quote from a price older than this, even if the API is down. */
const STALE_MS = 15 * 60_000;
export const QUOTE_TTL_S = 10 * 60;

/** USD per whole token, keyed by lower-case price address. Tests pass a fake. */
export type PriceSource = (addresses: string[]) => Promise<Record<string, number>>;

const gecko: PriceSource = async (addresses) => {
  const url = `https://api.geckoterminal.com/api/v2/simple/networks/ronin/token_price/${addresses.join(',')}`;
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`GeckoTerminal ${r.status}`);
  const data = (await r.json()) as { data?: { attributes?: { token_prices?: Record<string, string | null> } } };
  const out: Record<string, number> = {};
  for (const [a, p] of Object.entries(data.data?.attributes?.token_prices ?? {})) {
    const n = Number(p);
    if (p !== null && Number.isFinite(n) && n > 0) out[a.toLowerCase()] = n;
  }
  return out;
};

let source: PriceSource = gecko;
const cache = new Map<string, { usd: number; at: number }>();

export function setPriceSource(s: PriceSource): void {
  source = s;
  cache.clear();
}

/** USD per whole token for each entry token, or null where unknown/stale. */
export async function usdPrices(cfg: Config): Promise<Record<string, number | null>> {
  const now = Date.now();
  const want = cfg.tokens.map((t) => t.priceAddress);
  if (want.some((a) => !cache.has(a) || now - cache.get(a)!.at > CACHE_MS)) {
    try {
      const fresh = await source([...new Set(want)]);
      for (const [a, usd] of Object.entries(fresh)) cache.set(a, { usd, at: now });
    } catch (e) {
      console.error('[prices]', (e as Error).message);
    }
  }
  return Object.fromEntries(cfg.tokens.map((t) => {
    const hit = cache.get(t.priceAddress);
    return [t.symbol, hit && now - hit.at <= STALE_MS ? hit.usd : null];
  }));
}

/**
 * Base units of `token` worth the same USD as `anchorPrice` of `anchor`,
 * rounded UP to a whole token so the number reads cleanly and never
 * undercuts the anchor.
 */
export function equivalent(
  anchor: EntryToken, anchorPrice: bigint, anchorUsd: number, token: EntryToken, tokenUsd: number,
): bigint {
  // Fixed-point ratio with 18 digits of headroom; prices are floats from the API.
  const SCALE = 10n ** 18n;
  const ratio = BigInt(Math.round((anchorUsd / tokenUsd) * 1e18));
  let units = (anchorPrice * ratio) / SCALE;
  if (token.decimals >= anchor.decimals) units *= 10n ** BigInt(token.decimals - anchor.decimals);
  else units /= 10n ** BigInt(anchor.decimals - token.decimals);
  const whole = 10n ** BigInt(token.decimals);
  return ((units + whole - 1n) / whole) * whole;
}

/** What RonkeTournament.quoteHash() computes — must match it exactly. */
export function quoteHash(
  chainId: number, tournament: string, player: string, token: string, unitPrice: bigint, expiry: number,
): `0x${string}` {
  return keccak256(encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }],
    [BigInt(chainId), tournament as `0x${string}`, player as `0x${string}`, token as `0x${string}`, unitPrice, BigInt(expiry)],
  ));
}

export interface Quote {
  token: string;
  unitPrice: string;
  expiry: number;
  signature: string;
  usd: number;
}

export async function signQuote(
  cfg: Config, player: string, token: EntryToken, unitPrice: bigint, usd: number,
): Promise<Quote | null> {
  if (!cfg.quoterKey) return null;
  const expiry = Math.floor(Date.now() / 1000) + QUOTE_TTL_S;
  const hash = quoteHash(cfg.chainId, cfg.tournament, player, token.address, unitPrice, expiry);
  const signature = await privateKeyToAccount(cfg.quoterKey).signMessage({ message: { raw: hash } });
  return { token: token.address, unitPrice: unitPrice.toString(), expiry, signature, usd };
}

export interface EntryPrice {
  mode: 'fixed' | 'quoted' | 'closed';
  /** Base units per entry — exact for fixed, the current estimate for quoted. */
  price: bigint | null;
  /** USD per entry, when prices are known. */
  usd: number | null;
}

/** Whole tokens worth `usd` at `tokenUsd` each, rounded UP (never under the price). */
export function forDollars(usd: number, token: EntryToken, tokenUsd: number): bigint {
  return BigInt(Math.ceil(usd / tokenUsd - 1e-9)) * 10n ** BigInt(token.decimals);
}

/**
 * Every token's entry price. With ENTRY_USD set, a quoted token costs
 * exactly that many dollars. Otherwise the anchor is the first fixed-price
 * token and quoted tokens match its USD value at current prices.
 */
export async function entryPrices(
  cfg: Config, rules: { prices: Record<string, bigint>; quoted: Record<string, boolean> },
): Promise<{ anchor: EntryToken | null; prices: Record<string, EntryPrice> }> {
  const usd = await usdPrices(cfg);
  const anchor = cfg.tokens.find((t) => (rules.prices[t.symbol] ?? 0n) > 0n) ?? null;
  const anchorPrice = anchor ? rules.prices[anchor.symbol] : 0n;
  const anchorUsd = anchor ? usd[anchor.symbol] : null;
  const perEntryUsd = anchor && anchorUsd ? (Number(anchorPrice) / 10 ** anchor.decimals) * anchorUsd : null;

  const prices: Record<string, EntryPrice> = {};
  for (const t of cfg.tokens) {
    const fixed = rules.prices[t.symbol] ?? 0n;
    if (fixed > 0n) {
      const tUsd = usd[t.symbol];
      prices[t.symbol] = { mode: 'fixed', price: fixed, usd: tUsd ? (Number(fixed) / 10 ** t.decimals) * tUsd : null };
    } else if (rules.quoted[t.symbol]) {
      const tUsd = usd[t.symbol];
      if (cfg.entryUsd) {
        prices[t.symbol] = tUsd
          ? { mode: 'quoted', price: forDollars(cfg.entryUsd, t, tUsd), usd: cfg.entryUsd }
          : { mode: 'quoted', price: null, usd: null };
        continue;
      }
      const est = anchor && anchorUsd && tUsd ? equivalent(anchor, anchorPrice, anchorUsd, t, tUsd) : null;
      prices[t.symbol] = { mode: 'quoted', price: est, usd: est ? perEntryUsd : null };
    } else {
      prices[t.symbol] = { mode: 'closed', price: null, usd: null };
    }
  }
  return { anchor, prices };
}
