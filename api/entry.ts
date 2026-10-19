// ═════════════════════════════════════════════════════════════
// POST /api/entry { txHash }  (signed in)
//
// Credit ranked voyages for an enter() call on the tournament escrow.
// 202 while the tx is unmined or short of confirmations — the client
// polls. Each hash is credited once, ever, and only to the wallet the
// contract recorded as the player. Entries belong to the week the
// contract put the fee in, which is the week they can be sailed in.
// ═════════════════════════════════════════════════════════════

import { walletFrom } from './_lib/auth.js';
import { checkEntry, getChain } from './_lib/chain.js';
import { body, configOr503, guard, type Req, type Res } from './_lib/http.js';
import { getStore, P } from './_lib/store.js';

export default async function handler(req: Req, res: Res): Promise<void> {
  const cfg = configOr503(res);
  if (!cfg) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  await guard('entry', res, async () => {
    const addr = walletFrom(cfg, req.headers);
    if (!addr) { res.status(401).json({ error: 'sign in first' }); return; }
    const hash = String(body(req).txHash ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hash)) { res.status(400).json({ error: 'bad transaction hash' }); return; }

    const store = getStore();
    const txKey = `${P}tx:${hash}`;
    if (await store.get(txKey)) { res.status(409).json({ error: 'that entry was already credited' }); return; }

    const check = await checkEntry(getChain(cfg), cfg, hash as `0x${string}`, addr);
    if (check.kind === 'pending') { res.status(202).json({ pending: true }); return; }
    if (check.kind === 'rejected') { res.status(422).json({ error: check.reason }); return; }

    // Claim the hash before crediting, so two racing requests can't both credit it.
    const claimed = await store.set(txKey, JSON.stringify({ addr, at: Date.now() }), { nx: true });
    if (claimed !== 'OK') { res.status(409).json({ error: 'that entry was already credited' }); return; }

    const credited = check.entries.reduce((n, e) => n + e.count, 0);
    const entries = await store.incrby(`${P}entries:${check.week}:${addr}`, credited);
    console.log(`[entry] ${addr} ${hash} week ${check.week} +${credited}`);
    res.status(200).json({ credited, entries, week: check.week });
  });
}
