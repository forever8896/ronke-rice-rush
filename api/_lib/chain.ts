// ═════════════════════════════════════════════════════════════
// Entry fees, checked against the chain — never against the client.
//
// The player sends an ordinary ERC-20 transfer of RONKE/RONKA to the
// treasury from their own wallet and gives us the tx hash. We read the
// receipt from Ronin and count only Transfer events that:
//   • were emitted by a configured entry-token contract,
//   • moved tokens FROM the signed-in wallet (so nobody can claim a
//     payment someone else made),
//   • moved them TO the treasury,
//   • are in a successful tx with enough confirmations on top.
// The hash is then burned in Redis so it can't be credited twice.
// ═════════════════════════════════════════════════════════════

import { createPublicClient, http } from 'viem';
import type { Config, EntryToken } from './config.js';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface ReceiptLike {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  logs: Array<{ address: string; topics: readonly string[]; data: string }>;
}

/** What the payment and sign-in checks need from a node — tests pass a fake. */
export interface ChainReader {
  receipt(hash: `0x${string}`): Promise<ReceiptLike | null>;
  blockNumber(): Promise<bigint>;
  blockTime(n: bigint): Promise<number>;
  /**
   * A smart-account signature, which can't be recovered from — the
   * account answers for itself (ERC-1271), or for an account not yet
   * deployed, the wrapped signature carries its own deployment (ERC-6492).
   */
  contractSignatureValid(address: `0x${string}`, message: string, signature: `0x${string}`): Promise<boolean>;
}

let reader: ChainReader | null = null;

export function getChain(cfg: Config): ChainReader {
  if (reader) return reader;
  const client = createPublicClient({ transport: http(cfg.rpcUrl, { timeout: 8000 }) });
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
    async blockTime(n) {
      const b = await client.getBlock({ blockNumber: n });
      return Number(b.timestamp) * 1000;
    },
    async contractSignatureValid(address, message, signature) {
      try {
        return await client.verifyMessage({ address, message, signature });
      } catch {
        return false;
      }
    },
  };
  return reader;
}

export function setChain(c: ChainReader): void {
  reader = c;
}

export type PaymentCheck =
  | { kind: 'pending' }
  | { kind: 'rejected'; reason: string }
  | { kind: 'ok'; paidAt: number; amounts: Array<{ token: EntryToken; amount: bigint }> };

function topicAddr(t: string | undefined): string {
  return t ? `0x${t.slice(-40)}`.toLowerCase() : '';
}

export async function checkPayment(
  chain: ChainReader, cfg: Config, hash: `0x${string}`, payer: string,
): Promise<PaymentCheck> {
  const r = await chain.receipt(hash);
  if (!r) return { kind: 'pending' };
  if (r.status !== 'success') return { kind: 'rejected', reason: 'transaction reverted' };
  const head = await chain.blockNumber();
  if (head - r.blockNumber + 1n < BigInt(cfg.confirmations)) return { kind: 'pending' };

  const totals = new Map<EntryToken, bigint>();
  for (const log of r.logs) {
    const token = cfg.tokens.find((t) => t.address === log.address.toLowerCase());
    if (!token || log.topics[0] !== TRANSFER || log.topics.length !== 3) continue;
    if (topicAddr(log.topics[1]) !== payer || topicAddr(log.topics[2]) !== cfg.treasury) continue;
    const value = BigInt(log.data);
    totals.set(token, (totals.get(token) ?? 0n) + value);
  }
  if (totals.size === 0) {
    return { kind: 'rejected', reason: 'no entry-token transfer from your wallet to the treasury in that transaction' };
  }
  const paidAt = await chain.blockTime(r.blockNumber);
  return { kind: 'ok', paidAt, amounts: [...totals].map(([token, amount]) => ({ token, amount })) };
}
