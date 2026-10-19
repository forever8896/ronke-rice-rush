// ═════════════════════════════════════════════════════════════
// Voyage logs — every step's input, recorded in the browser and
// replayed on the server.
//
// A ranked score is never taken on the client's word. The browser
// sends the seed it was dealt and the inputs it fed the sim; the
// server runs the same Sim over them and the score it lands on is the
// score that counts. Shared by both sides, so it stays DOM-free.
//
// Wire format (JSON, then gzip, then base64 in transit):
//   { v, n, s, a, m }
//   v  SIM_VERSION the run was played on
//   n  step count
//   s  steer, Int16 deltas step-to-step, base64
//   a  aim (mrad), Int16 deltas, base64
//   m  step indices where the mouth toggled (first toggle = open)
// A ten-minute voyage is ~36k steps and lands well under 100 KB.
// ═════════════════════════════════════════════════════════════

import {
  Sim, SIM_VERSION, MAX_STEPS, NULL_FX, NULL_CALLBACKS,
  type RoundStats, type SimInput, type SimCallbacks,
} from './sim.js';

export { MAX_STEPS };

export interface RunLogWire {
  v: number;
  n: number;
  s: string;
  a: string;
  m: number[];
}

export class RunRecorder {
  private steer: number[] = [];
  private aim: number[] = [];
  private toggles: number[] = [];
  private mouth = false;

  push(input: SimInput): void {
    const i = this.steer.length;
    this.steer.push(input.steer);
    this.aim.push(input.aim);
    if (input.mouth !== this.mouth) {
      this.toggles.push(i);
      this.mouth = input.mouth;
    }
  }

  get length(): number { return this.steer.length; }

  toWire(): RunLogWire {
    return {
      v: SIM_VERSION,
      n: this.steer.length,
      s: encodeDeltas(this.steer),
      a: encodeDeltas(this.aim),
      m: this.toggles.slice(),
    };
  }
}

/** Expand a wire log back into per-step inputs. Throws on malformed logs. */
export function decodeInputs(log: RunLogWire): SimInput[] {
  if (log.v !== SIM_VERSION) throw new Error(`log is for sim v${log.v}, this is v${SIM_VERSION}`);
  const n = log.n;
  // One extra step: the sim spends a step noticing the 60-minute cap.
  if (!Number.isInteger(n) || n <= 0 || n > MAX_STEPS + 1) throw new Error('bad step count');
  const steer = decodeDeltas(log.s, n);
  const aim = decodeDeltas(log.a, n);
  if (!Array.isArray(log.m)) throw new Error('bad mouth track');
  const out: SimInput[] = new Array(n);
  let mouth = false;
  let k = 0;
  let prev = -1;
  for (let i = 0; i < n; i++) {
    while (k < log.m.length && log.m[k] === i) {
      mouth = !mouth;
      k++;
    }
    out[i] = { steer: steer[i], aim: aim[i], mouth };
  }
  for (const idx of log.m) {
    if (!Number.isInteger(idx) || idx <= prev || idx >= n) throw new Error('bad mouth track');
    prev = idx;
  }
  return out;
}

export interface ReplayResult {
  score: number;
  stats: RoundStats;
  /** Steps the sim actually consumed before the hull went down. */
  steps: number;
  /** False if the log ran out before the boat sank. */
  ended: boolean;
}

/** Run the rules over a log. Pure: same (seed, log) → same result, everywhere. */
export function replay(seed: number, log: RunLogWire, callbacks: SimCallbacks = NULL_CALLBACKS): ReplayResult {
  const inputs = decodeInputs(log);
  let result: { score: number; stats: RoundStats } | null = null;
  const sim = new Sim({
    seed,
    fx: NULL_FX,
    callbacks: {
      ...callbacks,
      onEnd: (score, stats) => {
        result = { score, stats };
        callbacks.onEnd(score, stats);
      },
    },
  });
  for (const input of inputs) {
    if (sim.state !== 'playing') break;
    sim.step(input);
  }
  const done = result as { score: number; stats: RoundStats } | null;
  return {
    score: done ? done.score : Math.round(sim.score),
    stats: done ? done.stats : sim.stats,
    steps: sim.steps,
    ended: !!done,
  };
}

// ── Int16 delta codec ──

function encodeDeltas(values: number[]): string {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  let prev = 0;
  for (let i = 0; i < values.length; i++) {
    const d = Math.max(-32768, Math.min(32767, values[i] - prev));
    view.setInt16(i * 2, d, true);
    prev += d;
  }
  return bytesToB64(bytes);
}

function decodeDeltas(b64: string, n: number): number[] {
  if (typeof b64 !== 'string') throw new Error('bad track');
  const bytes = b64ToBytes(b64);
  if (bytes.length !== n * 2) throw new Error('track length mismatch');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Array<number>(n);
  let v = 0;
  for (let i = 0; i < n; i++) {
    v += view.getInt16(i * 2, true);
    out[i] = v;
  }
  return out;
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
