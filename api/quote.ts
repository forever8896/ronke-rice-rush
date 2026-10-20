// ═════════════════════════════════════════════════════════════
// GET /api/quote?token=SYMBOL  (signed in)
//
// A signed entry price for a quoted token: the amount of it worth the
// same in USD, right now, as the anchor's fixed price (10 000 RONKE).
// Valid for this player only, for QUOTE_TTL_S. The escrow verifies the
// signature in enterQuoted(); see _lib/prices.ts.
// ═════════════════════════════════════════════════════════════

import { walletFrom } from './_lib/auth.js';
import { getChain } from './_lib/chain.js';
import { configOr503, guard, type Req, type Res } from './_lib/http.js';
import { entryPrices, signQuote } from './_lib/prices.js';

export default async function handler(req: Req, res: Res): Promise<void> {
  const cfg = configOr503(res);
  if (!cfg) return;
  await guard('quote', res, async () => {
    const addr = walletFrom(cfg, req.headers);
    if (!addr) { res.status(401).json({ error: 'sign in first' }); return; }
    const symbol = String(req.query?.token ?? '').toUpperCase();
    const token = cfg.tokens.find((t) => t.symbol === symbol);
    if (!token) { res.status(400).json({ error: 'unknown token' }); return; }

    const rules = await getChain(cfg).rules();
    if (!rules.quoted[symbol]) { res.status(400).json({ error: `${symbol} is not priced by quote` }); return; }
    const { prices } = await entryPrices(cfg, rules);
    const p = prices[symbol];
    if (!p.price || !p.usd) {
      res.status(503).json({ error: `no live ${symbol} price right now — try again in a minute, or enter with the anchor token` });
      return;
    }
    const quote = await signQuote(cfg, addr, token, p.price, p.usd);
    if (!quote) { res.status(503).json({ error: 'quotes are not configured' }); return; }
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).json(quote);
  });
}
