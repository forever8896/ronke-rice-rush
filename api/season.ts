// ═════════════════════════════════════════════════════════════
// GET /api/season — everything the tournament panel shows.
//
// The week's window, entry prices, the live pool per token and what
// each place would take home right now, the board, last week's payout
// sheet (with payment tx hashes once sent), and — when signed in —
// the caller's unspent entries and best run.
// ═════════════════════════════════════════════════════════════

import { walletFrom } from './_lib/auth.js';
import { configOr503, guard, type Req, type Res } from './_lib/http.js';
import { board, pools, seasonEnd, seasonOf, seasonStart, splitPool } from './_lib/season.js';
import { getStore, P, type BestRun, type ClosedSeason } from './_lib/store.js';

const BOARD_N = 10;

export default async function handler(req: Req, res: Res): Promise<void> {
  const cfg = configOr503(res);
  if (!cfg) return;
  await guard('season', res, async () => {
    const store = getStore();
    const now = Date.now();
    const season = seasonOf(now);

    const gross = await pools(store, cfg, season);
    const rows = await board(store, season, BOARD_N);
    const names = rows.length
      ? await store.mget<Array<string | null>>(...rows.map((r) => `${P}name:${r.address}`))
      : [];
    const bests = rows.length
      ? await store.mget<Array<BestRun | null>>(...rows.map((r) => `${P}best:${season}:${r.address}`))
      : [];

    const tokens = cfg.tokens.map((t) => {
      const s = splitPool(gross[t.symbol] ?? 0n, cfg);
      return {
        symbol: t.symbol,
        address: t.address,
        decimals: t.decimals,
        price: t.price.toString(),
        pool: (gross[t.symbol] ?? 0n).toString(),
        prizes: s.places.map(String),
      };
    });

    const last = await store.get<ClosedSeason>(`${P}closed:${season - 1}`);

    let me: unknown = null;
    const addr = walletFrom(cfg, req.headers);
    if (addr) {
      const [entries, name, best] = await Promise.all([
        store.get<number>(`${P}entries:${addr}`),
        store.get<string>(`${P}name:${addr}`),
        store.get<BestRun>(`${P}best:${season}:${addr}`),
      ]);
      let rank: number | null = null;
      const mine = await store.zscore(`${P}lb:${season}`, addr);
      if (mine !== null && mine !== undefined) {
        rank = Number(await store.zcount(`${P}lb:${season}`, `(${mine}`, '+inf')) + 1;
      }
      me = { address: addr, entries: Number(entries ?? 0), name, best: best?.score ?? null, rank };
    }

    res.setHeader('Cache-Control', addr ? 'private, no-store' : 's-maxage=5, stale-while-revalidate=20');
    res.status(200).json({
      season,
      startsAt: seasonStart(season),
      endsAt: seasonEnd(season),
      treasury: cfg.treasury,
      chainId: 2020,
      rakePercent: cfg.rakePercent,
      split: cfg.split,
      tokens,
      board: rows.map((r, i) => ({
        ...r,
        name: names[i] ?? null,
        runId: bests[i]?.runId ?? null,
      })),
      last,
      me,
    });
  });
}
