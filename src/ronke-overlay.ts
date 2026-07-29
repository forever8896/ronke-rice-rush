// ═════════════════════════════════════════════════════════════
// Ronke overlay — turns the player into Ronke the Monke.
// One head, two eye states, and a mouth WINDOW:
//
//   ronke-head.png          sleepy idle eyes
//   ronke-head-excited.png  wide excited eyes — shown while the
//                           player's tongue is out
//
// Both are Venice-generated (nano-banana edit chain from the
// canonical community art) with IDENTICAL head geometry, and both
// have a feathered mouth window baked into the PNG at build time.
// The player's REAL mouth and tongue are always visible through
// the window — that guarantees pixel-perfect tongue alignment,
// because the tongue on screen IS the video. Ronke reacts with
// his eyes, not his mouth.
//
// Tracking approach inherited from the Lick'em king overlay:
// single-anchor + lerp smoothing, because multi-landmark fits
// jitter more than one point smoothed at the lick-zone rate.
// Decorative only — game logic never reads this module.
// ═════════════════════════════════════════════════════════════

import type { MouthState } from './detection';

export interface RonkeOverlayState {
  /** Mouth anchor in viewport pixels (after lerp). Null until first detect. */
  x: number | null;
  y: number | null;
  /** Face width in viewport pixels — drives head scale. */
  width: number;
  /** Face roll in radians — drives rotation. */
  roll: number;
  /** 0..1 — fades out when face leaves frame. */
  alpha: number;
  /** True while the player's tongue is out → excited eyes. */
  licking: boolean;
  /** performance.now() of the last licking rising edge — drives the pop. */
  lickStartedAt: number;
}

export function makeRonkeOverlayState(): RonkeOverlayState {
  return { x: null, y: null, width: 0, roll: 0, alpha: 0, licking: false, lickStartedAt: 0 };
}

const POS_LERP = 0.32;
const SCALE_LERP = 0.18;
const ROLL_LERP = 0.22;
const ALPHA_LERP = 0.18;
/** Detection age past which the monke fades out. */
const FADE_AFTER_MS = 350;

// The head assets are the CANONICAL community art (ronkeverse logo,
// peach circle removed, 2× Lanczos to 512) — not a regeneration, so
// it can't drift off-model. The excited state is the same pixels with
// wide cartoon eyes painted over the sleepy lids (ImageMagick draw),
// keeping every other pixel identical.
//
// Anchor = the pink-lip centroid measured at (157,177) of the 256
// logo → (0.613, 0.690). Head width ≈ 0.75 of the frame, so 2.4×
// face width lands the head at ~1.8× the player's face on screen.
// The baked mouth window is centred just below the anchor and reaches
// far enough down that a fully extended tongue stays inside it.
const LIP_X = 0.613;
const LIP_Y = 0.690;
const HEAD_SCALE = 2.4;

/** Rising-edge "pop": brief scale-up so the eye swap lands with punch. */
const POP_MS = 140;
const POP_SCALE = 0.06;

function loadImage(src: string): { img: HTMLImageElement; ready: () => boolean } {
  const img = new Image();
  let ok = false;
  img.src = src;
  img.onload = (): void => { ok = true; };
  img.onerror = (): void => { ok = false; };
  return { img, ready: () => ok && img.naturalWidth > 0 };
}

const idleHead = loadImage('/ronke/ronke-head.png');
const excitedHead = loadImage('/ronke/ronke-head-excited.png');

/**
 * Update the smoothed overlay state from the current mouth state.
 * Call once per render frame; landmark inference is only ~10-15Hz so
 * the lerp is what makes motion silky. `project` converts normalized
 * video coords → viewport pixels (same projector as the lick zone so
 * the monke and the catch rings stay in lock-step).
 */
export function updateRonkeOverlay(
  state: RonkeOverlayState,
  mouth: MouthState,
  project: (xNorm: number, yNorm: number) => { x: number; y: number },
): void {
  const detectAge = performance.now() - mouth.lastDetectAt;
  const fresh = mouth.detected && detectAge < FADE_AFTER_MS;
  const targetAlpha = fresh ? 1 : 0;
  state.alpha += (targetAlpha - state.alpha) * ALPHA_LERP;

  // Excited eyes track the detector's mouth state; stamp the rising
  // edge for the scale pop.
  const licking = fresh && mouth.mouthOpen;
  if (licking && !state.licking) state.lickStartedAt = performance.now();
  state.licking = licking;

  if (!mouth.detected || !fresh) return;

  const anchor = project(mouth.centerX, mouth.centerY);
  const left = project(mouth.faceLeftX, mouth.faceLeftY);
  const right = project(mouth.faceRightX, mouth.faceRightY);

  const faceWidth = Math.hypot(right.x - left.x, right.y - left.y);
  const roll = Math.atan2(right.y - left.y, right.x - left.x);

  if (state.x === null || state.y === null) {
    state.x = anchor.x;
    state.y = anchor.y;
    state.width = faceWidth;
    state.roll = roll;
  } else {
    state.x += (anchor.x - state.x) * POS_LERP;
    state.y += (anchor.y - state.y) * POS_LERP;
    state.width += (faceWidth - state.width) * SCALE_LERP;
    // Wrap roll to nearest target so we don't take the long way at ±π.
    let rd = roll - state.roll;
    if (rd > Math.PI) rd -= 2 * Math.PI;
    if (rd < -Math.PI) rd += 2 * Math.PI;
    state.roll += rd * ROLL_LERP;
  }
}

/** Draw Ronke to `ctx`. No-op until visible and sized. */
export function paintRonke(ctx: CanvasRenderingContext2D, state: RonkeOverlayState): void {
  if (state.alpha < 0.02 || state.x === null || state.y === null) return;
  if (state.width <= 0) return;

  const fw = state.width;

  ctx.save();
  ctx.globalAlpha = state.alpha;
  ctx.translate(state.x, state.y);
  ctx.rotate(state.roll);

  // Brief pop on the tongue's rising edge — eases back over POP_MS.
  if (state.licking) {
    const t = (performance.now() - state.lickStartedAt) / POP_MS;
    if (t < 1) {
      const s = 1 + POP_SCALE * (1 - t) * (1 - t);
      ctx.scale(s, s);
    }
  }

  const face = state.licking && excitedHead.ready() ? excitedHead : idleHead;
  if (face.ready()) {
    const w = fw * HEAD_SCALE;
    const h = w * (face.img.naturalHeight / face.img.naturalWidth);
    // Position so Ronke's mouth window lands on the player's mouth (origin).
    ctx.drawImage(face.img, -w * LIP_X, -h * LIP_Y, w, h);
  } else {
    // Vector fallback for the first frames before the PNGs decode —
    // simple blue head band + ears so there's never a bare face.
    drawFallbackHead(ctx, fw);
  }

  ctx.restore();
}

const BLUE = '#3d7dc8';
const OUTLINE = '#14212f';

/** Minimal MSPaint-style stand-in used only while the PNGs load. */
function drawFallbackHead(ctx: CanvasRenderingContext2D, fw: number): void {
  const lw = Math.max(2.5, fw * 0.045);
  // Relative to the MOUTH anchor: dome centre sits well above it.
  const domeCy = -fw * 0.42;
  const domeR = fw * 0.62;
  const earY = domeCy + fw * 0.28;

  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(side * fw * 0.68, earY, fw * 0.22, 0, Math.PI * 2);
    ctx.fillStyle = BLUE;
    ctx.fill();
    ctx.lineWidth = lw;
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(0, domeCy + fw * 0.34, domeR, Math.PI * 1.08, Math.PI * 1.92);
  ctx.lineWidth = fw * 0.16;
  ctx.strokeStyle = BLUE;
  ctx.stroke();
}
