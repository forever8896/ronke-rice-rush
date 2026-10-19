// ═════════════════════════════════════════════════════════════
// Tournament configuration — from env, with the money rules on chain.
//
//   TOURNAMENT_ADDRESS  0x… RonkeTournament escrow (contracts/)
//   CHAIN_ID            2020 Ronin mainnet (default) · 202601 Saigon testnet
//   ENTRY_TOKENS        SYMBOL:0xcontract:decimals, comma-separated —
//                       which tokens the page offers and how to show them.
//                       Prices, rake and split are read from the contract.
//   AUTH_SECRET         ≥32 random chars; signs session tokens
//   RONIN_RPC_URL       optional; defaults to the public node for CHAIN_ID
//   CONFIRMATIONS       optional, blocks before an entry counts (default 3)
//   KV_REST_API_URL / KV_REST_API_TOKEN   Upstash Redis
//
// If anything required is missing the tournament endpoints answer 503
// and the page simply doesn't offer ranked play.
// ═════════════════════════════════════════════════════════════

export interface EntryToken {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
}

export interface Config {
  tournament: `0x${string}`;
  chainId: number;
  tokens: EntryToken[];
  authSecret: string;
  rpcUrl: string;
  confirmations: number;
  explorer: string;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;

export const CHAINS: Record<number, { rpc: string; explorer: string; name: string }> = {
  2020: { rpc: 'https://api.roninchain.com/rpc', explorer: 'https://app.roninchain.com', name: 'Ronin' },
  202601: { rpc: 'https://saigon-testnet.roninchain.com/rpc', explorer: 'https://saigon-app.roninchain.com', name: 'Saigon' },
};

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
  const tournament = (env.TOURNAMENT_ADDRESS ?? '').trim();
  const secret = env.AUTH_SECRET ?? '';
  const chainId = Number(env.CHAIN_ID ?? '2020');
  const chain = CHAINS[chainId];
  if (!ADDR.test(tournament) || secret.length < 32 || !env.ENTRY_TOKENS || !chain) return null;
  if (!env.KV_REST_API_URL || !env.KV_REST_API_TOKEN) return null;

  const tokens: EntryToken[] = [];
  for (const part of env.ENTRY_TOKENS.split(',')) {
    const [symbol, address, decimals] = part.trim().split(':');
    const d = Number(decimals);
    if (!symbol || !ADDR.test(address ?? '') || !Number.isInteger(d) || d < 0 || d > 36) {
      console.error(`[config] bad ENTRY_TOKENS entry "${part}"`);
      return null;
    }
    tokens.push({ symbol: symbol.toUpperCase(), address: address.toLowerCase() as `0x${string}`, decimals: d });
  }

  cached = {
    tournament: tournament.toLowerCase() as `0x${string}`,
    chainId,
    tokens,
    authSecret: secret,
    rpcUrl: env.RONIN_RPC_URL || chain.rpc,
    confirmations: Number(env.CONFIRMATIONS ?? '3') || 3,
    explorer: chain.explorer,
  };
  return cached;
}

/** Tests swap config between cases. */
export function resetConfigCache(): void {
  cached = undefined;
}
