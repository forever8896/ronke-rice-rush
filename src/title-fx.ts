// ═════════════════════════════════════════════════════════════
// Title ambience — riceballs drifting down behind the menu card,
// drawn on the (otherwise idle) ronke overlay canvas. Stopped the
// moment the camera overlay or a round owns the screen.
// ═════════════════════════════════════════════════════════════

import { buildRiceballBitmaps } from './riceballs';

interface Drifter {
  x: number;
  y: number;
  vy: number;
  sway: number;
  swayPhase: number;
  rot: number;
  rotV: number;
  size: number;
  gold: boolean;
}

let rafId = 0;
let running = false;
let drifters: Drifter[] = [];
let bitmaps: ReturnType<typeof buildRiceballBitmaps> | null = null;
let lastAt = 0;

function spawn(w: number, h: number, fromTop: boolean): Drifter {
  return {
    x: Math.random() * w,
    y: fromTop ? -60 : Math.random() * h,
    vy: 26 + Math.random() * 40,
    sway: 10 + Math.random() * 18,
    swayPhase: Math.random() * Math.PI * 2,
    rot: Math.random() * Math.PI * 2,
    rotV: (Math.random() - 0.5) * 0.8,
    size: 30 + Math.random() * 26,
    gold: Math.random() < 0.12,
  };
}

export function startTitleFx(canvas: HTMLCanvasElement): void {
  if (running) return;
  running = true;
  bitmaps ??= buildRiceballBitmaps(96);
  const ctx = canvas.getContext('2d');
  if (!ctx) { running = false; return; }

  const w = window.innerWidth;
  const h = window.innerHeight;
  drifters = Array.from({ length: 13 }, () => spawn(w, h, false));
  lastAt = performance.now();

  const tick = (): void => {
    if (!running) return;
    const now = performance.now();
    const dt = Math.min(60, now - lastAt) / 1000;
    lastAt = now;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    const dpr = window.devicePixelRatio || 1;
    ctx.scale(dpr, dpr);
    for (let i = 0; i < drifters.length; i++) {
      const d = drifters[i];
      d.y += d.vy * dt;
      d.swayPhase += dt * 1.4;
      d.rot += d.rotV * dt;
      if (d.y > vh + 60) drifters[i] = spawn(vw, vh, true);
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.translate(d.x + Math.sin(d.swayPhase) * d.sway, d.y);
      ctx.rotate(d.rot);
      ctx.drawImage(
        bitmaps![d.gold ? 'gold' : 'rice'],
        -d.size / 2, -d.size / 2, d.size, d.size,
      );
      ctx.restore();
    }
    ctx.restore();
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

export function stopTitleFx(canvas: HTMLCanvasElement): void {
  if (!running) return;
  running = false;
  cancelAnimationFrame(rafId);
  const ctx = canvas.getContext('2d');
  ctx?.clearRect(0, 0, canvas.width, canvas.height);
}
