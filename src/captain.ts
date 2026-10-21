// ═════════════════════════════════════════════════════════════
// Captain Ronke — the head at the helm.
//
// This is the aim readout. The head rotates with the player's own
// head tilt, the cannon is bolted to the same axis, and the ball
// leaves the muzzle along it. Tilt your head, his head tilts, the
// gun swings. Nothing else on screen tells you where you're pointing
// as directly as a monke leaning into the shot.
//
// The head art is the canonical community logo (peach circle removed,
// 2× Lanczos to 512) with a feathered mouth window baked into the
// alpha channel, plus a wide-eyed variant for "charging". The badge
// art is drawn under the window so the hole shows Ronke's own snout —
// and the player's REAL mouth, sampled straight from the camera
// frame, is blitted into the middle of it. His face, your jaw.
//
// Decorative only: game logic never reads this module.
// ═════════════════════════════════════════════════════════════

import type { FaceState } from './detection';

// Mouth anchor inside the head PNG (pink-lip centroid, measured off
// the 256px logo at (157,177)).
const LIP_X = 0.613;
const LIP_Y = 0.690;
// The baked window: same x as the lip anchor, a touch lower, sized to
// just inside where the art turns opaque again.
const WINDOW_DY = 0.738 - LIP_Y;
const WINDOW_RX = 0.204;
const WINDOW_RY = 0.212;
// Lip patch radius as a fraction of HEAD width, resting → gaping.
const PATCH_RX_CLOSED = 0.113;
const PATCH_RX_OPEN = 0.148;
const PATCH_RY_RATIO = 0.9;
/** Untouched video out to INNER × radius, then feathered to clear. */
const PATCH_INNER = 0.72;
/** Half-width of the video crop, as a fraction of the player's face. */
const SRC_FACE_FRACTION = 0.34;
const TAU = Math.PI * 2;

function loadImage(src: string): { img: HTMLImageElement; ready: () => boolean } {
  const img = new Image();
  let ok = false;
  img.src = src;
  img.onload = (): void => { ok = true; };
  img.onerror = (): void => { console.warn(`[captain] failed to load ${src}`); };
  return { img, ready: () => ok && img.naturalWidth > 0 };
}

const idleHead = loadImage('/ronke/ronke-head.png');
const excitedHead = loadImage('/ronke/ronke-head-excited.png');
const filler = loadImage('/ronke/ronke-badge.png');

export interface CaptainDraw {
  /** Where his MOUTH sits, in canvas px (the cannon pivot). */
  x: number;
  y: number;
  /** Aim + rock, radians. 0 = upright. */
  angle: number;
  /** Head width in canvas px. */
  width: number;
  /** 0..1 — how far the jaw is open (drives the patch size). */
  open: number;
  /** Wide-eyed while charging. */
  charging: boolean;
  /** 0..1 recoil kick, shoves the head back down the deck. */
  recoil: number;
  /** Fades out when the face is lost. */
  alpha: number;
}

/** Scratch canvas the feathered lip patch is cut on. */
let patchPad: HTMLCanvasElement | null = null;

/**
 * Sample the player's mouth out of the live camera frame and return a
 * feathered, alpha-masked square of it. Null when the frame isn't
 * usable yet.
 */
function cutMouth(video: HTMLVideoElement, face: FaceState, size: number): HTMLCanvasElement | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh || size < 6) return null;

  // Crop a square around the mouth, proportional to the face so it
  // holds up at any distance from the camera.
  const half = Math.max(8, face.faceWidth * SRC_FACE_FRACTION * vw);
  const sx = face.mouthX * vw - half;
  const sy = face.mouthY * vh - half;

  if (!patchPad) patchPad = document.createElement('canvas');
  const px = Math.round(size);
  if (patchPad.width !== px || patchPad.height !== px) {
    patchPad.width = px;
    patchPad.height = px;
  }
  const p = patchPad.getContext('2d');
  if (!p) return null;
  p.setTransform(1, 0, 0, 1, 0, 0);
  p.clearRect(0, 0, px, px);
  try {
    p.drawImage(video, sx, sy, half * 2, half * 2, 0, 0, px, px);
  } catch {
    return null; // frame not decodable this tick
  }

  // Feather it into an ellipse so nothing reads as a pasted-on disc.
  p.save();
  p.globalCompositeOperation = 'destination-in';
  const r = px / 2;
  const mask = p.createRadialGradient(r, r, r * PATCH_INNER, r, r, r);
  mask.addColorStop(0, 'rgba(0,0,0,1)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  p.fillStyle = mask;
  p.fillRect(0, 0, px, px);
  p.restore();
  return patchPad;
}

/**
 * Paint the captain. Everything happens in his own rotated frame, so
 * the window, the snout filler and the lip patch stay locked together
 * however far the player tilts.
 */
export function paintCaptain(
  ctx: CanvasRenderingContext2D,
  d: CaptainDraw,
  video: HTMLVideoElement | null,
  face: FaceState | null,
): void {
  if (d.alpha < 0.02 || d.width <= 0) return;
  const head = d.charging && excitedHead.ready() ? excitedHead : idleHead;
  const headW = d.width;
  const headH = head.ready()
    ? headW * (head.img.naturalHeight / head.img.naturalWidth)
    : headW;

  ctx.save();
  ctx.globalAlpha = d.alpha;
  // Recoil shoves him back along his own axis, not down the screen.
  ctx.translate(
    d.x + Math.sin(d.angle) * -d.recoil * headW * 0.10,
    d.y + Math.cos(d.angle) * d.recoil * headW * 0.10,
  );
  ctx.rotate(d.angle);
  // The pivot is the deck point; shift so the HEAD is centred on it
  // while the mouth (and therefore the muzzle) stays on the axis.
  ctx.translate(headW * (LIP_X - 0.5), 0);

  if (!head.ready()) {
    drawFallbackHead(ctx, headW);
    ctx.restore();
    return;
  }

  const wcx = 0;
  const wcy = headH * WINDOW_DY;
  const wrx = headW * WINDOW_RX;
  const wry = headH * WINDOW_RY;

  // 1. Snout filler, visible only through the window.
  if (filler.ready()) {
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(wcx, wcy, wrx, wry, 0, 0, TAU);
    ctx.clip();
    ctx.drawImage(filler.img, -headW * LIP_X, -headH * LIP_Y, headW, headH);
    ctx.restore();
  }

  // 2. The head itself.
  ctx.drawImage(head.img, -headW * LIP_X, -headH * LIP_Y, headW, headH);

  // 3. The player's own mouth, blitted into the muzzle — or, with no
  //    camera (a replay), a drawn mouth that opens with the recorded jaw.
  if (!(video && face && face.detected)) {
    drawJaw(ctx, wcx, wcy, wrx, wry, d.open);
  } else {
    const rx = headW * (PATCH_RX_CLOSED + (PATCH_RX_OPEN - PATCH_RX_CLOSED) * d.open);
    const ry = rx * PATCH_RY_RATIO;
    const pad = cutMouth(video, face, Math.ceil(rx * 2 * (window.devicePixelRatio || 1)));
    if (pad) {
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(wcx, wcy, wrx, wry, 0, 0, TAU);
      ctx.clip();
      ctx.scale(-1, 1); // selfie mirror, so it moves the way he expects
      ctx.drawImage(pad, -rx, -ry, rx * 2, ry * 2);
      ctx.restore();
    }
  }

  ctx.restore();
}

/**
 * A cartoon jaw for when there's no camera to sample: a lip line at
 * rest, a dark gape with a tongue as `open` (0…1) grows. Sized to sit
 * inside the baked mouth window.
 */
function drawJaw(ctx: CanvasRenderingContext2D, cx: number, cy: number, wrx: number, wry: number, open: number): void {
  const o = Math.max(0, Math.min(1, open));
  const rx = wrx * (0.5 + 0.08 * o);
  ctx.save();
  if (o < 0.04) {
    // Closed: a soft lip line.
    ctx.beginPath();
    ctx.moveTo(cx - rx, cy);
    ctx.quadraticCurveTo(cx, cy + wry * 0.12, cx + rx, cy);
    ctx.lineWidth = Math.max(1.5, wry * 0.09);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#2a0a10';
    ctx.stroke();
    ctx.restore();
    return;
  }
  const ry = wry * (0.14 + 0.5 * o);
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
  ctx.fillStyle = '#3d0e18';
  ctx.fill();
  // Tongue, resting on the lower lip.
  ctx.save();
  ctx.clip();
  ctx.beginPath();
  ctx.ellipse(cx, cy + ry * 0.75, rx * 0.62, ry * 0.55, 0, 0, TAU);
  ctx.fillStyle = '#e46b7c';
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
  ctx.lineWidth = Math.max(1.5, wry * 0.08);
  ctx.strokeStyle = '#2a0a10';
  ctx.stroke();
  ctx.restore();
}

const BLUE = '#3d7dc8';
const OUTLINE = '#14212f';

/** MSPaint stand-in for the frames before the PNGs decode. */
function drawFallbackHead(ctx: CanvasRenderingContext2D, headW: number): void {
  const fw = headW / 3;
  const lw = Math.max(2.5, fw * 0.045);
  const domeCy = -fw * 0.42;
  const earY = domeCy + fw * 0.28;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(side * fw * 0.68, earY, fw * 0.22, 0, TAU);
    ctx.fillStyle = BLUE;
    ctx.fill();
    ctx.lineWidth = lw;
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(0, domeCy + fw * 0.34, fw * 0.62, Math.PI * 1.08, Math.PI * 1.92);
  ctx.lineWidth = fw * 0.16;
  ctx.strokeStyle = BLUE;
  ctx.stroke();
}
