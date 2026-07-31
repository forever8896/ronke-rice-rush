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
// logo → (0.613, 0.690). Head width ≈ 0.75 of the frame, so 3.0×
// face width lands the head at ~2.25× the player's face on screen —
// deliberately oversized so the human head is fully swallowed by the
// monke and only the mouth reads through the baked window.
const LIP_X = 0.613;
const LIP_Y = 0.690;
const HEAD_SCALE = 3.0;

// ── Spotlight veil ──
// The player is a controller, not the subject: everything outside
// Ronke's head (room, torso, shoulders, whoever walked past) gets
// painted over in navy, with a soft hole around the head so the real
// mouth still reads through the window. Drawn on this canvas, so it
// sits above the video and below the riceballs.
const VEIL = 'rgba(9, 24, 44, 0.94)';
/** Veil opacity while no face is tracked — never a bare room. */
const VEIL_UNTRACKED = 0.88;
/** Hole radii as fractions of the drawn head width. */
const HOLE_INNER = 0.42;
const HOLE_OUTER = 0.70;

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

/**
 * Cover the camera feed in navy, punching a soft hole around the head
 * so only the tracked face shows through. `cx/cy` is the head centre;
 * pass nothing tracked yet and the whole frame is veiled.
 */
function paintVeil(
  ctx: CanvasRenderingContext2D,
  hole: { cx: number; cy: number; w: number; alpha: number } | null,
): void {
  const cw = ctx.canvas.clientWidth || ctx.canvas.width;
  const ch = ctx.canvas.clientHeight || ctx.canvas.height;

  ctx.save();
  ctx.globalAlpha = hole ? 1 : VEIL_UNTRACKED;
  ctx.fillStyle = VEIL;
  ctx.fillRect(0, 0, cw, ch);

  if (hole) {
    // Erase the veil over the head — fades in with the monke so a lost
    // face closes the hole instead of snapping the room back on.
    const g = ctx.createRadialGradient(
      hole.cx, hole.cy, hole.w * HOLE_INNER,
      hole.cx, hole.cy, hole.w * HOLE_OUTER,
    );
    g.addColorStop(0, `rgba(0, 0, 0, ${hole.alpha})`);
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cw, ch);
  }
  ctx.restore();
}

/** Draw the veil + Ronke to `ctx`. */
export function paintRonke(ctx: CanvasRenderingContext2D, state: RonkeOverlayState): void {
  if (state.x === null || state.y === null || state.width <= 0) {
    paintVeil(ctx, null); // no face yet — keep the room hidden
    return;
  }

  const fw = state.width;
  const headFace = state.licking && excitedHead.ready() ? excitedHead : idleHead;
  const headW = fw * HEAD_SCALE;
  const headH = headFace.ready()
    ? headW * (headFace.img.naturalHeight / headFace.img.naturalWidth)
    : headW;
  paintVeil(ctx, {
    cx: state.x + headW * (0.5 - LIP_X),
    cy: state.y + headH * (0.5 - LIP_Y),
    w: headW,
    alpha: state.alpha,
  });

  if (state.alpha < 0.02) return;

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

  if (headFace.ready()) {
    // Position so Ronke's mouth window lands on the player's mouth (origin).
    ctx.drawImage(headFace.img, -headW * LIP_X, -headH * LIP_Y, headW, headH);
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
