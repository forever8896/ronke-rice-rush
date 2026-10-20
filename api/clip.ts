// ═════════════════════════════════════════════════════════════
// Face clips for ranked voyages.
//
//   POST /api/clip  (Vercel Blob client-upload handshake, signed in)
//        issues an upload token for exactly one path — the run's own
//        clip — and only for a run the server marked as clip-worthy
//   POST /api/clip { action: 'done', runId, contentType, sync }  (signed in)
//        confirms the upload landed and records how to sync it
//   GET  /api/clip?run=<runId>  (tournament owner only)
//        a short-lived URL to watch it, plus the run's replay data
//
// See _lib/clips.ts for the policy: private store, owner-only viewing,
// deleted when the week is paid out.
// ═════════════════════════════════════════════════════════════

import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { walletFrom } from './_lib/auth.js';
import { getChain } from './_lib/chain.js';
import {
  CLIP_MAX_BYTES, CLIP_TYPES, clipPath, getClips, type ClipRecord, type ClipWanted,
} from './_lib/clips.js';
import { body, configOr503, guard, type Req, type Res } from './_lib/http.js';
import { getStore, P, type BestRun, type Store, type StoredLog } from './_lib/store.js';

const MAX_SYNC = 40_000;
const UPLOAD_WINDOW_MS = 30 * 60 * 1000;

export default async function handler(req: Req, res: Res): Promise<void> {
  const cfg = configOr503(res);
  if (!cfg) return;
  await guard('clip', res, async () => {
    const store = getStore();
    const addr = walletFrom(cfg, req.headers);

    if (req.method === 'GET') {
      if (!addr || addr !== (await getChain(cfg).rules()).owner) {
        res.status(403).json({ error: 'only the tournament owner can review clips' });
        return;
      }
      const runId = String(req.query?.run ?? '');
      if (!/^[0-9a-f]{32}$/.test(runId)) { res.status(400).json({ error: 'bad run id' }); return; }
      const [clip, run] = await Promise.all([
        store.get<ClipRecord>(`${P}clip:${runId}`),
        store.get<StoredLog>(`${P}log:${runId}`),
      ]);
      if (!run) { res.status(404).json({ error: 'no replay for that run' }); return; }
      const url = clip ? await getClips().viewUrl(clip.pathname) : null;
      const name = await store.get<string>(`${P}name:${run.addr}`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({ ...run, name, clip: clip ? { url, contentType: clip.contentType, sync: clip.sync, size: clip.size } : null });
      return;
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      res.status(405).json({ error: 'method not allowed' });
      return;
    }
    if (!addr) { res.status(401).json({ error: 'sign in first' }); return; }
    const b = body(req);

    // ── Blob client-upload handshake ──
    if (typeof b.type === 'string' && b.type.startsWith('blob.')) {
      const out = await handleUpload({
        body: b as unknown as HandleUploadBody,
        request: req as never,
        onBeforeGenerateToken: async (pathname, clientPayload) => {
          const { runId, contentType } = JSON.parse(clientPayload ?? '{}') as { runId?: string; contentType?: string };
          const want = await store.get<ClipWanted>(`${P}clipwant:${runId}`);
          if (!want || want.addr !== addr || !contentType || !CLIP_TYPES.includes(contentType)
            || !(await isCurrentBest(store, want, String(runId)))) {
            throw new Error('this voyage has no clip to upload');
          }
          // The token is good for this one path and nothing else.
          if (pathname !== clipPath(want.week, String(runId), contentType)) throw new Error('wrong clip path');
          return {
            allowedContentTypes: [contentType],
            maximumSizeInBytes: CLIP_MAX_BYTES,
            addRandomSuffix: false,
            allowOverwrite: true,
            validUntil: Date.now() + UPLOAD_WINDOW_MS,
          };
        },
      });
      res.status(200).json(out);
      return;
    }

    if (b.action === 'done') {
      const runId = String(b.runId ?? '');
      const contentType = String(b.contentType ?? '');
      if (!/^[0-9a-f]{32}$/.test(runId) || !CLIP_TYPES.includes(contentType)) {
        res.status(400).json({ error: 'bad clip' });
        return;
      }
      const want = await store.get<ClipWanted>(`${P}clipwant:${runId}`);
      if (!want || want.addr !== addr) { res.status(404).json({ error: 'this voyage has no clip to upload' }); return; }
      const sync = cleanSync(b.sync);
      if (!sync) { res.status(400).json({ error: 'bad clip timing' }); return; }
      const pathname = clipPath(want.week, runId, contentType);
      const clips = getClips();
      const size = await clips.size(pathname);
      if (!size) { res.status(409).json({ error: 'clip upload not found' }); return; }
      // A slow upload from an older best must never displace the newer best's clip.
      if (!(await isCurrentBest(store, want, runId))) {
        await clips.remove([pathname]);
        await store.del(`${P}clipwant:${runId}`);
        res.status(409).json({ error: 'you have a better run this week — its clip is the one that counts' });
        return;
      }

      const record: ClipRecord = { pathname, size, contentType, sync, at: Date.now() };
      await store.set(`${P}clip:${runId}`, JSON.stringify(record));
      await store.hset(`${P}cliplist:${want.week}`, { [runId]: pathname });
      await store.del(`${P}clipwant:${runId}`);

      // One clip per player per week: the best run's. The one it replaces goes.
      const prevKey = `${P}clipof:${want.week}:${addr}`;
      const prev = await store.get<string>(prevKey);
      await store.set(prevKey, runId);
      if (prev && prev !== runId) {
        const old = await store.get<ClipRecord>(`${P}clip:${prev}`);
        if (old) await clips.remove([old.pathname]);
        await store.del(`${P}clip:${prev}`);
      }
      res.status(200).json({ ok: true, size });
      return;
    }

    res.status(400).json({ error: 'unknown action' });
  });
}

async function isCurrentBest(store: Store, want: ClipWanted, runId: string): Promise<boolean> {
  const best = await store.get<BestRun>(`${P}best:${want.week}:${want.addr}`);
  return best?.runId === runId;
}

/** [[ms, step], …], both non-negative integers, both never going backwards. */
function cleanSync(raw: unknown): Array<[number, number]> | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SYNC) return null;
  const out: Array<[number, number]> = [];
  let lastT = -1;
  let lastS = -1;
  for (const p of raw) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const [t, s] = p.map(Number);
    if (!Number.isInteger(t) || !Number.isInteger(s) || t < lastT || s < lastS) return null;
    out.push([t, s]);
    lastT = t;
    lastS = s;
  }
  return out;
}
