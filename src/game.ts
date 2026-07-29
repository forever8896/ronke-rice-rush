// ═════════════════════════════════════════════════════════════
// Ronke Rice Rush — game loop.
// Riceballs (onigiri) fall from the top; the player flicks their
// tongue to catch them at the lick zone. Timing tiers (PERFECT /
// GOOD / LATE) by distance from the zone centre, combo multiplier,
// endless with lives.
//
//   GOLD riceballs — rare, worth 3×.
//   RUGs — do NOT lick: −points and combo break ("RUGGED!").
//          Letting them fall is free.
//   RONKE ARC — hit a 10-combo and 7 seconds of fever start:
//          double points, rice raining at double rate, no rugs.
//
// Pacing matched to the original Lick'em festival game (300px/s
// base fall, 900ms spawns tightening to 320ms, caps up to 6
// concurrent) — that speed curve is what made it frantic and fun.
//
// The canvas is transparent — it sits above the camera feed and the
// ronke overlay canvas.
// ═════════════════════════════════════════════════════════════

import { buildRiceballBitmaps, type RiceballBitmaps, type RiceballType } from './riceballs';

export type CatchKind = 'perfect' | 'good' | 'late' | 'whiff' | 'miss' | 'rug-hit';
export type GameState = 'idle' | 'playing' | 'over';

export interface GameConfig {
  lives: number;
  /** Base ms between spawns, shrinking over time down to minSpawnMs. */
  spawnIntervalMs: number;
  minSpawnMs: number;
  /** ms shaved off the spawn interval per elapsed ms (ramp slope). */
  spawnShrinkRate: number;
  /** Fall speed in px/s at t=0 and its cap. */
  fallSpeedPx: number;
  fallSpeedPxMax: number;
  /** Per-second multiplier added to fall speed (ramp). */
  speedupPerSec: number;
  /** Extra speed bonus per catch — endless progression. */
  speedupPerCatch: number;
  /** Riceball sprite width in px. */
  ballSize: number;
  /** Chance a spawn is GOLD. */
  goldChance: number;
  /** Chance a spawn is a RUG (0 before rugFromMs, ramping to max). */
  rugChanceMax: number;
  rugFromMs: number;
  /** Max items on screen at once, ramped by elapsed time. */
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
    rugPenalty: number;
  };
  combo: Array<{ step: number; mul: number }>;
  fever: {
    /** Combo count that triggers RONKE ARC (and every multiple of it). */
    triggerCombo: number;
    durationMs: number;
    pointsMul: number;
    /** Spawn-interval multiplier during fever (lower = denser rain). */
    spawnMul: number;
  };
}

export const DEFAULT_GAME_CONFIG: GameConfig = {
  lives: 3,
  spawnIntervalMs: 900,
  minSpawnMs: 320,
  spawnShrinkRate: 0.012,
  fallSpeedPx: 300,
  fallSpeedPxMax: 900,
  speedupPerSec: 0.026,
  speedupPerCatch: 0.012,
  ballSize: 76,
  goldChance: 0.08,
  rugChanceMax: 0.18,
  rugFromMs: 12_000,
  // Round opens one-at-a-time so the player finds the rhythm, then
  // tightens every 15s — the original's pacing lesson. By 60s the rice
  // is genuinely raining.
  concurrentCap: [
    { untilMs: 15_000, max: 1 },
    { untilMs: 30_000, max: 2 },
    { untilMs: 45_000, max: 3 },
    { untilMs: 60_000, max: 4 },
    { untilMs: Infinity, max: 6 },
  ],
  zone: { lateRadius: 110, goodRadius: 75, perfectRadius: 38 },
  scoring: { perfect: 150, good: 100, late: 50, goldMultiplier: 3, rugPenalty: -100 },
  combo: [
    { step: 3, mul: 2 },
    { step: 6, mul: 3 },
    { step: 10, mul: 4 },
  ],
  fever: { triggerCombo: 10, durationMs: 7_000, pointsMul: 2, spawnMul: 0.45 },
};

interface FallingItem {
  x: number;
  y: number;
  vy: number; // px/s
  type: RiceballType;
  wobblePhase: number;
  spin: number; // rugs tumble
  caught: boolean;
  /** Catch animation clock (ms since catch) when caught. */
  catchAge: number;
}

interface Particle {
  x: number; y: number; vx: number; vy: number; age: number; life: number;
  color: string; size: number;
  shape: 'grain' | 'square';
}

interface ScoreFloat {
  x: number; y: number; text: string; color: string; age: number;
}

export interface RoundStats {
  catches: number;
  bestCombo: number;
  rugsHit: number;
  goldCaught: number;
  fevers: number;
}

export interface GameCallbacks {
  onCatch: (kind: CatchKind, points: number, gold: boolean) => void;
  onLifeLost: (livesLeft: number) => void;
  onComboChange: (combo: number, mul: number) => void;
  onFever: (active: boolean) => void;
  onEnd: (score: number, stats: RoundStats) => void;
}

export class Game {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: GameConfig;
  private cb: GameCallbacks;

  private state: GameState = 'idle';
  private items: FallingItem[] = [];
  private particles: Particle[] = [];
  private floats: ScoreFloat[] = [];
  private bitmaps: RiceballBitmaps;

  private score = 0;
  private lives = 0;
  private combo = 0;
  private stats: RoundStats = { catches: 0, bestCombo: 0, rugsHit: 0, goldCaught: 0, fevers: 0 };
  private startedAt = 0;
  private lastSpawnAt = 0;
  private lastFrameAt = 0;
  private rafId = 0;

  // RONKE ARC fever state
  private feverUntil = 0;
  /** Combo value at which the last fever fired — prevents re-trigger
   *  until the player climbs another triggerCombo steps. */
  private lastFeverCombo = 0;

  // Lick zone (tongue tip) in canvas pixels.
  private zoneX = 0;
  private zoneY = 0;
  private zoneVisible = false;
  private tongueDetected = false;
  private zonePulse = 0; // catch flash clock for ring juice

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
  getStats(): Readonly<RoundStats> { return this.stats; }
  isFever(): boolean { return performance.now() < this.feverUntil; }
  /** 0..1 remaining fraction of the active fever, for the HUD bar. */
  feverFraction(): number {
    if (!this.isFever()) return 0;
    return (this.feverUntil - performance.now()) / this.config.fever.durationMs;
  }

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
    this.items = [];
    this.particles = [];
    this.floats = [];
    this.score = 0;
    this.lives = this.config.lives;
    this.combo = 0;
    this.stats = { catches: 0, bestCombo: 0, rugsHit: 0, goldCaught: 0, fevers: 0 };
    this.startedAt = performance.now();
    this.lastSpawnAt = 0;
    this.feverUntil = 0;
    this.lastFeverCombo = 0;
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
   * Tongue flick (or touch tap). Catches the nearest un-caught item
   * within lateRadius of the zone; tier by distance. Rugs in range get
   * caught too — that's the trap. With no target in range it's a
   * whiff — no penalty.
   */
  lick(x?: number, y?: number): void {
    if (this.state !== 'playing') return;
    const zx = x ?? this.zoneX;
    const zy = y ?? this.zoneY;

    let best: FallingItem | null = null;
    let bestDist = Infinity;
    for (const b of this.items) {
      if (b.caught) continue;
      const d = Math.hypot(b.x - zx, b.y - zy);
      if (d < bestDist) { bestDist = d; best = b; }
    }

    const { lateRadius, goodRadius, perfectRadius } = this.config.zone;
    if (!best || bestDist > lateRadius) {
      this.cb.onCatch('whiff', 0, false);
      this.spawnParticles(zx, zy, 4, '#cfe2f7', 'grain');
      return;
    }

    if (best.type === 'rug') {
      // RUGGED. Points down, combo gone, no life lost — the lesson is
      // aim, not punishment.
      best.caught = true;
      best.catchAge = 0;
      const penalty = this.config.scoring.rugPenalty;
      this.score = Math.max(0, this.score + penalty);
      this.combo = 0;
      this.stats.rugsHit++;
      this.spawnParticles(best.x, best.y, 14, '#c04848', 'square');
      this.floats.push({ x: best.x, y: best.y - 20, text: 'RUGGED!', color: '#ff5d5d', age: 0 });
      this.cb.onComboChange(0, 1);
      this.cb.onCatch('rug-hit', penalty, false);
      return;
    }

    let kind: CatchKind;
    let base: number;
    if (bestDist <= perfectRadius) { kind = 'perfect'; base = this.config.scoring.perfect; }
    else if (bestDist <= goodRadius) { kind = 'good'; base = this.config.scoring.good; }
    else { kind = 'late'; base = this.config.scoring.late; }

    this.combo++;
    this.stats.bestCombo = Math.max(this.stats.bestCombo, this.combo);
    const mul = this.comboMultiplier();
    const goldMul = best.type === 'gold' ? this.config.scoring.goldMultiplier : 1;
    const feverMul = this.isFever() ? this.config.fever.pointsMul : 1;
    const points = base * mul * goldMul * feverMul;
    this.score += points;
    this.stats.catches++;
    if (best.type === 'gold') this.stats.goldCaught++;
    best.caught = true;
    best.catchAge = 0;
    this.zonePulse = 1;

    // RONKE ARC — every `triggerCombo` catches past the last trigger.
    const ft = this.config.fever.triggerCombo;
    if (!this.isFever() && this.combo >= this.lastFeverCombo + ft) {
      this.lastFeverCombo = this.combo;
      this.feverUntil = performance.now() + this.config.fever.durationMs;
      this.stats.fevers++;
      this.cb.onFever(true);
    }

    const color = best.type === 'gold' ? '#ffd94a' : kind === 'perfect' ? '#7dffa0' : '#ffffff';
    this.spawnParticles(best.x, best.y, best.type === 'gold' ? 20 : 12, color, 'grain');
    this.floats.push({
      x: best.x, y: best.y - 20,
      text: `+${points}${best.type === 'gold' ? ' ★' : ''}`,
      color, age: 0,
    });

    this.cb.onCatch(kind, points, best.type === 'gold');
    this.cb.onComboChange(this.combo, mul);
  }

  // ── internals ──

  private currentCap(elapsed: number): number {
    for (const c of this.config.concurrentCap) {
      if (elapsed < c.untilMs) return c.max;
    }
    return this.config.concurrentCap[this.config.concurrentCap.length - 1].max;
  }

  private pickType(elapsed: number): RiceballType {
    if (!this.isFever() && elapsed >= this.config.rugFromMs) {
      // Rug share ramps in over 30s after unlock.
      const t = Math.min(1, (elapsed - this.config.rugFromMs) / 30_000);
      if (Math.random() < this.config.rugChanceMax * t) return 'rug';
    }
    const gold = this.isFever() ? this.config.goldChance * 2 : this.config.goldChance;
    return Math.random() < gold ? 'gold' : 'rice';
  }

  private frame = (): void => {
    if (this.state !== 'playing') return;
    const now = performance.now();
    const dt = Math.min(50, now - this.lastFrameAt) / 1000;
    this.lastFrameAt = now;
    const elapsed = now - this.startedAt;

    // Fever expiry
    if (this.feverUntil > 0 && now >= this.feverUntil) {
      this.feverUntil = 0;
      this.cb.onFever(false);
    }

    // ── Spawning ──
    let spawnT = Math.max(
      this.config.minSpawnMs,
      this.config.spawnIntervalMs - elapsed * this.config.spawnShrinkRate,
    );
    if (this.isFever()) spawnT *= this.config.fever.spawnMul;
    const active = this.items.filter((b) => !b.caught).length;
    const cap = this.isFever() ? this.currentCap(elapsed) + 2 : this.currentCap(elapsed);
    if (now - this.lastSpawnAt >= spawnT && active < cap) {
      this.lastSpawnAt = now;
      const w = this.canvas.clientWidth || window.innerWidth;
      const margin = this.config.ballSize;
      const speedMul =
        1 + (elapsed / 1000) * this.config.speedupPerSec + this.stats.catches * this.config.speedupPerCatch;
      const type = this.pickType(elapsed);
      this.items.push({
        x: margin + Math.random() * (w - margin * 2),
        y: -this.config.ballSize,
        vy: Math.min(this.config.fallSpeedPxMax, this.config.fallSpeedPx * speedMul)
          * (type === 'rug' ? 0.8 : 1),
        type,
        wobblePhase: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 2.4,
        caught: false,
        catchAge: 0,
      });
    }

    // ── Physics + miss detection ──
    const h = this.canvas.clientHeight || window.innerHeight;
    for (const b of this.items) {
      if (b.caught) {
        b.catchAge += dt * 1000;
        continue;
      }
      b.y += b.vy * dt;
      b.wobblePhase += dt * 3;
      if (b.y > h + this.config.ballSize) {
        b.caught = true; // recycled below
        b.catchAge = 999; // no catch animation
        if (b.type === 'rug') continue; // dodging rugs is free
        this.lives--;
        this.combo = 0;
        this.cb.onComboChange(0, 1);
        this.cb.onLifeLost(this.lives);
        this.cb.onCatch('miss', 0, false);
        if (this.lives <= 0) {
          this.endRound();
          return;
        }
      }
    }
    this.items = this.items.filter((b) => !b.caught || b.catchAge < 400);

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
    this.zonePulse = Math.max(0, this.zonePulse - dt * 3);

    this.render();
    this.rafId = requestAnimationFrame(this.frame);
  };

  private endRound(): void {
    this.state = 'over';
    if (this.feverUntil > 0) {
      this.feverUntil = 0;
      this.cb.onFever(false);
    }
    cancelAnimationFrame(this.rafId);
    this.render(); // final frame
    this.cb.onEnd(this.score, this.stats);
  }

  private spawnParticles(
    x: number, y: number, n: number, color: string, shape: 'grain' | 'square',
  ): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 90 + Math.random() * 260;
      this.particles.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 140,
        age: 0,
        life: 420 + Math.random() * 320,
        color,
        size: 3 + Math.random() * 4,
        shape,
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
    const fever = this.isFever();

    // Falling items
    const size = this.config.ballSize;
    for (const b of this.items) {
      const bmp = this.bitmaps[b.type];
      ctx.save();
      if (b.caught && b.catchAge < 400) {
        const t = b.catchAge / 400;
        ctx.globalAlpha = 1 - t;
        ctx.translate(b.x, b.y);
        ctx.scale(1 + t * 0.6, 1 + t * 0.6);
        ctx.rotate(t * 0.5);
        ctx.drawImage(bmp, -size / 2, -size / 2, size, size);
      } else if (!b.caught) {
        ctx.translate(b.x + Math.sin(b.wobblePhase) * 6, b.y);
        if (b.type === 'rug') {
          ctx.rotate(b.wobblePhase * 0.5 * b.spin);
        } else {
          ctx.rotate(Math.sin(b.wobblePhase * 0.7) * 0.12);
        }
        if (b.type === 'gold') {
          ctx.shadowColor = 'rgba(255,217,74,0.9)';
          ctx.shadowBlur = 18;
        }
        ctx.drawImage(bmp, -size / 2, -size / 2, size, size);
      }
      ctx.restore();
    }

    // Catch reticle — a living target, not a flat circle:
    //   · outer late ring: slow-rotating dashes
    //   · good ring: faint guide
    //   · perfect zone: breathing soft-glow disc + crisp ring that
    //     kicks outward on every catch (zonePulse)
    //   · centre: three rice grains, lit when a fire is armed
    // Colour = state: gold aiming, green when a flick will land
    // (armed semantics fed by main.ts), fire-orange during RONKE ARC.
    if (this.zoneVisible) {
      const { lateRadius, goodRadius, perfectRadius } = this.config.zone;
      const base = this.tongueDetected
        ? '125,255,160'
        : fever ? '255,170,60' : '255,217,74';
      const now = performance.now();
      const breathe = 1 + Math.sin(now / 420) * 0.045;
      const pulse = this.zonePulse;
      const zx = this.zoneX;
      const zy = this.zoneY;
      ctx.save();

      // Outer dashed ring, rotating slowly (counter-rotates in fever)
      ctx.setLineDash([10, 14]);
      ctx.lineDashOffset = (fever ? -now : now) / 24;
      ctx.lineWidth = 2;
      ctx.strokeStyle = `rgba(${base},0.28)`;
      ctx.beginPath();
      ctx.arc(zx, zy, lateRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Good ring — faint guide
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = `rgba(${base},0.30)`;
      ctx.beginPath();
      ctx.arc(zx, zy, goodRadius, 0, Math.PI * 2);
      ctx.stroke();

      // Perfect zone: soft glow disc
      const pr = (perfectRadius + pulse * 8) * breathe;
      const glow = ctx.createRadialGradient(zx, zy, 0, zx, zy, pr * 1.5);
      glow.addColorStop(0, `rgba(${base},${0.28 + pulse * 0.25})`);
      glow.addColorStop(0.7, `rgba(${base},0.10)`);
      glow.addColorStop(1, `rgba(${base},0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(zx, zy, pr * 1.5, 0, Math.PI * 2);
      ctx.fill();

      // Crisp perfect ring + corner ticks
      ctx.shadowColor = `rgba(${base},0.9)`;
      ctx.shadowBlur = 12 + pulse * 20;
      ctx.lineWidth = 3.5 + pulse * 2.5;
      ctx.strokeStyle = `rgba(${base},0.95)`;
      ctx.beginPath();
      ctx.arc(zx, zy, pr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 3;
      for (let i = 0; i < 4; i++) {
        const a = i * Math.PI / 2 + Math.PI / 4;
        ctx.beginPath();
        ctx.moveTo(zx + Math.cos(a) * (pr + 7), zy + Math.sin(a) * (pr + 7));
        ctx.lineTo(zx + Math.cos(a) * (pr + 15), zy + Math.sin(a) * (pr + 15));
        ctx.stroke();
      }

      // Centre grains — lit when the ring is green (flick will land)
      ctx.globalAlpha = this.tongueDetected ? 0.95 : 0.45;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 1.5;
      const grains: Array<[number, number, number]> = [
        [0, -4, -0.5], [-6, 4, 0.4], [6, 4, 1.2],
      ];
      for (const [gx, gy, rot] of grains) {
        ctx.save();
        ctx.translate(zx + gx, zy + gy);
        ctx.rotate(rot);
        ctx.beginPath();
        ctx.ellipse(0, 0, 5.5, 3, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // Particles
    for (const p of this.particles) {
      ctx.globalAlpha = 1 - p.age / p.life;
      ctx.fillStyle = p.color;
      if (p.shape === 'grain') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.vx * 0.01);
        ctx.beginPath();
        ctx.ellipse(0, 0, p.size * 0.8, p.size * 0.45, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else {
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
    }
    ctx.globalAlpha = 1;

    // Score floats
    ctx.textAlign = 'center';
    ctx.font = '800 28px "Baloo 2", sans-serif';
    for (const f of this.floats) {
      ctx.globalAlpha = 1 - f.age / 900;
      ctx.fillStyle = f.color;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = 5;
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  }
}
