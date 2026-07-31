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
// The badge art fills that window back in with Ronke's own snout,
// and the player's REAL mouth is blitted into the middle of it —
// pixel-perfect by construction, because the mouth on screen IS the
// video. Ronke reacts with his eyes, not his mouth.
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
  /** 0..1 smoothed mouth-open amount — sizes the lip patch. */
  open: number;
  /** Where the video frame lands in canvas space, so the lip patch can
   *  be blitted from it. Width is negative — the feed is selfie-mirrored. */
  videoX: number;
  videoY: number;
  videoW: number;
  videoH: number;
}

export function makeRonkeOverlayState(): RonkeOverlayState {
  return {
    x: null, y: null, width: 0, roll: 0, alpha: 0, licking: false, lickStartedAt: 0, open: 0,
    videoX: 0, videoY: 0, videoW: 0, videoH: 0,
  };
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

// ── Snout filler + lip patch ──
// The player is a controller, not the subject, so the camera feed is
// hidden outright (html[data-ar] #video is transparent — it keeps
// playing for the detector) and the paddy art is the backdrop. Nothing
// is ever painted over Ronke or dimmed: the only piece of the player
// left on screen is their MOUTH, blitted from the video at full
// brightness into his muzzle.
//
// The baked window was measured off the head PNGs' alpha channel: an
// ellipse centred at (0.613, 0.738) of the image — same x as the lip
// anchor, a touch lower — clear by 0.137 × 0.143 of image width and
// opaque again by 0.209 × 0.217. That is wide enough to swallow the
// player's eyes and chin, which is the "too much human" problem, so
// the BADGE art (same canonical head, same framing, muzzle never
// punched out) is drawn underneath, clipped to the window. Ronke gets
// his snout back, and the only hole in it is a mouth-sized ellipse.
const WINDOW_DY = 0.738 - LIP_Y;
/** Window radii — just inside the point where the art turns opaque. */
const WINDOW_RX = 0.204;
const WINDOW_RY = 0.212;

/** Patch radii as fractions of FACE width: resting → chomping. A mouth
 *  is ~0.35 of face width, so 0.34 clears the whole lip line and the
 *  badge's painted lips underneath it. */
const LIP_RX_CLOSED = 0.34;
const LIP_RX_OPEN = 0.43;
/** Vertical squash of the patch — a mouth is wider than it is tall. */
const LIP_RY_RATIO = 0.9;
/** Patch is untouched video out to INNER × radius, then fades to clear
 *  by the rim, so nothing reads as a pasted-on disc. */
const LIP_INNER = 0.74;
/** How fast the patch follows the chomp (per frame lerp). */
const OPEN_LERP = 0.3;
const TAU = Math.PI * 2;

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
/** Same art, same framing, muzzle intact — drawn under the head so the
 *  baked window shows Ronke's snout instead of the player's face. */
const filler = loadImage('/ronke/ronke-badge.png');

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
  state.open += ((licking ? 1 : 0) - state.open) * OPEN_LERP;

  if (!mouth.detected || !fresh) return;

  // The video's drawn rect, from the same projector the zone uses —
  // corner to corner, so cover-crop and selfie mirror come along free.
  const v0 = project(0, 0);
  const v1 = project(1, 1);
  state.videoX = v0.x;
  state.videoY = v0.y;
  state.videoW = v1.x - v0.x; // negative: mirrored
  state.videoH = v1.y - v0.y;

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

/** Window/cavity centre in canvas space — straight below the lip
 *  anchor along the head's own axis, so it rides the roll. */
function windowCentre(
  state: RonkeOverlayState, headH: number,
): { x: number; y: number } {
  const dy = headH * WINDOW_DY;
  return {
    x: state.x! - Math.sin(state.roll) * dy,
    y: state.y! + Math.cos(state.roll) * dy,
  };
}

/** Scratch canvas the lip patch is cut on — a soft-edged blit needs an
 *  alpha mask, which means compositing somewhere other than the stage. */
let lipPad: HTMLCanvasElement | null = null;

/** Blit the player's mouth out of the video and into Ronke's muzzle
 *  window, at full brightness, on top. Clipped to the window, so it can
 *  never paint over the art; alpha-feathered at the rim so it blends
 *  into the PNG's own feather instead of reading as a pasted disc. */
function paintLips(
  ctx: CanvasRenderingContext2D,
  state: RonkeOverlayState,
  video: HTMLVideoElement,
  headW: number,
  headH: number,
): void {
  if (!video.videoWidth || !video.videoHeight || state.videoW === 0) return;

  // Patch rides the lip anchor (the filler art has Ronke's own mouth
  // there); the clip rides the window centre.
  const c = windowCentre(state, headH);
  const mx = state.x!;
  const my = state.y!;
  const rx = state.width * (LIP_RX_CLOSED + (LIP_RX_OPEN - LIP_RX_CLOSED) * state.open);
  const ry = rx * LIP_RY_RATIO;
  const pad = Math.ceil(Math.max(rx, ry)) + 2;
  const size = pad * 2;
  if (size < 4) return;

  if (!lipPad) lipPad = document.createElement('canvas');
  if (lipPad.width !== size || lipPad.height !== size) {
    lipPad.width = size;
    lipPad.height = size;
  }
  const lctx = lipPad.getContext('2d');
  if (!lctx) return;

  // Draw the live frame with the mouth centred in the pad …
  lctx.setTransform(1, 0, 0, 1, 0, 0);
  lctx.clearRect(0, 0, size, size);
  lctx.save();
  lctx.translate(pad - mx, pad - my);
  lctx.translate(state.videoX, state.videoY);
  lctx.scale(state.videoW / video.videoWidth, state.videoH / video.videoHeight);
  lctx.drawImage(video, 0, 0);
  lctx.restore();

  // … then keep only the feathered ellipse of it.
  lctx.save();
  lctx.globalCompositeOperation = 'destination-in';
  lctx.translate(pad, pad);
  lctx.rotate(state.roll);
  lctx.scale(1, ry / rx);
  const mask = lctx.createRadialGradient(0, 0, rx * LIP_INNER, 0, 0, rx);
  mask.addColorStop(0, 'rgba(0, 0, 0, 1)');
  mask.addColorStop(1, 'rgba(0, 0, 0, 0)');
  lctx.fillStyle = mask;
  lctx.fillRect(-rx, -rx, rx * 2, rx * 2);
  lctx.restore();

  ctx.save();
  ctx.globalAlpha = state.alpha;
  // Clip to the window — the guarantee that the art stays untouched.
  ctx.beginPath();
  ctx.ellipse(c.x, c.y, headW * WINDOW_RX, headH * WINDOW_RY, state.roll, 0, TAU);
  ctx.clip();
  ctx.drawImage(lipPad, mx - pad, my - pad);
  ctx.restore();
}

/** Draw Ronke — the head, then the player's mouth blitted into his
 *  muzzle window. `video` is the live feed the patch comes from; pass
 *  null and the window simply shows the backdrop. */
export function paintRonke(
  ctx: CanvasRenderingContext2D,
  state: RonkeOverlayState,
  video: HTMLVideoElement | null = null,
): void {
  if (state.x === null || state.y === null || state.width <= 0) return;
  if (state.alpha < 0.02) return;

  const fw = state.width;
  const headFace = state.licking && excitedHead.ready() ? excitedHead : idleHead;

  // Brief pop on the chomp's rising edge — eases back over POP_MS. It
  // scales the head SIZE (not the canvas) so the cavity and the lip
  // patch stay locked to the window through the pop.
  let pop = 1;
  if (state.licking) {
    const t = (performance.now() - state.lickStartedAt) / POP_MS;
    if (t < 1) pop = 1 + POP_SCALE * (1 - t) * (1 - t);
  }
  const headW = fw * HEAD_SCALE * pop;
  const headH = (headFace.ready()
    ? headW * (headFace.img.naturalHeight / headFace.img.naturalWidth)
    : headW);

  // Filler pass: the badge art at the same geometry, clipped to the
  // window. It only ever shows THROUGH the window, so Ronke's snout
  // fills what would otherwise be a face-sized hole.
  if (headFace.ready() && filler.ready()) {
    const c = windowCentre(state, headH);
    ctx.save();
    ctx.globalAlpha = state.alpha;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, headW * WINDOW_RX, headH * WINDOW_RY, state.roll, 0, TAU);
    ctx.clip();
    ctx.translate(state.x, state.y);
    ctx.rotate(state.roll);
    ctx.drawImage(filler.img, -headW * LIP_X, -headH * LIP_Y, headW, headH);
    ctx.restore();
  }

  ctx.save();
  ctx.globalAlpha = state.alpha;
  ctx.translate(state.x, state.y);
  ctx.rotate(state.roll);
  if (headFace.ready()) {
    // Position so Ronke's mouth window lands on the player's mouth (origin).
    ctx.drawImage(headFace.img, -headW * LIP_X, -headH * LIP_Y, headW, headH);
  } else {
    // Vector fallback for the first frames before the PNGs decode —
    // simple blue head band + ears so there's never a bare face.
    drawFallbackHead(ctx, fw);
  }
  ctx.restore();

  if (video && headFace.ready()) paintLips(ctx, state, video, headW, headH);
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
