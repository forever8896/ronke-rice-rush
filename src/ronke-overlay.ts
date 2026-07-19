// ═════════════════════════════════════════════════════════════
// Ronke overlay — turns the player into Ronke the Monke.
// The actual Ronke head (community art from ronkeverse.com,
// background-removed at build time → /ronke/ronke-head.png) is
// anchored to the player's MOUTH landmark, scaled by face width
// and rotated by the cheek-line roll. A feathered hole is punched
// over Ronke's lips every frame (destination-out) so the player's
// real mouth and tongue stay visible — the tongue is the
// controller, and seeing it come through Ronke's face IS the game.
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

// Ronke head PNG geometry — normalized coords in the 256×256 asset.
// LIP_* is the centre of Ronke's pink lips (measured pixel centroid of
// the pink region: 157,177); the image is drawn so this point lands
// exactly on the player's mouth, and the see-through hole is punched
// there.
const LIP_X = 0.613;
const LIP_Y = 0.690;
/** Drawn image width as a multiple of the player's face width. Big —
 *  Ronke is a gorilla; his head has to swallow the player's whole head. */
const HEAD_SCALE = 2.4;

const headImage = new Image();
headImage.src = '/ronke/ronke-head.png';
let headLoaded = false;
headImage.onload = (): void => { headLoaded = true; };
headImage.onerror = (): void => { headLoaded = false; };

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
 * Draw Ronke to `ctx` (the dedicated overlay canvas — the mouth hole is
 * punched with destination-out, which is only safe because nothing else
 * paints on this canvas). No-op until visible and sized.
 */
export function paintRonke(ctx: CanvasRenderingContext2D, state: RonkeOverlayState): void {
  if (state.alpha < 0.02 || state.x === null || state.y === null) return;
  if (state.width <= 0) return;

  const fw = state.width;

  ctx.save();
  ctx.globalAlpha = state.alpha;
  ctx.translate(state.x, state.y);
  ctx.rotate(state.roll);

  if (headLoaded && headImage.naturalWidth > 0) {
    const w = fw * HEAD_SCALE;
    const h = w * (headImage.naturalHeight / headImage.naturalWidth);
    // Position so Ronke's lips land on the player's mouth (the origin).
    ctx.drawImage(headImage, -w * LIP_X, -h * LIP_Y, w, h);

    // Punch the see-through mouth hole — feathered ellipse over the lips.
    const rx = fw * 0.34;
    const ry = fw * 0.26;
    const hole = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    hole.addColorStop(0, 'rgba(0,0,0,1)');
    hole.addColorStop(0.75, 'rgba(0,0,0,1)');
    hole.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.save();
    ctx.scale(rx, ry);
    ctx.fillStyle = hole;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
  } else {
    // Vector fallback for the first frames before the PNG decodes —
    // simple blue head band + ears so there's never a bare face.
    drawFallbackHead(ctx, fw);
  }

  ctx.restore();
}

const BLUE = '#3d7dc8';
const OUTLINE = '#14212f';

/** Minimal MSPaint-style stand-in used only while the PNG loads. */
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
