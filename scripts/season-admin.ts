// ═════════════════════════════════════════════════════════════
// Weekly tournament admin — run from your machine, never deployed.
//
//   npm run admin -- status [season]          pools, board, flags, replay links
//   npm run admin -- dq <season> <addr> <why> disqualify before closing
//   npm run admin -- close <season>           freeze the payout sheet
//   npm run admin -- paid <season> <rank> <SYMBOL> <txHash>
//                                             record a prize you've sent
//
// Payouts are deliberately manual: the server holds no key that can
// move funds. `close` prints exactly what to send from the treasury;
// you watch the top runs, send the transfers from your wallet, then
// record each tx with `paid` so the page shows it.
//
// Needs the production env locally:
//   vercel env pull .env.production.local --environment=production
// ═════════════════════════════════════════════════════════════

import { formatUnits } from 'viem';
import { loadConfig } from '../api/_lib/config.js';
import { board, GRACE_MS, pools, seasonEnd, seasonOf, seasonStart, splitPool } from '../api/_lib/season.js';
import { getStore, P, type BestRun, type ClosedSeason } from '../api/_lib/store.js';

const SITE = process.env.SITE_URL ?? 'https://ronke-rice-rush.vercel.app';

const cfg = loadConfig();
if (!cfg) {
  console.error('Tournament env incomplete — pull it with:\n  vercel env pull .env.production.local --environment=production');
  process.exit(1);
}
const store = getStore();
const [cmd, ...args] = process.argv.slice(2);

const fmt = (sym: string, v: bigint): string => {
  const t = cfg.tokens.find((x) => x.symbol === sym)!;
  return `${formatUnits(v, t.decimals)} ${sym}`;
};

async function status(season: number): Promise<void> {
  const end = seasonEnd(season);
  console.log(`\nSeason ${season}: ${new Date(seasonStart(season)).toISOString()} → ${new Date(end).toISOString()}`);
  console.log(Date.now() < end ? `  open — ends in ${((end - Date.now()) / 3600000).toFixed(1)} h` : '  ended');
  const closed = await store.get<ClosedSeason>(`${P}closed:${season}`);
  if (closed) console.log(`  CLOSED ${new Date(closed.closedAt).toISOString()}`);

  const gross = await pools(store, cfg!, season);
  for (const t of cfg!.tokens) {
    const s = splitPool(gross[t.symbol], cfg!);
    console.log(`\n  ${t.symbol} pool ${fmt(t.symbol, gross[t.symbol])}  · your ${cfg!.rakePercent}% = ${fmt(t.symbol, s.operator)}`);
    s.places.forEach((p, i) => console.log(`    ${i + 1}. ${fmt(t.symbol, p)}`));
  }

  const rows = await board(store, season, 10);
  console.log('\n  Board:');
  for (const r of rows) {
    const best = await store.get<BestRun>(`${P}best:${season}:${r.address}`);
    const name = await store.get<string>(`${P}name:${r.address}`);
    const flags = best?.flags.length ? `  ⚠ ${best.flags.join(', ')}` : '';
    console.log(`  ${String(r.rank).padStart(2)}. ${r.address} ${(name ?? '').padEnd(14)} ${String(r.score).padStart(8)}${flags}`);
    if (r.rank <= cfg!.split.length && best) console.log(`      watch: ${SITE}/?replay=${best.runId}`);
  }
  if (closed) {
    console.log('\n  Payout sheet:');
    for (const p of closed.payouts) {
      console.log(`    ${p.rank}. ${p.address} ${fmt(p.symbol, BigInt(p.amount))}  ${p.paidTx ? `PAID ${p.paidTx}` : 'UNPAID'}`);
    }
  }
}

async function dq(season: number, addr: string, why: string): Promise<void> {
  if (await store.get(`${P}closed:${season}`)) throw new Error('season already closed');
  const a = addr.toLowerCase();
  const removed = await store.zrem(`${P}lb:${season}`, a);
  await store.set(`${P}dq:${season}:${a}`, JSON.stringify({ why, at: Date.now() }));
  console.log(removed ? `disqualified ${a} from season ${season}: ${why}` : `${a} was not on the board`);
}

async function close(season: number): Promise<void> {
  if (Date.now() < seasonEnd(season) + GRACE_MS) {
    throw new Error(`season ${season} can be closed after ${new Date(seasonEnd(season) + GRACE_MS).toISOString()} (voyages dealt before the bell may still finish)`);
  }
  if (await store.get(`${P}closed:${season}`)) throw new Error('already closed');
  const rows = await board(store, season, cfg!.split.length);
  const gross = await pools(store, cfg!, season);
  const sheet: ClosedSeason = { season, closedAt: Date.now(), payouts: [], operator: {}, rollover: {} };

  for (const t of cfg!.tokens) {
    const s = splitPool(gross[t.symbol], cfg!);
    sheet.operator[t.symbol] = s.operator.toString();
    let roll = 0n;
    s.places.forEach((amount, i) => {
      const row = rows[i];
      if (row && amount > 0n) sheet.payouts.push({ rank: i + 1, address: row.address, symbol: t.symbol, amount: amount.toString() });
      else roll += amount;
    });
    sheet.rollover[t.symbol] = roll.toString();
    if (roll > 0n) {
      await store.hset(`${P}pool:${season + 1}:${t.symbol}`, { [`rollover:${season}`]: roll.toString() });
    }
  }
  // Written last: from here on nothing can be credited to or finished in this week.
  await store.set(`${P}closed:${season}`, JSON.stringify(sheet));

  console.log(`\nSeason ${season} closed. Send these from the treasury (${cfg!.treasury}):\n`);
  for (const p of sheet.payouts) console.log(`  ${p.rank}. ${p.address}  ${fmt(p.symbol, BigInt(p.amount))}`);
  for (const [sym, v] of Object.entries(sheet.operator)) console.log(`  operator cut: ${fmt(sym, BigInt(v))}`);
  for (const [sym, v] of Object.entries(sheet.rollover)) if (v !== '0') console.log(`  rolled into season ${season + 1}: ${fmt(sym, BigInt(v))}`);
  console.log('\nThen record each one:  npm run admin -- paid <season> <rank> <SYMBOL> <txHash>');
}

async function paid(season: number, rank: number, symbol: string, tx: string): Promise<void> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) throw new Error('bad tx hash');
  const sheet = await store.get<ClosedSeason>(`${P}closed:${season}`);
  if (!sheet) throw new Error('season not closed');
  const p = sheet.payouts.find((x) => x.rank === rank && x.symbol === symbol.toUpperCase());
  if (!p) throw new Error('no such payout');
  p.paidTx = tx.toLowerCase();
  await store.set(`${P}closed:${season}`, JSON.stringify(sheet));
  console.log(`recorded: season ${season} #${rank} ${symbol} → ${tx}`);
}

const num = (s: string | undefined, fallback?: number): number => {
  const n = s === undefined ? fallback : Number(s);
  if (n === undefined || !Number.isInteger(n)) throw new Error('expected a season number');
  return n;
};

try {
  const current = seasonOf(Date.now());
  if (cmd === 'status' || !cmd) await status(num(args[0], current));
  else if (cmd === 'dq') await dq(num(args[0]), args[1] ?? '', args.slice(2).join(' ') || 'no reason given');
  else if (cmd === 'close') await close(num(args[0]));
  else if (cmd === 'paid') await paid(num(args[0]), Number(args[1]), args[2] ?? '', args[3] ?? '');
  else throw new Error(`unknown command "${cmd}"`);
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
