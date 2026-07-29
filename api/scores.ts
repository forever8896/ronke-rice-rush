// ═════════════════════════════════════════════════════════════
// Leaderboard — one Vercel function, Upstash Redis sorted set.
// Reuses the KV store provisioned for the original Lick'em project
// (same KV_REST_API_URL / KV_REST_API_TOKEN env vars) under this
// game's own key. One entry per name; ZADD GT keeps the best score.
//
//   GET  /api/scores               → { rows: [{ name, score }] } top 10
//   POST /api/scores {name, score} → { ok, rank }
//
// If KV env vars are missing the endpoint 503s and the frontend
// simply hides the leaderboard — the game itself never depends on it
// (same graceful-degradation philosophy as the original).
// ═════════════════════════════════════════════════════════════

import { Redis } from '@upstash/redis';

// Minimal request/response shapes — Vercel's Node runtime provides
// these; self-typing avoids the heavyweight @vercel/node dev-dep.
interface Req {
  method?: string;
  body?: unknown;
}
interface Res {
  status(code: number): Res;
  json(data: unknown): void;
  setHeader(name: string, value: string): void;
}

const KEY = 'rrr:lb';
const TOP_N = 10;
// Sanity ceiling — a legit god-run sits well under this; anything
// above is someone poking the API with curl.
const MAX_SCORE = 500_000;

export default async function handler(req: Req, res: Res): Promise<void> {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    res.status(503).json({ error: 'leaderboard not configured' });
    return;
  }
  const redis = new Redis({ url, token });

  try {
    if (req.method === 'GET') {
      const raw = (await redis.zrange(KEY, 0, TOP_N - 1, {
        rev: true,
        withScores: true,
      })) as Array<string | number>;
      const rows: Array<{ name: string; score: number }> = [];
      for (let i = 0; i + 1 < raw.length; i += 2) {
        rows.push({ name: String(raw[i]), score: Number(raw[i + 1]) });
      }
      res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
      res.status(200).json({ rows });
      return;
    }

    if (req.method === 'POST') {
      const body = (req.body ?? {}) as { name?: unknown; score?: unknown };
      const clean = String(body.name ?? '')
        .trim()
        .slice(0, 14)
        .replace(/[^\w \-.$!?]/g, '');
      const score = Math.floor(Number(body.score));
      if (clean.length < 2 || !Number.isFinite(score) || score <= 0 || score > MAX_SCORE) {
        res.status(400).json({ error: 'bad name or score' });
        return;
      }
      // GT: only ever raise a name's score — resubmitting a worse run
      // can't clobber a best.
      await redis.zadd(KEY, { gt: true }, { score, member: clean });
      // Rank = how many entries score strictly higher, plus one.
      const above = await redis.zcount(KEY, `(${score}`, '+inf');
      res.status(200).json({ ok: true, rank: Number(above) + 1 });
      return;
    }

    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    console.error('[scores]', e);
    res.status(500).json({ error: 'leaderboard error' });
  }
}
