// ═════════════════════════════════════════════════════════════
// Weekly tournament client — Ronin wallet, entry fees, ranked runs.
//
// The wallet does three things and nothing else: sign a free sign-in
// message, pay the entry fee into the tournament escrow,
// and identify who is on the board. Two ways in, the same pair the
// Ronkeverse site uses: the Ronin Wallet (extension, or the Ronin app's
// browser) through Sky Mavis's own tanto-connect, and Ronin Stash for
// email login. Both end as an EIP-1193 provider, so nothing below the
// connect step knows which was used.
//
// Entry fees go into the RonkeTournament escrow contract, never to the
// operator: approve, then enter(). The contract alone pays winners and
// its fixed rake when the owner settles a week, and refunds every
// entrant if a week is never settled. Nothing here can move a player's
// funds except the two transactions they approve in their own wallet.
//
// Every entry hash is parked in localStorage until the server has
// credited it, so a closed tab or a slow block never loses an entry.
// ═════════════════════════════════════════════════════════════

import { requestRoninWalletConnector, type RoninWalletConnector } from '@sky-mavis/tanto-connect';
import type { FaceClip } from './faceclip';
import type { RunLogWire } from './runlog';
import { bytesToB64 } from './runlog';
import { SIM_VERSION } from './sim';

const SESSION_KEY = 'ronke:session';
const PENDING_KEY = 'ronke:pendingTx';

/** Which network the tournament lives on. Told by the server, mainnet until then. */
const chain = { id: 2020, rpc: 'https://api.roninchain.com/rpc', explorer: 'https://app.roninchain.com' };
export const explorer = (): string => chain.explorer;

export interface TokenInfo {
  symbol: string;
  address: string;
  decimals: number;
  /** fixed = the contract's price · quoted = USD-equivalent of the anchor, signed at entry */
  mode: 'fixed' | 'quoted' | 'closed';
  /** Per entry, base units. Exact if fixed, the current estimate if quoted. */
  price: string;
  usd: number | null;
  pool: string;
  prizes: string[];
}

export interface SeasonInfo {
  season: number;
  startsAt: number;
  endsAt: number;
  chainId: number;
  rpc: string;
  explorer: string;
  /** The escrow contract. Where fees go and prizes come from. */
  tournament: string;
  owner: string;
  pendingOwner: string;
  feeRecipient: string;
  paused: boolean;
  /** The fixed-price token every other price is the USD equivalent of. */
  anchor: string | null;
  /** Dollars per entry when the tournament is priced in USD. */
  entryUsd: number | null;
  /** Tokens still fixed-priced on chain that should move to quotes. */
  pricingTodo: Array<{ symbol: string; address: string }>;
  rakePercent: number;
  split: number[];
  tokens: TokenInfo[];
  board: Array<{ rank: number; address: string; score: number; name: string | null; runId: string | null }>;
  last: {
    season: number;
    tx: string;
    payouts: Array<{ rank: number; address: string; symbol: string; amount: string; paidTx?: string }>;
  } | null;
  /** Last week, ready for the owner's settle() call. Winners with a face clip only. */
  settle: {
    week: number;
    winners: string[];
    scores: number[];
    runs: string[];
    skipped: Array<{ address: string; score: number; reason: string }>;
  } | null;
  me: { address: string; entries: number; name: string | null; best: number | null; rank: number | null } | null;
}

export type WalletVia = 'extension' | 'stash';

interface Session { token: string; address: string; via?: WalletVia }

interface Eip1193 {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

/**
 * Ronin Stash (email login). OFF by default: Stash's transaction page
 * currently rejects this game's mainnet requests ("Chain ID 2020 is not
 * supported"), so an email player could sign in but never pay an entry.
 * Turn it back on with VITE_STASH_APP_ID=cmpkwmb7l001c0bjp3sdn6n8e (Ronin
 * Stash's Privy app id) once that works. Ronin Waypoint is deliberately
 * absent: Sky Mavis deprecated it.
 */
const STASH_APP_ID: string = import.meta.env.VITE_STASH_APP_ID ?? '';

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

/** `fresh` asks the server to re-read the contract instead of its 60 s cache. */
export async function fetchSeason(fresh = false): Promise<SeasonInfo | null> {
  try {
    const r = await api<SeasonInfo>(fresh ? '/api/season?fresh=1' : '/api/season');
    // Anything but a real season (an SPA fallback page, a proxy error)
    // means no tournament — never a half-drawn one.
    const ok = r.status === 200 && Number.isInteger(r.data?.season)
      && Array.isArray(r.data.tokens) && Array.isArray(r.data.board) && /^0x[0-9a-f]{40}$/.test(r.data.tournament);
    if (!ok) return null;
    chain.id = r.data.chainId;
    chain.rpc = r.data.rpc;
    chain.explorer = r.data.explorer;
    return r.data;
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
      id: chain.id,
      name: chain.id === 2020 ? 'Ronin' : 'Saigon',
      nativeCurrency: { name: 'RON', symbol: 'RON', decimals: 18 },
      rpcUrls: { default: { http: [chain.rpc] } },
    }],
    chainId: chain.id,
  }) as unknown as Eip1193;
  return stash;
}

export interface WalletOptions { extension: boolean; email: boolean }

/** Which ways in this browser has. */
export async function walletOptions(): Promise<WalletOptions> {
  return { extension: !!(await roninConnector()), email: !!STASH_APP_ID };
}

/**
 * A provider for `via`, connected and on the tournament's network, plus
 * the address it is acting as.
 */
async function wallet(via: WalletVia): Promise<{ p: Eip1193; address: string }> {
  let p: Eip1193;
  let account: string | undefined;
  if (via === 'stash') {
    const sp = await stashProvider();
    if (!sp) {
      throw new Error('Email wallets can\'t pay entries yet. Sign out, then connect with the Ronin Wallet extension or the Ronin app.');
    }
    p = sp;
    // Privy's cross-app provider runs the email login inside the first
    // eth_requestAccounts and then resolves with *nothing*; only later
    // calls answer with the address. So ask again once it's connected.
    const first = (await p.request({ method: 'eth_requestAccounts' })) as string[] | undefined;
    account = first?.[0];
    if (!account) {
      const after = (await p.request({ method: 'eth_accounts' })) as string[] | undefined;
      account = after?.[0];
    }
  } else {
    const c = await roninConnector();
    if (!c) throw new Error('No Ronin Wallet found. Install the extension, open this page in the Ronin app, or continue with email.');
    // connect() is a no-op prompt when the site is already authorised,
    // and asks the wallet to move networks if it's elsewhere.
    const r = await c.connect(chain.id);
    account = r.account;
    if (r.chainId !== chain.id) await c.switchChain(chain.id);
    p = r.provider as unknown as Eip1193;
  }
  const address = String(account ?? '').toLowerCase().replace(/^ronin:/, '0x');
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    throw new Error(via === 'stash'
      ? 'The email login didn\'t finish. Complete it in the Ronin Stash window (allow pop-ups for this site), then try again.'
      : 'The wallet did not share an address.');
  }
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

/** The signed-in wallet, re-connected. Never a different one. */
async function sessionWallet(): Promise<{ p: Eip1193; address: string }> {
  const s = session();
  if (!s) throw new Error('Sign in first.');
  const w = await wallet(s.via ?? 'extension');
  if (s.address !== w.address) throw new Error('Your wallet switched accounts. Sign out and sign in again.');
  return w;
}

interface Quote { unitPrice: string; expiry: number; signature: string; usd: number }

/**
 * Buy one entry in `token`: approve the escrow for exactly the price
 * (skipped if an allowance already covers it), then enter() — or, for a
 * quoted token, fetch a fresh signed quote first and enterQuoted().
 * Resolves once the server has credited it; `onStatus` narrates the wait.
 */
export async function buyEntry(
  info: SeasonInfo, token: TokenInfo, onStatus: (msg: string) => void,
): Promise<number> {
  const { p, address } = await sessionWallet();
  let quote: Quote | null = null;
  if (token.mode === 'quoted') {
    onStatus(`Getting today's ${token.symbol} price…`);
    const q = await api<Quote>(`/api/quote?token=${encodeURIComponent(token.symbol)}`);
    if (q.status !== 200) throw new Error(errorOf(q.data, `No ${token.symbol} price right now.`));
    quote = q.data;
  } else if (token.mode !== 'fixed') {
    throw new Error(`${token.symbol} entries are not open right now.`);
  }
  const price = BigInt(quote ? quote.unitPrice : token.price);
  if (price === 0n) throw new Error(`${token.symbol} entries are not open right now.`);
  const call = async (to: string, data: string): Promise<bigint> =>
    BigInt(String(await p.request({ method: 'eth_call', params: [{ to, data }, 'latest'] })));

  const bal = await call(token.address, `0x70a08231${word(address)}`);
  if (bal < price) {
    throw new Error(`You need ${formatAmount(price, token.decimals)} ${token.symbol}. This wallet has ${formatAmount(bal, token.decimals)}.`);
  }

  // allowance(player, escrow)
  const allowed = await call(token.address, `0xdd62ed3e${word(address)}${word(info.tournament)}`);
  if (allowed < price) {
    onStatus(`Step 1 of 2: approve ${formatAmount(price, token.decimals)} ${token.symbol} for the tournament contract…`);
    const approveHash = await send(p, address, token.address, `0x095ea7b3${word(info.tournament)}${uint(price)}`);
    onStatus('Step 1 of 2: waiting for the approval to confirm…');
    await waitForReceipt(p, approveHash);
  }

  if (quote && quote.expiry * 1000 < Date.now() + 30_000) {
    throw new Error('The price quote ran out while waiting. Press enter again for a fresh one.');
  }
  onStatus(allowed < price ? 'Step 2 of 2: confirm the entry in your wallet…' : 'Confirm the entry in your wallet…');
  const data = quote
    ? enterQuotedCalldata(token.address, 1, price, quote.expiry, quote.signature)
    : `0x7e348b7d${word(token.address)}${uint(1n)}`; // enter(token, 1)
  const hash = await send(p, address, info.tournament, data);
  rememberPending(hash);
  onStatus('Entry sent. Waiting for Ronin to confirm…');
  return creditPayment(hash, onStatus);
}

/** A read straight from the Ronin node, never through the wallet. */
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(chain.rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await r.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? `${method} failed`);
  return body.result as T;
}

/**
 * Send a transaction the way wagmi does: gas estimated up front against
 * the Ronin node. Ronin Stash's confirmation page hangs on a request
 * without gas, and estimating here also turns "this would fail" and
 * "no RON for gas" into plain messages instead of a stuck window.
 */
async function send(p: Eip1193, from: string, to: string, data: string): Promise<string> {
  const call = { from, to, data, value: '0x0' };
  let gas: bigint;
  try {
    gas = (BigInt(await rpc<string>('eth_estimateGas', [call])) * 125n) / 100n;
  } catch (e) {
    const why = (e as Error).message.replace(/^execution reverted:?\s*/i, '');
    throw new Error(`This transaction would fail${why ? ` (${why})` : ''}. Nothing was sent.`);
  }
  const [balance, gasPrice] = await Promise.all([
    rpc<string>('eth_getBalance', [from, 'latest']).then(BigInt),
    rpc<string>('eth_gasPrice', []).then(BigInt),
  ]);
  if (balance < gas * gasPrice) {
    const need = Number(gas * gasPrice) / 1e18;
    throw new Error(`Your wallet needs a little RON for gas (about ${need.toFixed(4)} RON). Top it up, then try again.`);
  }
  // Exactly the shape viem/wagmi send for a wallet-held account (what the
  // Ronke casino's working Stash integration sends): no chainId — Privy
  // fills it in as a number, and a hex chainId leaves Stash's page dead —
  // and no zero `value`.
  const tx = { from, to, data, gas: `0x${gas.toString(16)}` };
  return String(await p.request({ method: 'eth_sendTransaction', params: [tx] }));
}

/** Wait for a tx to be mined; throws if it reverted. */
async function waitForReceipt(_p: Eip1193, hash: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const r = await rpc<{ status?: string } | null>('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (r?.status) {
      if (Number(r.status) !== 1) throw new Error('That transaction failed on chain. Nothing was charged beyond gas.');
      return;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error('The transaction is taking a long time to confirm. Try again in a minute.');
}

// ── Owner ──
// The two calls only the escrow's owner can make. The contract checks
// that itself; these just build the transaction.

/** Pay out last week: the escrow sends the prizes and the rake. */
export async function settleWeek(info: SeasonInfo, onStatus: (msg: string) => void): Promise<string> {
  const plan = info.settle;
  if (!plan) throw new Error('Nothing to settle right now.');
  const { p, address } = await sessionWallet();
  if (address !== info.owner) throw new Error('Only the tournament owner can settle.');
  onStatus(`Confirm settling week ${plan.week} in your wallet…`);
  const hash = await send(p, address, info.tournament, settleCalldata(plan.week, plan.winners, plan.scores));
  onStatus('Settling. Waiting for Ronin to confirm…');
  await waitForReceipt(p, hash);
  for (let i = 0; i < 20; i++) {
    const r = await api('/api/settled', { method: 'POST', body: { txHash: hash } });
    if (r.status === 200) return hash;
    await new Promise((res) => setTimeout(res, 3000));
  }
  return hash;
}

/** Open or pause new entries. Settling and refunds are never affected. */
export async function setEntriesPaused(info: SeasonInfo, paused: boolean): Promise<string> {
  const { p, address } = await sessionWallet();
  if (address !== info.owner) throw new Error('Only the tournament owner can do that.');
  const hash = await send(p, address, info.tournament, `0xa4cd4b71${uint(paused ? 1n : 0n)}`);
  await waitForReceipt(p, hash);
  return hash;
}

/**
 * Move a token from a fixed on-chain price to signed dollar quotes:
 * setQuoted(token, true), then setPrice(token, 0). Two wallet prompts.
 */
export async function switchToQuoted(info: SeasonInfo, token: string, onStatus: (msg: string) => void): Promise<string> {
  const { p, address } = await sessionWallet();
  if (address !== info.owner) throw new Error('Only the tournament owner can do that.');
  onStatus('Step 1 of 2: allow dollar quotes for this token…');
  const a = await send(p, address, info.tournament, `0xbef99b3c${word(token)}${uint(1n)}`);
  await waitForReceipt(p, a);
  onStatus('Step 2 of 2: remove its fixed price…');
  const b = await send(p, address, info.tournament, `0x00e4768b${word(token)}${uint(0n)}`);
  await waitForReceipt(p, b);
  return b;
}

/** Second half of the two-step ownership hand-over. */
export async function acceptOwnership(info: SeasonInfo): Promise<string> {
  const { p, address } = await sessionWallet();
  if (address !== info.pendingOwner) throw new Error('This wallet has not been offered ownership.');
  const hash = await send(p, address, info.tournament, '0x79ba5097');
  await waitForReceipt(p, hash);
  return hash;
}

/** ABI-encode enterQuoted(address, uint256, uint256, uint256, bytes). */
export function enterQuotedCalldata(token: string, count: number, unitPrice: bigint, expiry: number, signature: string): string {
  const sig = signature.replace(/^0x/, '');
  const len = sig.length / 2;
  return '0x8665d0c7'
    + word(token) + uint(BigInt(count)) + uint(unitPrice) + uint(BigInt(expiry))
    + uint(160n) // offset of the bytes argument: five head words
    + uint(BigInt(len)) + sig.padEnd(Math.ceil(len / 32) * 64, '0');
}

/** ABI-encode settle(uint256, address[], uint256[]). */
export function settleCalldata(week: number, winners: string[], scores: number[]): string {
  const n = winners.length;
  const head = 3 * 32;
  const winnersAt = head;
  const scoresAt = head + 32 + n * 32;
  return '0xde030637'
    + uint(BigInt(week)) + uint(BigInt(winnersAt)) + uint(BigInt(scoresAt))
    + uint(BigInt(n)) + winners.map(word).join('')
    + uint(BigInt(n)) + scores.map((x) => uint(BigInt(x))).join('');
}

/** Poll the server until a payment is credited (or definitively refused). */
async function creditPayment(hash: string, onStatus: (msg: string) => void): Promise<number> {
  for (let i = 0; i < 40; i++) {
    const r = await api<{ entries: number; error?: string }>('/api/entry', { method: 'POST', body: { txHash: hash } });
    if (r.status === 200) { forgetPending(hash); return r.data.entries; }
    if (r.status === 409) { forgetPending(hash); throw new Error('That entry was already credited.'); }
    if (r.status === 422 || r.status === 400) { forgetPending(hash); throw new Error(errorOf(r.data, 'Payment not accepted.')); }
    if (r.status === 401) throw new Error('Signed out. Sign in again; your payment is saved and will be credited.');
    if (i === 6) onStatus('Still confirming. This can take a minute…');
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
      onStatus('An earlier entry has been credited.');
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

export interface FinishResult {
  score: number;
  best: boolean;
  rank: number | null;
  /** This run should upload its face clip. */
  clip: boolean;
  week: number;
}

export async function finishRun(runId: string, log: RunLogWire): Promise<FinishResult> {
  const zipped = await gzip(JSON.stringify(log));
  // A dropped connection here would cost a paid voyage — retry a few times.
  let last = 'Could not reach the server.';
  for (let i = 0; i < 4; i++) {
    try {
      const r = await api<FinishResult>('/api/run', {
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

/**
 * Upload a run's face clip straight to the private clip store (the
 * server only hands out a token for this one file), then confirm it.
 */
export async function uploadClip(
  runId: string, week: number, clip: FaceClip, onProgress: (pct: number) => void,
): Promise<void> {
  const s = session();
  if (!s) throw new Error('Signed out before the clip could upload.');
  const { upload } = await import('@vercel/blob/client');
  const ext = clip.contentType === 'video/mp4' ? 'mp4' : 'webm';
  await upload(`clips/${week}/${runId}.${ext}`, clip.blob, {
    access: 'private',
    handleUploadUrl: '/api/clip',
    headers: { Authorization: `Bearer ${s.token}` },
    clientPayload: JSON.stringify({ runId, contentType: clip.contentType }),
    contentType: clip.contentType,
    multipart: clip.blob.size > 8 * 1024 * 1024,
    onUploadProgress: (e) => onProgress(e.percentage),
  });
  const r = await api('/api/clip', {
    method: 'POST', body: { action: 'done', runId, contentType: clip.contentType, sync: clip.sync, pose: clip.pose, calib: clip.calib },
  });
  if (r.status !== 200) throw new Error(errorOf(r.data, 'The clip uploaded but could not be confirmed.'));
}

export interface ReviewData {
  seed: number;
  score: number;
  addr: string;
  name: string | null;
  log: RunLogWire;
  clip: {
    url: string;
    contentType: string;
    sync: Array<[number, number]>;
    /** [ms, headX×1000, roll mrad, jaw×1000]; headX -1 = no face. */
    pose: Array<[number, number, number, number]>;
    calib: { headX: number; roll: number } | null;
    size: number;
  } | null;
}

/** Owner only: a run's replay plus a short-lived link to its face clip. */
export async function fetchReview(runId: string): Promise<ReviewData> {
  const r = await api<ReviewData>(`/api/clip?run=${encodeURIComponent(runId)}`);
  if (r.status !== 200) throw new Error(errorOf(r.data, 'Could not load that run.'));
  return r.data;
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

function uint(v: bigint): string {
  return v.toString(16).padStart(64, '0');
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
