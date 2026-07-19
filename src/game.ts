// ═════════════════════════════════════════════════════════════
// Ronke Rice Rush — game loop.
// One mode only: riceballs (onigiri) fall from the top; the player
// flicks their tongue out to catch them at the lick zone. Timing
// tiers (PERFECT / GOOD / LATE) by distance from the zone centre,
// combo multiplier, endless with lives. GOLD riceballs are rare
// and worth 3×. Missing a riceball (falls off screen) costs a life.
//
// The canvas is transparent — it sits above the camera feed and the
// ronke overlay canvas.
// ═════════════════════════════════════════════════════════════

import { buildRiceballBitmaps, type RiceballBitmaps, type RiceballType } from './riceballs';

export type CatchKind = 'perfect' | 'good' | 'late' | 'whiff' | 'miss';
export type GameState = 'idle' | 'playing' | 'over';

export interface GameConfig {
  lives: number;
  /** Base ms between spawns, shrinking over time down to minSpawnMs. */
  spawnIntervalMs: number;
  minSpawnMs: number;
  /** Fall speed in px/s at t=0 and its cap. */
  fallSpeedPx: number;
  fallSpeedPxMax: number;
  /** Per-second multiplier added to fall speed (ramp). */
  speedupPerSec: number;
  /** Extra speed bonus per catch — endless progression. */
  speedupPerCatch: number;
  /** Riceball sprite width in px (scaled from viewport at resize). */
  ballSize: number;
  /** Chance a spawn is GOLD. */
  goldChance: number;
  /** Max riceballs on screen at once, ramped by elapsed time. */
  concurrentCap: Array<{ untilMs: number; max: number }>;
  zone: {
    lateRadius: number;
    goodRadius: number;
    perfectRadius: number;
  };
  scoring: {
    perfect: number;
    good: number;
    late: number;
    goldMultiplier: number;
  };
  combo: Array<{ step: number; mul: number }>;
}

export const DEFAULT_GAME_CONFIG: GameConfig = {
  lives: 3,
  spawnIntervalMs: 1400,
  minSpawnMs: 450,
  fallSpeedPx: 170,
  fallSpeedPxMax: 700,
  speedupPerSec: 0.018,
  speedupPerCatch: 0.012,
  ballSize: 72,
  goldChance: 0.08,
  // Round opens one-at-a-time so the player finds the rhythm, then
  // tightens every 20s — same pacing lesson learned in Lick'em.
  concurrentCap: [
    { untilMs: 20_000, max: 1 },
    { untilMs: 40_000, max: 2 },
    { untilMs: 65_000, max: 3 },
    { untilMs: Infinity, max: 4 },
  ],
  zone: { lateRadius: 110, goodRadius: 72, perfectRadius: 40 },
  scoring: { perfect: 100, good: 60, late: 25, goldMultiplier: 3 },
  combo: [
    { step: 3, mul: 2 },
    { step: 6, mul: 3 },
    { step: 10, mul: 4 },
  ],
};

interface Riceball {
  x: number;
  y: number;
  vy: number; // px/s
  type: RiceballType;
  wobblePhase: number;
  caught: boolean;
  /** Catch animation clock (ms since catch) when caught. */
  catchAge: number;
}

interface Particle {
  x: number; y: number; vx: number; vy: number; age: number; life: number;
  color: string; size: number;
}

interface ScoreFloat {
  x: number; y: number; text: string; color: string; age: number;
}

export interface GameCallbacks {
  onCatch: (kind: CatchKind, points: number) => void;
  onLifeLost: (livesLeft: number) => void;
  onComboChange: (combo: number, mul: number) => void;
  onEnd: (score: number) => void;
}

export class Game {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: GameConfig;
  private cb: GameCallbacks;

  private state: GameState = 'idle';
  private balls: Riceball[] = [];
  private particles: Particle[] = [];
  private floats: ScoreFloat[] = [];
  private bitmaps: RiceballBitmaps;

  private score = 0;
  private lives = 0;
  private combo = 0;
  private catches = 0;
  private startedAt = 0;
  private lastSpawnAt = 0;
  private lastFrameAt = 0;
  private rafId = 0;

  // Lick zone (tongue tip) in canvas pixels. Driven externally every
  // frame from the projected detector state, or by touch.
  private zoneX = 0;
  private zoneY = 0;
  private zoneVisible = false;
  private tongueDetected = false;

  constructor(canvas: HTMLCanvasElement, config: GameConfig, cb: GameCallbacks) {
    this.canvas = canvas;
    this.config = config;
    this.cb = cb;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('game canvas 2d unsupported');
    this.ctx = ctx;
    this.bitmaps = buildRiceballBitmaps(config.ballSize * (window.devicePixelRatio || 1));
    this.resize();
    window.addEventListener('resize', this.resize);
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.resize);
  }

  private resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  getState(): GameState { return this.state; }
  getScore(): number { return this.score; }
  getLives(): number { return this.lives; }
  getCombo(): number { return this.combo; }

  comboMultiplier(): number {
    let mul = 1;
    for (const tier of this.config.combo) {
      if (this.combo >= tier.step) mul = tier.mul;
    }
    return mul;
  }

  /** Tongue-tip position in CSS pixels (canvas-local). */
  setZoneAbsolute(x: number, y: number): void {
    this.zoneX = x;
    this.zoneY = y;
    this.zoneVisible = true;
  }

  setZoneHidden(): void { this.zoneVisible = false; }

  /** Ring turns green while the tongue is out — pure visual state. */
  setTongueDetected(v: boolean): void { this.tongueDetected = v; }

  start(): void {
    this.state = 'playing';
    this.balls = [];
    this.particles = [];
    this.floats = [];
    this.score = 0;
    this.lives = this.config.lives;
    this.combo = 0;
    this.catches = 0;
    this.startedAt = performance.now();
    this.lastSpawnAt = 0;
    this.lastFrameAt = performance.now();
    cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.state = 'idle';
    cancelAnimationFrame(this.rafId);
    this.clearCanvas();
  }

  /**
   * Tongue flick (or touch tap). Catches the nearest un-caught riceball
   * within lateRadius of the zone; tier by distance. With no target in
   * range it's a whiff — no penalty, tiny visual only.
   */
  lick(x?: number, y?: number): void {
    if (this.state !== 'playing') return;
    const zx = x ?? this.zoneX;
    const zy = y ?? this.zoneY;

    let best: Riceball | null = null;
    let bestDist = Infinity;
    for (const b of this.balls) {
      if (b.caught) continue;
      const d = Math.hypot(b.x - zx, b.y - zy);
      if (d < bestDist) { bestDist = d; best = b; }
    }

    const { lateRadius, goodRadius, perfectRadius } = this.config.zone;
    if (!best || bestDist > lateRadius) {
      this.cb.onCatch('whiff', 0);
      this.spawnParticles(zx, zy, 4, '#9fb8d6');
      return;
    }

    let kind: CatchKind;
    let base: number;
    if (bestDist <= perfectRadius) { kind = 'perfect'; base = this.config.scoring.perfect; }
    else if (bestDist <= goodRadius) { kind = 'good'; base = this.config.scoring.good; }
    else { kind = 'late'; base = this.config.scoring.late; }

    this.combo++;
    const mul = this.comboMultiplier();
    const goldMul = best.type === 'gold' ? this.config.scoring.goldMultiplier : 1;
    const points = base * mul * goldMul;
    this.score += points;
    this.catches++;
    best.caught = true;
    best.catchAge = 0;

    const color = best.type === 'gold' ? '#ffd94a' : kind === 'perfect' ? '#7dffa0' : '#ffffff';
    this.spawnParticles(best.x, best.y, best.type === 'gold' ? 18 : 10, color);
    this.floats.push({
      x: best.x, y: best.y - 20,
      text: `+${points}${best.type === 'gold' ? ' 🌟' : ''}`,
      color, age: 0,
    });

    this.cb.onCatch(kind, points);
    this.cb.onComboChange(this.combo, mul);
  }

  // ── internals ──

  private currentCap(elapsed: number): number {
    for (const c of this.config.concurrentCap) {
      if (elapsed < c.untilMs) return c.max;
    }
    return this.config.concurrentCap[this.config.concurrentCap.length - 1].max;
  }

  private frame = (): void => {
    if (this.state !== 'playing') return;
    const now = performance.now();
    const dt = Math.min(50, now - this.lastFrameAt) / 1000;
    this.lastFrameAt = now;
    const elapsed = now - this.startedAt;

    // ── Spawning ──
    const spawnT = Math.max(
      this.config.minSpawnMs,
      this.config.spawnIntervalMs - elapsed * 0.008,
    );
    const active = this.balls.filter((b) => !b.caught).length;
    if (now - this.lastSpawnAt >= spawnT && active < this.currentCap(elapsed)) {
      this.lastSpawnAt = now;
      const w = this.canvas.clientWidth || window.innerWidth;
      const margin = this.config.ballSize;
      const speedMul =
        1 + (elapsed / 1000) * this.config.speedupPerSec + this.catches * this.config.speedupPerCatch;
      this.balls.push({
        x: margin + Math.random() * (w - margin * 2),
        y: -this.config.ballSize,
        vy: Math.min(this.config.fallSpeedPxMax, this.config.fallSpeedPx * speedMul),
        type: Math.random() < this.config.goldChance ? 'gold' : 'rice',
        wobblePhase: Math.random() * Math.PI * 2,
        caught: false,
        catchAge: 0,
      });
    }

    // ── Physics + miss detection ──
    const h = this.canvas.clientHeight || window.innerHeight;
    for (const b of this.balls) {
      if (b.caught) {
        b.catchAge += dt * 1000;
        continue;
      }
      b.y += b.vy * dt;
      b.wobblePhase += dt * 3;
      if (b.y > h + this.config.ballSize) {
        b.caught = true; // recycled below
        b.catchAge = 999; // no catch animation
        this.lives--;
        this.combo = 0;
        this.cb.onComboChange(0, 1);
        this.cb.onLifeLost(this.lives);
        this.cb.onCatch('miss', 0);
        if (this.lives <= 0) {
          this.endRound();
          return;
        }
      }
    }
    this.balls = this.balls.filter((b) => !b.caught || b.catchAge < 400);

    // ── Particles / floats ──
    for (const p of this.particles) {
      p.age += dt * 1000;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 500 * dt;
    }
    this.particles = this.particles.filter((p) => p.age < p.life);
    for (const f of this.floats) {
      f.age += dt * 1000;
      f.y -= 40 * dt;
    }
    this.floats = this.floats.filter((f) => f.age < 900);

    this.render();
    this.rafId = requestAnimationFrame(this.frame);
  };

  private endRound(): void {
    this.state = 'over';
    cancelAnimationFrame(this.rafId);
    this.render(); // final frame
    this.cb.onEnd(this.score);
  }

  private spawnParticles(x: number, y: number, n: number, color: string): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 80 + Math.random() * 220;
      this.particles.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 120,
        age: 0,
        life: 400 + Math.random() * 300,
        color,
        size: 3 + Math.random() * 4,
      });
    }
  }

  private clearCanvas(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.ctx.clearRect(0, 0, w, h);
  }

  private render(): void {
    const ctx = this.ctx;
    this.clearCanvas();

    // Riceballs
    const size = this.config.ballSize;
    for (const b of this.balls) {
      const bmp = this.bitmaps[b.type];
      ctx.save();
      if (b.caught && b.catchAge < 400) {
        // Pop-and-fade catch animation
        const t = b.catchAge / 400;
        ctx.globalAlpha = 1 - t;
        ctx.translate(b.x, b.y);
        ctx.scale(1 + t * 0.6, 1 + t * 0.6);
        ctx.rotate(t * 0.5);
        ctx.drawImage(bmp, -size / 2, -size / 2, size, size);
      } else if (!b.caught) {
        ctx.translate(b.x + Math.sin(b.wobblePhase) * 6, b.y);
        ctx.rotate(Math.sin(b.wobblePhase * 0.7) * 0.12);
        ctx.drawImage(bmp, -size / 2, -size / 2, size, size);
      }
      ctx.restore();
    }

    // Lick zone rings — centred on the tongue tip
    if (this.zoneVisible) {
      const { lateRadius, goodRadius, perfectRadius } = this.config.zone;
      const ringColor = this.tongueDetected ? 'rgba(125,255,160,' : 'rgba(255,217,74,';
      ctx.lineWidth = 3;
      ctx.strokeStyle = `${ringColor}0.85)`;
      ctx.beginPath();
      ctx.arc(this.zoneX, this.zoneY, perfectRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = `${ringColor}0.45)`;
      ctx.beginPath();
      ctx.arc(this.zoneX, this.zoneY, goodRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = `${ringColor}0.22)`;
      ctx.beginPath();
      ctx.arc(this.zoneX, this.zoneY, lateRadius, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Particles
    for (const p of this.particles) {
      ctx.globalAlpha = 1 - p.age / p.life;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    // Score floats
    ctx.textAlign = 'center';
    ctx.font = 'bold 26px "Comic Sans MS", "Comic Neue", cursive, sans-serif';
    for (const f of this.floats) {
      ctx.globalAlpha = 1 - f.age / 900;
      ctx.fillStyle = f.color;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 4;
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  }
}
