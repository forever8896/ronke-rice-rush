// ═════════════════════════════════════════════════════════════
// POST /api/settled { txHash }
//
// Record a week's payout from the settle() transaction itself. Anyone
// may post the hash — nothing here is taken on trust: the winners and
// amounts are read from the escrow's own events in the receipt, so the
// page can only ever show what the contract actually paid.
// ═════════════════════════════════════════════════════════════

import { getChain, readSettlement } from './_lib/chain.js';
import { body, configOr503, guard, type Req, type Res } from './_lib/http.js';
import { getStore, P, type ClosedSeason } from './_lib/store.js';

export default async function handler(req: Req, res: Res): Promise<void> {
  const cfg = configOr503(res);
  if (!cfg) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  await guard('settled', res, async () => {
    const hash = String(body(req).txHash ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hash)) { res.status(400).json({ error: 'bad transaction hash' }); return; }
    const s = await readSettlement(getChain(cfg), cfg, hash as `0x${string}`);
    if (!s) { res.status(202).json({ pending: true }); return; }

    const symbolOf = (addr: string): string => cfg.tokens.find((t) => t.address === addr)?.symbol ?? addr;
    const sheet: ClosedSeason = {
      season: s.week,
      closedAt: Date.now(),
      tx: hash,
      payouts: s.prizes.map((p) => ({
        rank: p.place, address: p.winner, symbol: symbolOf(p.token), amount: p.amount.toString(), paidTx: hash,
      })),
      operator: Object.fromEntries(s.rake.map((r) => [symbolOf(r.token), r.amount.toString()])),
    };
    await getStore().set(`${P}closed:${s.week}`, JSON.stringify(sheet));
    res.status(200).json({ week: s.week, payouts: sheet.payouts.length });
  });
}
