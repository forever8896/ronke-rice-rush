// ═════════════════════════════════════════════════════════════
// Weekly tournament client — Ronin wallet, entry fees, ranked runs.
//
// The wallet does three things and nothing else: sign a free sign-in
// message, send an ERC-20 transfer of the entry fee to the treasury,
// and identify who is on the board. Two ways in, the same pair the
// Ronkeverse site uses: the Ronin Wallet (extension, or the Ronin app's
// browser) through Sky Mavis's own tanto-connect, and Ronin Stash for
// email login. Both end as an EIP-1193 provider, so nothing below the
// connect step knows which was used. Prizes are sent by the operator
// from the treasury; nothing here can move a player's funds except
// the transfer they approve in their own wallet.
//
// Every payment hash is parked in localStorage until the server has
// credited it, so a closed tab or a slow block never loses an entry.
// ═════════════════════════════════════════════════════════════

import { requestRoninWalletConnector, type RoninWalletConnector } from '@sky-mavis/tanto-connect';
import type { RunLogWire } from './runlog';
import { bytesToB64 } from './runlog';
import { SIM_VERSION } from './sim';

const RONIN_CHAIN_ID = 2020;
const SESSION_KEY = 'ronke:session';
const PENDING_KEY = 'ronke:pendingTx';
export const EXPLORER = 'https://app.roninchain.com';

export interface TokenInfo {
  symbol: string;
  address: string;
  decimals: number;
  price: string;
  pool: string;
  prizes: string[];
}

export interface SeasonInfo {
  season: number;
  startsAt: number;
  endsAt: number;
  treasury: string;
  chainId: number;
  rakePercent: number;
  split: number[];
  tokens: TokenInfo[];
  board: Array<{ rank: number; address: string; score: number; name: string | null; runId: string | null }>;
  last: {
    season: number;
    payouts: Array<{ rank: number; address: string; symbol: string; amount: string; paidTx?: string }>;
  } | null;
  me: { address: string; entries: number; name: string | null; best: number | null; rank: number | null } | null;
}

export type WalletVia = 'extension' | 'stash';

interface Session { token: string; address: string; via?: WalletVia }

interface Eip1193 {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

/**
 * Ronin Stash's Privy app id — the one the Ronke casino and the
 * Ronkeverse site run on. Set VITE_STASH_APP_ID to override, or to an
 * empty string to turn email login off. (Ronin Waypoint is deliberately
 * absent: Sky Mavis deprecated it, and its wallets lose access to their
 * assets after 16 September 2026.)
 */
const STASH_APP_ID: string = import.meta.env.VITE_STASH_APP_ID ?? 'cmpkwmb7l001c0bjp3sdn6n8e';

// ── Session ──

export function session(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function signOut(): void {
  const via = session()?.via;
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  if (via === 'stash') void stash?.request({ method: 'wallet_disconnect' }).catch(() => {});
  else void connector?.disconnect().catch(() => {});
}

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: T }> {
  const s = session();
  const r = await fetch(path, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(s ? { Authorization: `Bearer ${s.token}` } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (r.status === 401 && s) signOut();
  const data = (await r.json().catch(() => ({}))) as T;
  return { status: r.status, data };
}

const errorOf = (d: unknown, fallback: string): string =>
  (d && typeof d === 'object' && 'error' in d && typeof (d as { error: unknown }).error === 'string')
    ? (d as { error: string }).error
    : fallback;

export async function fetchSeason(): Promise<SeasonInfo | null> {
  try {
    const r = await api<SeasonInfo>('/api/season');
    // Anything but a real season (an SPA fallback page, a proxy error)
    // means no tournament — never a half-drawn one.
    const ok = r.status === 200 && Number.isInteger(r.data?.season)
      && Array.isArray(r.data.tokens) && Array.isArray(r.data.board);
    return ok ? r.data : null;
  } catch {
    return null;
  }
}

// ── Wallet ──

let connector: RoninWalletConnector | null = null;
let connectorTried: Promise<RoninWalletConnector | null> | null = null;
let stash: Eip1193 | null = null;

/** The injected Ronin Wallet, or null if this browser has none. Resolved once. */
function roninConnector(): Promise<RoninWalletConnector | null> {
  connectorTried ??= requestRoninWalletConnector()
    .then((c) => (connector = c))
    .catch(() => null);
  return connectorTried;
}

/** Stash is Privy underneath; its cross-app connect hands back a plain provider. Loaded on demand. */
async function stashProvider(): Promise<Eip1193 | null> {
  if (!STASH_APP_ID) return null;
  if (stash) return stash;
  const { toPrivyWalletProvider } = await import('@privy-io/cross-app-connect');
  stash = toPrivyWalletProvider({
    providerAppId: STASH_APP_ID,
    chains: [{
      id: RONIN_CHAIN_ID,
      name: 'Ronin',
      nativeCurrency: { name: 'RON', symbol: 'RON', decimals: 18 },
      rpcUrls: { default: { http: ['https://api.roninchain.com/rpc'] } },
    }],
    chainId: RONIN_CHAIN_ID,
  }) as unknown as Eip1193;
  return stash;
}

export interface WalletOptions { extension: boolean; email: boolean }

/** Which ways in this browser has. */
export async function walletOptions(): Promise<WalletOptions> {
  return { extension: !!(await roninConnector()), email: !!STASH_APP_ID };
}

/**
 * A provider for `via`, connected and on Ronin mainnet, plus the address
 * it is acting as.
 */
async function wallet(via: WalletVia): Promise<{ p: Eip1193; address: string }> {
  let p: Eip1193;
  let account: string | undefined;
  if (via === 'stash') {
    const sp = await stashProvider();
    if (!sp) throw new Error('Email login is not available.');
    p = sp;
    const accounts = (await p.request({ method: 'eth_requestAccounts' })) as string[];
    account = accounts?.[0];
  } else {
    const c = await roninConnector();
    if (!c) throw new Error('No Ronin Wallet found — install the extension, open this page in the Ronin app, or continue with email.');
    // connect() is a no-op prompt when the site is already authorised,
    // and asks the wallet to move to Ronin mainnet if it's elsewhere.
    const r = await c.connect(RONIN_CHAIN_ID);
    account = r.account;
    if (r.chainId !== RONIN_CHAIN_ID) await c.switchChain(RONIN_CHAIN_ID);
    p = r.provider as unknown as Eip1193;
  }
  const address = String(account ?? '').toLowerCase().replace(/^ronin:/, '0x');
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error('The wallet did not share an address.');
  return { p, address };
}

export async function signIn(via: WalletVia): Promise<string> {
  const { p, address } = await wallet(via);
  const n = await api<{ nonce: string; message: string }>('/api/auth', {
    method: 'POST', body: { action: 'nonce', address },
  });
  if (n.status !== 200) throw new Error(errorOf(n.data, 'Sign-in unavailable right now.'));
  const signature = await p.request({ method: 'personal_sign', params: [utf8Hex(n.data.message), address] });
  const v = await api<{ token: string; address: string }>('/api/auth', {
    method: 'POST', body: { action: 'verify', address, nonce: n.data.nonce, signature },
  });
  if (v.status !== 200) throw new Error(errorOf(v.data, 'Sign-in failed.'));
  localStorage.setItem(SESSION_KEY, JSON.stringify({ token: v.data.token, address: v.data.address, via }));
  return v.data.address;
}

export async function setName(name: string): Promise<void> {
  const r = await api('/api/auth', { method: 'POST', body: { action: 'name', name } });
  if (r.status !== 200) throw new Error(errorOf(r.data, 'Could not save that name.'));
}

/**
 * Pay one entry in `token`. Resolves once the server has credited it;
 * `onStatus` narrates the wait.
 */
export async function buyEntry(
  info: SeasonInfo, token: TokenInfo, onStatus: (msg: string) => void,
): Promise<number> {
  const s = session();
  if (!s) throw new Error('Sign in first.');
  // The same wallet the session was signed with — never a different one.
  const { p, address } = await wallet(s.via ?? 'extension');
  if (s.address !== address) throw new Error('Your wallet switched accounts — sign out and sign in again.');
  const price = BigInt(token.price);

  const bal = BigInt(String(await p.request({
    method: 'eth_call',
    params: [{ to: token.address, data: `0x70a08231${word(address)}` }, 'latest'],
  })));
  if (bal < price) {
    throw new Error(`You need ${formatAmount(price, token.decimals)} ${token.symbol} — this wallet has ${formatAmount(bal, token.decimals)}.`);
  }

  onStatus('confirm the transfer in your wallet…');
  const hash = String(await p.request({
    method: 'eth_sendTransaction',
    params: [{
      from: address,
      to: token.address,
      value: '0x0',
      // transfer(treasury, price)
      data: `0xa9059cbb${word(info.treasury)}${price.toString(16).padStart(64, '0')}`,
    }],
  }));
  rememberPending(hash);
  onStatus('payment sent — waiting for Ronin to confirm…');
  return creditPayment(hash, onStatus);
}

/** Poll the server until a payment is credited (or definitively refused). */
async function creditPayment(hash: string, onStatus: (msg: string) => void): Promise<number> {
  for (let i = 0; i < 40; i++) {
    const r = await api<{ entries: number; error?: string }>('/api/entry', { method: 'POST', body: { txHash: hash } });
    if (r.status === 200) { forgetPending(hash); return r.data.entries; }
    if (r.status === 409) { forgetPending(hash); throw new Error('That payment was already credited.'); }
    if (r.status === 422 || r.status === 400) { forgetPending(hash); throw new Error(errorOf(r.data, 'Payment not accepted.')); }
    if (r.status === 401) throw new Error('Signed out — sign in again; your payment is saved and will be credited.');
    if (i === 6) onStatus('still confirming… (this can take a minute)');
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error('Ronin is slow right now. Your payment is saved and will be credited next time you open the game.');
}

/** Credit any payments a previous visit didn't get to finish. */
export async function retryPending(onStatus: (msg: string) => void): Promise<void> {
  if (!session()) return;
  for (const hash of pending()) {
    try {
      await creditPayment(hash, onStatus);
      onStatus('an earlier payment has been credited ✓');
    } catch (e) {
      onStatus((e as Error).message);
    }
  }
}

function pending(): string[] {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]') as string[]; } catch { return []; }
}
function rememberPending(h: string): void {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify([...new Set([...pending(), h])])); } catch { /* ignore */ }
}
function forgetPending(h: string): void {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(pending().filter((x) => x !== h))); } catch { /* ignore */ }
}

// ── Ranked voyages ──

export async function startRun(): Promise<{ runId: string; seed: number; v: number }> {
  const r = await api<{ runId: string; seed: number; v: number; error?: string }>('/api/run', {
    method: 'POST', body: { action: 'start', v: SIM_VERSION },
  });
  if (r.status !== 200) throw new Error(errorOf(r.data, 'Could not start a ranked voyage.'));
  return r.data;
}

export async function finishRun(runId: string, log: RunLogWire): Promise<{ score: number; best: boolean; rank: number | null }> {
  const zipped = await gzip(JSON.stringify(log));
  // A dropped connection here would cost a paid voyage — retry a few times.
  let last = 'Could not reach the server.';
  for (let i = 0; i < 4; i++) {
    try {
      const r = await api<{ score: number; best: boolean; rank: number | null }>('/api/run', {
        method: 'POST', body: { action: 'finish', runId, log: bytesToB64(zipped) },
      });
      if (r.status === 200) return r.data;
      if (r.status < 500) throw new Error(errorOf(r.data, 'Voyage not accepted.'));
      last = errorOf(r.data, last);
    } catch (e) {
      if (e instanceof Error && !(e instanceof TypeError)) throw e;
    }
    await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
  }
  throw new Error(last);
}

export async function fetchReplay(id: string): Promise<{ seed: number; score: number; addr: string; name: string | null; log: RunLogWire } | null> {
  try {
    const r = await api<{ seed: number; score: number; addr: string; name: string | null; log: RunLogWire }>(`/api/run?id=${encodeURIComponent(id)}`);
    return r.status === 200 ? r.data : null;
  } catch {
    return null;
  }
}

// ── Helpers ──

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function word(address: string): string {
  return address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function utf8Hex(s: string): string {
  return '0x' + [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whole tokens with up to two decimals, thousands-grouped. */
export function formatAmount(v: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const cents = ((v % base) * 100n) / base;
  const w = whole.toLocaleString('en-US');
  return cents > 0n ? `${w}.${cents.toString().padStart(2, '0').replace(/0$/, '')}` : w;
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
