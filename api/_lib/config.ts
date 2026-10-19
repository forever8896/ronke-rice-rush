// ═════════════════════════════════════════════════════════════
// Tournament configuration — all of it from env, none of it in code.
//
//   TREASURY_ADDRESS   0x… wallet that receives entry fees and pays prizes
//   ENTRY_TOKENS       SYMBOL:0xcontract:decimals:price, comma-separated
//                      e.g. RONKE:0x…:18:1000,RONKA:0x…:18:500
//   PRIZE_SPLIT        percent of the net pool per place, e.g. 50,30,20
//   RAKE_PERCENT       operator's cut of each gross pool, e.g. 10
//   AUTH_SECRET        ≥32 random chars; signs session tokens
//   RONIN_RPC_URL      optional, defaults to the public Ronin RPC
//   CONFIRMATIONS      optional, blocks before a payment counts (default 3)
//   KV_REST_API_URL / KV_REST_API_TOKEN   Upstash Redis
//
// If any required value is missing the tournament endpoints answer 503
// and the page simply doesn't offer ranked play. Free play never
// depends on any of this.
// ═════════════════════════════════════════════════════════════

export interface EntryToken {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  /** Entry price in base units. */
  price: bigint;
}

export interface Config {
  treasury: `0x${string}`;
  tokens: EntryToken[];
  /** Percent of the net pool for 1st, 2nd, 3rd … (sums to 100). */
  split: number[];
  rakePercent: number;
  authSecret: string;
  rpcUrl: string;
  confirmations: number;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** "1000" or "12.5" in whole tokens → base units. */
export function parseUnits(text: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`bad amount "${text}"`);
  const frac = (m[2] ?? '').padEnd(decimals, '0');
  if (frac.length > decimals) throw new Error(`"${text}" has more than ${decimals} decimals`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac || '0');
}

let cached: Config | null | undefined;

export function loadConfig(): Config | null {
  if (cached !== undefined) return cached;
  cached = null;
  const env = process.env;
  const treasury = (env.TREASURY_ADDRESS ?? '').trim();
  const secret = env.AUTH_SECRET ?? '';
  if (!ADDR.test(treasury) || secret.length < 32 || !env.ENTRY_TOKENS) return null;
  if (!env.KV_REST_API_URL || !env.KV_REST_API_TOKEN) return null;

  const tokens: EntryToken[] = [];
  for (const part of env.ENTRY_TOKENS.split(',')) {
    const [symbol, address, decimals, price] = part.trim().split(':');
    const d = Number(decimals);
    if (!symbol || !ADDR.test(address ?? '') || !Number.isInteger(d) || d < 0 || d > 36 || !price) {
      console.error(`[config] bad ENTRY_TOKENS entry "${part}"`);
      return null;
    }
    tokens.push({
      symbol: symbol.toUpperCase(),
      address: address.toLowerCase() as `0x${string}`,
      decimals: d,
      price: parseUnits(price, d),
    });
  }

  const split = (env.PRIZE_SPLIT ?? '50,30,20').split(',').map(Number);
  if (split.some((n) => !Number.isInteger(n) || n < 0) || split.reduce((a, b) => a + b, 0) !== 100) {
    console.error('[config] PRIZE_SPLIT must be whole percents summing to 100');
    return null;
  }
  const rake = Number(env.RAKE_PERCENT ?? '10');
  if (!Number.isInteger(rake) || rake < 0 || rake > 50) {
    console.error('[config] RAKE_PERCENT must be a whole number 0–50');
    return null;
  }

  cached = {
    treasury: treasury.toLowerCase() as `0x${string}`,
    tokens,
    split,
    rakePercent: rake,
    authSecret: secret,
    rpcUrl: env.RONIN_RPC_URL || 'https://api.roninchain.com/rpc',
    confirmations: Number(env.CONFIRMATIONS ?? '3') || 3,
  };
  return cached;
}

/** Tests swap config between cases. */
export function resetConfigCache(): void {
  cached = undefined;
}
