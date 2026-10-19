// ═════════════════════════════════════════════════════════════
// Weekly tournament admin — run from your machine, never deployed.
//
//   npm run admin -- status [week]           pools (on chain), board, flags, replay links
//   npm run admin -- dq <week> <addr> <why>  disqualify before settling
//   npm run admin -- settle-cmd <week>       the settle() call, for `cast` users
//
// Paying out happens on chain: open the game with ?admin, connect the
// owner wallet, and press SETTLE — the escrow pays the winners and the
// rake itself. Watch the top runs and disqualify bots BEFORE that; once
// settled, a week's payout is final.
//
// Needs the production env locally:
//   vercel env pull .env.production.local --environment=production
// ═════════════════════════════════════════════════════════════

import { formatUnits } from 'viem';
import { getChain } from '../api/_lib/chain.js';
import { loadConfig } from '../api/_lib/config.js';
import { board, GRACE_MS, seasonEnd, seasonOf, seasonStart, splitPool } from '../api/_lib/season.js';
import { getStore, P, type BestRun, type ClosedSeason } from '../api/_lib/store.js';

const SITE = process.env.SITE_URL ?? 'https://ronke-rice-rush.vercel.app';

const cfg = loadConfig();
if (!cfg) {
  console.error('Tournament env incomplete — pull it with:\n  vercel env pull .env.production.local --environment=production');
  process.exit(1);
}
const store = getStore();
const chain = getChain(cfg);
const [cmd, ...args] = process.argv.slice(2);

const fmt = (sym: string, v: bigint): string => {
  const t = cfg.tokens.find((x) => x.symbol === sym)!;
  return `${formatUnits(v, t.decimals)} ${sym}`;
};

async function status(week: number): Promise<void> {
  const end = seasonEnd(week);
  const rules = await chain.rules();
  console.log(`\nWeek ${week}: ${new Date(seasonStart(week)).toISOString()} → ${new Date(end).toISOString()}`);
  console.log(Date.now() < end ? `  open — ends in ${((end - Date.now()) / 3600000).toFixed(1)} h` : '  ended');
  console.log(`  escrow ${cfg!.tournament}  owner ${rules.owner}  rake ${rules.rakeBps / 100}%  split ${rules.split.map((b) => b / 100).join('/')}`);
  if (await chain.settled(week)) console.log('  SETTLED on chain');

  const gross = await chain.pools(week);
  for (const t of cfg!.tokens) {
    const s = splitPool(gross[t.symbol], rules.rakeBps, rules.split);
    console.log(`\n  ${t.symbol} pool ${fmt(t.symbol, gross[t.symbol])}  · rake ${fmt(t.symbol, s.rake)}  · price ${fmt(t.symbol, rules.prices[t.symbol])}`);
    s.places.forEach((p, i) => console.log(`    ${i + 1}. ${fmt(t.symbol, p)}`));
  }

  const rows = await board(store, week, 10);
  console.log('\n  Board:');
  for (const r of rows) {
    const best = await store.get<BestRun>(`${P}best:${week}:${r.address}`);
    const name = await store.get<string>(`${P}name:${r.address}`);
    const flags = best?.flags.length ? `  ⚠ ${best.flags.join(', ')}` : '';
    console.log(`  ${String(r.rank).padStart(2)}. ${r.address} ${(name ?? '').padEnd(14)} ${String(r.score).padStart(8)}${flags}`);
    if (r.rank <= rules.split.length && best) console.log(`      watch: ${SITE}/?replay=${best.runId}`);
  }
  const closed = await store.get<ClosedSeason>(`${P}closed:${week}`);
  if (closed) {
    console.log(`\n  Paid out in ${closed.tx}:`);
    for (const p of closed.payouts) console.log(`    ${p.rank}. ${p.address} ${fmt(p.symbol, BigInt(p.amount))}`);
  }
}

async function dq(week: number, addr: string, why: string): Promise<void> {
  if (await chain.settled(week)) throw new Error('that week is already settled on chain');
  const a = addr.toLowerCase();
  const removed = await store.zrem(`${P}lb:${week}`, a);
  await store.set(`${P}dq:${week}:${a}`, JSON.stringify({ why, at: Date.now() }));
  console.log(removed ? `disqualified ${a} from week ${week}: ${why}` : `${a} was not on the board`);
}

async function settleCmd(week: number): Promise<void> {
  if (Date.now() < seasonEnd(week) + GRACE_MS) {
    throw new Error(`week ${week} can be settled after ${new Date(seasonEnd(week) + GRACE_MS).toISOString()}`);
  }
  const rules = await chain.rules();
  const top = await board(store, week, rules.split.length);
  if (!top.length) throw new Error('nobody on the board — leave it unsettled and entrants can refund after 30 days');
  const winners = `[${top.map((r) => r.address).join(',')}]`;
  const scores = `[${top.map((r) => r.score).join(',')}]`;
  console.log(`\ncast send ${cfg!.tournament} "settle(uint256,address[],uint256[])" ${week} "${winners}" "${scores}" --rpc-url ${cfg!.rpcUrl} --account <owner>`);
  console.log(`\nThen record it:  curl -X POST ${SITE}/api/settled -H 'content-type: application/json' -d '{"txHash":"0x…"}'`);
}

const num = (s: string | undefined, fallback?: number): number => {
  const n = s === undefined ? fallback : Number(s);
  if (n === undefined || !Number.isInteger(n)) throw new Error('expected a week number');
  return n;
};

try {
  const current = seasonOf(Date.now());
  if (cmd === 'status' || !cmd) await status(num(args[0], current));
  else if (cmd === 'dq') await dq(num(args[0]), args[1] ?? '', args.slice(2).join(' ') || 'no reason given');
  else if (cmd === 'settle-cmd') await settleCmd(num(args[0], current - 1));
  else throw new Error(`unknown command "${cmd}"`);
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
