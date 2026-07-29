// ═════════════════════════════════════════════════════════════
// Falling-item sprites — drawn once to offscreen canvases and
// blitted by the game loop. MSPaint-meme style: flat fills, thick
// dark outlines, one cheeky highlight.
//
//   RICE — standard onigiri. Catch it.
//   GOLD — golden $RICE onigiri, rare, worth 3×.
//   RUG  — a rolled-up rug. DO NOT LICK. (−points, combo break —
//          every Ronke knows the rug pull.)
// ═════════════════════════════════════════════════════════════

export type RiceballType = 'rice' | 'gold' | 'rug';

export type RiceballBitmaps = Record<RiceballType, HTMLCanvasElement>;

/** Build all sprites at the given pixel width (height = width). */
export function buildRiceballBitmaps(size: number): RiceballBitmaps {
  return {
    rice: drawOnigiri(size, '#ffffff', '#e9e6da', '#1c1c1c'),
    gold: drawOnigiri(size, '#ffd94a', '#f5b81e', '#5a3a00', true),
    rug: drawRug(size),
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

  // Rounded-triangle rice body.
  const top = { x: w * 0.5, y: w * 0.10 };
  const bl = { x: w * 0.10, y: w * 0.82 };
  const br = { x: w * 0.90, y: w * 0.82 };
  const r = w * 0.16;

  const bodyPath = (): void => {
    ctx.beginPath();
    ctx.moveTo(top.x - r, top.y + r * 0.9);
    ctx.quadraticCurveTo(top.x, top.y - r * 0.4, top.x + r, top.y + r * 0.9);
    ctx.lineTo(br.x + r * 0.2, br.y - r);
    ctx.quadraticCurveTo(br.x + r * 0.5, br.y, br.x - r * 0.6, br.y);
    ctx.lineTo(bl.x + r * 0.6, bl.y);
    ctx.quadraticCurveTo(bl.x - r * 0.5, bl.y, bl.x - r * 0.2, bl.y - r);
    ctx.closePath();
  };

  bodyPath();
  ctx.fillStyle = fill;
  ctx.fill();

  // Flat side-shade for volume.
  ctx.save();
  ctx.clip();
  ctx.fillStyle = shade;
  ctx.beginPath();
  ctx.moveTo(w * 0.60, w * 0.04);
  ctx.lineTo(w * 0.98, w * 0.86);
  ctx.lineTo(w * 0.60, w * 0.86);
  ctx.closePath();
  ctx.fill();
  // Cheek highlight — small soft wedge upper-left.
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.ellipse(w * 0.36, w * 0.30, w * 0.10, w * 0.055, -0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  bodyPath();
  ctx.lineWidth = lw;
  ctx.strokeStyle = outline;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Nori strip.
  const nw = w * 0.34;
  const nh = w * 0.30;
  const nx = w * 0.5 - nw / 2;
  const ny = w * 0.82 - nh;
  ctx.fillStyle = '#173318';
  ctx.fillRect(nx, ny, nw, nh);
  // Nori sheen line
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  ctx.fillRect(nx + nw * 0.14, ny + nh * 0.12, nw * 0.14, nh * 0.76);
  ctx.strokeStyle = outline;
  ctx.lineWidth = lw * 0.8;
  ctx.strokeRect(nx, ny, nw, nh);

  if (sparkle) {
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

/** Rolled-up rug, seen from the side — spiral end face + RUG tag so
 *  there's zero ambiguity about what not to lick. */
function drawRug(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const w = size;
  const lw = Math.max(2, w * 0.05);
  ctx.lineJoin = 'round';

  // Rug body — horizontal cylinder.
  const bx = w * 0.08;
  const by = w * 0.30;
  const bw = w * 0.72;
  const bh = w * 0.40;
  ctx.fillStyle = '#a03030';
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, bh * 0.18);
  ctx.fill();
  // Carpet pattern stripes
  ctx.fillStyle = '#7c1f1f';
  ctx.fillRect(bx + bw * 0.16, by, bw * 0.10, bh);
  ctx.fillRect(bx + bw * 0.48, by, bw * 0.10, bh);
  ctx.fillStyle = '#d8b34a';
  ctx.fillRect(bx + bw * 0.30, by, bw * 0.05, bh);
  ctx.fillRect(bx + bw * 0.62, by, bw * 0.05, bh);
  ctx.lineWidth = lw;
  ctx.strokeStyle = '#3a1010';
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, bh * 0.18);
  ctx.stroke();

  // Spiral end face (rolled side).
  const ex = bx + bw;
  const ey = by + bh / 2;
  const er = bh / 2;
  ctx.fillStyle = '#c04848';
  ctx.beginPath();
  ctx.ellipse(ex, ey, er * 0.55, er, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#3a1010';
  ctx.lineWidth = lw * 0.9;
  ctx.stroke();
  ctx.lineWidth = lw * 0.6;
  ctx.beginPath();
  ctx.ellipse(ex, ey, er * 0.32, er * 0.58, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(ex, ey, er * 0.12, er * 0.22, 0, 0, Math.PI * 2);
  ctx.stroke();

  // Fringe on the left end.
  ctx.strokeStyle = '#d8b34a';
  ctx.lineWidth = lw * 0.7;
  for (let i = 0; i < 4; i++) {
    const fy = by + bh * (0.15 + i * 0.23);
    ctx.beginPath();
    ctx.moveTo(bx, fy);
    ctx.lineTo(bx - w * 0.06, fy + w * 0.02);
    ctx.stroke();
  }

  // "RUG" tag hanging below — the unmissable label.
  const tx = w * 0.30;
  const ty = by + bh + w * 0.02;
  const tw = w * 0.34;
  const th = w * 0.17;
  ctx.strokeStyle = '#3a1010';
  ctx.lineWidth = lw * 0.5;
  ctx.beginPath();
  ctx.moveTo(tx + tw / 2, by + bh);
  ctx.lineTo(tx + tw / 2, ty + th * 0.2);
  ctx.stroke();
  ctx.fillStyle = '#f5ecd8';
  ctx.strokeStyle = '#3a1010';
  ctx.lineWidth = lw * 0.6;
  ctx.beginPath();
  ctx.roundRect(tx, ty, tw, th, th * 0.25);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#7c1f1f';
  ctx.font = `800 ${Math.round(th * 0.72)}px "Baloo 2", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('RUG', tx + tw / 2, ty + th * 0.56);

  return c;
}
