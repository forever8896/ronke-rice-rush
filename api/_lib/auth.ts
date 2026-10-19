// ═════════════════════════════════════════════════════════════
// Wallet sign-in. The player signs a one-time message with their
// Ronin wallet (free, moves nothing); we check the signature and hand
// back a session token — HMAC over (address, expiry), so no session
// table is needed. Every money or score action is bound to it.
// ═════════════════════════════════════════════════════════════

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { recoverMessageAddress } from 'viem';
import type { ChainReader } from './chain.js';
import type { Config } from './config.js';
import { P, type Store } from './store.js';

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const NONCE_TTL_S = 600;
const ADDR = /^0x[0-9a-f]{40}$/;

/** Ronin wallets show `ronin:abc…`; underneath it is the same 0x address. */
export function normAddress(raw: unknown): string | null {
  const s = String(raw ?? '').trim().toLowerCase().replace(/^ronin:/, '0x');
  return ADDR.test(s) ? s : null;
}

export function signInMessage(addr: string, nonce: string, issuedAt: string): string {
  return [
    'Ronke Boat Battle — sign in',
    '',
    `Wallet: ${addr}`,
    `Nonce: ${nonce}`,
    `Issued: ${issuedAt}`,
    '',
    'Signing is free and does not move any funds.',
  ].join('\n');
}

export async function issueNonce(store: Store, addr: string): Promise<{ nonce: string; message: string }> {
  const nonce = randomBytes(16).toString('hex');
  const message = signInMessage(addr, nonce, new Date().toISOString());
  await store.set(`${P}nonce:${nonce}`, JSON.stringify({ addr, message }), { ex: NONCE_TTL_S });
  return { nonce, message };
}

/** Returns a session token, or null if the signature doesn't check out. */
export async function verifySignIn(
  store: Store, cfg: Config, chain: ChainReader, addr: string, nonce: string, signature: string,
): Promise<string | null> {
  if (!/^[0-9a-f]{32}$/.test(nonce) || !/^0x[0-9a-fA-F]+$/.test(signature)) return null;
  const raw = await store.getdel<string | { addr: string; message: string }>(`${P}nonce:${nonce}`);
  if (!raw) return null;
  const rec = typeof raw === 'string' ? (JSON.parse(raw) as { addr: string; message: string }) : raw;
  if (rec.addr !== addr) return null;
  // The Ronin extension is a plain key: recover it locally, no node needed.
  try {
    const signer = await recoverMessageAddress({ message: rec.message, signature: signature as `0x${string}` });
    if (signer.toLowerCase() === addr) return makeToken(cfg, addr);
  } catch {
    // Not a plain 65-byte signature — fall through to the smart-account check.
  }
  // Stash (email login) may be a smart account; only the chain can vouch for it.
  const ok = await chain.contractSignatureValid(addr as `0x${string}`, rec.message, signature as `0x${string}`);
  return ok ? makeToken(cfg, addr) : null;
}

function mac(cfg: Config, body: string): string {
  return createHmac('sha256', cfg.authSecret).update(body).digest('base64url');
}

export function makeToken(cfg: Config, addr: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ a: addr, e: now + TOKEN_TTL_MS })).toString('base64url');
  return `${body}.${mac(cfg, body)}`;
}

/** The wallet a request is signed in as, or null. */
export function walletFrom(cfg: Config, headers: Record<string, string | string[] | undefined>): string | null {
  const h = headers.authorization ?? headers.Authorization;
  const auth = Array.isArray(h) ? h[0] : h;
  const m = /^Bearer ([\w-]+)\.([\w-]+)$/.exec(auth ?? '');
  if (!m) return null;
  const want = Buffer.from(mac(cfg, m[1]));
  const got = Buffer.from(m[2]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const { a, e } = JSON.parse(Buffer.from(m[1], 'base64url').toString()) as { a: string; e: number };
    if (typeof e !== 'number' || e < Date.now()) return null;
    return normAddress(a);
  } catch {
    return null;
  }
}
