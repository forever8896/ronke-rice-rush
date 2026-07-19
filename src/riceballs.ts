// ═════════════════════════════════════════════════════════════
// Riceball sprites — MSPaint-style onigiri drawn to offscreen
// canvases once and blitted by the game loop. Two types:
//   RICE — the standard onigiri. Catch it.
//   GOLD — golden $RICE onigiri, rare, worth 3×.
// Flat fills + thick dark outlines to match Ronke's MSPaint roots.
// ═════════════════════════════════════════════════════════════

export type RiceballType = 'rice' | 'gold';

export interface RiceballBitmaps {
  rice: HTMLCanvasElement;
  gold: HTMLCanvasElement;
}

/** Build both sprites at the given pixel width (height = width). */
export function buildRiceballBitmaps(size: number): RiceballBitmaps {
  return {
    rice: drawOnigiri(size, '#ffffff', '#f0efe8', '#1c1c1c'),
    gold: drawOnigiri(size, '#ffd94a', '#ffc31e', '#5a3a00', true),
  };
}

function drawOnigiri(
  size: number,
  fill: string,
  shade: string,
  outline: string,
  sparkle = false,
): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const w = size;
  const lw = Math.max(2, size * 0.05);

  // Rounded-triangle rice body. Points: top, bottom-left, bottom-right.
  const top = { x: w * 0.5, y: w * 0.10 };
  const bl = { x: w * 0.10, y: w * 0.82 };
  const br = { x: w * 0.90, y: w * 0.82 };
  const r = w * 0.16; // corner rounding

  ctx.beginPath();
  ctx.moveTo(top.x - r, top.y + r * 0.9);
  ctx.quadraticCurveTo(top.x, top.y - r * 0.4, top.x + r, top.y + r * 0.9);
  ctx.lineTo(br.x + r * 0.2, br.y - r);
  ctx.quadraticCurveTo(br.x + r * 0.5, br.y, br.x - r * 0.6, br.y);
  ctx.lineTo(bl.x + r * 0.6, bl.y);
  ctx.quadraticCurveTo(bl.x - r * 0.5, bl.y, bl.x - r * 0.2, bl.y - r);
  ctx.closePath();

  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = lw;
  ctx.strokeStyle = outline;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Right-side flat shade for a hint of volume (still MSPaint-flat).
  ctx.save();
  ctx.clip();
  ctx.fillStyle = shade;
  ctx.beginPath();
  ctx.moveTo(w * 0.62, w * 0.06);
  ctx.lineTo(w * 0.96, w * 0.86);
  ctx.lineTo(w * 0.62, w * 0.86);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Nori strip — dark rectangle across the bottom middle.
  const nw = w * 0.34;
  const nh = w * 0.30;
  ctx.fillStyle = '#173318';
  ctx.strokeStyle = outline;
  ctx.lineWidth = lw * 0.8;
  const nx = w * 0.5 - nw / 2;
  const ny = w * 0.82 - nh;
  ctx.fillRect(nx, ny, nw, nh);
  ctx.strokeRect(nx, ny, nw, nh);

  if (sparkle) {
    // Simple 4-point star sparkle, top-right — "this one's the $RICE".
    ctx.fillStyle = '#fffbe0';
    ctx.strokeStyle = '#5a3a00';
    ctx.lineWidth = Math.max(1, lw * 0.4);
    const sx = w * 0.78;
    const sy = w * 0.22;
    const sr = w * 0.11;
    ctx.beginPath();
    ctx.moveTo(sx, sy - sr);
    ctx.quadraticCurveTo(sx, sy, sx + sr, sy);
    ctx.quadraticCurveTo(sx, sy, sx, sy + sr);
    ctx.quadraticCurveTo(sx, sy, sx - sr, sy);
    ctx.quadraticCurveTo(sx, sy, sx, sy - sr);
    ctx.fill();
    ctx.stroke();
  }

  return c;
}
