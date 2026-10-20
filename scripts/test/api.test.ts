// End-to-end tournament flow against an in-memory Redis and a fake
// Ronin node: sign in → enter → sail → finish → board → settle, plus
// the attacks the endpoints are meant to stop. Chain events are real
// ABI encodings of RonkeTournament's, so the decoding path is tested too.

import { gzipSync } from 'node:zlib';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import authHandler from '../../api/auth';
import entryHandler from '../../api/entry';
import runHandler from '../../api/run';
import seasonHandler from '../../api/season';
import settledHandler from '../../api/settled';
import clipHandler from '../../api/clip';
import { setClips } from '../../api/_lib/clips';
import { TOURNAMENT_ABI } from '../../api/_lib/abi';
import { resetConfigCache } from '../../api/_lib/config';
import { GRACE_MS, seasonEnd, seasonOf } from '../../api/_lib/season';
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
const ESCROW = '0x' + 'ee'.repeat(20);
const IMPOSTOR_ESCROW = '0x' + 'ef'.repeat(20);
const SMART_ACCOUNT = '0x' + 'cc'.repeat(20);
const SMART_SIG = ('0x' + 'ab'.repeat(200)) as `0x${string}`;
const E18 = 10n ** 18n;
const WEEK = seasonOf(Date.now());
const OWNER_PK = generatePrivateKey();
const OWNER = privateKeyToAccount(OWNER_PK).address.toLowerCase();

// ── Fake private clip store ──
const blobs = new Map<string, number>();
const removed: string[] = [];
setClips({
  async size(p) { return blobs.get(p) ?? null; },
  async remove(ps) { for (const p of ps) { blobs.delete(p); removed.push(p); } },
  async viewUrl(p) { return `https://signed.example/${p}?sig=short-lived`; },
});
const receipts = new Map<string, ReceiptLike>();
const chainPools: Record<number, Record<string, bigint>> = {};
let head = 100n;
setChain({
  async receipt(h) { return receipts.get(h) ?? null; },
  async blockNumber() { return head; },
  // Stands in for a deployed smart account that approves exactly one signature.
  async contractSignatureValid(address, _message, signature) {
    return address === SMART_ACCOUNT && signature === SMART_SIG;
  },
  async rules() {
    return {
      owner: OWNER, pendingOwner: '0x' + '00'.repeat(20), feeRecipient: '0x' + 'aa'.repeat(20),
      rakeBps: 1000, split: [5000, 3000, 2000], paused: false, prices: { RONKE: 1000n * E18 },
    };
  },
  async pools(week) { return chainPools[week] ?? { RONKE: 0n }; },
  async settled() { return false; },
});

type Hex = `0x${string}`;
/** Event topics as plain strings (no wildcard nulls — every arg is given). */
const topicsOf = (args: Parameters<typeof encodeEventTopics>[0]): string[] =>
  encodeEventTopics(args as never) as string[];
/** A real `Entered` log, as RonkeTournament would emit it. */
function enteredLog(emitter: string, week: number, player: string, token: string, count: number) {
  const topics = topicsOf({
    abi: TOURNAMENT_ABI, eventName: 'Entered',
    args: { week: BigInt(week), player: player as Hex, token: token as Hex },
  });
  const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(count), BigInt(count) * 1000n * E18]);
  return { address: emitter, topics, data };
}
function entryTx(hash: string, logs: ReceiptLike['logs'], block = 99n): void {
  receipts.set(hash, { status: 'success', blockNumber: block, logs });
}

process.env.TOURNAMENT_ADDRESS = ESCROW;
process.env.CHAIN_ID = '202601';
process.env.ENTRY_TOKENS = `RONKE:${TOKEN}:18`;
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

// ═══ Entering (the fee goes to the escrow; we only credit what it recorded) ═══
const H1 = '0x' + '01'.repeat(32);
entryTx(H1, [enteredLog(ESCROW, WEEK, alice.addr, TOKEN, 2)]);
head = 99n;
check((await call(entryHandler, 'POST', { txHash: H1 }, alice.token)).status === 202, 'unconfirmed entry → pending');
head = 110n;
let r = await call(entryHandler, 'POST', { txHash: H1 }, alice.token);
check(r.status === 200 && r.data.credited === 2 && r.data.entries === 2 && r.data.week === WEEK,
  `enter(RONKE, 2) credits 2 entries for this week (${JSON.stringify(r.data)})`);
r = await call(entryHandler, 'POST', { txHash: H1 }, alice.token);
check(r.status === 409, 'same entry cannot be credited twice');
r = await call(entryHandler, 'POST', { txHash: H1 }, bob.token);
check(r.status === 409, "bob can't claim alice's entry either");

const H2 = '0x' + '02'.repeat(32);
entryTx(H2, [enteredLog(ESCROW, WEEK, alice.addr, TOKEN, 1)]);
check((await call(entryHandler, 'POST', { txHash: H2 }, bob.token)).status === 422, "an entry by alice can't credit bob");
const H3 = '0x' + '03'.repeat(32);
entryTx(H3, [enteredLog(ESCROW, WEEK, bob.addr, OTHER_TOKEN, 1)]);
check((await call(entryHandler, 'POST', { txHash: H3 }, bob.token)).status === 422, 'an entry in an unlisted token is refused');
const H4 = '0x' + '04'.repeat(32);
entryTx(H4, [enteredLog(IMPOSTOR_ESCROW, WEEK, bob.addr, TOKEN, 5)]);
check((await call(entryHandler, 'POST', { txHash: H4 }, bob.token)).status === 422,
  'an identical event from some other contract is ignored');
const H5 = '0x' + '05'.repeat(32);
entryTx(H5, [enteredLog(ESCROW, WEEK, bob.addr, TOKEN, 1)]);
receipts.get(H5)!.status = 'reverted';
check((await call(entryHandler, 'POST', { txHash: H5 }, bob.token)).status === 422, 'a reverted tx is refused');
const H6 = '0x' + '06'.repeat(32);
entryTx(H6, [enteredLog(ESCROW, WEEK, bob.addr, TOKEN, 1)]);
check((await call(entryHandler, 'POST', { txHash: H6 }, bob.token)).data.entries === 1, 'bob buys 1 entry');
const H7 = '0x' + '07'.repeat(32);
entryTx(H7, [enteredLog(ESCROW, WEEK - 1, bob.addr, TOKEN, 3)]);
await call(entryHandler, 'POST', { txHash: H7 }, bob.token);
check(Number(kv.get(`rbb:t:entries:${WEEK}:${bob.addr}`)) === 1, "last week's entries don't count toward this week");
chainPools[WEEK] = { RONKE: 3000n * E18 };

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

await fake.incrby(`rbb:t:entries:${WEEK}:${alice.addr}`, 1);
const s4 = await call(runHandler, 'POST', { action: 'start', v: SIM_VERSION }, alice.token);
const v4 = sail(Number(s4.data.seed));
await backdate(String(s4.data.runId), v4.log.n * STEP_MS + 5000);
// Tampering: claim a better voyage by editing the log's step count.
const forged = { ...v4.log, n: v4.log.n + 10 };
r = await call(runHandler, 'POST', { action: 'finish', runId: s4.data.runId, log: zip(forged) }, alice.token);
check(r.status === 400, 'a log whose tracks don\'t match its step count is rejected');

await fake.incrby(`rbb:t:entries:${WEEK}:${alice.addr}`, 1);
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
check(tok.pool === (3000n * E18).toString(), `pool is read from the escrow (${tok.pool})`);
check(tok.prizes[0] === (1350n * E18).toString(), `1st shows 50% of the pool after the contract's 10% rake (${tok.prizes[0]})`);
check(season.data.chainId === 202601 && season.data.tournament === ESCROW, 'page is told which chain and escrow to use');
const me = season.data.me as { entries: number; rank: number };
check(me.rank === 1, 'signed-in caller sees their own rank');
const rep = await call(runHandler, 'GET', {}, undefined, { id: board[0].runId });
check(rep.status === 200 && rep.data.score === bestAlice, 'the leading voyage is publicly replayable');

// ═══ Face clips ═══
{
  // Alice's best this week is near the top, so its clip is wanted.
  const runId = (JSON.parse(kv.get(`rbb:t:best:${WEEK}:${alice.addr}`)!) as { runId: string }).runId;
  check(kv.has(`rbb:t:clipwant:${runId}`), 'a new top-10 best asks for its face clip');
  {
    // An earlier best that has since been beaten: its late upload must not count.
    const older = 'e'.repeat(32);
    await fake.set(`rbb:t:clipwant:${older}`, JSON.stringify({ addr: alice.addr, week: WEEK, steps: 10 }));
    blobs.set(`clips/${WEEK}/${older}.webm`, 999);
    const late = await call(clipHandler, 'POST', { action: 'done', runId: older, contentType: 'video/webm', sync: [[0, 0]] }, alice.token);
    check(late.status === 409 && !blobs.has(`clips/${WEEK}/${older}.webm`),
      "a beaten run's late clip is refused and deleted — it can't displace the best run's");
  }
  const sync = [[0, 0], [250, 15], [500, 30]];
  let c = await call(clipHandler, 'POST', { action: 'done', runId, contentType: 'video/webm', sync }, alice.token);
  check(c.status === 409, 'confirming a clip that never uploaded is refused');
  blobs.set(`clips/${WEEK}/${runId}.webm`, 123_456);
  c = await call(clipHandler, 'POST', { action: 'done', runId, contentType: 'video/webm', sync }, bob.token);
  check(c.status === 404, "bob can't attach a clip to alice's run");
  c = await call(clipHandler, 'POST', { action: 'done', runId, contentType: 'video/webm', sync: [[0, 5], [10, 2]] }, alice.token);
  check(c.status === 400, 'clip timing that runs backwards is refused');
  c = await call(clipHandler, 'POST', { action: 'done', runId, contentType: 'video/webm', sync }, alice.token);
  check(c.status === 200 && c.data.size === 123_456, 'the uploaded clip is recorded');
  c = await call(clipHandler, 'POST', { action: 'done', runId, contentType: 'video/webm', sync }, alice.token);
  check(c.status === 404, 'a run can only confirm its clip once');

  const v = await call(clipHandler, 'GET', {}, alice.token, { run: runId });
  check(v.status === 403, 'players cannot watch clips — not even their own run via the review route');
  const owner = await signIn(OWNER_PK);
  const o = await call(clipHandler, 'GET', {}, owner.token, { run: runId });
  const oc = o.data.clip as { url: string; sync: number[][] } | null;
  check(o.status === 200 && !!oc && oc.url.includes('short-lived') && oc.sync.length === 3 && o.data.seed !== undefined,
    'the owner gets a short-lived link plus the replay data');

  // Last week's board: carol on top without a clip, alice and bob with.
  const prev = WEEK - 1;
  const carol = '0x' + 'c0'.repeat(20);
  const rows: Array<[string, number, string, boolean]> = [
    [carol, 900, 'c'.repeat(32), false], [alice.addr, 800, 'a'.repeat(32), true], [bob.addr, 700, 'b'.repeat(32), true],
  ];
  for (const [who, score, run, hasClip] of rows) {
    await fake.zadd(`rbb:t:lb:${prev}`, {}, { score: score * 1e6, member: who });
    await fake.set(`rbb:t:best:${prev}:${who}`, JSON.stringify({ score, runId: run, at: 0, steps: 1, flags: [], stats: {} }));
    if (hasClip) {
      await fake.set(`rbb:t:clip:${run}`, JSON.stringify({ pathname: `clips/${prev}/${run}.webm`, size: 1, contentType: 'video/webm', sync: [[0, 0]], at: 0 }));
      await fake.hset(`rbb:t:cliplist:${prev}`, { [run]: `clips/${prev}/${run}.webm` });
      blobs.set(`clips/${prev}/${run}.webm`, 1);
    }
  }
  chainPools[prev] = { RONKE: 3000n * E18 };
  if (Date.now() >= seasonEnd(prev) + GRACE_MS) {
    const plan = (await call(seasonHandler, 'GET', {})).data.settle as {
      winners: string[]; runs: string[]; skipped: Array<{ address: string; reason: string }>;
    };
    check(plan.winners.join() === [alice.addr, bob.addr].join() && plan.runs[0] === 'a'.repeat(32),
      'the settle plan puts forward only runs with a face clip, in board order');
    check(plan.skipped.length === 1 && plan.skipped[0].address === carol && plan.skipped[0].reason === 'no face clip',
      'a higher run without a clip is passed over — and says why');
  } else {
    console.log('skip settle-plan checks: last week is still inside its 70-minute grace');
  }
}

// ═══ Settlement is read back from the contract's own events ═══
{
  const HS = '0x' + '5e'.repeat(32);
  const winners = [alice.addr, bob.addr] as Hex[];
  const settledTopics = topicsOf({ abi: TOURNAMENT_ABI, eventName: 'Settled', args: { week: BigInt(WEEK - 1) } });
  const settledData = encodeAbiParameters([{ type: 'address[]' }, { type: 'uint256[]' }], [winners, [9000n, 4000n]]);
  const prize = (w: Hex, place: number, amount: bigint) => ({
    address: ESCROW,
    topics: topicsOf({ abi: TOURNAMENT_ABI, eventName: 'Prize', args: { week: BigInt(WEEK - 1), winner: w, token: TOKEN as Hex } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(place), amount]),
  });
  receipts.set(HS, { status: 'success', blockNumber: 105n, logs: [
    prize(winners[0], 1, 1125n * E18), prize(winners[1], 2, 675n * E18),
    { address: ESCROW, topics: settledTopics, data: settledData },
  ] });
  const st = await call(settledHandler, 'POST', { txHash: HS });
  check(st.status === 200 && st.data.payouts === 2, 'a settle() tx is recorded from its events');
  check(st.data.clipsDeleted === 2 && removed.includes(`clips/${WEEK - 1}/${'a'.repeat(32)}.webm`)
    && !blobs.has(`clips/${WEEK - 1}/${'b'.repeat(32)}.webm`), "paying a week out deletes all of that week's face clips");
  const after = await call(seasonHandler, 'GET', {});
  const last = after.data.last as { payouts: Array<{ address: string; amount: string; paidTx: string }> };
  check(last.payouts[0].address === alice.addr && last.payouts[0].amount === (1125n * E18).toString() && last.payouts[0].paidTx === HS,
    "last week's winners show what the contract actually paid, linked to the tx");
  const fakeSettle = '0x' + '5f'.repeat(32);
  receipts.set(fakeSettle, { status: 'success', blockNumber: 105n, logs: [{ ...prize(winners[1], 1, 999n * E18), address: IMPOSTOR_ESCROW }] });
  check((await call(settledHandler, 'POST', { txHash: fakeSettle })).status === 202, 'a payout claimed by some other contract is not recorded');
}

process.exit(fail ? 1 : 0);
