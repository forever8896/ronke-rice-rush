// ═════════════════════════════════════════════════════════════
// RONKE BOAT BATTLE — the loop and the picture.
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
// The rules live in sim.ts and run on a fixed 60 Hz step. This file
// owns everything around them: feeding the step with the face's
// latest reading, logging each step's input for ranked voyages,
// hit-stop and screen shake, particles, and drawing the lot. The
// field is a fixed FIELD_W × FIELD_H, scaled to fit the canvas.
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
import { Sea } from './sea';
import { paintCaptain } from './captain';
import type { FaceState } from './detection';
import {
  Sim, STEP_MS, FIELD_W, FIELD_H, DEFAULT_GAME_CONFIG,
  type Enemy, type EnemyKind, type GameConfig, type SimCallbacks, type SimFx, type SimInput,
} from './sim';
import { RunRecorder, decodeInputs, type RunLogWire } from './runlog';

export { DEFAULT_GAME_CONFIG };
export type { GameConfig, RoundStats, Signal, StageInfo } from './sim';
export type GameCallbacks = SimCallbacks;
export type GameState = 'idle' | 'playing' | 'over';

const W = FIELD_W;
const H = FIELD_H;
/** Most sim steps one frame may run before it gives up catching up. */
const MAX_CATCHUP = 4;

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

export interface StartOptions {
  drill?: boolean;
  /** Dealt by the server for a ranked voyage; random otherwise. */
  seed?: number;
  /** Log every step's input so the server can replay the run. */
  record?: boolean;
}

export class Game {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: GameConfig;
  private cb: GameCallbacks;

  private state: GameState = 'idle';
  private sim: Sim | null = null;
  private recorder: RunRecorder | null = null;
  /** Replay mode: inputs come from a log instead of the face. */
  private script: SimInput[] | null = null;
  /** Review mode: the replay only moves when seekReplay() says so. */
  private manual = false;
  private replaySeed = 0;
  /** Jumping the replay: skipped steps make no sound and no particles. */
  private seeking = false;
  private sea = new Sea();
  private bitmaps: BarrelBitmaps;
  private art: Record<string, Sprite>;

  // Live input, refreshed by the control pump between steps.
  private steer = 0.5;
  private aim = 0;
  private mouth = false;
  private faceLost = false;

  // Loop timing
  private rafId = 0;
  private lastFrameAt = 0;
  private acc = 0;
  private hitStopUntil = 0;

  // Pure presentation
  private particles: Particle[] = [];
  private floats: Float[] = [];
  private shocks: Shock[] = [];
  private shake = 0;
  private flash = 0;
  private recoil = 0;
  private lastStorm = -1;

  // Field → canvas transform, refreshed on resize.
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;
  private scale = 1;
  private offX = 0;
  private offY = 0;

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
    this.dpr = window.devicePixelRatio || 1;
    this.cssW = this.canvas.clientWidth || window.innerWidth;
    this.cssH = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    // Fit the field, then let it overhang a touch rather than letterbox
    // a phone that's slightly taller or wider than 1:2.
    this.scale = Math.min(this.cssW / W, this.cssH / H);
    this.offX = (this.cssW - W * this.scale) / 2;
    this.offY = (this.cssH - H * this.scale) / 2;
  };

  // ── Public API ──

  getState(): GameState { return this.state; }
  getScore(): number { return this.sim ? this.sim.score : 0; }
  getCombo(): number { return this.sim ? this.sim.combo : 0; }
  isBroadside(): boolean { return !!this.sim && this.sim.isBroadside(); }
  broadsideFraction(): number { return this.sim ? this.sim.broadsideFraction() : 0; }
  isReloading(): boolean { return !!this.sim && this.sim.isReloading(); }
  /** The input log of the voyage just played (ranked runs only). */
  getLog(): RunLogWire | null { return this.recorder ? this.recorder.toWire() : null; }
  /** Steps the current/last voyage has run, for the pacing check. */
  getSteps(): number { return this.sim ? this.sim.steps : 0; }

  setCaptainSource(video: HTMLVideoElement, face: () => FaceState | null): void {
    this.video = video;
    this.face = face;
  }

  /** Where the head is, 0 (screen left) … 1 (screen right). */
  setSteer(x: number): void { this.steer = Math.max(0, Math.min(1, x)); }

  /** Cannon angle in radians; 0 = straight up the sea, + = right. */
  setAim(angle: number): void {
    const m = this.config.maxAim;
    this.aim = Math.max(-m, Math.min(m, angle));
  }

  /** Mouth open packs powder; the step that sees it close fires. */
  setMouth(open: boolean): void { this.mouth = open; }

  setFaceLost(lost: boolean): void { this.faceLost = lost; }

  start(opts: StartOptions = {}): void {
    const seed = opts.seed ?? Math.floor(Math.random() * 0xffffffff);
    this.script = null;
    this.manual = false;
    this.recorder = opts.record ? new RunRecorder() : null;
    this.begin(new Sim({ seed, drill: opts.drill, config: this.config, callbacks: this.simCallbacks(), fx: this.fx }));
  }

  /**
   * Play a logged voyage back exactly as it was sailed. With `manual`,
   * it doesn't advance on its own — seekReplay() drives it (the review
   * page slaves it to the face clip's playhead).
   */
  startReplay(seed: number, log: RunLogWire, manual = false): void {
    this.script = decodeInputs(log);
    this.recorder = null;
    this.faceLost = false;
    this.manual = manual;
    this.replaySeed = seed;
    this.begin(new Sim({ seed, config: this.config, callbacks: this.simCallbacks(), fx: this.fx }));
  }

  /** Review mode: bring the replay to `step`. Backwards means a fresh run fast-forwarded — the sim is fast. */
  seekReplay(step: number): void {
    if (!this.script || !this.sim) return;
    const target = Math.max(0, Math.min(step, this.script.length));
    if (target < this.sim.steps) {
      this.sim = new Sim({ seed: this.replaySeed, config: this.config, callbacks: this.simCallbacks(), fx: this.fx });
      this.state = 'playing';
      this.particles = [];
      this.floats = [];
      this.shocks = [];
    }
    // A frame or two of normal playback keeps its sound and spray; a jump
    // would otherwise fire every skipped explosion in the same instant.
    this.seeking = target - this.sim.steps > 3;
    while (this.sim.steps < target && this.sim.state === 'playing') this.stepOnce();
    this.seeking = false;
    if (this.state !== 'playing') {
      // Ran off the end: keep the last frame up.
      this.state = 'playing';
      cancelAnimationFrame(this.rafId);
      this.rafId = requestAnimationFrame(this.frame);
    }
  }

  /** The logged input at the replay's current step, for the review gauges. */
  replayInput(): SimInput | null {
    if (!this.script || !this.sim) return null;
    return this.script[Math.max(0, this.sim.steps - 1)] ?? null;
  }

  private begin(sim: Sim): void {
    this.sim = sim;
    this.state = 'playing';
    this.mouth = false;
    this.particles = [];
    this.floats = [];
    this.shocks = [];
    this.shake = 0;
    this.flash = 0;
    this.recoil = 0;
    this.hitStopUntil = 0;
    this.lastStorm = -1;
    this.acc = 0;
    this.lastFrameAt = performance.now();
    cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.state = 'idle';
    cancelAnimationFrame(this.rafId);
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** The sim's callbacks, with the end of the voyage routed through here first. */
  private simCallbacks(): SimCallbacks {
    return {
      ...this.cb,
      onSignal: (sig, value) => {
        if (!this.seeking) this.cb.onSignal(sig, value);
      },
      onEnd: (score, stats) => {
        // Review keeps the picture up at the end; the reviewer scrubs.
        if (this.manual) return;
        this.state = 'over';
        cancelAnimationFrame(this.rafId);
        this.render();
        this.cb.onEnd(score, stats);
      },
    };
  }

  // ── Drill API ──
  // Pass-throughs for the tutorial director; inert outside drill mode.

  drillBarrel(kind: BarrelKind, xFrac: number, speedMul = 1): void { this.sim?.drillBarrel(kind, xFrac, speedMul); }
  drillEnemy(kind: EnemyKind, hp: number): void { this.sim?.drillEnemy(kind, hp); }
  drillClear(): void { this.sim?.drillClear(); }
  setHull(n: number): void { this.sim?.setHull(n); }

  /** How many barrels are still in play (optionally of one kind). */
  liveBarrels(kind?: BarrelKind): number {
    return this.sim ? this.sim.barrels.filter((b) => !b.dead && (!kind || b.kind === kind)).length : 0;
  }

  enemyAlive(): boolean {
    const e = this.sim?.enemy;
    return !!e && e.dying <= 0;
  }

  /** Boat position as 0…1 across the field, for aimed spawns. */
  boatFraction(): number { return this.sim ? this.sim.boatX / W : 0.5; }

  // ── Main frame ──
  // Real time is banked and spent in fixed sim steps. Hit-stop freezes
  // the bank; a long gap (hidden tab — RAF pauses) is simply dropped,
  // so nothing comes due all at once when the player switches back.

  private frame = (): void => {
    if (this.state !== 'playing' || !this.sim) return;
    const now = performance.now();
    let gap = now - this.lastFrameAt;
    this.lastFrameAt = now;
    if (gap > 400) gap = 0;
    const dt = Math.min(0.05, gap / 1000);

    if (this.manual) {
      // Review: the face clip's playhead decides the step, not the clock.
    } else if (now >= this.hitStopUntil) {
      this.acc += gap;
      let n = 0;
      while (this.acc >= STEP_MS && n < MAX_CATCHUP && this.state === 'playing') {
        this.stepOnce();
        this.acc -= STEP_MS;
        n++;
        if (performance.now() < this.hitStopUntil) { this.acc = 0; break; }
      }
      if (n === MAX_CATCHUP) this.acc = 0;
    }
    if (this.state !== 'playing') return;

    const sim = this.sim;
    if (sim.storm !== this.lastStorm) {
      this.sea.setStorm(sim.storm);
      this.lastStorm = sim.storm;
    }
    this.sea.setCurrent(sim.currentPx);
    this.sea.update(dt, sim.scroll, W, H);
    this.flash = Math.max(0, this.flash - dt * 6);
    this.recoil = Math.max(0, this.recoil - dt * 5);
    this.shake = Math.max(0, this.shake - dt * 26);
    this.updateFx(dt);

    this.render();
    this.rafId = requestAnimationFrame(this.frame);
  };

  private stepOnce(): void {
    const sim = this.sim;
    if (!sim) return;
    let input: SimInput;
    if (this.script) {
      const next = this.script[sim.steps];
      if (!next) {
        // Log ran dry before the hull did — the voyage was abandoned.
        this.state = 'over';
        return;
      }
      input = next;
    } else {
      input = {
        steer: Math.round(this.steer * 1000),
        aim: Math.round(this.aim * 1000),
        mouth: this.mouth,
      };
      this.recorder?.push(input);
    }
    sim.step(input);
  }

  // ── FX sink ──
  // The sim says what happened; this decides how it looks. Free to use
  // Math.random — none of it ever feeds back into the rules.

  private fx: SimFx = {
    puff: (x, y, n, color, shape = 'spark') => { if (!this.seeking) this.puff(x, y, n, color, shape); },
    splinter: (x, y, kind) => { if (!this.seeking) this.splinter(x, y, kind); },
    boom: (x, y, scale) => { if (!this.seeking) this.boom(x, y, scale); },
    float: (x, y, text, color, size) => { if (!this.seeking) this.floats.push({ x, y, text, color, age: 0, size }); },
    shake: (amount) => { if (!this.seeking) this.shake = Math.max(this.shake, amount); },
    hitStop: (ms) => { if (!this.manual) this.hitStopUntil = Math.max(this.hitStopUntil, performance.now() + ms); },
    fired: () => { this.flash = 1; this.recoil = 1; },
    sinking: (e, dt) => {
      if (!this.seeking && Math.random() < dt * 14) {
        this.boom(e.x + (Math.random() - 0.5) * e.w * 0.7, e.y + (Math.random() - 0.5) * e.h * 0.5, 0.5);
      }
    },
    ramming: (e, dt) => {
      // Bow wave while he closes.
      if (!this.seeking && Math.random() < dt * 30) {
        this.particles.push({
          x: e.x + (Math.random() - 0.5) * e.w * 0.8, y: e.y + e.h * 0.45,
          vx: (Math.random() - 0.5) * 90, vy: 220 + Math.random() * 160,
          age: 0, life: 500, color: 'rgba(255,255,255,0.85)', size: 4 + Math.random() * 5,
          shape: 'foam',
        });
      }
    },
  };

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
    const sim = this.sim;
    // Cannonball trails.
    if (sim) {
      for (const ball of sim.balls) {
        if (Math.random() < 0.6) {
          this.particles.push({
            x: ball.x, y: ball.y, vx: 0, vy: 0, age: 0, life: 220,
            color: ball.power > 0.75 ? 'rgba(255,170,60,0.7)' : 'rgba(210,220,230,0.5)',
            size: ball.r * 0.7, shape: 'smoke',
          });
        }
      }
    }
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
    const sim = this.sim;
    if (!sim) return;
    const ctx = this.ctx;
    const now = performance.now();

    // Gutters outside the field: deep water, so a non-1:2 screen reads
    // as open sea rather than a letterbox.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#0b2a4a';
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    const k = this.dpr * this.scale;
    ctx.setTransform(k, 0, 0, k, this.dpr * this.offX, this.dpr * this.offY);

    ctx.save();
    if (this.shake > 0.4) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
    }

    this.sea.render(ctx, W, H);
    this.sea.wake(ctx, sim.boatX, sim.boatY + sim.hullH * 0.42, sim.hullW, H, sim.scroll);

    // Enemy first — it's furthest away.
    if (sim.enemy) this.drawEnemy(ctx, sim.enemy, now);

    // Barrels.
    for (const b of sim.barrels) {
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
    for (const b of sim.eballs) drawEnemyBall(ctx, b.x, b.y, b.r, b.spin);

    // Your iron.
    for (const b of sim.balls) drawCannonball(ctx, b.x, b.y, b.r, b.power, now);

    this.drawBoat(ctx, sim, now);
    this.drawAimLine(ctx, sim);

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
    if (this.faceLost && !this.script) {
      ctx.fillStyle = 'rgba(7,16,30,0.55)';
      ctx.fillRect(0, 0, W, H);
      ctx.font = '800 26px "Baloo 2", sans-serif';
      ctx.fillStyle = '#ffd94a';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 5;
      ctx.strokeText('SHOW YOUR FACE, CAPTAIN', W / 2, H * 0.45);
      ctx.fillText('SHOW YOUR FACE, CAPTAIN', W / 2, H * 0.45);
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
      ctx.save();
      ctx.translate(e.x, e.y);
      if (e.portsOpen) {
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

  private drawBoat(ctx: CanvasRenderingContext2D, sim: Sim, now: number): void {
    const hullW = sim.hullW;
    const hullH = sim.hullH;
    const hurt = sim.t < sim.hurtUntil;
    ctx.save();
    ctx.translate(sim.boatX, sim.boatY);
    ctx.rotate(sim.rock);
    // I-frames flash.
    if (hurt) ctx.globalAlpha = 0.45 + Math.abs(Math.sin(now / 60)) * 0.55;

    const boat = this.art.boat;
    if (boat.ready()) {
      ctx.drawImage(boat.img, -hullW / 2, -hullH / 2, hullW, hullH);
    } else {
      drawHullFallback(ctx, hullW, hullH);
    }

    // Cannon, bolted to the aim axis.
    drawCannon(ctx, 0, sim.pivotY, sim.aim, sim.cannonLen, sim.charge, this.flash);

    // Captain Ronke at the helm, leaning into the shot. A replay has no
    // camera, so his own mouth stands in.
    const face = this.script ? null : this.face?.() ?? null;
    paintCaptain(
      ctx,
      {
        x: 0,
        y: hullH * 0.10,
        angle: sim.aim,
        width: hullW * 1.32,
        // Live: the camera's jaw. Replay: the recorded mouth, gaping wider
        // as the powder packs, shut the instant the shot goes.
        open: face ? (face.mouthOpen ? 1 : 0) : sim.charging ? 0.35 + 0.65 * sim.charge : 0,
        charging: sim.charging,
        recoil: this.recoil,
        alpha: 1,
      },
      this.script ? null : this.video,
      face,
    );
    ctx.restore();

    // Reload sweep under the hull: a thin arc that fills as the next
    // ball goes home, so "why didn't it fire" is never a mystery.
    const rem = sim.readyAt - sim.t;
    if (rem > 0) {
      // Against the reload actually in flight — the fixed span here read
      // half-full the instant a light shot went off, and never filled
      // during a broadside.
      const total = Math.max(1, sim.reloadSpan);
      const t = 1 - Math.min(1, rem / total);
      ctx.save();
      ctx.translate(sim.boatX, sim.boatY + hullH * 0.52);
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
  private drawAimLine(ctx: CanvasRenderingContext2D, sim: Sim): void {
    const m = sim.muzzle();
    const len = H * 0.95;
    const ex = m.x + Math.sin(m.a) * len;
    const ey = m.y - Math.cos(m.a) * len;
    const charged = sim.charge > 0.8;
    const ready = !sim.isReloading();
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
    const e = sim.enemy;
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
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.sea.update(dt, 340, this.cssW, this.cssH);
    this.sea.render(ctx, this.cssW, this.cssH);
  }
}
