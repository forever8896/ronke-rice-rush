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
//          double points, denser rice, no rugs — and NOTHING can
//          kill you: rice that falls during the arc (or that the arc
//          spawned) sinks for free, no life and no combo break. The
//          arc rains faster than any mouth can chomp, so charging a
//          life per uneaten grain just ended runs on the spot.
//
// Pacing matched to the original Lick'em festival game (300px/s
// base fall, 900ms spawns tightening to 320ms, caps up to 6
// concurrent) — that speed curve is what made it frantic and fun.
//
// The canvas is transparent — it sits above the camera feed and the
// ronke overlay canvas.
// ═════════════════════════════════════════════════════════════

import { buildRiceballBitmaps, type RiceballBitmaps, type RiceballType } from './riceballs';

export type CatchKind =
  | 'perfect' | 'good' | 'late' | 'whiff' | 'miss' | 'rug-hit'
  | 'big-hit' | 'big-burst' | 'hat-catch' | 'hat-save';
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
  /** Paddy field strip height at the bottom — rice that reaches the
   *  water is gone (splash + life). */
  fieldHeight: number;
  /** Hit-stop freeze on perfect / gold catches, ms. */
  hitStopMs: number;
  /** Horizontal drift ramps in after this ms, up to maxDriftPx/s. */
  driftFromMs: number;
  maxDriftPx: number;
  /** Wave spawns: N quick riceballs, every waveEveryMs±jitter after waveFromMs. */
  waveFromMs: number;
  waveEveryMs: number;
  waveSize: number;
  /** BIG onigiri: slow feast, needs bigHp chomps, bursts for bigBonus. */
  bigFromMs: number;
  bigEveryMs: number;
  bigHp: number;
  bigChompPoints: number;
  bigBonus: number;
  /** Kasa hat: eat it to wear it — absorbs one missed riceball. */
  hatFromMs: number;
  hatEveryMs: number;
  fever: {
    /** Combo count that triggers RONKE ARC (and every multiple of it). */
    triggerCombo: number;
    durationMs: number;
    pointsMul: number;
    /** Spawn-interval multiplier during fever (lower = denser rain). */
    spawnMul: number;
    /** Floor on the fever spawn interval — past this the rain stops
     *  reading as rain and turns into an unreadable wall. */
    minSpawnMs: number;
    /** Extra concurrent items allowed while the arc is up. */
    capBonus: number;
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
  fieldHeight: 76,
  hitStopMs: 60,
  driftFromMs: 30_000,
  maxDriftPx: 70,
  waveFromMs: 20_000,
  waveEveryMs: 11_000,
  waveSize: 3,
  bigFromMs: 25_000,
  bigEveryMs: 34_000,
  bigHp: 3,
  bigChompPoints: 80,
  bigBonus: 300,
  hatFromMs: 15_000,
  hatEveryMs: 42_000,
  fever: {
    triggerCombo: 10,
    durationMs: 7_000,
    pointsMul: 2,
    spawnMul: 0.7,
    minSpawnMs: 240,
    capBonus: 1,
  },
};

interface FallingItem {
  x: number;
  y: number;
  vy: number; // px/s
  type: RiceballType;
  wobblePhase: number;
  spin: number; // rugs tumble
  /** Horizontal drift phase seed — real movement, ramps with time. */
  driftPhase: number;
  caught: boolean;
  /** Catch animation clock (ms since catch) when caught. */
  catchAge: number;
  /** True once it splashed into the paddy (sinking render). */
  splashed: boolean;
  /** BIG onigiri: chomps remaining. 0 = regular item. */
  hp: number;
  big: boolean;
  /** Spawned during a RONKE ARC — missing it never costs a life, even
   *  if it lands after the arc has ended. */
  arc: boolean;
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
  bigBursts: number;
  hatSaves: number;
}

export interface GameCallbacks {
  onCatch: (kind: CatchKind, points: number, gold: boolean) => void;
  onLifeLost: (livesLeft: number) => void;
  onComboChange: (combo: number, mul: number) => void;
  onFever: (active: boolean) => void;
  /** Kasa shield picked up (true) or consumed (false). */
  onShield: (held: boolean) => void;
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
  private stats: RoundStats = {
    catches: 0, bestCombo: 0, rugsHit: 0, goldCaught: 0, fevers: 0, bigBursts: 0, hatSaves: 0,
  };
  private startedAt = 0;
  private lastSpawnAt = 0;
  private lastFrameAt = 0;
  private rafId = 0;

  // Juice + pacing state
  private hitStopUntil = 0;
  private nextWaveAt = 0;
  private nextBigAt = 0;
  private nextHatAt = 0;
  private shieldHeld = false;
  private pendingWave: Array<{ at: number; x: number; type: RiceballType }> = [];
  private ripples: Array<{ x: number; y: number; age: number }> = [];
  private fieldSway = 0;

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
  hasShield(): boolean { return this.shieldHeld; }
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
    this.stats = {
      catches: 0, bestCombo: 0, rugsHit: 0, goldCaught: 0, fevers: 0, bigBursts: 0, hatSaves: 0,
    };
    this.startedAt = performance.now();
    this.lastSpawnAt = 0;
    this.hitStopUntil = 0;
    this.nextWaveAt = 0;
    this.nextBigAt = 0;
    this.nextHatAt = 0;
    this.shieldHeld = false;
    this.pendingWave = [];
    this.ripples = [];
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
   * Chomp. Catches the nearest un-caught item within lateRadius of
   * the zone; tier by distance. Rugs in range get
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

    if (best.type === 'hat') {
      best.caught = true;
      best.catchAge = 0;
      this.shieldHeld = true;
      this.nextHatAt = 0; // re-offer clock restarts after it's consumed
      this.zonePulse = 1;
      this.spawnParticles(best.x, best.y, 10, '#d8b34a', 'grain');
      this.floats.push({ x: best.x, y: best.y - 20, text: 'KASA!', color: '#d8b34a', age: 0 });
      this.cb.onShield(true);
      this.cb.onCatch('hat-catch', 0, false);
      return;
    }

    if (best.big) {
      // Feast: each chomp bites a chunk; the last one bursts it.
      best.hp--;
      this.combo++;
      this.stats.bestCombo = Math.max(this.stats.bestCombo, this.combo);
      const mul = this.comboMultiplier();
      const feverMul = this.isFever() ? this.config.fever.pointsMul : 1;
      this.zonePulse = 1;
      if (best.hp <= 0) {
        best.caught = true;
        best.catchAge = 0;
        const points = this.config.bigBonus * mul * feverMul;
        this.score += points;
        this.stats.catches++;
        this.stats.bigBursts++;
        this.hitStopUntil = performance.now() + this.config.hitStopMs * 1.6;
        this.spawnParticles(best.x, best.y, 26, '#ffffff', 'grain');
        this.floats.push({ x: best.x, y: best.y - 26, text: `+${points} FEAST!`, color: '#7dffa0', age: 0 });
        this.cb.onCatch('big-burst', points, false);
      } else {
        const points = this.config.bigChompPoints * mul * feverMul;
        this.score += points;
        this.hitStopUntil = performance.now() + this.config.hitStopMs * 0.7;
        this.spawnParticles(best.x, best.y, 8, '#ffffff', 'grain');
        this.floats.push({ x: best.x, y: best.y - 20, text: `+${points}`, color: '#ffffff', age: 0 });
        this.cb.onCatch('big-hit', points, false);
      }
      this.cb.onComboChange(this.combo, this.comboMultiplier());
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
    if (bestDist <= perfectRadius || best.type === 'gold') {
      // Hit-stop: a heartbeat of frozen time sells the impact.
      this.hitStopUntil = performance.now()
        + this.config.hitStopMs * (best.type === 'gold' ? 1.6 : 1);
    }
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

  private spawnItem(type: RiceballType, x: number, elapsed: number, big = false): void {
    const speedMul =
      1 + (elapsed / 1000) * this.config.speedupPerSec + this.stats.catches * this.config.speedupPerCatch;
    const slow = type === 'rug' ? 0.8 : type === 'hat' ? 0.7 : big ? 0.5 : 1;
    this.items.push({
      x,
      y: -this.config.ballSize * (big ? 1.7 : 1),
      vy: Math.min(this.config.fallSpeedPxMax, this.config.fallSpeedPx * speedMul) * slow,
      type,
      wobblePhase: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 2.4,
      driftPhase: Math.random() * Math.PI * 2,
      caught: false,
      catchAge: 0,
      splashed: false,
      hp: big ? this.config.bigHp : 0,
      big,
      arc: this.isFever(),
    });
  }

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
    // Hit-stop: render but freeze simulation for a few frames.
    if (now < this.hitStopUntil) {
      this.lastFrameAt = now;
      this.render();
      this.rafId = requestAnimationFrame(this.frame);
      return;
    }
    const dt = Math.min(50, now - this.lastFrameAt) / 1000;
    this.lastFrameAt = now;
    const elapsed = now - this.startedAt;
    this.fieldSway += dt;

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
    if (this.isFever()) {
      spawnT = Math.max(this.config.fever.minSpawnMs, spawnT * this.config.fever.spawnMul);
    }
    const active = this.items.filter((b) => !b.caught).length;
    const cap = this.currentCap(elapsed) + (this.isFever() ? this.config.fever.capBonus : 0);
    const w = this.canvas.clientWidth || window.innerWidth;
    const margin = this.config.ballSize;
    if (now - this.lastSpawnAt >= spawnT && active < cap) {
      this.lastSpawnAt = now;
      this.spawnItem(this.pickType(elapsed), margin + Math.random() * (w - margin * 2), elapsed);
    }

    // ── Wave spawns: a quick fan of rice, readable and generous ──
    if (elapsed >= this.config.waveFromMs && !this.isFever()) {
      if (this.nextWaveAt === 0) {
        this.nextWaveAt = now + this.config.waveEveryMs;
      } else if (now >= this.nextWaveAt) {
        this.nextWaveAt = now + this.config.waveEveryMs + Math.random() * 5000;
        const dir = Math.random() < 0.5 ? 1 : -1;
        const x0 = dir === 1 ? margin : w - margin;
        const step = ((w - margin * 2) / (this.config.waveSize + 1)) * dir;
        for (let i = 0; i < this.config.waveSize; i++) {
          this.pendingWave.push({
            at: now + i * 170,
            x: x0 + step * (i + 1),
            // one gold guarantee per wave keeps waves worth chasing
            type: i === this.config.waveSize - 1 ? 'gold' : 'rice',
          });
        }
      }
    }
    while (this.pendingWave.length > 0 && now >= this.pendingWave[0].at) {
      const p = this.pendingWave.shift()!;
      if (this.items.filter((b) => !b.caught).length < cap + 3) {
        this.spawnItem(p.type, p.x, elapsed);
      }
    }

    // ── BIG onigiri — a slow feast on a timer (cap-exempt) ──
    if (elapsed >= this.config.bigFromMs && !this.isFever()) {
      if (this.nextBigAt === 0) this.nextBigAt = now + this.config.bigEveryMs * 0.5;
      else if (now >= this.nextBigAt) {
        this.nextBigAt = now + this.config.bigEveryMs + Math.random() * 8000;
        this.spawnItem('rice', margin + Math.random() * (w - margin * 2), elapsed, true);
      }
    }
    // ── Kasa hat — only offered while not already worn ──
    if (elapsed >= this.config.hatFromMs && !this.shieldHeld) {
      if (this.nextHatAt === 0) this.nextHatAt = now + this.config.hatEveryMs * 0.4;
      else if (now >= this.nextHatAt) {
        this.nextHatAt = now + this.config.hatEveryMs + Math.random() * 10000;
        this.spawnItem('hat', margin + Math.random() * (w - margin * 2), elapsed);
      }
    }

    // ── Physics + the paddy takes what you don't eat ──
    const h = this.canvas.clientHeight || window.innerHeight;
    const waterY = h - this.config.fieldHeight * 0.55;
    // Horizontal drift ramps in over 25s after driftFromMs.
    const driftAmp = this.config.maxDriftPx *
      Math.min(1, Math.max(0, (elapsed - this.config.driftFromMs) / 25_000));
    for (const b of this.items) {
      if (b.caught) {
        b.catchAge += dt * 1000;
        continue;
      }
      b.y += b.vy * dt;
      b.wobblePhase += dt * 3;
      if (driftAmp > 0) {
        b.driftPhase += dt * 1.1;
        b.x += Math.sin(b.driftPhase) * driftAmp * dt;
        b.x = Math.max(margin * 0.6, Math.min(w - margin * 0.6, b.x));
      }
      if (b.y >= waterY && !b.splashed) {
        b.splashed = true;
        b.caught = true; // recycled below
        b.catchAge = 999; // no catch animation
        this.ripples.push({ x: b.x, y: waterY, age: 0 });
        this.spawnParticles(b.x, waterY - 6, 9, '#bfe3ef', 'grain');
        if (b.type === 'rug' || b.type === 'hat') continue; // no penalty for these
        // RONKE ARC is a pure reward window. It rains faster than a
        // mouth can chomp, so arc rice sinks for free — no life, no
        // combo break, no hat spent. The `arc` flag carries that past
        // the timer so the tail of the rain can't end the run either.
        if (this.isFever() || b.arc) continue;
        if (this.shieldHeld) {
          // The kasa takes the hit — rice saved, hat gone.
          this.shieldHeld = false;
          this.stats.hatSaves++;
          this.floats.push({ x: b.x, y: waterY - 24, text: 'HAT SAVE!', color: '#d8b34a', age: 0 });
          this.cb.onShield(false);
          this.cb.onCatch('hat-save', 0, false);
          continue;
        }
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
    for (const r of this.ripples) r.age += dt * 1000;
    this.ripples = this.ripples.filter((r) => r.age < 700);

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
        } else if (b.type === 'hat') {
          ctx.rotate(Math.sin(b.wobblePhase) * 0.3); // seesawing drift
        } else {
          ctx.rotate(Math.sin(b.wobblePhase * 0.7) * 0.12);
        }
        if (b.type === 'gold') {
          ctx.shadowColor = 'rgba(255,217,74,0.9)';
          ctx.shadowBlur = 18;
        }
        if (b.type === 'hat') {
          ctx.shadowColor = 'rgba(216,179,74,0.8)';
          ctx.shadowBlur = 14;
        }
        const drawSize = b.big ? size * 1.7 : size;
        ctx.drawImage(bmp, -drawSize / 2, -drawSize / 2, drawSize, drawSize);
        if (b.big) {
          // Chomps-remaining pips under the feast
          ctx.shadowBlur = 0;
          for (let i = 0; i < b.hp; i++) {
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = 'rgba(0,0,0,0.6)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc((i - (b.hp - 1) / 2) * 16, drawSize / 2 + 12, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        }
      }
      ctx.restore();
    }

    // ── Paddy field strip: water band + swaying rice stalks ──
    {
      const w = this.canvas.clientWidth || window.innerWidth;
      const h = this.canvas.clientHeight || window.innerHeight;
      const fh = this.config.fieldHeight;
      const top = h - fh;
      // Water
      const water = ctx.createLinearGradient(0, top, 0, h);
      water.addColorStop(0, 'rgba(38, 84, 100, 0.55)');
      water.addColorStop(1, 'rgba(16, 42, 60, 0.85)');
      ctx.fillStyle = water;
      ctx.fillRect(0, top, w, fh);
      // Water surface line with a slow shimmer
      ctx.strokeStyle = 'rgba(180, 226, 240, 0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 14) {
        const yy = top + Math.sin(x * 0.05 + this.fieldSway * 1.8) * 1.6;
        if (x === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
      }
      ctx.stroke();
      // Ripples from splashes
      for (const r of this.ripples) {
        const t = r.age / 700;
        ctx.globalAlpha = (1 - t) * 0.7;
        ctx.strokeStyle = '#cfeaf5';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(r.x, r.y, 10 + t * 46, 3 + t * 12, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      // Rice stalk clusters — painterly, uneven heights and spacing so
      // the row reads organic rather than picket-fence.
      const sway = Math.sin(this.fieldSway * 1.3) * 3;
      ctx.lineWidth = 3;
      let x = 6;
      while (x < w) {
        const seed = (x * 7919) % 97;
        const jitter = (seed % 13) - 6;
        const baseY = h - 2;
        const tall = seed % 3 === 0;
        const tipY = top + (tall ? 2 : 14) + (seed % 14);
        const swayHere = sway * (0.6 + (seed % 5) * 0.2);
        ctx.strokeStyle = `rgba(${86 + (seed % 24)}, ${150 + (seed % 30)}, 88, 0.9)`;
        ctx.beginPath();
        ctx.moveTo(x, baseY);
        ctx.quadraticCurveTo(x + jitter * 0.4, (baseY + tipY) / 2, x + swayHere + jitter * 0.3, tipY);
        ctx.stroke();
        if (tall) {
          // grain head only on the tall stalks — ready for harvest
          ctx.fillStyle = 'rgba(216, 196, 120, 0.95)';
          ctx.beginPath();
          ctx.ellipse(x + swayHere + jitter * 0.3, tipY, 3.4, 5.6, 0.3, 0, Math.PI * 2);
          ctx.fill();
        }
        x += 16 + (seed % 18);
      }
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
