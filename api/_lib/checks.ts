// ═════════════════════════════════════════════════════════════
// Review flags — things a face can't do.
//
// The replay already guarantees a score obeys the rules. What it can't
// tell is whether a person produced the inputs. These checks catch the
// obvious non-human signatures: inputs that teleport faster than the
// control pump's smoothing allows, and a jaw that opens and shuts
// faster than face tracking can even see. A flagged run still counts
// on the board; the flags are for the admin's review before payout.
//
// This is a deterrent, not a proof: everything here is measured in the
// player's own browser, so a determined cheat can forge it. It raises
// the effort well past what weekly prizes are worth, and every top-3
// run is still watched before a prize is sent.
// ═════════════════════════════════════════════════════════════

import { STEP_MS } from '../../src/sim.js';
import type { SimInput } from '../../src/sim.js';

/** Biggest per-step steer change the pump's smoothing allows a real head. */
const MAX_STEER_STEP = 250;
/** Same for the cannon, in milliradians. */
const MAX_AIM_STEP = 400;
/** Face tracking runs at camera rate; an open shorter than this isn't a jaw. */
const MIN_OPEN_STEPS = 3;
/** Chomps in any two-second window. */
const MAX_CHOMPS_2S = 14;

export function reviewFlags(inputs: SimInput[]): string[] {
  const flags: string[] = [];
  let teleSteer = 0;
  let teleAim = 0;
  let shortOpens = 0;
  let opens = 0;
  let openAt = -1;
  const openSteps: number[] = [];

  for (let i = 1; i < inputs.length; i++) {
    const a = inputs[i - 1];
    const b = inputs[i];
    if (Math.abs(b.steer - a.steer) > MAX_STEER_STEP) teleSteer++;
    if (Math.abs(b.aim - a.aim) > MAX_AIM_STEP) teleAim++;
    if (b.mouth && !a.mouth) { opens++; openAt = i; openSteps.push(i); }
    if (!b.mouth && a.mouth && openAt >= 0 && i - openAt < MIN_OPEN_STEPS) shortOpens++;
  }

  if (teleSteer > 0) flags.push(`steer-teleport×${teleSteer}`);
  if (teleAim > 0) flags.push(`aim-teleport×${teleAim}`);
  if (opens > 20 && shortOpens / opens > 0.05) flags.push(`jaw-too-fast ${shortOpens}/${opens}`);

  const window = Math.round(2000 / STEP_MS);
  let lo = 0;
  let worst = 0;
  for (let hi = 0; hi < openSteps.length; hi++) {
    while (openSteps[hi] - openSteps[lo] > window) lo++;
    worst = Math.max(worst, hi - lo + 1);
  }
  if (worst > MAX_CHOMPS_2S) flags.push(`chomp-rate ${worst}/2s`);

  return flags;
}

// ── Head track ──
// The browser sends the face tracker's head position, tilt and jaw (ten
// times a second, numbers only) next to the inputs. A real player's
// inputs are a function of that track; a script's are not, unless it
// also forges a believable head that agrees with every input.

/** The game's own control gains (src/main.ts). */
const STEER_GAIN = 2.6;
const ROLL_GAIN = 2.4;
const MAX_AIM = 1.05;
/** Leeway for the control pump's smoothing lag. */
const STEER_TOL = 0.15;
const AIM_TOL = 0.25;
/** Jaw clearly open / clearly shut (the game latches at 0.28 / 0.18). */
const JAW_OPEN = 0.4;
const JAW_SHUT = 0.1;
/** Below this share of agreeing samples, a control is flagged. */
const MIN_AGREE = 0.8;
/** Need at least this many usable samples to judge a control. */
const MIN_SAMPLES = 30;
const MAX_TRACK = 40_000;

type Sample = [number, number, number, number];

function parseTrack(raw: unknown): { calib: { headX: number; roll: number }; s: Sample[] } | null {
  const t = raw as { calib?: { headX?: unknown; roll?: unknown }; s?: unknown } | null;
  const headX = Number(t?.calib?.headX);
  const roll = Number(t?.calib?.roll);
  if (!Number.isFinite(headX) || !Number.isFinite(roll) || !Array.isArray(t?.s) || t.s.length > MAX_TRACK) return null;
  const s: Sample[] = [];
  let last = -1;
  for (const p of t.s as unknown[]) {
    if (!Array.isArray(p) || p.length !== 4) return null;
    const v = p.map(Number) as Sample;
    if (!v.every(Number.isInteger) || v[0] < last || v[3] < 0 || v[3] > 1000) return null;
    s.push(v);
    last = v[0];
  }
  return { calib: { headX, roll }, s };
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** Review flags from the head track against the scored inputs. */
export function trackFlags(inputs: SimInput[], raw: unknown): string[] {
  if (raw === undefined || raw === null) return ['no head track'];
  const track = parseTrack(raw);
  if (!track) return ['bad head track'];
  const { calib, s } = track;
  if (!s.length) return ['empty head track'];

  const seen = s.filter((x) => x[1] >= 0);
  const flags: string[] = [];
  const coverage = seen.length / s.length;
  if (coverage < 0.5) flags.push(`face out of view ${pct(1 - coverage)}`);
  if (calib.headX < 0.1 || calib.headX > 0.9) flags.push('odd calibration');

  let steerN = 0, steerOk = 0, aimN = 0, aimOk = 0, jawN = 0, jawOk = 0;
  for (const [step, hx, roll, jaw] of seen) {
    const input = inputs[Math.min(Math.max(step - 1, 0), inputs.length - 1)];
    if (!input) continue;
    const steer = Math.max(0, Math.min(1, 0.5 + (hx / 1000 - calib.headX) * STEER_GAIN));
    steerN++;
    if (Math.abs(steer - input.steer / 1000) <= STEER_TOL) steerOk++;
    const aim = Math.max(-MAX_AIM, Math.min(MAX_AIM, (roll / 1000 - calib.roll) * ROLL_GAIN));
    aimN++;
    if (Math.abs(aim - input.aim / 1000) <= AIM_TOL) aimOk++;
    const j = jaw / 1000;
    if (j >= JAW_OPEN || j <= JAW_SHUT) {
      jawN++;
      if ((j >= JAW_OPEN) === input.mouth) jawOk++;
    }
  }
  if (steerN >= MIN_SAMPLES && steerOk / steerN < MIN_AGREE) flags.push(`steer off head ${pct(1 - steerOk / steerN)}`);
  if (aimN >= MIN_SAMPLES && aimOk / aimN < MIN_AGREE) flags.push(`aim off tilt ${pct(1 - aimOk / aimN)}`);
  if (jawN >= MIN_SAMPLES && jawOk / jawN < MIN_AGREE) flags.push(`fire off jaw ${pct(1 - jawOk / jawN)}`);

  // A tracked human head never holds perfectly still, and never moves
  // perfectly smoothly: there's always tracker jitter on top of motion.
  if (seen.length >= MIN_SAMPLES) {
    let still = 0;
    let curve = 0;
    for (let i = 2; i < seen.length; i++) {
      const d1 = seen[i][1] - seen[i - 1][1];
      const d0 = seen[i - 1][1] - seen[i - 2][1];
      if (d1 === 0 && seen[i][2] === seen[i - 1][2]) still++;
      curve += Math.abs(d1 - d0);
    }
    if (still / (seen.length - 2) > 0.6) flags.push('head track frozen');
    else if (curve / (seen.length - 2) < 0.5) flags.push('head track too smooth');
  }
  return flags;
}
