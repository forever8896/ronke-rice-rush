// ═════════════════════════════════════════════════════════════
// GET /api/season — everything the tournament panel shows.
//
// The week's window; the escrow's own rules (prices, rake, split, owner)
// and live pools, read from the contract; what each place would take
// home right now; the board; last week's payout as the contract paid
// it; and — when signed in — the caller's entries and best run.
//
// `settle` is filled once last week can be settled and hasn't been:
// the winners and scores the owner's settle() call should carry.
// ═════════════════════════════════════════════════════════════

import { walletFrom } from './_lib/auth.js';
import { getChain, type OnChainRules } from './_lib/chain.js';
import type { ClipRecord } from './_lib/clips.js';
import { CHAINS } from './_lib/config.js';
import { configOr503, guard, type Req, type Res } from './_lib/http.js';
import { entryPrices } from './_lib/prices.js';
import { board, GRACE_MS, seasonEnd, seasonOf, seasonStart, splitPool } from './_lib/season.js';
import { getStore, P, type BestRun, type ClosedSeason } from './_lib/store.js';

const BOARD_N = 10;
const RULES_TTL_MS = 60_000;
const FRESH_MIN_MS = 3_000;
let rulesCache: { at: number; rules: OnChainRules } | null = null;

export default async function handler(req: Req, res: Res): Promise<void> {
  const cfg = configOr503(res);
  if (!cfg) return;
  await guard('season', res, async () => {
    const store = getStore();
    const chain = getChain(cfg);
    const now = Date.now();
    const season = seasonOf(now);

    // ?fresh=1 re-reads the contract at once (after an owner action), but
    // never more than every FRESH_MIN_MS, so it can't hammer the node.
    const fresh = req.query?.fresh === '1' && (!rulesCache || now - rulesCache.at > FRESH_MIN_MS);
    if (fresh || !rulesCache || now - rulesCache.at > RULES_TTL_MS) rulesCache = { at: now, rules: await chain.rules() };
    const rules = rulesCache.rules;
    const gross = await chain.pools(season);

    const rows = await board(store, season, BOARD_N);
    const names = rows.length
      ? await store.mget<Array<string | null>>(...rows.map((r) => `${P}name:${r.address}`))
      : [];
    const bests = rows.length
      ? await store.mget<Array<BestRun | null>>(...rows.map((r) => `${P}best:${season}:${r.address}`))
      : [];

    const { anchor, prices } = await entryPrices(cfg, rules);
    const tokens = cfg.tokens.map((t) => ({
      symbol: t.symbol,
      address: t.address,
      decimals: t.decimals,
      /** 'fixed' = the contract's price · 'quoted' = USD-equivalent, signed at entry · 'closed' */
      mode: prices[t.symbol].mode,
      // Exact for fixed; for quoted, the current estimate ('0' when no live price).
      price: (prices[t.symbol].price ?? 0n).toString(),
      usd: prices[t.symbol].usd,
      pool: (gross[t.symbol] ?? 0n).toString(),
      prizes: splitPool(gross[t.symbol] ?? 0n, rules.rakeBps, rules.split).places.map(String),
    }));

    // Last week, once the bell + grace has passed: either its payout, or
    // what the owner needs to send to settle it.
    const prev = season - 1;
    const last = await store.get<ClosedSeason>(`${P}closed:${prev}`);
    let settle: unknown = null;
    if (!last && now >= seasonEnd(prev) + GRACE_MS && !(await chain.settled(prev))) {
      const prevPools = await chain.pools(prev);
      if (Object.values(prevPools).some((v) => v > 0n)) {
        // Winners in board order — but only runs with a face clip. A run
        // above the last winner that has none is passed over, and said so.
        const rowsPrev = await board(store, prev, 20);
        const winners: Array<{ address: string; score: number; runId: string }> = [];
        const skipped: Array<{ address: string; score: number; reason: string }> = [];
        for (const r of rowsPrev) {
          if (winners.length >= rules.split.length) break;
          const best = await store.get<BestRun>(`${P}best:${prev}:${r.address}`);
          const clip = best ? await store.get<ClipRecord>(`${P}clip:${best.runId}`) : null;
          if (best && clip) winners.push({ address: r.address, score: r.score, runId: best.runId });
          else skipped.push({ address: r.address, score: r.score, reason: 'no face clip' });
        }
        if (winners.length) {
          settle = {
            week: prev,
            winners: winners.map((w) => w.address),
            scores: winners.map((w) => w.score),
            runs: winners.map((w) => w.runId),
            skipped,
          };
        }
      }
    }

    let me: unknown = null;
    const addr = walletFrom(cfg, req.headers);
    if (addr) {
      const [entries, name, best] = await Promise.all([
        store.get<number>(`${P}entries:${season}:${addr}`),
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
      chainId: cfg.chainId,
      rpc: CHAINS[cfg.chainId].rpc,
      explorer: cfg.explorer,
      tournament: cfg.tournament,
      owner: rules.owner,
      pendingOwner: rules.pendingOwner,
      feeRecipient: rules.feeRecipient,
      paused: rules.paused,
      anchor: anchor?.symbol ?? null,
      rakePercent: rules.rakeBps / 100,
      split: rules.split.map((b) => b / 100),
      tokens,
      board: rows.map((r, i) => ({ ...r, name: names[i] ?? null, runId: bests[i]?.runId ?? null })),
      last,
      settle,
      me,
    });
  });
}
