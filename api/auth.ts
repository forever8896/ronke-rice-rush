// ═════════════════════════════════════════════════════════════
// POST /api/auth
//   { action: 'nonce',  address }                    → { nonce, message }
//   { action: 'verify', address, nonce, signature }  → { token, address }
//   { action: 'name',   name }  (signed in)          → { name }
// ═════════════════════════════════════════════════════════════

import { issueNonce, normAddress, verifySignIn, walletFrom } from './_lib/auth.js';
import { getChain } from './_lib/chain.js';
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
  await guard('auth', res, async () => {
    const b = body(req);
    const store = getStore();

    if (b.action === 'nonce') {
      const addr = normAddress(b.address);
      if (!addr) { res.status(400).json({ error: 'bad address' }); return; }
      res.status(200).json(await issueNonce(store, addr));
      return;
    }

    if (b.action === 'verify') {
      const addr = normAddress(b.address);
      if (!addr) { res.status(400).json({ error: 'bad address' }); return; }
      const token = await verifySignIn(store, cfg, getChain(cfg), addr, String(b.nonce ?? ''), String(b.signature ?? ''));
      if (!token) { res.status(401).json({ error: 'signature did not verify — try signing in again' }); return; }
      res.status(200).json({ token, address: addr });
      return;
    }

    if (b.action === 'name') {
      const addr = walletFrom(cfg, req.headers);
      if (!addr) { res.status(401).json({ error: 'sign in first' }); return; }
      const name = String(b.name ?? '').trim().slice(0, 14).replace(/[^\w \-.$!?]/g, '');
      if (name.length < 2) { res.status(400).json({ error: 'name needs at least 2 characters' }); return; }
      await store.set(`${P}name:${addr}`, name);
      res.status(200).json({ name });
      return;
    }

    res.status(400).json({ error: 'unknown action' });
  });
}
