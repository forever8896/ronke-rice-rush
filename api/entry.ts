// ═════════════════════════════════════════════════════════════
// POST /api/entry { txHash }  (signed in)
//
// Credit ranked voyages for an entry-fee payment. 202 while the tx is
// unmined or short of confirmations — the client polls. Each hash is
// credited once, ever, and only to the wallet that sent the tokens.
// Every unit paid goes into the pool; entries are floor(paid / price),
// so an overpayment still feeds the pool but buys no partial entry.
// ═════════════════════════════════════════════════════════════

import { walletFrom } from './_lib/auth.js';
import { checkPayment, getChain } from './_lib/chain.js';
import { body, configOr503, guard, type Req, type Res } from './_lib/http.js';
import { seasonOf } from './_lib/season.js';
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
    if (await store.get(txKey)) { res.status(409).json({ error: 'that payment was already credited' }); return; }

    const check = await checkPayment(getChain(cfg), cfg, hash as `0x${string}`, addr);
    if (check.kind === 'pending') { res.status(202).json({ pending: true }); return; }
    if (check.kind === 'rejected') { res.status(422).json({ error: check.reason }); return; }

    // Claim the hash before crediting anything, so two racing requests
    // can't both credit it.
    const claimed = await store.set(txKey, JSON.stringify({ addr, at: Date.now() }), { nx: true });
    if (claimed !== 'OK') { res.status(409).json({ error: 'that payment was already credited' }); return; }

    // Fees land in the week the block was mined — unless that week has
    // already been closed and paid out, in which case the current one.
    let season = seasonOf(check.paidAt);
    if (await store.get(`${P}closed:${season}`)) season = seasonOf(Date.now());

    let credited = 0;
    for (const { token, amount } of check.amounts) {
      await store.hset(`${P}pool:${season}:${token.symbol}`, { [hash]: amount.toString() });
      credited += Number(amount / token.price);
    }
    const entries = credited > 0
      ? await store.incrby(`${P}entries:${addr}`, credited)
      : Number((await store.get<number>(`${P}entries:${addr}`)) ?? 0);
    console.log(`[entry] ${addr} ${hash} season ${season} +${credited} entries`);
    res.status(200).json({ credited, entries, season });
  });
}
