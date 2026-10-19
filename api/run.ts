// ═════════════════════════════════════════════════════════════
// Ranked voyages.
//
//   POST /api/run { action: 'start' }                 (signed in)
//        spends one entry, deals { runId, seed, v }
//   POST /api/run { action: 'finish', runId, log }    (signed in)
//        log = base64(gzip(JSON RunLogWire))
//        → { score, best, rank }
//   GET  /api/run?id=<runId>
//        the stored log of a run that set a best — anyone can watch it
//
// The score the client saw is never sent, let alone trusted. The
// server replays the dealt seed against the logged inputs and the
// sim's own end-of-voyage score is what goes on the board. On top:
//   • a ticket is single-use and bound to the wallet that bought it,
//   • the voyage can't have been sailed faster than real time,
//   • it must actually have ended (hull lost, or the 60-minute cap),
//   • a finished run must arrive before the week's grace period ends.
// ═════════════════════════════════════════════════════════════

import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { SIM_VERSION, STEP_MS } from '../src/sim.js';
import { decodeInputs, replay, b64ToBytes, type RunLogWire } from '../src/runlog.js';
import { walletFrom } from './_lib/auth.js';
import { reviewFlags } from './_lib/checks.js';
import { body, configOr503, guard, type Req, type Res } from './_lib/http.js';
import { composite, GRACE_MS, seasonEnd, seasonOf } from './_lib/season.js';
import { getStore, P, type BestRun, type RunTicket, type StoredLog } from './_lib/store.js';

const TICKET_TTL_S = 3 * 60 * 60;
const LOG_TTL_S = 90 * 24 * 60 * 60;
/** Decompressed log ceiling — a full 60-minute voyage is ~1.3 MB. */
const MAX_LOG_BYTES = 4 * 1024 * 1024;
/** Real time may trail game time by this much (rounding, the bank). */
const PACE_SLACK_MS = 1500;

export default async function handler(req: Req, res: Res): Promise<void> {
  const cfg = configOr503(res);
  if (!cfg) return;
  await guard('run', res, async () => {
    const store = getStore();

    if (req.method === 'GET') {
      const id = String(req.query?.id ?? '');
      if (!/^[0-9a-f]{32}$/.test(id)) { res.status(400).json({ error: 'bad run id' }); return; }
      const stored = await store.get<StoredLog>(`${P}log:${id}`);
      if (!stored) { res.status(404).json({ error: 'no replay for that run' }); return; }
      const name = await store.get<string>(`${P}name:${stored.addr}`);
      res.setHeader('Cache-Control', 's-maxage=3600');
      res.status(200).json({ ...stored, name });
      return;
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      res.status(405).json({ error: 'method not allowed' });
      return;
    }

    const addr = walletFrom(cfg, req.headers);
    if (!addr) { res.status(401).json({ error: 'sign in first' }); return; }
    const b = body(req);

    if (b.action === 'start') {
      // Checked before the entry is spent: a stale page must not burn one.
      if (b.v !== SIM_VERSION) {
        res.status(409).json({ error: 'the game has been updated — reload the page to sail ranked' });
        return;
      }
      const now = Date.now();
      const left = await store.decr(`${P}entries:${addr}`);
      if (left < 0) {
        await store.incr(`${P}entries:${addr}`);
        res.status(402).json({ error: 'no entries left — buy one to sail a ranked voyage' });
        return;
      }
      const runId = randomBytes(16).toString('hex');
      const seed = randomBytes(4).readUInt32LE(0);
      const ticket: RunTicket = { addr, seed, season: seasonOf(now), startedAt: now, v: SIM_VERSION };
      await store.set(`${P}run:${runId}`, JSON.stringify(ticket), { ex: TICKET_TTL_S });
      res.status(200).json({ runId, seed, v: SIM_VERSION, entries: left });
      return;
    }

    if (b.action === 'finish') {
      const runId = String(b.runId ?? '');
      if (!/^[0-9a-f]{32}$/.test(runId)) { res.status(400).json({ error: 'bad run id' }); return; }
      const peek = await store.get<RunTicket | string>(`${P}run:${runId}`);
      const owner = typeof peek === 'string' ? (JSON.parse(peek) as RunTicket).addr : peek?.addr;
      if (owner && owner !== addr) { res.status(403).json({ error: 'that voyage belongs to another wallet' }); return; }
      // Single use: whatever happens next, this ticket is gone.
      const raw = await store.getdel<RunTicket | string>(`${P}run:${runId}`);
      if (!raw) { res.status(404).json({ error: 'voyage ticket not found or already used' }); return; }
      const ticket = typeof raw === 'string' ? (JSON.parse(raw) as RunTicket) : raw;
      if (ticket.v !== SIM_VERSION) { res.status(409).json({ error: 'the game updated mid-voyage — reload' }); return; }

      const now = Date.now();
      if (now > seasonEnd(ticket.season) + GRACE_MS || (await store.get(`${P}closed:${ticket.season}`))) {
        res.status(410).json({ error: 'that week has closed' });
        return;
      }

      let log: RunLogWire;
      try {
        const zipped = b64ToBytes(String(b.log ?? ''));
        const json = gunzipSync(zipped, { maxOutputLength: MAX_LOG_BYTES }).toString('utf8');
        log = JSON.parse(json) as RunLogWire;
      } catch {
        res.status(400).json({ error: 'voyage log unreadable' });
        return;
      }

      let result;
      let inputs;
      try {
        inputs = decodeInputs(log);
        result = replay(ticket.seed, log);
      } catch (e) {
        res.status(400).json({ error: `voyage log rejected: ${(e as Error).message}` });
        return;
      }
      if (!result.ended) { res.status(422).json({ error: 'voyage never ended' }); return; }
      if (now - ticket.startedAt + PACE_SLACK_MS < result.steps * STEP_MS) {
        console.warn(`[run] ${addr} ${runId} sailed faster than real time`);
        res.status(422).json({ error: 'voyage log rejected' });
        return;
      }

      const flags = reviewFlags(inputs);
      const lbKey = `${P}lb:${ticket.season}`;
      const prev = await store.zscore(lbKey, addr);
      const comp = composite(result.score, now, ticket.season);
      const improved = result.score > 0 && (prev === null || prev === undefined || comp > Number(prev));
      if (improved) {
        const best: BestRun = {
          score: result.score, runId, at: now, steps: result.steps, flags,
          stats: result.stats as unknown as Record<string, number>,
        };
        const stored: StoredLog = { seed: ticket.seed, addr, season: ticket.season, score: result.score, log };
        await store.set(`${P}log:${runId}`, JSON.stringify(stored), { ex: LOG_TTL_S });
        await store.set(`${P}best:${ticket.season}:${addr}`, JSON.stringify(best));
        await store.zadd(lbKey, { gt: true }, { score: comp, member: addr });
      }
      const mine = Number(await store.zscore(lbKey, addr) ?? comp);
      const rank = Number(await store.zcount(lbKey, `(${mine}`, '+inf')) + 1;
      if (flags.length) console.warn(`[run] ${addr} ${runId} score ${result.score} flags: ${flags.join(', ')}`);
      res.status(200).json({ score: result.score, best: improved, rank: prev === null && !improved ? null : rank });
      return;
    }

    res.status(400).json({ error: 'unknown action' });
  });
}
