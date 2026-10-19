// ═════════════════════════════════════════════════════════════
// Deterministic maths for the simulation.
//
// The server replays every ranked voyage to recompute its score, and
// the replay has to land on the same float bits as the player's
// browser. +, −, ×, ÷, sqrt and floor are exact IEEE operations in
// every engine; Math.sin/cos/exp are NOT specified to the last bit,
// and Safari and V8 do differ. So the sim only ever calls these.
//
// Accuracy is ~1e-9 over the ranges the game uses — far below
// anything a player could see, which is the only bar that matters.
// ═════════════════════════════════════════════════════════════

const PI = 3.141592653589793;
const HALF_PI = 1.5707963267948966;
const TWO_PI = 6.283185307179586;
const LN2 = 0.6931471805599453;

export function dsin(x: number): number {
  let r = x - Math.floor(x / TWO_PI + 0.5) * TWO_PI;
  if (r > HALF_PI) r = PI - r;
  else if (r < -HALF_PI) r = -PI - r;
  const r2 = r * r;
  return r * (1 - (r2 / 6) * (1 - (r2 / 20) * (1 - (r2 / 42) * (1 - (r2 / 72)
    * (1 - (r2 / 110) * (1 - (r2 / 156) * (1 - r2 / 210)))))));
}

export function dcos(x: number): number {
  return dsin(x + HALF_PI);
}

export function dexp(x: number): number {
  const n = Math.floor(x / LN2 + 0.5);
  const r = x - n * LN2;
  let term = 1;
  let sum = 1;
  for (let i = 1; i <= 14; i++) {
    term = (term * r) / i;
    sum += term;
  }
  // Scale by 2^n with exact multiplies.
  if (n > 0) for (let i = 0; i < n; i++) sum *= 2;
  else for (let i = 0; i < -n; i++) sum *= 0.5;
  return sum;
}

export function dhypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** mulberry32 — tiny, fast, and identical in every engine. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
