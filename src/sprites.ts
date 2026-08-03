// ═════════════════════════════════════════════════════════════
// Sprites — everything that isn't a generated PNG is drawn here,
// once, to offscreen canvases and blitted by the loop.
//
// MSPaint-meme style to match the Ronke art: flat fills, thick dark
// outlines, one cheeky highlight.
//
//   WOOD    plain barrel. One shot pops it. Hits the hull.
//   POWDER  black keg. Shoot it and it takes its neighbours with it.
//   SPIKE   iron-banded. Light shots ping off — needs a charged ball.
//   RICE    supply crate. DON'T shoot it: ram it with the hull to
//           patch a plank.
// ═════════════════════════════════════════════════════════════

export type BarrelKind = 'wood' | 'powder' | 'spike' | 'rice';

export type BarrelBitmaps = Record<BarrelKind, HTMLCanvasElement>;

const OUTLINE = '#1c1410';

function pad(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

/** Build every barrel sprite at the given pixel width (height = width). */
export function buildBarrelBitmaps(size: number): BarrelBitmaps {
  return {
    wood: drawBarrel(size, '#a9702f', '#8a5622', '#c98c44', '#6b6b6b'),
    powder: drawPowderKeg(size),
    spike: drawSpikeBarrel(size),
    rice: drawRiceCrate(size),
  };
}

/** A barrel lying on its side, rolling down at you. */
function drawBarrel(
  size: number,
  body: string,
  shade: string,
  light: string,
  hoop: string,
): HTMLCanvasElement {
  const c = pad(size);
  const ctx = c.getContext('2d')!;
  const w = size;
  const lw = Math.max(2, w * 0.045);
  ctx.lineJoin = 'round';

  // Bulging cylinder: two arcs top and bottom, straight-ish sides.
  const x0 = w * 0.14;
  const x1 = w * 0.86;
  const y0 = w * 0.10;
  const y1 = w * 0.90;
  const bulge = w * 0.10;

  const bodyPath = (): void => {
    ctx.beginPath();
    ctx.moveTo(x0, y0 + w * 0.06);
    ctx.quadraticCurveTo(w * 0.5, y0 - w * 0.05, x1, y0 + w * 0.06);
    ctx.quadraticCurveTo(x1 + bulge, w * 0.5, x1, y1 - w * 0.06);
    ctx.quadraticCurveTo(w * 0.5, y1 + w * 0.05, x0, y1 - w * 0.06);
    ctx.quadraticCurveTo(x0 - bulge, w * 0.5, x0, y0 + w * 0.06);
    ctx.closePath();
  };

  bodyPath();
  ctx.fillStyle = body;
  ctx.fill();

  // Staves + a light streak so the roll reads.
  ctx.save();
  ctx.clip();
  ctx.fillStyle = shade;
  ctx.fillRect(w * 0.62, 0, w * 0.4, w);
  ctx.fillStyle = light;
  ctx.fillRect(w * 0.24, 0, w * 0.09, w);
  ctx.strokeStyle = 'rgba(60,34,12,0.55)';
  ctx.lineWidth = lw * 0.5;
  for (const t of [0.34, 0.5, 0.68]) {
    ctx.beginPath();
    ctx.moveTo(w * t, 0);
    ctx.lineTo(w * t, w);
    ctx.stroke();
  }
  ctx.restore();

  // Iron hoops across the belly.
  ctx.strokeStyle = hoop;
  ctx.lineWidth = lw * 1.5;
  for (const t of [0.3, 0.7]) {
    ctx.beginPath();
    ctx.moveTo(x0 - bulge * 0.55, w * t);
    ctx.quadraticCurveTo(w * 0.5, w * t + w * 0.02, x1 + bulge * 0.55, w * t);
    ctx.stroke();
  }

  bodyPath();
  ctx.lineWidth = lw;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();
  return c;
}

/** Gunpowder keg — black, skull-stamped, fuse lit. Shoot it. */
function drawPowderKeg(size: number): HTMLCanvasElement {
  const c = drawBarrel(size, '#2f2b33', '#1c1a20', '#484350', '#8a1f1f');
  const ctx = c.getContext('2d')!;
  const w = size;

  // Skull stamp.
  ctx.fillStyle = '#f3efe4';
  ctx.strokeStyle = '#0f0d10';
  ctx.lineWidth = Math.max(1, w * 0.02);
  ctx.beginPath();
  ctx.ellipse(w * 0.5, w * 0.46, w * 0.15, w * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#f3efe4';
  ctx.beginPath();
  ctx.roundRect(w * 0.42, w * 0.58, w * 0.16, w * 0.08, w * 0.03);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#0f0d10';
  ctx.beginPath();
  ctx.ellipse(w * 0.445, w * 0.45, w * 0.037, w * 0.045, 0, 0, Math.PI * 2);
  ctx.ellipse(w * 0.555, w * 0.45, w * 0.037, w * 0.045, 0, 0, Math.PI * 2);
  ctx.fill();

  // Fuse + spark.
  ctx.strokeStyle = '#c9a227';
  ctx.lineWidth = Math.max(2, w * 0.05);
  ctx.beginPath();
  ctx.moveTo(w * 0.66, w * 0.16);
  ctx.quadraticCurveTo(w * 0.82, w * 0.08, w * 0.86, w * 0.2);
  ctx.stroke();
  ctx.fillStyle = '#ffca3a';
  ctx.beginPath();
  ctx.arc(w * 0.86, w * 0.2, w * 0.06, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ff7b2c';
  ctx.beginPath();
  ctx.arc(w * 0.86, w * 0.2, w * 0.035, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

/** Spiked iron barrel — light shots ping off it. */
function drawSpikeBarrel(size: number): HTMLCanvasElement {
  const c = pad(size);
  const ctx = c.getContext('2d')!;
  const w = size;
  const lw = Math.max(2, w * 0.045);
  ctx.lineJoin = 'round';

  // Spikes first so the body covers their roots.
  ctx.fillStyle = '#9aa3ad';
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = lw * 0.8;
  const spikes = 8;
  for (let i = 0; i < spikes; i++) {
    const a = (i / spikes) * Math.PI * 2 + 0.2;
    const r0 = w * 0.34;
    const r1 = w * 0.48;
    const spread = 0.16;
    ctx.beginPath();
    ctx.moveTo(w * 0.5 + Math.cos(a - spread) * r0, w * 0.5 + Math.sin(a - spread) * r0);
    ctx.lineTo(w * 0.5 + Math.cos(a) * r1, w * 0.5 + Math.sin(a) * r1);
    ctx.lineTo(w * 0.5 + Math.cos(a + spread) * r0, w * 0.5 + Math.sin(a + spread) * r0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  const body = drawBarrel(size, '#5b6570', '#3f4750', '#79838e', '#2b3138');
  ctx.drawImage(body, w * 0.09, w * 0.09, w * 0.82, w * 0.82);

  // Rivets.
  ctx.fillStyle = '#c3ccd4';
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = Math.max(1, w * 0.014);
  for (const t of [0.3, 0.7]) {
    for (const u of [0.3, 0.5, 0.7]) {
      ctx.beginPath();
      ctx.arc(w * u, w * t, w * 0.028, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
  return c;
}

/** Rice supply crate — ram it, don't shoot it. */
function drawRiceCrate(size: number): HTMLCanvasElement {
  const c = pad(size);
  const ctx = c.getContext('2d')!;
  const w = size;
  const lw = Math.max(2, w * 0.05);
  ctx.lineJoin = 'round';

  ctx.fillStyle = '#d8b871';
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.roundRect(w * 0.12, w * 0.16, w * 0.76, w * 0.68, w * 0.08);
  ctx.fill();
  ctx.stroke();

  // Slats.
  ctx.strokeStyle = 'rgba(90,62,18,0.55)';
  ctx.lineWidth = lw * 0.5;
  for (const t of [0.36, 0.56, 0.76]) {
    ctx.beginPath();
    ctx.moveTo(w * 0.14, w * t);
    ctx.lineTo(w * 0.86, w * t);
    ctx.stroke();
  }

  // Onigiri stamped on the lid: white triangle + nori band.
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = lw * 0.75;
  ctx.beginPath();
  ctx.moveTo(w * 0.5, w * 0.28);
  ctx.lineTo(w * 0.72, w * 0.66);
  ctx.lineTo(w * 0.28, w * 0.66);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#173318';
  ctx.fillRect(w * 0.4, w * 0.52, w * 0.2, w * 0.14);
  ctx.strokeRect(w * 0.4, w * 0.52, w * 0.2, w * 0.14);
  return c;
}

// ── Cannonballs ──

/** Player ball. `power` 0..1 grows it from pea-shooter to MIGHTY. */
export function drawCannonball(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  power: number,
  t: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  // Heat halo — a charged ball reads as molten.
  if (power > 0.5) {
    const glow = ctx.createRadialGradient(0, 0, r * 0.4, 0, 0, r * 2.4);
    glow.addColorStop(0, `rgba(255,170,60,${0.5 * power})`);
    glow.addColorStop(1, 'rgba(255,120,30,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, r * 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = power > 0.75 ? '#3a2a2a' : '#26262c';
  ctx.strokeStyle = '#0d0d10';
  ctx.lineWidth = Math.max(1.5, r * 0.22);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (power > 0.75) {
    // Cracked-molten seams on a mighty ball.
    ctx.strokeStyle = `rgba(255,140,40,${0.7 + Math.sin(t / 60) * 0.3})`;
    ctx.lineWidth = Math.max(1, r * 0.16);
    ctx.beginPath();
    ctx.moveTo(-r * 0.6, -r * 0.2);
    ctx.lineTo(-r * 0.1, r * 0.1);
    ctx.lineTo(r * 0.5, -r * 0.4);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.ellipse(-r * 0.35, -r * 0.38, r * 0.24, r * 0.16, -0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Enemy shot — a spiked black iron ball, unmistakably not yours. */
export function drawEnemyBall(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  spin: number,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(spin);
  ctx.fillStyle = '#7a1f2b';
  ctx.strokeStyle = '#2a0a10';
  ctx.lineWidth = Math.max(1.5, r * 0.2);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a - 0.3) * r * 0.8, Math.sin(a - 0.3) * r * 0.8);
    ctx.lineTo(Math.cos(a) * r * 1.5, Math.sin(a) * r * 1.5);
    ctx.lineTo(Math.cos(a + 0.3) * r * 0.8, Math.sin(a + 0.3) * r * 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = '#3a1018';
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,120,120,0.4)';
  ctx.beginPath();
  ctx.arc(-r * 0.3, -r * 0.3, r * 0.28, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ── The cannon (rotates with your head tilt) ──

/**
 * Ronke's deck gun. Drawn from the pivot outward along `angle`
 * (0 = straight up the screen, + = right), so it visualises the aim
 * axis the head tilt controls.
 */
export function drawCannon(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  angle: number,
  len: number,
  charge: number,
  flash: number,
): void {
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(angle);
  const barrelW = len * 0.34 * (1 + charge * 0.10);

  // Barrel — tapered, pointing "up" in local space (negative y).
  ctx.beginPath();
  ctx.moveTo(-barrelW * 0.5, len * 0.1);
  ctx.lineTo(-barrelW * 0.42, -len * 0.86);
  ctx.lineTo(-barrelW * 0.52, -len * 0.92);
  ctx.lineTo(barrelW * 0.52, -len * 0.92);
  ctx.lineTo(barrelW * 0.42, -len * 0.86);
  ctx.lineTo(barrelW * 0.5, len * 0.1);
  ctx.closePath();
  const g = ctx.createLinearGradient(-barrelW * 0.5, 0, barrelW * 0.5, 0);
  g.addColorStop(0, '#4c5560');
  g.addColorStop(0.4, '#2b3138');
  g.addColorStop(1, '#161a1f');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = '#0d1014';
  ctx.lineWidth = Math.max(2, len * 0.045);
  ctx.stroke();

  // Reinforcing rings.
  ctx.strokeStyle = '#5d6774';
  ctx.lineWidth = Math.max(1.5, len * 0.035);
  for (const t of [-0.28, -0.62]) {
    ctx.beginPath();
    ctx.moveTo(-barrelW * 0.52, len * t);
    ctx.lineTo(barrelW * 0.52, len * t);
    ctx.stroke();
  }

  // Muzzle glow while charging — the readout for "how mighty".
  if (charge > 0.02) {
    const my = -len * 0.92;
    const r = barrelW * (0.32 + charge * 0.7);
    const glow = ctx.createRadialGradient(0, my, 0, 0, my, r * 2.2);
    const hot = charge > 0.85;
    glow.addColorStop(0, hot ? 'rgba(255,255,220,0.95)' : `rgba(255,170,60,${0.35 + charge * 0.6})`);
    glow.addColorStop(0.45, `rgba(255,120,30,${0.35 * charge})`);
    glow.addColorStop(1, 'rgba(255,90,20,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, my, r * 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Muzzle flash on fire.
  if (flash > 0) {
    const my = -len * 0.94;
    ctx.globalAlpha = flash;
    ctx.fillStyle = '#ffe9a8';
    ctx.beginPath();
    ctx.moveTo(0, my - len * 0.5 * flash);
    for (let i = 1; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const rr = (i % 2 === 0 ? 0.34 : 0.16) * len * (0.6 + flash);
      ctx.lineTo(Math.sin(a) * rr, my - Math.cos(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,140,40,0.75)';
    ctx.beginPath();
    ctx.arc(0, my, len * 0.22 * (0.5 + flash), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

// ── Vector fallbacks (used until the generated PNGs decode) ──

/** Ronke's hull, pointing up the screen. */
export function drawHullFallback(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(0, -h * 0.5);
  ctx.quadraticCurveTo(w * 0.5, -h * 0.18, w * 0.44, h * 0.34);
  ctx.quadraticCurveTo(w * 0.4, h * 0.5, 0, h * 0.5);
  ctx.quadraticCurveTo(-w * 0.4, h * 0.5, -w * 0.44, h * 0.34);
  ctx.quadraticCurveTo(-w * 0.5, -h * 0.18, 0, -h * 0.5);
  ctx.closePath();
  ctx.fillStyle = '#a9702f';
  ctx.fill();
  ctx.lineWidth = Math.max(3, w * 0.055);
  ctx.strokeStyle = '#14212f';
  ctx.stroke();
  ctx.strokeStyle = '#3d7dc8';
  ctx.lineWidth = Math.max(2, w * 0.04);
  ctx.stroke();
  ctx.restore();
}

/** Generic pirate hull for the frames before its PNG lands. */
export function drawPirateFallback(
  ctx: CanvasRenderingContext2D, w: number, h: number, color: string,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(0, h * 0.5);
  ctx.quadraticCurveTo(w * 0.5, h * 0.18, w * 0.44, -h * 0.34);
  ctx.quadraticCurveTo(w * 0.4, -h * 0.5, 0, -h * 0.5);
  ctx.quadraticCurveTo(-w * 0.4, -h * 0.5, -w * 0.44, -h * 0.34);
  ctx.quadraticCurveTo(-w * 0.5, h * 0.18, 0, h * 0.5);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = Math.max(3, w * 0.05);
  ctx.strokeStyle = '#14212f';
  ctx.stroke();
  ctx.restore();
}

// ── PNG loading ──

export interface Sprite {
  img: HTMLImageElement;
  ready: () => boolean;
  /** Natural aspect (h/w), 1 until decoded. */
  ratio: () => number;
}

export function loadSprite(src: string): Sprite {
  const img = new Image();
  let ok = false;
  img.src = src;
  img.onload = (): void => { ok = true; };
  img.onerror = (): void => { console.warn(`[sprites] failed to load ${src}`); };
  return {
    img,
    ready: () => ok && img.naturalWidth > 0,
    ratio: () => (ok && img.naturalWidth > 0 ? img.naturalHeight / img.naturalWidth : 1),
  };
}
