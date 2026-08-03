// ═════════════════════════════════════════════════════════════
// RONKE BOAT BATTLE — the loop.
//
// Three inputs, one body:
//
//   HEAD POSITION  steers the hull. Barrels roll down the sea at you
//                  and the only way past them is to physically move.
//   HEAD TILT      swings the deck gun. Independent axis, so the
//                  dodge and the firing solution fight each other —
//                  a barrel on your left pushes you right while the
//                  pirate on your left needs you tilted left.
//   MOUTH          opens to pack powder, closes to FIRE. Hold longer
//                  for a mightier ball: a tap pops one barrel, a full
//                  charge punches through the lot and staggers a boss.
//
// The pirates are trying to stop the voyage. Sink one and a worse one
// sails in; every fifth is a boss. Difficulty climbs on every axis
// (speed, density, armour, weather) but so does the toolkit —
// powder kegs to chain, supply crates to repair, gunport windows to
// exploit, and the BROADSIDE arc for chaining hits.
//
// The canvas is opaque: the sea is drawn here, the camera feed lives
// underneath it and is never shown (only the player's mouth, blitted
// into Ronke's muzzle by captain.ts).
// ═════════════════════════════════════════════════════════════

import {
  buildBarrelBitmaps, drawCannon, drawCannonball, drawEnemyBall,
  drawHullFallback, drawPirateFallback, loadSprite,
  type BarrelBitmaps, type BarrelKind, type Sprite,
} from './sprites';
import { Sea, HORIZON } from './sea';
import { paintCaptain } from './captain';
import type { FaceState } from './detection';

export type GameState = 'idle' | 'playing' | 'over';

export type Signal =
  | 'fire-light' | 'fire-mighty' | 'charge' | 'dry-click'
  | 'barrel-pop' | 'powder-blast' | 'supply' | 'ping'
  | 'enemy-hit' | 'enemy-sunk' | 'boss-in' | 'boss-sunk'
  | 'hull-hit' | 'broadside' | 'stage-up';

export interface EnemySpec {
  kind: 'skiff' | 'gunner' | 'ironclad' | 'boss';
  name: string;
  hp: number;
  /** Sprite width as a fraction of the play column. */
  widthFrac: number;
  /** Strafe speed multiplier. */
  speed: number;
}

export interface GameConfig {
  hull: number;
  /** Aim clamp in radians (0 = straight up the sea). */
  maxAim: number;
  /** Full-power charge time, ms. */
  fullChargeMs: number;
  /** Base reload after a shot, ms (scaled by power). */
  reloadMs: number;
  /** Invulnerable window after a hull hit, ms. */
  iFramesMs: number;
  broadside: {
    triggerCombo: number;
    durationMs: number;
    /** Extra balls either side of the aim line. */
    spread: number;
    reloadMul: number;
    pointsMul: number;
  };
  combo: Array<{ step: number; mul: number }>;
}

export const DEFAULT_GAME_CONFIG: GameConfig = {
  hull: 3,
  maxAim: 1.05,
  fullChargeMs: 700,
  reloadMs: 210,
  iFramesMs: 1100,
  broadside: {
    triggerCombo: 12,
    durationMs: 6500,
    spread: 0.19,
    reloadMul: 0.55,
    pointsMul: 2,
  },
  combo: [
    { step: 5, mul: 2 },
    { step: 11, mul: 3 },
    { step: 20, mul: 4 },
  ],
};

// Every fifth pirate is the boss. The three regular hulls rotate in a
// fixed order so the player can learn the read on each one.
const ROSTER: EnemySpec[] = [
  { kind: 'skiff', name: 'BARREL SKIFF', hp: 10, widthFrac: 0.30, speed: 1.0 },
  { kind: 'gunner', name: 'GUNBOAT', hp: 16, widthFrac: 0.34, speed: 1.25 },
  { kind: 'ironclad', name: 'IRONCLAD', hp: 22, widthFrac: 0.31, speed: 0.85 },
  { kind: 'skiff', name: 'RAIDER SKIFF', hp: 20, widthFrac: 0.30, speed: 1.5 },
];
const BOSS: EnemySpec = {
  kind: 'boss', name: 'CAPTAIN RUGBEARD', hp: 85, widthFrac: 0.62, speed: 0.7,
};

export interface RoundStats {
  pirates: number;
  bosses: number;
  barrels: number;
  supplies: number;
  bestCombo: number;
  shots: number;
  hits: number;
  mighty: number;
  broadsides: number;
  /** Nautical miles, purely for flavour on the over screen. */
  distance: number;
}

export interface StageInfo {
  index: number;
  tier: number;
  name: string;
  boss: boolean;
}

export interface GameCallbacks {
  onSignal: (s: Signal, value?: number) => void;
  onHull: (hp: number, hit: boolean) => void;
  onCombo: (combo: number, mul: number) => void;
  onStage: (info: StageInfo) => void;
  /** Enemy health 0..1 and its name, for the top-of-screen bar. */
  onEnemyHealth: (frac: number, name: string, boss: boolean) => void;
  onBroadside: (active: boolean) => void;
  onEnd: (score: number, stats: RoundStats) => void;
}

interface Barrel {
  x: number; y: number;
  vx: number; vy: number;
  kind: BarrelKind;
  hp: number;
  r: number;
  spin: number;
  spinV: number;
  dead: boolean;
  /** Counted for the near-miss bonus only once. */
  scored: boolean;
}

interface Ball {
  x: number; y: number;
  vx: number; vy: number;
  r: number;
  power: number;
  dmg: number;
  pierce: boolean;
  dead: boolean;
  hitIds: Set<number>;
}

interface EnemyBall {
  x: number; y: number;
  vx: number; vy: number;
  r: number;
  spin: number;
  dead: boolean;
}

interface Enemy {
  spec: EnemySpec;
  x: number; y: number;
  w: number; h: number;
  hp: number;
  maxHp: number;
  t: number;
  /** Strafe phase + home y. */
  phase: number;
  baseY: number;
  dropAt: number;
  shootAt: number;
  /** Ironclad / boss: are the gunports open (the damage window)? */
  portsOpen: boolean;
  portTimer: number;
  /** Boss only. */
  bossPhase: number;
  charging: boolean;
  chargeT: number;
  staggerUntil: number;
  dying: number;
}

interface Particle {
  x: number; y: number; vx: number; vy: number;
  age: number; life: number;
  color: string; size: number;
  shape: 'spark' | 'splinter' | 'foam' | 'smoke';
}

interface Float {
  x: number; y: number; text: string; color: string; age: number; size: number;
}

interface Shock {
  x: number; y: number; age: number; life: number; max: number; color: string;
}

export class Game {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: GameConfig;
  private cb: GameCallbacks;

  private state: GameState = 'idle';
  private sea = new Sea();
  private bitmaps: BarrelBitmaps;
  private art: Record<string, Sprite>;

  // Entities
  private barrels: Barrel[] = [];
  private balls: Ball[] = [];
  private eballs: EnemyBall[] = [];
  private particles: Particle[] = [];
  private floats: Float[] = [];
  private shocks: Shock[] = [];
  private enemy: Enemy | null = null;

  // Boat
  private boatX = 0;
  private boatVX = 0;
  private steer = 0.5;
  private aim = 0;
  private aimTarget = 0;
  private rock = 0;
  private charge = 0;
  private charging = false;
  private chargeStart = 0;
  private readyAt = 0;
  private flash = 0;
  private recoil = 0;
  private hurtUntil = 0;
  private faceLost = false;

  // Run state
  private hp = 0;
  private score = 0;
  private combo = 0;
  private stage = 0;
  private stats: RoundStats = blankStats();
  private startedAt = 0;
  private lastFrameAt = 0;
  private rafId = 0;
  private hitStopUntil = 0;
  private shake = 0;
  private nextStageAt = 0;
  private ambientAt = 0;
  private barrageAt = 0;
  private broadsideUntil = 0;
  private currentPx = 0;
  private currentTarget = 0;
  private scroll = 520;

  // Captain source (camera feed + landmarks) — decorative only.
  private video: HTMLVideoElement | null = null;
  private face: (() => FaceState | null) | null = null;

  constructor(canvas: HTMLCanvasElement, config: GameConfig, cb: GameCallbacks) {
    this.canvas = canvas;
    this.config = config;
    this.cb = cb;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('game canvas 2d unsupported');
    this.ctx = ctx;
    this.bitmaps = buildBarrelBitmaps(96 * Math.min(2, window.devicePixelRatio || 1));
    this.art = {
      boat: loadSprite('/sea/boat.png'),
      skiff: loadSprite('/sea/pirate-skiff.png'),
      gunner: loadSprite('/sea/pirate-gunner.png'),
      ironclad: loadSprite('/sea/pirate-ironclad.png'),
      boss: loadSprite('/sea/boss-galleon.png'),
    };
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

  private get w(): number { return this.canvas.clientWidth || window.innerWidth; }
  private get h(): number { return this.canvas.clientHeight || window.innerHeight; }

  // ── Geometry helpers ──
  // The boat is sized by LENGTH (it has to fit above the bottom edge)
  // and the beam falls out of the sprite's own aspect, so what you see
  // and what the barrels collide with are the same rectangle.
  private get boatRatio(): number {
    const b = this.art.boat;
    return b.ready() ? b.ratio() : 2.9;
  }
  private get hullH(): number { return Math.max(118, Math.min(this.h * 0.235, 250)); }
  private get hullW(): number { return this.hullH / this.boatRatio; }
  private get boatY(): number { return this.h * 0.78; }
  private get cannonLen(): number { return this.hullH * 0.30; }
  /** Cannon pivot in boat-local space (before rock). */
  private get pivotY(): number { return -this.hullH * 0.30; }

  // ── Public API ──

  getState(): GameState { return this.state; }
  getScore(): number { return this.score; }
  getCombo(): number { return this.combo; }
  getStats(): Readonly<RoundStats> { return this.stats; }
  getChargeFraction(): number { return this.charge; }
  isBroadside(): boolean { return performance.now() < this.broadsideUntil; }
  broadsideFraction(): number {
    if (!this.isBroadside()) return 0;
    return (this.broadsideUntil - performance.now()) / this.config.broadside.durationMs;
  }
  isReloading(): boolean { return performance.now() < this.readyAt; }

  setCaptainSource(video: HTMLVideoElement, face: () => FaceState | null): void {
    this.video = video;
    this.face = face;
  }

  /** Where the head is, 0 (screen left) … 1 (screen right). */
  setSteer(x: number): void {
    this.steer = Math.max(0, Math.min(1, x));
  }

  /** Cannon angle in radians; 0 = straight up the sea, + = right. */
  setAim(angle: number): void {
    const m = this.config.maxAim;
    this.aimTarget = Math.max(-m, Math.min(m, angle));
  }

  setFaceLost(lost: boolean): void { this.faceLost = lost; }

  /** Mouth opened — start packing powder. */
  startCharge(): void {
    if (this.state !== 'playing') return;
    this.charging = true;
    this.chargeStart = performance.now();
    this.cb.onSignal('charge');
  }

  /** Mouth closed — FIRE. `heldMs` sets the power. */
  fire(heldMs: number): void {
    this.charging = false;
    if (this.state !== 'playing') return;
    const now = performance.now();
    if (now < this.readyAt) {
      // Still ramming the next ball home — a dry click, no penalty.
      this.charge = 0;
      this.cb.onSignal('dry-click');
      this.puff(this.muzzle().x, this.muzzle().y, 4, '#b9c6d2');
      return;
    }
    const power = Math.max(0, Math.min(1, heldMs / this.config.fullChargeMs));
    this.charge = 0;
    this.shoot(power);
  }

  start(): void {
    this.state = 'playing';
    this.barrels = [];
    this.balls = [];
    this.eballs = [];
    this.particles = [];
    this.floats = [];
    this.shocks = [];
    this.enemy = null;
    this.hp = this.config.hull;
    this.score = 0;
    this.combo = 0;
    this.stage = 0;
    this.stats = blankStats();
    this.boatX = this.w / 2;
    this.boatVX = 0;
    this.aim = 0;
    this.aimTarget = 0;
    this.charge = 0;
    this.charging = false;
    this.readyAt = 0;
    this.flash = 0;
    this.recoil = 0;
    this.hurtUntil = 0;
    this.shake = 0;
    this.hitStopUntil = 0;
    this.broadsideUntil = 0;
    this.currentPx = 0;
    this.currentTarget = 0;
    this.startedAt = performance.now();
    this.lastFrameAt = this.startedAt;
    this.ambientAt = this.startedAt + 1200;
    this.barrageAt = this.startedAt + 26_000;
    this.nextStageAt = this.startedAt + 900;
    this.cb.onHull(this.hp, false);
    this.cb.onCombo(0, 1);
    cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.state = 'idle';
    cancelAnimationFrame(this.rafId);
    const c = this.ctx;
    c.clearRect(0, 0, this.w, this.h);
  }

  // ── Difficulty curve ──
  // Everything scales off the pirate index. `tier` is the lap counter:
  // it ticks up each time a boss goes down and turns the weather.

  private get tier(): number { return Math.floor((this.stage - 1) / 5) + 1; }

  private barrelInterval(): number {
    return Math.max(400, 1700 - this.stage * 74);
  }

  private barrelSpeed(): number {
    return Math.min(640, 200 + this.stage * 22 + this.tier * 18);
  }

  private comboMul(): number {
    let mul = 1;
    for (const t of this.config.combo) if (this.combo >= t.step) mul = t.mul;
    return mul;
  }

  private scoreMul(): number {
    return this.comboMul() * (this.isBroadside() ? this.config.broadside.pointsMul : 1);
  }

  // ── Firing ──

  private muzzle(): { x: number; y: number; a: number } {
    const a = this.aim + this.rock;
    const px = this.boatX + Math.sin(this.rock) * -this.pivotY;
    const py = this.boatY + Math.cos(this.rock) * this.pivotY;
    return {
      x: px + Math.sin(a) * this.cannonLen,
      y: py - Math.cos(a) * this.cannonLen,
      a,
    };
  }

  private shoot(power: number): void {
    const m = this.muzzle();
    const speed = 1180 - power * 260;
    const r = 8 + power * 13;
    const dmg = power < 0.35 ? 1 : power < 0.8 ? 2 : 4;
    const mighty = power >= 0.8;
    const spread = this.isBroadside() ? [-this.config.broadside.spread, 0, this.config.broadside.spread] : [0];

    for (const off of spread) {
      const a = m.a + off;
      this.balls.push({
        x: m.x, y: m.y,
        vx: Math.sin(a) * speed,
        vy: -Math.cos(a) * speed,
        r,
        power,
        dmg,
        pierce: mighty,
        dead: false,
        hitIds: new Set(),
      });
    }

    this.stats.shots++;
    if (mighty) this.stats.mighty++;
    this.flash = 1;
    this.recoil = 1;
    this.readyAt = performance.now()
      + (this.config.reloadMs + power * 340) * (this.isBroadside() ? this.config.broadside.reloadMul : 1);
    this.shake = Math.max(this.shake, 3 + power * 9);
    this.puff(m.x, m.y, 8 + Math.round(power * 14), '#d9d2c4', 'smoke');
    this.cb.onSignal(mighty ? 'fire-mighty' : 'fire-light', power);
    if (mighty) this.hitStopUntil = performance.now() + 45;
  }

  // ── Spawning ──

  private spawnStage(): void {
    this.stage++;
    const boss = this.stage % 5 === 0;
    const spec = boss ? BOSS : ROSTER[(this.stage - 1) % ROSTER.length];
    const scale = boss ? 0 : 1 + (this.stage - 1) * 0.28;
    const sprite = this.art[spec.kind];
    const ratio = sprite.ready() ? sprite.ratio() : 2;
    // Width-first sizing blew the galleon off the top of the screen on
    // tall columns — these hulls are 2:1 or worse. Cap the LENGTH and
    // let the beam follow.
    let w = this.w * spec.widthFrac;
    let h = w * ratio;
    const maxH = this.h * (boss ? 0.42 : 0.30);
    if (h > maxH) { h = maxH; w = h / ratio; }
    const hp = boss ? 70 + 34 * this.tier : Math.round(spec.hp * scale);
    this.enemy = {
      spec,
      x: this.w / 2,
      y: -h * 0.6,
      w, h,
      hp,
      maxHp: hp,
      t: 0,
      phase: Math.random() * Math.PI * 2,
      baseY: boss ? this.h * 0.245 : this.h * 0.21,
      dropAt: 900,
      shootAt: 2200,
      portsOpen: false,
      portTimer: 2400,
      bossPhase: 1,
      charging: false,
      chargeT: 0,
      staggerUntil: 0,
      dying: 0,
    };
    if (boss && this.hp < this.config.hull) {
      this.hp = this.config.hull;
      this.cb.onHull(this.hp, false);
      this.floats.push({
        x: this.w / 2, y: this.h * 0.6, text: 'HULL REBUILT', color: '#7dffa0', age: 0, size: 26,
      });
    }
    this.cb.onStage({ index: this.stage, tier: this.tier, name: spec.name, boss });
    this.cb.onEnemyHealth(1, spec.name, boss);
    this.cb.onSignal(boss ? 'boss-in' : 'stage-up');
    // The weather turns with the lap.
    this.sea.setStorm(Math.min(1, (this.tier - 1) * 0.34));
  }

  private spawnBarrel(x: number, kind: BarrelKind, y?: number, vx = 0, speedMul = 1): void {
    const r = (kind === 'rice' ? 25 : 23) * (this.w / 700 + 0.55);
    this.barrels.push({
      x,
      y: y ?? this.h * HORIZON + 8,
      vx,
      vy: this.barrelSpeed() * speedMul * (kind === 'rice' ? 0.8 : 1),
      kind,
      hp: kind === 'spike' ? 2 : 1,
      r,
      spin: Math.random() * Math.PI * 2,
      spinV: (Math.random() - 0.5) * 3 + 3.4,
      dead: false,
      scored: false,
    });
  }

  private pickBarrelKind(): BarrelKind {
    const s = this.stage;
    const roll = Math.random();
    if (roll < 0.10) return 'rice';
    if (s >= 2 && roll < 0.30) return 'powder';
    if (s >= 3 && roll < 0.44) return 'spike';
    return 'wood';
  }

  /** A wall of barrels with exactly one gap — pure positioning test. */
  private barrage(): void {
    const lanes = Math.min(7, 4 + Math.floor(this.stage / 3));
    const gap = Math.floor(Math.random() * lanes);
    const margin = this.w * 0.08;
    const step = (this.w - margin * 2) / (lanes - 1);
    for (let i = 0; i < lanes; i++) {
      if (i === gap) continue;
      this.spawnBarrel(margin + step * i, i % 3 === 0 && this.stage >= 3 ? 'spike' : 'wood', undefined, 0, 0.9);
    }
    this.floats.push({
      x: this.w / 2, y: this.h * 0.34, text: 'BARRAGE!', color: '#ff9a3c', age: 0, size: 34,
    });
  }

  // ── Main frame ──

  private frame = (): void => {
    if (this.state !== 'playing') return;
    const now = performance.now();
    if (now < this.hitStopUntil) {
      this.lastFrameAt = now;
      this.render();
      this.rafId = requestAnimationFrame(this.frame);
      return;
    }
    // A long gap means the tab was hidden (RAF pauses, wall clock does
    // not). Without this every deadline below — spawns, reloads,
    // i-frames — comes due at once and the player eats a wall of
    // barrels for switching tabs. Slide the whole schedule instead.
    const gap = now - this.lastFrameAt;
    if (gap > 400) this.shiftClocks(gap);
    const dt = Math.min(0.05, (now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;
    const elapsed = now - this.startedAt;

    this.stats.distance = (elapsed / 1000) * 0.021;
    this.score += 8 * dt * (this.isBroadside() ? 2 : 1);

    // ── Charge ──
    if (this.charging) {
      this.charge = Math.min(1, (now - this.chargeStart) / this.config.fullChargeMs);
    } else {
      this.charge = 0;
    }
    this.flash = Math.max(0, this.flash - dt * 6);
    this.recoil = Math.max(0, this.recoil - dt * 5);
    this.shake = Math.max(0, this.shake - dt * 26);

    // ── Broadside expiry ──
    if (this.broadsideUntil > 0 && now >= this.broadsideUntil) {
      this.broadsideUntil = 0;
      this.cb.onBroadside(false);
    }

    // ── Sea state ──
    // From tier 2 a lateral current shoves the hull, so holding a lane
    // means holding your head off-centre. It rolls over slowly.
    if (this.tier >= 2) {
      if (Math.random() < dt * 0.12) {
        this.currentTarget = (Math.random() - 0.5) * 2 * (18 + this.tier * 16);
      }
    } else {
      this.currentTarget = 0;
    }
    this.currentPx += (this.currentTarget - this.currentPx) * Math.min(1, dt * 0.7);
    this.sea.setCurrent(this.currentPx);
    this.scroll = 420 + this.barrelSpeed() * 0.55;
    this.sea.update(dt, this.scroll, this.w, this.h);

    // ── Boat physics ──
    const margin = this.hullW * 0.55;
    const target = margin + this.steer * (this.w - margin * 2);
    // Spring toward the head position, with real inertia: the hull is
    // heavy, so you have to lead your dodges.
    this.boatVX += ((target - this.boatX) * 88 - this.boatVX * 13) * dt;
    this.boatX += (this.boatVX + this.currentPx) * dt;
    if (this.boatX < margin) { this.boatX = margin; this.boatVX *= -0.2; }
    if (this.boatX > this.w - margin) { this.boatX = this.w - margin; this.boatVX *= -0.2; }
    // Rock: the swell plus a lean into the turn.
    const swell = Math.sin(elapsed / 620) * 0.035 + Math.sin(elapsed / 271) * 0.018;
    this.rock += (swell + this.boatVX * 0.00035 - this.rock) * Math.min(1, dt * 9);
    this.aim += (this.aimTarget - this.aim) * Math.min(1, dt * 18);

    // ── Stage flow ──
    if (!this.enemy && now >= this.nextStageAt) this.spawnStage();
    if (this.enemy) this.updateEnemy(this.enemy, dt, now);

    // ── Ambient barrels streaming down the sea ──
    // A boss brings his own weather: the drifting stream stops and the
    // sea sends supply crates instead, which is the only way to patch
    // a plank mid-fight. Stacking ambient kegs on top of his volleys
    // made phase 1 unsurvivable.
    const bossFight = !!this.enemy && this.enemy.spec.kind === 'boss' && this.enemy.dying <= 0;
    if (now >= this.ambientAt) {
      this.ambientAt = now + (bossFight
        ? 5000 + Math.random() * 3000
        : this.barrelInterval() * (0.7 + Math.random() * 0.6));
      const x = this.w * (0.1 + Math.random() * 0.8);
      this.spawnBarrel(x, bossFight ? 'rice' : this.pickBarrelKind());
    }
    // ── Barrage walls, from stage 3 (never during a boss) ──
    if (this.stage >= 3 && !bossFight && now >= this.barrageAt) {
      this.barrageAt = now + Math.max(9000, 20_000 - this.stage * 600) + Math.random() * 5000;
      this.barrage();
    }

    this.updateBarrels(dt);
    this.updateBalls(dt);
    this.updateEnemyBalls(dt);
    this.updateFx(dt);

    this.render();
    if (this.state === 'playing') this.rafId = requestAnimationFrame(this.frame);
  };

  /** Push every wall-clock deadline forward by a pause. */
  private shiftClocks(gap: number): void {
    this.startedAt += gap;
    this.lastFrameAt += gap;
    this.ambientAt += gap;
    this.barrageAt += gap;
    this.nextStageAt += gap;
    if (this.readyAt > 0) this.readyAt += gap;
    if (this.hurtUntil > 0) this.hurtUntil += gap;
    if (this.broadsideUntil > 0) this.broadsideUntil += gap;
    if (this.hitStopUntil > 0) this.hitStopUntil += gap;
    if (this.charging) this.chargeStart += gap;
    const e = this.enemy;
    if (e && e.staggerUntil > 0) e.staggerUntil += gap;
  }

  // ── Enemies ──

  private updateEnemy(e: Enemy, dt: number, now: number): void {
    e.t += dt * 1000;

    if (e.dying > 0) {
      e.dying -= dt * 1000;
      e.y += 24 * dt;
      if (Math.random() < dt * 14) {
        this.boom(e.x + (Math.random() - 0.5) * e.w * 0.7, e.y + (Math.random() - 0.5) * e.h * 0.5, 0.5);
      }
      if (e.dying <= 0) {
        this.enemy = null;
        this.nextStageAt = now + 1500;
        this.cb.onEnemyHealth(0, '', false);
      }
      return;
    }

    // Sail in from the top.
    e.y += (e.baseY - e.y) * Math.min(1, dt * 1.6);

    const boss = e.spec.kind === 'boss';
    const stageSpeed = 1 + this.stage * 0.06;
    const amp = this.w * (boss ? 0.16 : 0.30);
    e.phase += dt * 0.55 * e.spec.speed * stageSpeed * (e.charging ? 0.2 : 1);
    e.x = this.w / 2 + Math.sin(e.phase) * amp + Math.sin(e.phase * 2.3) * amp * 0.22;

    const staggered = now < e.staggerUntil;

    // ── Ironclad: the armour opens on a rhythm. That window is the
    // whole fight — you have to be aimed and charged when it comes.
    if (e.spec.kind === 'ironclad' || boss) {
      e.portTimer -= dt * 1000;
      if (e.portTimer <= 0) {
        e.portsOpen = !e.portsOpen;
        e.portTimer = e.portsOpen
          ? (boss ? 2000 : 1500)
          : Math.max(1200, (boss ? 2600 : 2400) - this.stage * 40);
      }
    } else {
      e.portsOpen = true;
    }

    if (staggered) return;

    // ── Attacks ──
    e.dropAt -= dt * 1000;
    e.shootAt -= dt * 1000;

    if (boss) {
      this.bossBehaviour(e, dt, now);
      return;
    }

    if (e.dropAt <= 0) {
      e.dropAt = this.barrelInterval() * (e.spec.kind === 'skiff' ? 1.0 : 1.4);
      const n = e.spec.kind === 'skiff' && this.stage >= 4 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        this.spawnBarrel(
          e.x + (Math.random() - 0.5) * e.w * 0.7 + (i - 0.5) * 40,
          this.pickBarrelKind(),
          e.y + e.h * 0.3,
          (Math.random() - 0.5) * 60,
        );
      }
    }

    if (e.spec.kind === 'gunner' && e.shootAt <= 0) {
      e.shootAt = Math.max(900, 2600 - this.stage * 110);
      this.enemyShot(e, this.boatX, this.boatY, 430 + this.stage * 14);
    }
  }

  private bossBehaviour(e: Enemy, dt: number, now: number): void {
    const frac = e.hp / e.maxHp;
    const phase = frac > 0.66 ? 1 : frac > 0.33 ? 2 : 3;
    if (phase !== e.bossPhase) {
      e.bossPhase = phase;
      e.staggerUntil = now + 700;
      this.shake = 14;
      this.floats.push({
        x: this.w / 2, y: this.h * 0.42,
        text: phase === 2 ? 'RUGBEARD RAGES' : 'FINAL BROADSIDE',
        color: '#ff6b6b', age: 0, size: 30,
      });
      this.boom(e.x, e.y, 1.4);
      return;
    }

    // Ram charge — he bears down on you, and he's wide open while he
    // does it. Dodge sideways and empty the gun into him.
    if (e.charging) {
      e.chargeT += dt * 1000;
      e.y += (this.h * 0.50 - e.y) * Math.min(1, dt * 1.1);
      e.portsOpen = true;
      if (e.chargeT > 2100) {
        e.charging = false;
        e.chargeT = 0;
        e.baseY = this.h * 0.245;
      }
      // Bow wave while he closes.
      if (Math.random() < dt * 30) {
        this.particles.push({
          x: e.x + (Math.random() - 0.5) * e.w * 0.8, y: e.y + e.h * 0.45,
          vx: (Math.random() - 0.5) * 90, vy: 220 + Math.random() * 160,
          age: 0, life: 500, color: 'rgba(255,255,255,0.85)', size: 4 + Math.random() * 5,
          shape: 'foam',
        });
      }
      return;
    }

    if (e.dropAt <= 0) {
      // Volley: a fan of kegs, one gap. Phase 3 adds a second fan.
      e.dropAt = Math.max(1800, 4200 - this.stage * 60) * (phase === 3 ? 0.65 : 1);
      const lanes = phase === 1 ? 4 : 5;
      const gap = Math.floor(Math.random() * lanes);
      for (let i = 0; i < lanes; i++) {
        if (i === gap) continue;
        const x = this.w * (0.12 + (0.76 / (lanes - 1)) * i);
        this.spawnBarrel(x, i % 2 === 0 ? 'powder' : 'wood', e.y + e.h * 0.35, 0, 0.95);
      }
    }

    if (e.shootAt <= 0) {
      e.shootAt = Math.max(1500, 3800 - this.stage * 70) * (phase === 3 ? 0.7 : 1);
      const shots = phase === 3 ? 3 : phase === 2 ? 2 : 1;
      for (let i = 0; i < shots; i++) {
        const spreadX = (i - (shots - 1) / 2) * 120;
        this.enemyShot(e, this.boatX + spreadX, this.boatY, 420 + this.stage * 12);
      }
      // Every few volleys he commits to a ram.
      if (phase >= 2 && Math.random() < 0.34) {
        e.charging = true;
        e.chargeT = 0;
        this.floats.push({
          x: this.w / 2, y: this.h * 0.46, text: 'RAMMING SPEED!', color: '#ffd94a', age: 0, size: 28,
        });
      }
    }
  }

  private enemyShot(e: Enemy, tx: number, ty: number, speed: number): void {
    const sx = e.x + (Math.random() - 0.5) * e.w * 0.5;
    const sy = e.y + e.h * 0.32;
    const d = Math.hypot(tx - sx, ty - sy) || 1;
    this.eballs.push({
      x: sx, y: sy,
      vx: ((tx - sx) / d) * speed,
      vy: ((ty - sy) / d) * speed,
      r: 13,
      spin: 0,
      dead: false,
    });
    this.puff(sx, sy, 6, '#c9c2b6', 'smoke');
  }

  private damageEnemy(e: Enemy, dmg: number, x: number, y: number, power: number): void {
    if (e.dying > 0) return;
    if (!e.portsOpen) {
      // Armour. The ball rings off it — no damage, no combo break, but
      // the shot is spent. Wait for the ports.
      this.spark(x, y, '#cfd8e3');
      this.cb.onSignal('ping');
      this.floats.push({ x, y: y - 14, text: 'CLANG', color: '#cfd8e3', age: 0, size: 20 });
      return;
    }
    e.hp -= dmg;
    this.stats.hits++;
    this.bumpCombo();
    const pts = Math.round(40 * dmg * this.scoreMul());
    this.score += pts;
    this.spark(x, y, '#ffce54');
    this.boom(x, y, 0.35 + power * 0.5);
    this.floats.push({ x, y: y - 18, text: `+${pts}`, color: '#ffe08a', age: 0, size: 22 });
    this.cb.onSignal('enemy-hit', dmg);
    this.cb.onEnemyHealth(Math.max(0, e.hp / e.maxHp), e.spec.name, e.spec.kind === 'boss');
    if (e.hp <= 0) this.sinkEnemy(e);
  }

  private sinkEnemy(e: Enemy): void {
    const boss = e.spec.kind === 'boss';
    e.dying = boss ? 2200 : 1100;
    e.charging = false;
    const pts = boss ? 5000 * this.tier : 600 + 300 * this.stage;
    this.score += Math.round(pts);
    if (boss) this.stats.bosses++; else this.stats.pirates++;
    this.shake = boss ? 22 : 12;
    this.hitStopUntil = performance.now() + (boss ? 220 : 90);
    this.boom(e.x, e.y, boss ? 2.6 : 1.5);
    this.floats.push({
      x: e.x, y: e.y, text: boss ? `RUGBEARD SUNK +${Math.round(pts)}` : `SUNK +${Math.round(pts)}`,
      color: '#7dffa0', age: 0, size: boss ? 32 : 26,
    });
    this.cb.onSignal(boss ? 'boss-sunk' : 'enemy-sunk');
    // Sinking a pirate patches a plank — the reward for pressing the
    // attack instead of only dodging.
    if (this.hp < this.config.hull) {
      this.hp++;
      this.cb.onHull(this.hp, false);
      this.floats.push({ x: this.boatX, y: this.boatY - 60, text: 'HULL PATCHED', color: '#7dffa0', age: 0, size: 22 });
    }
  }

  // ── Barrels ──

  private updateBarrels(dt: number): void {
    const hitR = this.hullW * 0.40;
    const hitH = this.hullH * 0.28;
    for (const b of this.barrels) {
      if (b.dead) continue;
      b.y += b.vy * dt;
      b.x += (b.vx + this.currentPx * 0.35) * dt;
      b.spin += b.spinV * dt;
      if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx); }
      if (b.x > this.w - b.r) { b.x = this.w - b.r; b.vx = -Math.abs(b.vx); }

      const dx = Math.abs(b.x - this.boatX);
      const dy = Math.abs(b.y - this.boatY);
      if (dx < hitR + b.r * 0.7 && dy < hitH + b.r * 0.7) {
        b.dead = true;
        if (b.kind === 'rice') {
          this.collectSupply(b);
        } else {
          this.hullHit(b.x, b.y);
        }
        continue;
      }
      // Near miss — a whisker of score for threading the needle.
      if (!b.scored && b.kind !== 'rice' && b.y > this.boatY - hitH && dx < hitR + b.r * 2.1) {
        b.scored = true;
        this.score += Math.round(15 * this.scoreMul());
        this.floats.push({ x: b.x, y: b.y - 20, text: 'CLOSE!', color: '#bfe3ef', age: 0, size: 16 });
      }
      if (b.y > this.h + b.r * 2) b.dead = true;
    }
    this.barrels = this.barrels.filter((b) => !b.dead);
  }

  private collectSupply(b: Barrel): void {
    this.stats.supplies++;
    this.bumpCombo();
    if (this.hp < this.config.hull) {
      this.hp++;
      this.cb.onHull(this.hp, false);
      this.floats.push({ x: b.x, y: b.y - 24, text: 'PLANK REPAIRED', color: '#7dffa0', age: 0, size: 22 });
    } else {
      const pts = Math.round(250 * this.scoreMul());
      this.score += pts;
      this.floats.push({ x: b.x, y: b.y - 24, text: `SUPPLIES +${pts}`, color: '#7dffa0', age: 0, size: 22 });
    }
    this.puff(b.x, b.y, 14, '#ffffff');
    this.cb.onSignal('supply');
  }

  private breakBarrel(b: Barrel, byPlayer: boolean, chain = false): void {
    if (b.dead) return;
    b.dead = true;
    if (b.kind === 'rice') {
      // Shooting the supplies is a real loss — the crate is gone.
      this.puff(b.x, b.y, 12, '#d8b871');
      this.floats.push({ x: b.x, y: b.y - 18, text: 'SUPPLIES LOST', color: '#ff9a3c', age: 0, size: 18 });
      return;
    }
    this.stats.barrels++;
    if (byPlayer) this.bumpCombo();
    const base = b.kind === 'powder' ? 45 : b.kind === 'spike' ? 40 : 30;
    const pts = Math.round(base * this.scoreMul() * (chain ? 1.5 : 1));
    this.score += pts;
    this.floats.push({ x: b.x, y: b.y - 16, text: `+${pts}`, color: chain ? '#ffb347' : '#ffffff', age: 0, size: 18 });
    this.splinter(b.x, b.y, b.kind);

    if (b.kind === 'powder') {
      // The reason to shoot DOWN instead of up: one keg clears a lane.
      this.cb.onSignal('powder-blast');
      this.boom(b.x, b.y, 1.1);
      this.shake = Math.max(this.shake, 9);
      const R = 150 + this.w * 0.12;
      for (const o of this.barrels) {
        if (o.dead || o === b) continue;
        if (Math.hypot(o.x - b.x, o.y - b.y) < R) this.breakBarrel(o, byPlayer, true);
      }
      const e = this.enemy;
      if (e && e.dying <= 0 && Math.hypot(e.x - b.x, e.y - b.y) < R + e.w * 0.3) {
        this.damageEnemy(e, 2, b.x, b.y, 1);
      }
    } else {
      this.cb.onSignal('barrel-pop');
    }
  }

  // ── Player cannonballs ──

  private updateBalls(dt: number): void {
    for (const ball of this.balls) {
      if (ball.dead) continue;
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;
      if (ball.y < -40 || ball.x < -40 || ball.x > this.w + 40 || ball.y > this.h + 40) {
        ball.dead = true;
        continue;
      }
      // Trail.
      if (Math.random() < 0.6) {
        this.particles.push({
          x: ball.x, y: ball.y, vx: 0, vy: 0, age: 0, life: 220,
          color: ball.power > 0.75 ? 'rgba(255,170,60,0.7)' : 'rgba(210,220,230,0.5)',
          size: ball.r * 0.7, shape: 'smoke',
        });
      }

      for (const b of this.barrels) {
        if (b.dead) continue;
        if (Math.hypot(b.x - ball.x, b.y - ball.y) > b.r + ball.r) continue;
        if (b.kind === 'spike' && ball.power < 0.35) {
          // Light shot pings off the iron bands — charge up for these.
          this.spark(ball.x, ball.y, '#cfd8e3');
          this.cb.onSignal('ping');
          ball.dead = true;
          break;
        }
        b.hp -= ball.dmg;
        if (b.hp <= 0) this.breakBarrel(b, true);
        else this.spark(ball.x, ball.y, '#e8dcc4');
        if (!ball.pierce) { ball.dead = true; break; }
      }
      if (ball.dead) continue;

      // Enemy shot-for-shot: a mighty ball swats incoming iron.
      for (const eb of this.eballs) {
        if (eb.dead) continue;
        if (Math.hypot(eb.x - ball.x, eb.y - ball.y) > eb.r + ball.r) continue;
        eb.dead = true;
        this.spark(ball.x, ball.y, '#ffb347');
        this.score += Math.round(25 * this.scoreMul());
        if (!ball.pierce) { ball.dead = true; break; }
      }
      if (ball.dead) continue;

      const e = this.enemy;
      if (e && e.dying <= 0) {
        if (Math.abs(ball.x - e.x) < e.w * 0.42 && Math.abs(ball.y - e.y) < e.h * 0.40) {
          this.damageEnemy(e, ball.dmg, ball.x, ball.y, ball.power);
          ball.dead = true;
        }
      }
    }
    this.balls = this.balls.filter((b) => !b.dead);
  }

  private updateEnemyBalls(dt: number): void {
    const hitR = this.hullW * 0.44;
    const hitH = this.hullH * 0.30;
    for (const b of this.eballs) {
      if (b.dead) continue;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.spin += dt * 7;
      if (b.y > this.h + 40 || b.x < -40 || b.x > this.w + 40) { b.dead = true; continue; }
      if (Math.abs(b.x - this.boatX) < hitR + b.r * 0.6 && Math.abs(b.y - this.boatY) < hitH + b.r * 0.6) {
        b.dead = true;
        this.hullHit(b.x, b.y);
      }
    }
    this.eballs = this.eballs.filter((b) => !b.dead);
  }

  // ── Damage ──

  private hullHit(x: number, y: number): void {
    const now = performance.now();
    if (now < this.hurtUntil) return;
    this.hurtUntil = now + this.config.iFramesMs;
    this.hp--;
    this.combo = 0;
    this.cb.onCombo(0, 1);
    this.cb.onHull(this.hp, true);
    this.cb.onSignal('hull-hit');
    this.shake = 18;
    this.hitStopUntil = now + 90;
    this.boom(x, y, 0.9);
    this.splinter(x, y, 'wood');
    if (this.hp <= 0) this.endRound();
  }

  private bumpCombo(): void {
    this.combo++;
    this.stats.bestCombo = Math.max(this.stats.bestCombo, this.combo);
    const bs = this.config.broadside;
    if (!this.isBroadside() && this.combo > 0 && this.combo % bs.triggerCombo === 0) {
      this.broadsideUntil = performance.now() + bs.durationMs;
      this.stats.broadsides++;
      this.cb.onBroadside(true);
      this.cb.onSignal('broadside');
      this.floats.push({
        x: this.w / 2, y: this.h * 0.45, text: 'BROADSIDE!', color: '#ffaa3c', age: 0, size: 40,
      });
    }
    this.cb.onCombo(this.combo, this.comboMul());
  }

  private endRound(): void {
    this.state = 'over';
    cancelAnimationFrame(this.rafId);
    if (this.isBroadside()) {
      this.broadsideUntil = 0;
      this.cb.onBroadside(false);
    }
    this.render();
    this.cb.onEnd(Math.round(this.score), this.stats);
  }

  // ── FX helpers ──

  private puff(x: number, y: number, n: number, color: string, shape: Particle['shape'] = 'spark'): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 150;
      this.particles.push({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40,
        age: 0, life: 300 + Math.random() * 400,
        color, size: 3 + Math.random() * 5, shape,
      });
    }
  }

  private spark(x: number, y: number, color: string): void {
    this.puff(x, y, 7, color, 'spark');
  }

  private splinter(x: number, y: number, kind: BarrelKind): void {
    const color = kind === 'powder' ? '#3a343f' : kind === 'spike' ? '#7d8794' : '#a9702f';
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 100 + Math.random() * 280;
      this.particles.push({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 80,
        age: 0, life: 420 + Math.random() * 380,
        color, size: 3 + Math.random() * 6, shape: 'splinter',
      });
    }
  }

  private boom(x: number, y: number, scale: number): void {
    this.shocks.push({
      x, y, age: 0, life: 420 + scale * 180, max: 60 * scale + 30, color: '#ffd08a',
    });
    for (let i = 0; i < Math.round(10 * scale) + 6; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (60 + Math.random() * 200) * scale;
      this.particles.push({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60,
        age: 0, life: 400 + Math.random() * 500,
        color: Math.random() < 0.5 ? '#ffb347' : '#5b5b66',
        size: (5 + Math.random() * 9) * scale, shape: 'smoke',
      });
    }
  }

  private updateFx(dt: number): void {
    for (const p of this.particles) {
      p.age += dt * 1000;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.shape === 'smoke') {
        p.vx *= 0.94;
        p.vy = p.vy * 0.94 - 20 * dt;
        p.size += dt * 26;
      } else if (p.shape !== 'foam') {
        p.vy += 620 * dt;
      }
    }
    this.particles = this.particles.filter((p) => p.age < p.life);
    for (const f of this.floats) {
      f.age += dt * 1000;
      f.y -= 42 * dt;
    }
    this.floats = this.floats.filter((f) => f.age < 950);
    for (const s of this.shocks) s.age += dt * 1000;
    this.shocks = this.shocks.filter((s) => s.age < s.life);
  }

  // ── Render ──

  private render(): void {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    const now = performance.now();

    ctx.save();
    if (this.shake > 0.4) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
    }

    this.sea.render(ctx, w, h);
    this.sea.wake(ctx, this.boatX, this.boatY + this.hullH * 0.42, this.hullW, h, this.scroll);

    // Enemy first — it's furthest away.
    if (this.enemy) this.drawEnemy(ctx, this.enemy, now);

    // Barrels.
    for (const b of this.barrels) {
      const bmp = this.bitmaps[b.kind];
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.kind === 'rice' ? Math.sin(b.spin) * 0.14 : b.spin);
      const s = b.r * 2;
      ctx.drawImage(bmp, -s / 2, -s / 2, s, s);
      ctx.restore();
      if (b.kind === 'powder') {
        // Fuse glow so the "shoot me" barrel is unmistakable.
        ctx.globalAlpha = 0.35 + Math.sin(now / 90 + b.spin) * 0.25;
        ctx.fillStyle = '#ff8c2c';
        ctx.beginPath();
        ctx.arc(b.x + b.r * 0.36, b.y - b.r * 0.3, b.r * 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // Enemy iron.
    for (const b of this.eballs) drawEnemyBall(ctx, b.x, b.y, b.r, b.spin);

    // Your iron.
    for (const b of this.balls) drawCannonball(ctx, b.x, b.y, b.r, b.power, now);

    this.drawBoat(ctx, now);
    this.drawAimLine(ctx);

    // ── FX on top ──
    for (const s of this.shocks) {
      const t = s.age / s.life;
      ctx.globalAlpha = (1 - t) * 0.8;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 4 * (1 - t) + 1;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.max * t, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    for (const p of this.particles) {
      const t = p.age / p.life;
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.fillStyle = p.color;
      if (p.shape === 'splinter') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.vx * 0.01);
        ctx.fillRect(-p.size * 0.6, -p.size * 0.25, p.size * 1.2, p.size * 0.5);
        ctx.restore();
      } else if (p.shape === 'smoke') {
        ctx.globalAlpha = Math.max(0, (1 - t) * 0.5);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1 - t * 0.5), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    ctx.textAlign = 'center';
    for (const f of this.floats) {
      const t = f.age / 950;
      ctx.globalAlpha = 1 - t * t;
      ctx.font = `800 ${f.size}px "Baloo 2", sans-serif`;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = 5;
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;

    // Face-lost curtain: without a face there are no controls, so say so.
    if (this.faceLost) {
      ctx.fillStyle = 'rgba(7,16,30,0.55)';
      ctx.fillRect(0, 0, w, h);
      ctx.font = '800 26px "Baloo 2", sans-serif';
      ctx.fillStyle = '#ffd94a';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 5;
      ctx.strokeText('SHOW YOUR FACE, CAPTAIN', w / 2, h * 0.45);
      ctx.fillText('SHOW YOUR FACE, CAPTAIN', w / 2, h * 0.45);
    }

    ctx.restore();
  }

  private drawEnemy(ctx: CanvasRenderingContext2D, e: Enemy, now: number): void {
    const sprite = this.art[e.spec.kind];
    ctx.save();
    ctx.translate(e.x, e.y);
    const bob = Math.sin(now / 700 + e.phase) * 0.03;
    ctx.rotate(bob);
    if (e.dying > 0) {
      const t = 1 - e.dying / (e.spec.kind === 'boss' ? 2200 : 1100);
      ctx.globalAlpha = 1 - t * 0.85;
      ctx.rotate(t * 0.5);
      ctx.scale(1 - t * 0.2, 1 - t * 0.2);
    }
    if (sprite.ready()) {
      ctx.drawImage(sprite.img, -e.w / 2, -e.h / 2, e.w, e.h);
    } else {
      drawPirateFallback(ctx, e.w, e.h, e.spec.kind === 'boss' ? '#3a1a1a' : '#4a4a52');
    }
    ctx.restore();

    if (e.dying > 0) return;

    // Armour state — the read the whole ironclad/boss fight hangs on.
    if (e.spec.kind === 'ironclad' || e.spec.kind === 'boss') {
      const open = e.portsOpen;
      ctx.save();
      ctx.translate(e.x, e.y);
      if (open) {
        const pulse = 0.55 + Math.sin(now / 110) * 0.25;
        ctx.globalAlpha = pulse;
        ctx.fillStyle = '#ff7a2c';
        for (const sx of [-0.22, 0.22]) {
          ctx.beginPath();
          ctx.ellipse(e.w * sx, e.h * 0.02, e.w * 0.13, e.h * 0.055, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.font = '800 15px "Baloo 2", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffd94a';
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.lineWidth = 4;
        ctx.strokeText('PORTS OPEN', 0, e.h * 0.5 + 20);
        ctx.fillText('PORTS OPEN', 0, e.h * 0.5 + 20);
      } else {
        // Shield shimmer.
        ctx.globalAlpha = 0.30 + Math.sin(now / 300) * 0.06;
        ctx.strokeStyle = '#9fd8ff';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.ellipse(0, 0, e.w * 0.56, e.h * 0.46, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = 'rgba(140,200,255,0.10)';
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    }

    // No canvas health bar: the enemy sails high enough that it would
    // sit under the HUD's own bar, and two red bars for one pirate is
    // just noise.
  }

  private drawBoat(ctx: CanvasRenderingContext2D, now: number): void {
    const hullW = this.hullW;
    const hullH = this.hullH;
    const hurt = now < this.hurtUntil;
    ctx.save();
    ctx.translate(this.boatX, this.boatY);
    ctx.rotate(this.rock);
    // I-frames flash.
    if (hurt) ctx.globalAlpha = 0.45 + Math.abs(Math.sin(now / 60)) * 0.55;

    const boat = this.art.boat;
    if (boat.ready()) {
      ctx.drawImage(boat.img, -hullW / 2, -hullH / 2, hullW, hullH);
    } else {
      drawHullFallback(ctx, hullW, hullH);
    }

    // Cannon, bolted to the aim axis.
    drawCannon(ctx, 0, this.pivotY, this.aim, this.cannonLen, this.charge, this.flash);

    // Captain Ronke at the helm, leaning into the shot.
    const face = this.face?.() ?? null;
    paintCaptain(
      ctx,
      {
        x: 0,
        y: hullH * 0.10,
        angle: this.aim,
        width: hullW * 1.32,
        open: face?.mouthOpen ? 1 : 0,
        charging: this.charging,
        recoil: this.recoil,
        alpha: 1,
      },
      this.video,
      face,
    );
    ctx.restore();

    // Reload sweep under the hull: a thin arc that fills as the next
    // ball goes home, so "why didn't it fire" is never a mystery.
    const rem = this.readyAt - now;
    if (rem > 0) {
      const total = this.config.reloadMs + 340;
      const t = 1 - Math.min(1, rem / total);
      ctx.save();
      ctx.translate(this.boatX, this.boatY + hullH * 0.52);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(0, 0, hullW * 0.5, Math.PI * 0.85, Math.PI * 2.15);
      ctx.stroke();
      ctx.strokeStyle = '#ffd94a';
      ctx.beginPath();
      ctx.arc(0, 0, hullW * 0.5, Math.PI * 0.85, Math.PI * 0.85 + Math.PI * 1.3 * t);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Dashed tracer along the aim axis — the firing solution, drawn. */
  private drawAimLine(ctx: CanvasRenderingContext2D): void {
    const m = this.muzzle();
    const len = this.h * 0.95;
    const ex = m.x + Math.sin(m.a) * len;
    const ey = m.y - Math.cos(m.a) * len;
    const charged = this.charge > 0.8;
    const ready = !this.isReloading();
    ctx.save();
    ctx.setLineDash([9, 13]);
    ctx.lineDashOffset = -performance.now() / 30;
    ctx.lineWidth = charged ? 3 : 2;
    ctx.strokeStyle = charged
      ? 'rgba(255,170,60,0.85)'
      : ready ? 'rgba(255,255,255,0.36)' : 'rgba(255,255,255,0.14)';
    ctx.beginPath();
    ctx.moveTo(m.x, m.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.setLineDash([]);

    // Crosshair where the line crosses the enemy band.
    const e = this.enemy;
    if (e && e.dying <= 0) {
      const dy = e.y - m.y;
      if (dy < 0) {
        const t = dy / -Math.cos(m.a);
        const cx = m.x + Math.sin(m.a) * t;
        const on = Math.abs(cx - e.x) < e.w * 0.42;
        ctx.strokeStyle = on ? 'rgba(125,255,160,0.95)' : 'rgba(255,255,255,0.45)';
        ctx.lineWidth = on ? 3 : 2;
        const r = on ? 16 : 11;
        ctx.beginPath();
        ctx.arc(cx, e.y, r, 0, Math.PI * 2);
        ctx.stroke();
        if (on) {
          ctx.beginPath();
          ctx.moveTo(cx - r - 7, e.y);
          ctx.lineTo(cx - r + 3, e.y);
          ctx.moveTo(cx + r - 3, e.y);
          ctx.lineTo(cx + r + 7, e.y);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  /** Title-screen ambience: the sea keeps rolling behind the menu. */
  renderIdle(dt: number): void {
    const ctx = this.ctx;
    this.sea.update(dt, 340, this.w, this.h);
    this.sea.render(ctx, this.w, this.h);
  }
}

function blankStats(): RoundStats {
  return {
    pirates: 0, bosses: 0, barrels: 0, supplies: 0,
    bestCombo: 0, shots: 0, hits: 0, mighty: 0, broadsides: 0, distance: 0,
  };
}
