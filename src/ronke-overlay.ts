// ═════════════════════════════════════════════════════════════
// Ronke overlay — turns the player into Ronke the Monke.
// MSPaint-style blue monke head frame (dome, tuft, big ears)
// drawn around the player's face, anchored to the MediaPipe
// forehead landmark (10) and rotated by the cheek-line roll.
// The player's own eyes and mouth stay visible — the tongue is
// the controller, so nothing may cover it.
//
// Tracking approach inherited from the Lick'em king overlay:
// single-anchor + lerp smoothing, because multi-landmark fits
// jitter more than one point smoothed at the lick-zone rate.
// Decorative only — game logic never reads this module.
// ═════════════════════════════════════════════════════════════

import type { MouthState } from './detection';

export interface RonkeOverlayState {
  /** Forehead anchor in viewport pixels (after lerp). Null until first detect. */
  x: number | null;
  y: number | null;
  /** Face width in viewport pixels — drives head scale. */
  width: number;
  /** Face roll in radians — drives rotation. */
  roll: number;
  /** 0..1 — fades out when face leaves frame. */
  alpha: number;
}

export function makeRonkeOverlayState(): RonkeOverlayState {
  return { x: null, y: null, width: 0, roll: 0, alpha: 0 };
}

const POS_LERP = 0.32;
const SCALE_LERP = 0.18;
const ROLL_LERP = 0.22;
const ALPHA_LERP = 0.18;
/** Detection age past which the monke fades out. */
const FADE_AFTER_MS = 350;

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

  if (!mouth.detected || !fresh) return;

  const fore = project(mouth.foreheadX, mouth.foreheadY);
  const left = project(mouth.faceLeftX, mouth.faceLeftY);
  const right = project(mouth.faceRightX, mouth.faceRightY);

  const faceWidth = Math.hypot(right.x - left.x, right.y - left.y);
  const roll = Math.atan2(right.y - left.y, right.x - left.x);

  if (state.x === null || state.y === null) {
    state.x = fore.x;
    state.y = fore.y;
    state.width = faceWidth;
    state.roll = roll;
  } else {
    state.x += (fore.x - state.x) * POS_LERP;
    state.y += (fore.y - state.y) * POS_LERP;
    state.width += (faceWidth - state.width) * SCALE_LERP;
    // Wrap roll to nearest target so we don't take the long way at ±π.
    let rd = roll - state.roll;
    if (rd > Math.PI) rd -= 2 * Math.PI;
    if (rd < -Math.PI) rd += 2 * Math.PI;
    state.roll += rd * ROLL_LERP;
  }
}

// Ronke's MSPaint palette — flat fills, thick outlines.
const BLUE = '#3d7dc8';
const BLUE_DARK = '#25577f';
const EAR_INNER = '#8fbde8';
const OUTLINE = '#14212f';

/**
 * Draw the monke head frame. Coordinates are relative to the forehead
 * anchor with +y down; everything scales off the face width so the
 * frame hugs any face size / camera distance.
 */
export function paintRonke(ctx: CanvasRenderingContext2D, state: RonkeOverlayState): void {
  if (state.alpha < 0.02 || state.x === null || state.y === null) return;
  if (state.width <= 0) return;

  const fw = state.width;
  const lw = Math.max(2.5, fw * 0.045); // MSPaint chunky outline

  ctx.save();
  ctx.globalAlpha = state.alpha;
  ctx.translate(state.x, state.y);
  ctx.rotate(state.roll);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // ── Ears — big blue circles with light inner disc, at cheek height ──
  const earR = fw * 0.24;
  const earX = fw * 0.68;
  const earY = fw * 0.30; // below the forehead anchor ≈ eye/cheek line
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(side * earX, earY, earR, 0, Math.PI * 2);
    ctx.fillStyle = BLUE;
    ctx.fill();
    ctx.lineWidth = lw;
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();
    // Inner ear
    ctx.beginPath();
    ctx.arc(side * earX, earY, earR * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = EAR_INNER;
    ctx.fill();
    ctx.lineWidth = lw * 0.6;
    ctx.stroke();
  }

  // ── Head dome — thick blue arc capping the skull above the brow ──
  // Drawn as a stroked band (not a filled dome) so the player's own
  // forehead/hair shows through the middle and the face stays theirs.
  const domeR = fw * 0.62;
  const domeCy = fw * 0.34; // circle centre sits below the anchor
  ctx.beginPath();
  ctx.arc(0, domeCy, domeR, Math.PI * 1.08, Math.PI * 1.92);
  ctx.lineWidth = fw * 0.16;
  ctx.strokeStyle = BLUE;
  ctx.stroke();
  // Outline edges of the band
  ctx.beginPath();
  ctx.arc(0, domeCy, domeR + fw * 0.08, Math.PI * 1.10, Math.PI * 1.90);
  ctx.lineWidth = lw * 0.7;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, domeCy, domeR - fw * 0.08, Math.PI * 1.13, Math.PI * 1.87);
  ctx.lineWidth = lw * 0.7;
  ctx.strokeStyle = BLUE_DARK;
  ctx.stroke();

  // ── Hair tuft — three chunky spikes on top of the dome ──
  const tuftBaseY = domeCy - domeR - fw * 0.05;
  ctx.fillStyle = BLUE;
  ctx.lineWidth = lw * 0.8;
  ctx.strokeStyle = OUTLINE;
  const spike = (x0: number, h: number, wSpike: number): void => {
    ctx.beginPath();
    ctx.moveTo(x0 - wSpike / 2, tuftBaseY + fw * 0.06);
    ctx.quadraticCurveTo(x0 - wSpike * 0.1, tuftBaseY - h, x0 + wSpike * 0.15, tuftBaseY - h);
    ctx.quadraticCurveTo(x0 + wSpike * 0.3, tuftBaseY - h * 0.4, x0 + wSpike / 2, tuftBaseY + fw * 0.06);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  };
  spike(-fw * 0.14, fw * 0.16, fw * 0.14);
  spike(0, fw * 0.22, fw * 0.15);
  spike(fw * 0.15, fw * 0.15, fw * 0.13);

  // ── Chin strap hint — short blue arcs framing the jaw sides so the
  //     head reads as wrapping the whole face, mouth left fully open ──
  ctx.lineWidth = fw * 0.10;
  ctx.strokeStyle = BLUE;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(0, domeCy, domeR, side === -1 ? Math.PI * 0.62 : Math.PI * 0.18, side === -1 ? Math.PI * 0.86 : Math.PI * 0.42);
    ctx.stroke();
  }

  ctx.restore();
}
