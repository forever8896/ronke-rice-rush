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
// This is a deterrent, not a proof. Anyone who models the pump and
// the jaw closely can pass it — which is why every top-3 run is
// watched before a prize is sent.
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
