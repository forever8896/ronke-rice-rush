// End-to-end tournament flow against an in-memory Redis and a fake
// Ronin node: sign in → pay → sail → finish → board, plus the attacks
// the endpoints are meant to stop.

import { gzipSync } from 'node:zlib';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import authHandler from '../../api/auth';
import entryHandler from '../../api/entry';
import runHandler from '../../api/run';
import seasonHandler from '../../api/season';
import { resetConfigCache } from '../../api/_lib/config';
import { setChain, type ReceiptLike } from '../../api/_lib/chain';
import { setStore, type Store } from '../../api/_lib/store';
import { Sim, FIELD_W, STEP_MS, SIM_VERSION, type SimInput } from '../../src/sim';
import { RunRecorder, bytesToB64, type RunLogWire } from '../../src/runlog';

let fail = 0;
const check = (ok: boolean, msg: string): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};

// ── Fake Upstash (auto-deserialises JSON like the real client) ──
const kv = new Map<string, string>();
const hashes = new Map<string, Map<string, string>>();
const zsets = new Map<string, Map<string, number>>();
const parse = (v: string | undefined): unknown => {
  if (v === undefined) return null;
  try { return JSON.parse(v); } catch { return v; }
};
const fake = {
  async get(k: string) { return parse(kv.get(k)); },
  async mget(...ks: string[]) { return ks.map((k) => parse(kv.get(k))); },
  async set(k: string, v: unknown, o?: { nx?: boolean }) {
    if (o?.nx && kv.has(k)) return null;
    kv.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    return 'OK';
  },
  async del(k: string) { return kv.delete(k) ? 1 : 0; },
  async getdel(k: string) { const v = parse(kv.get(k)); kv.delete(k); return v; },
  async incrby(k: string, n: number) { const v = Number(kv.get(k) ?? 0) + n; kv.set(k, String(v)); return v; },
  async incr(k: string) { return fake.incrby(k, 1); },
  async decr(k: string) { return fake.incrby(k, -1); },
  async hset(k: string, o: Record<string, string>) {
    const h = hashes.get(k) ?? new Map(); hashes.set(k, h);
    for (const [f, v] of Object.entries(o)) h.set(f, v);
    return 1;
  },
  async hgetall(k: string) { const h = hashes.get(k); return h ? Object.fromEntries(h) : null; },
  async zadd(k: string, o: { gt?: boolean }, m: { score: number; member: string }) {
    const z = zsets.get(k) ?? new Map(); zsets.set(k, z);
    const cur = z.get(m.member);
    if (cur === undefined || !o.gt || m.score > cur) z.set(m.member, m.score);
    return 1;
  },
  async zscore(k: string, m: string) { return zsets.get(k)?.get(m) ?? null; },
  async zrem(k: string, m: string) { return zsets.get(k)?.delete(m) ? 1 : 0; },
  async zcount(k: string, min: string) {
    const lo = Number(min.replace('(', ''));
    return [...(zsets.get(k)?.values() ?? [])].filter((s) => s > lo).length;
  },
  async zrange(k: string, a: number, b: number) {
    const rows = [...(zsets.get(k) ?? new Map()).entries()].sort((x, y) => y[1] - x[1]).slice(a, b + 1);
    return rows.flat();
  },
};
setStore(fake as unknown as Store);

// ── Fake Ronin ──
const TOKEN = '0x' + '11'.repeat(20);
const OTHER_TOKEN = '0x' + '22'.repeat(20);
const TREASURY = '0x' + 'aa'.repeat(20);
const SMART_ACCOUNT = '0x' + 'cc'.repeat(20);
const SMART_SIG = ('0x' + 'ab'.repeat(200)) as `0x${string}`;
const receipts = new Map<string, ReceiptLike>();
let head = 100n;
setChain({
  async receipt(h) { return receipts.get(h) ?? null; },
  async blockNumber() { return head; },
  async blockTime() { return Date.now(); },
  // Stands in for a deployed smart account that approves exactly one signature.
  async contractSignatureValid(address, _message, signature) {
    return address === SMART_ACCOUNT && signature === SMART_SIG;
  },
});
const pad = (a: string): string => '0x' + a.slice(2).padStart(64, '0');
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
function payment(hash: string, token: string, from: string, to: string, amount: bigint, block = 99n): void {
  receipts.set(hash, {
    status: 'success', blockNumber: block,
    logs: [{ address: token, topics: [TRANSFER, pad(from), pad(to)], data: '0x' + amount.toString(16).padStart(64, '0') }],
  });
}

process.env.TREASURY_ADDRESS = TREASURY;
process.env.ENTRY_TOKENS = `RONKE:${TOKEN}:18:1000`;
process.env.PRIZE_SPLIT = '50,30,20';
process.env.RAKE_PERCENT = '10';
process.env.AUTH_SECRET = 'x'.repeat(40);
process.env.KV_REST_API_URL = 'http://fake';
process.env.KV_REST_API_TOKEN = 'fake';
resetConfigCache();

// ── Tiny request driver ──
type Handler = (req: never, res: never) => Promise<void>;
async function call(h: Handler, method: string, b: unknown, token?: string, query?: Record<string, string>) {
  let status = 0;
  let data: Record<string, unknown> = {};
  const res = {
    status(c: number) { status = c; return res; },
    json(d: unknown) { data = d as Record<string, unknown>; },
    setHeader() {},
  };
  const req = { method, body: b, query, headers: token ? { authorization: `Bearer ${token}` } : {} };
  await h(req as never, res as never);
  return { status, data };
}

async function signIn(pk: `0x${string}`): Promise<{ token: string; addr: string }> {
  const acct = privateKeyToAccount(pk);
  const n = await call(authHandler, 'POST', { action: 'nonce', address: acct.address });
  const signature = await acct.signMessage({ message: String(n.data.message) });
  const v = await call(authHandler, 'POST', { action: 'verify', address: acct.address, nonce: n.data.nonce, signature });
  return { token: String(v.data.token), addr: acct.address.toLowerCase() };
}

/** Sail a bot voyage on a dealt seed; returns the wire log and the score it saw. */
function sail(seed: number, aimBias = 0): { log: RunLogWire; score: number } {
  let score = -1;
  const sim = new Sim({ seed, callbacks: {
    onSignal() {}, onHull() {}, onCombo() {}, onStage() {}, onEnemyHealth() {}, onBroadside() {},
    onEnd(s) { score = s; },
  } });
  const rec = new RunRecorder();
  for (let i = 0; sim.state === 'playing'; i++) {
    const threats = sim.barrels.filter((b) => b.kind !== 'rice' && b.y < sim.boatY && b.y > sim.boatY - 300);
    let steer = sim.enemy ? sim.enemy.x / FIELD_W : 0.5;
    if (threats.length) {
      const t = threats.reduce((a, b) => (b.y > a.y ? b : a));
      steer = t.x > sim.boatX ? (t.x - 160) / FIELD_W : (t.x + 160) / FIELD_W;
    }
    const aim = sim.enemy ? Math.atan2(sim.enemy.x - sim.boatX, sim.boatY - sim.enemy.y) + aimBias : 0;
    const input: SimInput = {
      steer: Math.round(Math.max(0, Math.min(1, steer)) * 1000),
      aim: Math.round(aim * 1000),
      mouth: i % 50 < 32,
    };
    rec.push(input);
    sim.step(input);
  }
  return { log: rec.toWire(), score };
}
const zip = (log: RunLogWire): string => bytesToB64(gzipSync(JSON.stringify(log)));

// Ticket start times are back-dated so the pacing check sees real time pass.
async function backdate(runId: string, ms: number): Promise<void> {
  const k = `rbb:t:run:${runId}`;
  const t = JSON.parse(kv.get(k)!);
  t.startedAt -= ms;
  kv.set(k, JSON.stringify(t));
}

// ═══ Sign-in ═══
const alice = await signIn(generatePrivateKey());
const bob = await signIn(generatePrivateKey());
check(alice.token.includes('.'), 'sign-in issues a session token');
{
  const acct = privateKeyToAccount(generatePrivateKey());
  const n = await call(authHandler, 'POST', { action: 'nonce', address: acct.address });
  const imposter = privateKeyToAccount(generatePrivateKey());
  const sig = await imposter.signMessage({ message: String(n.data.message) });
  const v = await call(authHandler, 'POST', { action: 'verify', address: acct.address, nonce: n.data.nonce, signature: sig });
  check(v.status === 401, 'signature from a different key is refused');
  const again = await call(authHandler, 'POST', { action: 'verify', address: acct.address, nonce: n.data.nonce, signature: sig });
  check(again.status === 401, 'a nonce cannot be reused');
}
{
  // A smart account (e.g. Stash) can't be ecrecovered; the chain vouches for it.
  const n = await call(authHandler, 'POST', { action: 'nonce', address: SMART_ACCOUNT });
  const v = await call(authHandler, 'POST', { action: 'verify', address: SMART_ACCOUNT, nonce: n.data.nonce, signature: SMART_SIG });
  check(v.status === 200 && v.data.address === SMART_ACCOUNT, 'smart-account signature accepted via the chain check');
  const n2 = await call(authHandler, 'POST', { action: 'nonce', address: SMART_ACCOUNT });
  const bad = await call(authHandler, 'POST', { action: 'verify', address: SMART_ACCOUNT, nonce: n2.data.nonce, signature: '0x' + 'cd'.repeat(200) });
  check(bad.status === 401, 'a smart account still has to approve the signature');
}
check((await call(entryHandler, 'POST', { txHash: '0x' + '0'.repeat(64) }, alice.token + 'x')).status === 401,
  'tampered session token is refused');

// ═══ Paying ═══
const H1 = '0x' + '01'.repeat(32);
payment(H1, TOKEN, alice.addr, TREASURY, 2000n * 10n ** 18n, 99n);
head = 99n;
check((await call(entryHandler, 'POST', { txHash: H1 }, alice.token)).status === 202, 'unconfirmed payment → pending');
head = 110n;
let r = await call(entryHandler, 'POST', { txHash: H1 }, alice.token);
check(r.status === 200 && r.data.credited === 2 && r.data.entries === 2, `2000 RONKE buys 2 entries (${JSON.stringify(r.data)})`);
r = await call(entryHandler, 'POST', { txHash: H1 }, alice.token);
check(r.status === 409, 'same payment cannot be credited twice');
r = await call(entryHandler, 'POST', { txHash: H1 }, bob.token);
check(r.status === 409, "bob can't claim alice's payment either");

const H2 = '0x' + '02'.repeat(32);
payment(H2, TOKEN, alice.addr, TREASURY, 1000n * 10n ** 18n);
r = await call(entryHandler, 'POST', { txHash: H2 }, bob.token);
check(r.status === 422, "a payment FROM alice can't credit bob");
const H3 = '0x' + '03'.repeat(32);
payment(H3, OTHER_TOKEN, bob.addr, TREASURY, 1000n * 10n ** 18n);
check((await call(entryHandler, 'POST', { txHash: H3 }, bob.token)).status === 422, 'a non-entry token is refused');
const H4 = '0x' + '04'.repeat(32);
payment(H4, TOKEN, bob.addr, '0x' + 'bb'.repeat(20), 1000n * 10n ** 18n);
check((await call(entryHandler, 'POST', { txHash: H4 }, bob.token)).status === 422, 'a transfer to some other wallet is refused');
const H5 = '0x' + '05'.repeat(32);
payment(H5, TOKEN, bob.addr, TREASURY, 1000n * 10n ** 18n);
receipts.get(H5)!.status = 'reverted';
check((await call(entryHandler, 'POST', { txHash: H5 }, bob.token)).status === 422, 'a reverted tx is refused');
const H6 = '0x' + '06'.repeat(32);
payment(H6, TOKEN, bob.addr, TREASURY, 1000n * 10n ** 18n);
check((await call(entryHandler, 'POST', { txHash: H6 }, bob.token)).data.entries === 1, 'bob buys 1 entry');

// ═══ Sailing ═══
check((await call(runHandler, 'POST', { action: 'start', v: SIM_VERSION }, (await signIn(generatePrivateKey())).token)).status === 402,
  'no entries → no voyage');
check((await call(runHandler, 'POST', { action: 'start', v: 0 }, alice.token)).status === 409,
  'a stale client is refused before an entry is spent');
const s1 = await call(runHandler, 'POST', { action: 'start', v: SIM_VERSION }, alice.token);
check(s1.status === 200 && s1.data.entries === 1, 'starting a voyage spends an entry');
const v1 = sail(Number(s1.data.seed));

r = await call(runHandler, 'POST', { action: 'finish', runId: s1.data.runId, log: zip(v1.log) }, alice.token);
check(r.status === 422, `finishing ${(v1.log.n * STEP_MS / 1000).toFixed(0)}s of voyage instantly → faster than real time, rejected`);
r = await call(runHandler, 'POST', { action: 'finish', runId: s1.data.runId, log: zip(v1.log) }, alice.token);
check(r.status === 404, 'a ticket is single-use even after a rejection');

const s2 = await call(runHandler, 'POST', { action: 'start', v: SIM_VERSION }, alice.token);
const v2 = sail(Number(s2.data.seed));
await backdate(String(s2.data.runId), v2.log.n * STEP_MS + 5000);
r = await call(runHandler, 'POST', { action: 'finish', runId: s2.data.runId, log: zip(v2.log) }, bob.token);
check(r.status === 403, "bob can't submit alice's voyage");

const s3 = await call(runHandler, 'POST', { action: 'start', v: SIM_VERSION }, bob.token);
// Replaying alice's winning log on bob's seed is a different sea.
const stolen = sail(Number(s2.data.seed));
await backdate(String(s3.data.runId), stolen.log.n * STEP_MS + 5000);
r = await call(runHandler, 'POST', { action: 'finish', runId: s3.data.runId, log: zip(stolen.log) }, bob.token);
check(r.status !== 200 || r.data.score !== stolen.score,
  `a log played on someone else's seed doesn't score what it scored there (${stolen.score} → ${r.data.score ?? r.data.error})`);

// Bob's attempt must not have burned alice's ticket.
r = await call(runHandler, 'POST', { action: 'finish', runId: s2.data.runId, log: zip(v2.log) }, alice.token);
check(r.status === 200 && r.data.score === v2.score, `alice's ticket survived bob's attempt (${r.data.score})`);

await fake.incrby(`rbb:t:entries:${alice.addr}`, 1);
const s4 = await call(runHandler, 'POST', { action: 'start', v: SIM_VERSION }, alice.token);
const v4 = sail(Number(s4.data.seed));
await backdate(String(s4.data.runId), v4.log.n * STEP_MS + 5000);
// Tampering: claim a better voyage by editing the log's step count.
const forged = { ...v4.log, n: v4.log.n + 10 };
r = await call(runHandler, 'POST', { action: 'finish', runId: s4.data.runId, log: zip(forged) }, alice.token);
check(r.status === 400, 'a log whose tracks don\'t match its step count is rejected');

await fake.incrby(`rbb:t:entries:${alice.addr}`, 1);
const s5 = await call(runHandler, 'POST', { action: 'start', v: SIM_VERSION }, alice.token);
const v5 = sail(Number(s5.data.seed));
await backdate(String(s5.data.runId), v5.log.n * STEP_MS + 5000);
r = await call(runHandler, 'POST', { action: 'finish', runId: s5.data.runId, log: zip(v5.log) }, alice.token);
check(r.status === 200 && r.data.score === v5.score,
  `honest voyage: server score ${r.data.score} == client ${v5.score}, rank ${r.data.rank}`);
const bestAlice = Math.max(v2.score, v5.score);

// ═══ The board ═══
const season = await call(seasonHandler, 'GET', {}, alice.token);
const board = season.data.board as Array<{ address: string; score: number; runId: string }>;
check(board.length >= 1 && board[0].address === alice.addr && board[0].score === bestAlice,
  `board keeps each wallet's best replayed score (${board[0].score})`);
const tok = (season.data.tokens as Array<{ pool: string; prizes: string[] }>)[0];
check(tok.pool === (3000n * 10n ** 18n).toString(), `pool counts every credited fee (${tok.pool})`);
check(tok.prizes[0] === (1350n * 10n ** 18n).toString(), `1st takes 50% of the pool after a 10% rake (${tok.prizes[0]})`);
const me = season.data.me as { entries: number; rank: number };
check(me.rank === 1, 'signed-in caller sees their own rank');
const rep = await call(runHandler, 'GET', {}, undefined, { id: board[0].runId });
check(rep.status === 200 && rep.data.score === bestAlice, 'the leading voyage is publicly replayable');

process.exit(fail ? 1 : 0);
