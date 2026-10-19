// Determinism check: a bot sails a voyage while being recorded, then the
// log is replayed from scratch and must land on the identical score.
import { Sim, FIELD_W, type SimInput } from '../../src/sim';
import { RunRecorder, replay } from '../../src/runlog';
import { dsin, dcos, dexp } from '../../src/dmath';

let fail = 0;
const check = (ok: boolean, msg: string): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};

// dmath vs the engine's own maths, over the ranges the sim uses.
let worst = 0;
for (let x = -50; x < 50; x += 0.0137) {
  worst = Math.max(worst, Math.abs(dsin(x) - Math.sin(x)), Math.abs(dcos(x) - Math.cos(x)));
}
for (let x = -40; x <= 0; x += 0.01) worst = Math.max(worst, Math.abs(dexp(x) - Math.exp(x)) / Math.exp(x));
check(worst < 1e-8, `dmath max error ${worst.toExponential(2)}`);

/** A crude but competent captain: dodge the nearest threat, aim at the pirate, chomp. */
function bot(sim: Sim, rnd: () => number, step: number): SimInput {
  let steer = 0.5;
  const threats = sim.barrels.filter((b) => b.kind !== 'rice' && b.y < sim.boatY && b.y > sim.boatY - 300);
  if (threats.length) {
    const t = threats.reduce((a, b) => (b.y > a.y ? b : a));
    steer = t.x > sim.boatX ? (t.x - 160) / FIELD_W : (t.x + 160) / FIELD_W;
  } else if (sim.enemy) steer = sim.enemy.x / FIELD_W;
  let aim = 0;
  if (sim.enemy) aim = Math.atan2(sim.enemy.x - sim.boatX, sim.boatY - sim.enemy.y);
  const mouth = step % 50 < 30 + Math.floor(rnd() * 8);
  return {
    steer: Math.round(Math.max(0, Math.min(1, steer + (rnd() - 0.5) * 0.02)) * 1000),
    aim: Math.round(aim * 1000),
    mouth,
  };
}

function seeded(s: number): () => number {
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

for (const seed of [1, 42, 0xdeadbeef]) {
  let endScore = -1;
  const sim = new Sim({ seed, callbacks: {
    onSignal() {}, onHull() {}, onCombo() {}, onStage() {}, onEnemyHealth() {}, onBroadside() {},
    onEnd(score) { endScore = score; },
  } });
  const rec = new RunRecorder();
  const rnd = seeded(seed);
  for (let i = 0; i < 60 * 60 * 10 && sim.state === 'playing'; i++) {
    const input = bot(sim, rnd, i);
    rec.push(input);
    sim.step(input);
  }
  const wire = rec.toWire();
  const kb = (JSON.stringify(wire).length / 1024).toFixed(1);
  const t0 = performance.now();
  const r = replay(seed, wire);
  const ms = (performance.now() - t0).toFixed(0);
  check(r.ended === (sim.state === 'over'), `seed ${seed}: ended flags agree`);
  check(r.score === (endScore >= 0 ? endScore : Math.round(sim.score)),
    `seed ${seed}: live ${endScore >= 0 ? endScore : Math.round(sim.score)} == replay ${r.score} ` +
    `(${(sim.steps / 60).toFixed(0)}s, stage ${sim.stage}, ${kb} KB log, replay ${ms} ms)`);
  // A different seed must not replay to the same voyage.
  const other = replay(seed + 1, wire);
  check(other.score !== r.score || other.steps !== r.steps, `seed ${seed}: wrong seed diverges (${other.score})`);
}

process.exit(fail ? 1 : 0);
