// ═════════════════════════════════════════════════════════════
// RONKE BOAT BATTLE — the rules, with nothing else attached.
//
// This is the whole game minus the pixels: boat physics, barrels,
// pirates, the boss, scoring. It touches no DOM, no wall clock and no
// Math.random, which is what lets the server replay a voyage from its
// input log and land on exactly the score the player saw:
//
//   • Time is a step counter. Every step is STEP_MS of game time, so a
//     run is a pure function of (seed, inputs) — frame rate, tab
//     switches and hit-stop live in the renderer, not here.
//   • Randomness comes from one seeded RNG, consumed only by rules.
//     Anything purely visual goes out through the FX sink, which the
//     browser fills with its own Math.random and the server ignores.
//   • The field is a fixed FIELD_W × FIELD_H, scaled to fit whatever
//     screen it lands on. Every captain sails the same water.
//
// The design notes on WHY the economy is tuned this way live with
// each rule below; see also the README's "How the loop pays".
// ═════════════════════════════════════════════════════════════

import { dsin, dcos, dexp, dhypot, makeRng } from './dmath.js';

/** Bump whenever a rule changes: old logs must not replay on new rules. */
export const SIM_VERSION = 1;

export const STEP_MS = 1000 / 60;
const STEP_S = STEP_MS / 1000;
/** A voyage ends here no matter what: 60 minutes of game time. */
export const MAX_STEPS = 60 * 60 * 60;

export const FIELD_W = 432;
export const FIELD_H = 864;
/** Fraction of the field taken by sky above the waterline. */
export const HORIZON = 0.13;

/** Sprite aspect ratios (height / width), from the PNGs in public/sea. */
export const SPRITE_RATIO: Record<'boat' | EnemyKind, number> = {
  boat: 420 / 145,
  skiff: 460 / 205,
  gunner: 460 / 236,
  ironclad: 460 / 208,
  boss: 700 / 354,
};

export type BarrelKind = 'wood' | 'powder' | 'spike' | 'rice';
export type EnemyKind = 'skiff' | 'gunner' | 'ironclad' | 'boss';
export type SimState = 'playing' | 'over';

export type Signal =
  | 'fire-light' | 'fire-mighty' | 'charge' | 'dry-click'
  | 'barrel-pop' | 'powder-blast' | 'supply' | 'ping'
  | 'enemy-hit' | 'enemy-sunk' | 'boss-in' | 'boss-sunk'
  | 'hull-hit' | 'broadside' | 'stage-up';

/**
 * One step of player input, already quantised — these integers are
 * exactly what gets logged and replayed.
 */
export interface SimInput {
  /** Head position, 0 (left) … 1000 (right). */
  steer: number;
  /** Cannon angle in milliradians; 0 = straight up the sea. */
  aim: number;
  /** Mouth open (packing powder). Closing it fires. */
  mouth: boolean;
}

export interface EnemySpec {
  kind: EnemyKind;
  name: string;
  hp: number;
  /** Sprite width as a fraction of the field. */
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
  /** Fire during a reload this close to ready and the shot is queued. */
  shotBufferMs: number;
  /** No hit for this long and the chain lapses. */
  comboDecayMs: number;
  broadside: {
    /** Hits needed SINCE the last broadside to earn the next one. */
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
  shotBufferMs: 320,
  comboDecayMs: 3800,
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
//
// Base HP is sized against the gun, which does ~3 damage a second
// however you swing it (a tap reloads fast and hits for 1, a full
// charge is slow and hits for 4). So `hp: 12` reads as "a four-second
// fight at stage 1", and the saturating scale below tops every pirate
// out around a twenty-second one. The ironclad is cheap in HP on
// purpose — its armour rhythm, not its hull, is the difficulty.
const ROSTER: EnemySpec[] = [
  { kind: 'skiff', name: 'BARREL SKIFF', hp: 10, widthFrac: 0.30, speed: 1.0 },
  { kind: 'gunner', name: 'GUNBOAT', hp: 15, widthFrac: 0.34, speed: 1.25 },
  { kind: 'ironclad', name: 'IRONCLAD', hp: 11, widthFrac: 0.31, speed: 0.85 },
  { kind: 'skiff', name: 'RAIDER SKIFF', hp: 14, widthFrac: 0.30, speed: 1.5 },
];
const BOSS: EnemySpec = {
  kind: 'boss', name: 'CAPTAIN RUGBEARD', hp: 85, widthFrac: 0.62, speed: 0.7,
};

/**
 * How long a ship is allowed to sit there before it starts pressing.
 * A boss gets a long fuse because a boss fight is SUPPOSED to run —
 * the ramp is there to break stalemates, not to rush the set piece.
 */
const PRESS_AT_MS = 14_000;
const BOSS_PRESS_AT_MS = 40_000;

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

export interface SimCallbacks {
  onSignal: (s: Signal, value?: number) => void;
  onHull: (hp: number, hit: boolean) => void;
  onCombo: (combo: number, mul: number) => void;
  onStage: (info: StageInfo) => void;
  /** Enemy health 0..1 and its name, for the top-of-screen bar. */
  onEnemyHealth: (frac: number, name: string, boss: boolean) => void;
  onBroadside: (active: boolean) => void;
  onEnd: (score: number, stats: RoundStats) => void;
}

/**
 * Everything the rules want SHOWN but that never feeds back into the
 * rules. The browser draws it; the server's replay passes NULL_FX.
 */
export interface SimFx {
  puff(x: number, y: number, n: number, color: string, shape?: 'spark' | 'smoke'): void;
  splinter(x: number, y: number, kind: BarrelKind): void;
  boom(x: number, y: number, scale: number): void;
  float(x: number, y: number, text: string, color: string, size: number): void;
  shake(amount: number): void;
  /** Freeze the picture for a beat. Game time does not stop. */
  hitStop(ms: number): void;
  /** Muzzle flash + recoil. */
  fired(power: number): void;
  /** One step of a sinking hull (debris and bursts). */
  sinking(e: Enemy, dt: number): void;
  /** One step of the boss's ram (bow wave). */
  ramming(e: Enemy, dt: number): void;
}

const noop = (): void => {};
export const NULL_FX: SimFx = {
  puff: noop, splinter: noop, boom: noop, float: noop, shake: noop,
  hitStop: noop, fired: noop, sinking: noop, ramming: noop,
};
export const NULL_CALLBACKS: SimCallbacks = {
  onSignal: noop, onHull: noop, onCombo: noop, onStage: noop,
  onEnemyHealth: noop, onBroadside: noop, onEnd: noop,
};

export interface Barrel {
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

export interface Ball {
  x: number; y: number;
  vx: number; vy: number;
  r: number;
  power: number;
  dmg: number;
  pierce: boolean;
  dead: boolean;
  /** Connected with anything yet? Accuracy counts balls, not victims. */
  hit: boolean;
}

export interface EnemyBall {
  x: number; y: number;
  vx: number; vy: number;
  r: number;
  spin: number;
  dead: boolean;
}

export interface Enemy {
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
  /** Standoff pressure has been announced (once per pirate). */
  pressed: boolean;
}

export interface SimOptions {
  seed: number;
  /**
   * Drill mode: the real loop, real physics, real gun — but the sea
   * sends nothing on its own and the hull can't be lost. The tutorial
   * director stocks the water by hand so it can teach one idea at a
   * time in the actual game rather than in a diagram of it.
   */
  drill?: boolean;
  config?: GameConfig;
  callbacks?: SimCallbacks;
  fx?: SimFx;
}

const W = FIELD_W;
const H = FIELD_H;

export class Sim {
  readonly config: GameConfig;
  readonly drill: boolean;
  private rng: () => number;
  private cb: SimCallbacks;
  private fx: SimFx;

  state: SimState = 'playing';
  /** Game time, ms. Advances STEP_MS per step and nothing else. */
  t = 0;
  steps = 0;

  // Entities
  barrels: Barrel[] = [];
  balls: Ball[] = [];
  eballs: EnemyBall[] = [];
  enemy: Enemy | null = null;

  // Boat
  boatX = W / 2;
  boatVX = 0;
  steer = 0.5;
  aim = 0;
  aimTarget = 0;
  rock = 0;
  charge = 0;
  charging = false;
  private chargeStart = 0;
  private mouthWas = false;
  readyAt = 0;
  /** Total length of the reload in flight, for the sweep under the hull. */
  reloadSpan = 0;
  /** Shot fired mid-reload, waiting for the ball to seat. */
  private queuedPower = -1;
  hurtUntil = 0;

  // Run state
  hp: number;
  score = 0;
  combo = 0;
  /** Hits banked toward the next broadside (reset when one fires). */
  private comboBank = 0;
  /** Game time of the last hit — the chain lapses off this. */
  private lastHitAt = 0;
  stage = 0;
  stats: RoundStats = blankStats();
  private nextStageAt = 900;
  private ambientAt = 1200;
  private barrageAt = 26_000;
  broadsideUntil = 0;
  currentPx = 0;
  private currentTarget = 0;
  scroll = 520;
  /** Weather 0…1; turns with the tier. */
  storm = 0;

  constructor(opts: SimOptions) {
    this.config = opts.config ?? DEFAULT_GAME_CONFIG;
    this.drill = !!opts.drill;
    this.rng = makeRng(opts.seed);
    this.cb = opts.callbacks ?? NULL_CALLBACKS;
    this.fx = opts.fx ?? NULL_FX;
    this.hp = this.config.hull;
    this.cb.onHull(this.hp, false);
    this.cb.onCombo(0, 1);
  }

  // ── Geometry ──
  // The boat is sized by LENGTH (it has to fit above the bottom edge)
  // and the beam falls out of the sprite's own aspect, so what you see
  // and what the barrels collide with are the same rectangle.
  readonly hullH = Math.max(118, Math.min(H * 0.235, 250));
  readonly hullW = this.hullH / SPRITE_RATIO.boat;
  readonly boatY = H * 0.78;
  readonly cannonLen = this.hullH * 0.30;
  /** Cannon pivot in boat-local space (before rock). */
  readonly pivotY = -this.hullH * 0.30;

  isBroadside(): boolean { return this.t < this.broadsideUntil; }
  broadsideFraction(): number {
    if (!this.isBroadside()) return 0;
    return (this.broadsideUntil - this.t) / this.config.broadside.durationMs;
  }
  isReloading(): boolean { return this.t < this.readyAt; }
  private get tier(): number { return Math.floor((this.stage - 1) / 5) + 1; }

  // ── The step ──

  step(input: SimInput): void {
    if (this.state !== 'playing') return;
    if (this.steps >= MAX_STEPS) { this.endRound(); return; }
    this.steps++;
    this.t += STEP_MS;
    const now = this.t;
    const dt = STEP_S;

    // ── Input ──
    this.steer = Math.max(0, Math.min(1000, input.steer)) / 1000;
    const m = this.config.maxAim;
    this.aimTarget = Math.max(-m, Math.min(m, input.aim / 1000));
    if (input.mouth && !this.mouthWas) this.startCharge();
    else if (!input.mouth && this.mouthWas) this.fire(now - this.chargeStart);
    this.mouthWas = input.mouth;

    this.stats.distance = (now / 1000) * 0.021;
    // Staying alive is worth a trickle and nothing more — the loot is in
    // the fighting, so surviving without shooting can't out-earn it.
    if (!this.drill) this.score += 4 * dt * (this.isBroadside() ? 2 : 1);

    // ── Charge ──
    this.charge = this.charging
      ? Math.min(1, (now - this.chargeStart) / this.config.fullChargeMs)
      : 0;

    // ── Queued shot lands the moment the ball is seated ──
    if (this.queuedPower >= 0 && now >= this.readyAt) {
      const p = this.queuedPower;
      this.queuedPower = -1;
      this.shoot(p);
    }

    // ── The chain lapses ──
    if (this.combo > 0 && now - this.lastHitAt > this.config.comboDecayMs) {
      this.combo = 0;
      this.comboBank = 0;
      this.cb.onCombo(0, 1);
      this.fx.float(this.boatX, this.boatY - 90, 'CHAIN LOST', '#9fb3c4', 18);
    }

    // ── Broadside expiry ──
    if (this.broadsideUntil > 0 && now >= this.broadsideUntil) {
      this.broadsideUntil = 0;
      this.cb.onBroadside(false);
    }

    // ── Sea state ──
    // From tier 2 a lateral current shoves the hull, so holding a lane
    // means holding your head off-centre. It rolls over slowly.
    if (this.tier >= 2) {
      if (this.rng() < dt * 0.12) {
        this.currentTarget = (this.rng() - 0.5) * 2 * (18 + this.tier * 16);
      }
    } else {
      this.currentTarget = 0;
    }
    this.currentPx += (this.currentTarget - this.currentPx) * Math.min(1, dt * 0.7);
    this.scroll = 420 + this.barrelSpeed() * 0.55;

    // ── Boat physics ──
    const margin = this.hullW * 0.55;
    const target = margin + this.steer * (W - margin * 2);
    // Spring toward the head position, with real inertia: the hull is
    // heavy, so you have to lead your dodges.
    this.boatVX += ((target - this.boatX) * 88 - this.boatVX * 13) * dt;
    this.boatX += (this.boatVX + this.currentPx) * dt;
    if (this.boatX < margin) { this.boatX = margin; this.boatVX *= -0.2; }
    if (this.boatX > W - margin) { this.boatX = W - margin; this.boatVX *= -0.2; }
    // Rock: the swell plus a lean into the turn.
    const swell = dsin(now / 620) * 0.035 + dsin(now / 271) * 0.018;
    this.rock += (swell + this.boatVX * 0.00035 - this.rock) * Math.min(1, dt * 9);
    this.aim += (this.aimTarget - this.aim) * Math.min(1, dt * 18);

    // ── Stage flow ──
    // In a drill the director owns what's on the water, so no pirate
    // sails in on its own and no stage counter advances.
    if (!this.drill && !this.enemy && now >= this.nextStageAt) this.spawnStage();
    if (this.enemy) this.updateEnemy(this.enemy, dt, now);

    // ── Ambient barrels streaming down the sea ──
    // A boss brings his own weather: the drifting stream stops and the
    // sea sends supply crates instead, which is the only way to patch
    // a plank mid-fight. Stacking ambient kegs on top of his volleys
    // made phase 1 unsurvivable.
    const bossFight = !!this.enemy && this.enemy.spec.kind === 'boss' && this.enemy.dying <= 0;
    if (!this.drill && now >= this.ambientAt) {
      this.ambientAt = now + (bossFight
        ? 5000 + this.rng() * 3000
        : this.barrelInterval() * (0.7 + this.rng() * 0.6));
      const x = W * (0.1 + this.rng() * 0.8);
      this.spawnBarrel(x, bossFight ? 'rice' : this.pickBarrelKind());
    }
    // ── Barrage walls, from stage 3 (never during a boss) ──
    if (!this.drill && this.stage >= 3 && !bossFight && now >= this.barrageAt) {
      this.barrageAt = now + Math.max(9000, 20_000 - this.stage * 600) + this.rng() * 5000;
      this.barrage();
    }

    this.updateBarrels(dt);
    this.updateBalls(dt);
    this.updateEnemyBalls(dt);
  }

  // ── Firing ──

  private startCharge(): void {
    this.charging = true;
    this.chargeStart = this.t;
    this.cb.onSignal('charge');
  }

  /** Mouth closed — FIRE. `heldMs` sets the power. */
  private fire(heldMs: number): void {
    if (!this.charging) return;
    this.charging = false;
    const now = this.t;
    const power = Math.max(0, Math.min(1, heldMs / this.config.fullChargeMs));
    this.charge = 0;
    if (now < this.readyAt) {
      // Packing powder while the ball is still being rammed home is
      // exactly what a gun crew does. Queue a chomp that lands near the
      // end of the reload instead of throwing the charge away — without
      // this you have to watch the sweep instead of the sea, and every
      // shot you time by feel is silently eaten.
      if (this.readyAt - now <= this.config.shotBufferMs) {
        this.queuedPower = power;
        return;
      }
      this.cb.onSignal('dry-click');
      const mz = this.muzzle();
      this.fx.puff(mz.x, mz.y, 4, '#b9c6d2');
      return;
    }
    this.shoot(power);
  }

  muzzle(): { x: number; y: number; a: number } {
    const a = this.aim + this.rock;
    const px = this.boatX + dsin(this.rock) * -this.pivotY;
    const py = this.boatY + dcos(this.rock) * this.pivotY;
    return {
      x: px + dsin(a) * this.cannonLen,
      y: py - dcos(a) * this.cannonLen,
      a,
    };
  }

  private shoot(power: number): void {
    const m = this.muzzle();
    const speed = 1180 - power * 260;
    const r = 8 + power * 13;
    const dmg = power < 0.35 ? 1 : power < 0.8 ? 2 : 4;
    const mighty = power >= 0.8;
    const bs = this.config.broadside;
    const spread = this.isBroadside() ? [-bs.spread, 0, bs.spread] : [0];

    for (const off of spread) {
      const a = m.a + off;
      this.balls.push({
        x: m.x, y: m.y,
        vx: dsin(a) * speed,
        vy: -dcos(a) * speed,
        r, power, dmg,
        pierce: mighty,
        dead: false,
        hit: false,
      });
    }

    this.queuedPower = -1;
    this.stats.shots++;
    if (mighty) this.stats.mighty++;
    this.reloadSpan = (this.config.reloadMs + power * 340)
      * (this.isBroadside() ? bs.reloadMul : 1);
    this.readyAt = this.t + this.reloadSpan;
    this.fx.fired(power);
    this.fx.shake(3 + power * 9);
    this.fx.puff(m.x, m.y, 8 + Math.round(power * 14), '#d9d2c4', 'smoke');
    this.cb.onSignal(mighty ? 'fire-mighty' : 'fire-light', power);
    if (mighty) this.fx.hitStop(45);
  }

  // ── Difficulty curve ──
  // Everything scales off the pirate index. `tier` is the lap counter:
  // it ticks up each time a boss goes down and turns the weather.

  private barrelInterval(): number {
    return Math.max(260, 1700 - this.stage * 70);
  }

  private barrelSpeed(): number {
    return Math.min(900, 200 + this.stage * 22 + this.tier * 18);
  }

  /**
   * Enemy hull multiplier. Saturates near 3.8× rather than climbing
   * forever: the gun's damage is flat, so a linear HP ramp turns the
   * late game into a minute of plinking at a sponge you cannot lose to.
   * Past ~stage 15 the pressure comes from the sea instead — barrels
   * keep getting faster and thicker, and those still kill you.
   */
  private hullScale(): number {
    return 1 + 2.8 * (1 - dexp(-(this.stage - 1) / 6));
  }

  private comboMul(): number {
    let mul = 1;
    for (const c of this.config.combo) if (this.combo >= c.step) mul = c.mul;
    return mul;
  }

  private scoreMul(): number {
    return this.comboMul() * (this.isBroadside() ? this.config.broadside.pointsMul : 1);
  }

  // ── Spawning ──

  private makeEnemy(spec: EnemySpec, hp: number, boss: boolean): Enemy {
    // Width-first sizing blew the galleon off the top of the screen on
    // tall columns — these hulls are 2:1 or worse. Cap the LENGTH and
    // let the beam follow.
    const ratio = SPRITE_RATIO[spec.kind];
    let w = W * spec.widthFrac;
    let h = w * ratio;
    const maxH = H * (boss ? 0.42 : 0.30);
    if (h > maxH) { h = maxH; w = h / ratio; }
    return {
      spec, x: W / 2, y: -h * 0.6, w, h,
      hp, maxHp: hp, t: 0,
      phase: this.rng() * Math.PI * 2,
      baseY: boss ? H * 0.245 : H * 0.21,
      dropAt: 900, shootAt: 2200,
      portsOpen: false, portTimer: 2400,
      bossPhase: 1, charging: false, chargeT: 0,
      staggerUntil: 0, dying: 0, pressed: false,
    };
  }

  private spawnStage(): void {
    this.stage++;
    const boss = this.stage % 5 === 0;
    const spec = boss ? BOSS : ROSTER[(this.stage - 1) % ROSTER.length];
    // A boss is a set piece, not a wall: capped so the fight stays a
    // readable minute of phases rather than an endurance test.
    const hp = boss
      ? Math.min(150, 85 + 14 * (this.tier - 1))
      : Math.round(spec.hp * this.hullScale());
    this.enemy = this.makeEnemy(spec, hp, boss);
    // No free hull here. Arriving at a boss on one plank is supposed to
    // be the consequence of the four fights before it — refilling on
    // sight made those four fights cost nothing.
    this.cb.onStage({ index: this.stage, tier: this.tier, name: spec.name, boss });
    this.cb.onEnemyHealth(1, spec.name, boss);
    this.cb.onSignal(boss ? 'boss-in' : 'stage-up');
    // The weather turns with the lap.
    this.storm = Math.min(1, (this.tier - 1) * 0.34);
  }

  private spawnBarrel(x: number, kind: BarrelKind, y?: number, vx = 0, speedMul = 1): void {
    const r = (kind === 'rice' ? 25 : 23) * (W / 700 + 0.55);
    this.barrels.push({
      x,
      y: y ?? H * HORIZON + 8,
      vx,
      vy: this.barrelSpeed() * speedMul * (kind === 'rice' ? 0.8 : 1),
      kind,
      hp: kind === 'spike' ? 2 : 1,
      r,
      spin: this.rng() * Math.PI * 2,
      spinV: (this.rng() - 0.5) * 3 + 3.4,
      dead: false,
      scored: false,
    });
  }

  private pickBarrelKind(): BarrelKind {
    const s = this.stage;
    const roll = this.rng();
    // Crates are the only repair in the game now, so the sea has to
    // actually send them — at 10% a bad run could go two pirates
    // without seeing one, which is a hull you lose to the dice.
    if (roll < 0.15) return 'rice';
    if (s >= 2 && roll < 0.36) return 'powder';
    if (s >= 3 && roll < 0.50) return 'spike';
    return 'wood';
  }

  /** A wall of barrels with exactly one gap — pure positioning test. */
  private barrage(): void {
    const lanes = Math.min(7, 4 + Math.floor(this.stage / 3));
    const gap = Math.floor(this.rng() * lanes);
    const margin = W * 0.08;
    const step = (W - margin * 2) / (lanes - 1);
    for (let i = 0; i < lanes; i++) {
      if (i === gap) continue;
      this.spawnBarrel(margin + step * i, i % 3 === 0 && this.stage >= 3 ? 'spike' : 'wood', undefined, 0, 0.9);
    }
    this.fx.float(W / 2, H * 0.34, 'BARRAGE!', '#ff9a3c', 34);
  }

  // ── Enemies ──

  private updateEnemy(e: Enemy, dt: number, now: number): void {
    e.t += dt * 1000;

    if (e.dying > 0) {
      e.dying -= dt * 1000;
      e.y += 24 * dt;
      this.fx.sinking(e, dt);
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
    const amp = W * (boss ? 0.16 : 0.30);
    e.phase += dt * 0.55 * e.spec.speed * stageSpeed * (e.charging ? 0.2 : 1);
    e.x = W / 2 + dsin(e.phase) * amp + dsin(e.phase * 2.3) * amp * 0.22;

    const staggered = now < e.staggerUntil;

    // ── Ironclad: the armour opens on a rhythm. That window is the
    // whole fight — you have to be aimed and charged when it comes.
    if (e.spec.kind === 'ironclad' || boss) {
      e.portTimer -= dt * 1000;
      if (e.portTimer <= 0) {
        e.portsOpen = !e.portsOpen;
        // The window has to be long enough to actually use: you spend
        // ~1.25s per charged shot, so a 1.5s opening was barely one
        // ball and the ironclad's HP bar crawled however well you read
        // the rhythm.
        e.portTimer = e.portsOpen
          ? (boss ? 2200 : 1800)
          : Math.max(1000, (boss ? 2600 : 2000) - this.stage * 40);
      }
    } else {
      e.portsOpen = true;
    }

    if (staggered) return;

    // ── Attacks ──
    e.dropAt -= dt * 1000;
    e.shootAt -= dt * 1000;

    // Standoff pressure. A pirate you refuse to finish doesn't wait
    // politely — it presses in. Without this, sitting under an enemy
    // you can't out-damage is a stable state you can farm forever,
    // which is the one line of play the whole game is arguing against.
    if (!e.pressed && e.t > (boss ? BOSS_PRESS_AT_MS : PRESS_AT_MS)) {
      e.pressed = true;
      this.fx.float(W / 2, H * 0.38, 'SHE CLOSES IN!', '#ff9a3c', 26);
    }

    if (boss) {
      this.bossBehaviour(e, dt, now);
      return;
    }

    const press = this.pressure(e);
    if (e.dropAt <= 0) {
      e.dropAt = this.barrelInterval() * (e.spec.kind === 'skiff' ? 1.0 : 1.4) / press;
      const n = e.spec.kind === 'skiff' && this.stage >= 4 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        this.spawnBarrel(
          e.x + (this.rng() - 0.5) * e.w * 0.7 + (i - 0.5) * 40,
          this.pickBarrelKind(),
          e.y + e.h * 0.3,
          (this.rng() - 0.5) * 60,
        );
      }
    }

    if (e.spec.kind === 'gunner' && e.shootAt <= 0) {
      e.shootAt = Math.max(900, 2600 - this.stage * 110) / press;
      this.enemyShot(e, this.boatX, this.boatY, 430 + this.stage * 14);
    }
  }

  /** Attack-rate multiplier that ramps once a ship overstays. */
  private pressure(e: Enemy): number {
    const at = e.spec.kind === 'boss' ? BOSS_PRESS_AT_MS : PRESS_AT_MS;
    return 1 + Math.min(1.3, Math.max(0, (e.t - at) / 14_000));
  }

  private bossBehaviour(e: Enemy, dt: number, now: number): void {
    const frac = e.hp / e.maxHp;
    const phase = frac > 0.66 ? 1 : frac > 0.33 ? 2 : 3;
    if (phase !== e.bossPhase) {
      e.bossPhase = phase;
      e.staggerUntil = now + 700;
      this.fx.shake(14);
      this.fx.float(W / 2, H * 0.42, phase === 2 ? 'RUGBEARD RAGES' : 'FINAL BROADSIDE', '#ff6b6b', 30);
      this.fx.boom(e.x, e.y, 1.4);
      return;
    }

    // Ram charge — he bears down on you, and he's wide open while he
    // does it. Dodge sideways and empty the gun into him.
    if (e.charging) {
      e.chargeT += dt * 1000;
      e.y += (H * 0.50 - e.y) * Math.min(1, dt * 1.1);
      e.portsOpen = true;
      if (e.chargeT > 2100) {
        e.charging = false;
        e.chargeT = 0;
        e.baseY = H * 0.245;
      }
      this.fx.ramming(e, dt);
      return;
    }

    const press = this.pressure(e);
    if (e.dropAt <= 0) {
      // Volley: a fan of kegs, one gap. Phase 3 adds a second fan.
      e.dropAt = Math.max(1800, 4200 - this.stage * 60) * (phase === 3 ? 0.65 : 1) / press;
      const lanes = phase === 1 ? 4 : 5;
      const gap = Math.floor(this.rng() * lanes);
      for (let i = 0; i < lanes; i++) {
        if (i === gap) continue;
        const x = W * (0.12 + (0.76 / (lanes - 1)) * i);
        this.spawnBarrel(x, i % 2 === 0 ? 'powder' : 'wood', e.y + e.h * 0.35, 0, 0.95);
      }
    }

    if (e.shootAt <= 0) {
      e.shootAt = Math.max(1500, 3800 - this.stage * 70) * (phase === 3 ? 0.7 : 1) / press;
      const shots = phase === 3 ? 3 : phase === 2 ? 2 : 1;
      for (let i = 0; i < shots; i++) {
        const spreadX = (i - (shots - 1) / 2) * 120;
        this.enemyShot(e, this.boatX + spreadX, this.boatY, 420 + this.stage * 12);
      }
      // Every few volleys he commits to a ram.
      if (phase >= 2 && this.rng() < 0.34) {
        e.charging = true;
        e.chargeT = 0;
        this.fx.float(W / 2, H * 0.46, 'RAMMING SPEED!', '#ffd94a', 28);
      }
    }
  }

  private enemyShot(e: Enemy, tx: number, ty: number, speed: number): void {
    const sx = e.x + (this.rng() - 0.5) * e.w * 0.5;
    const sy = e.y + e.h * 0.32;
    const d = dhypot(tx - sx, ty - sy) || 1;
    this.eballs.push({
      x: sx, y: sy,
      vx: ((tx - sx) / d) * speed,
      vy: ((ty - sy) / d) * speed,
      r: 13,
      spin: 0,
      dead: false,
    });
    this.fx.puff(sx, sy, 6, '#c9c2b6', 'smoke');
  }

  private damageEnemy(e: Enemy, dmg: number, x: number, y: number, power: number): void {
    if (e.dying > 0) return;
    if (!e.portsOpen) {
      // Armour. The ball rings off it — no damage, no combo break, but
      // the shot is spent. Wait for the ports.
      this.fx.puff(x, y, 7, '#cfd8e3');
      this.cb.onSignal('ping');
      this.fx.float(x, y - 14, 'CLANG', '#cfd8e3', 20);
      return;
    }
    e.hp -= dmg;
    this.bumpCombo();
    const pts = Math.round(40 * dmg * this.scoreMul());
    this.score += pts;
    this.fx.puff(x, y, 7, '#ffce54');
    this.fx.boom(x, y, 0.35 + power * 0.5);
    this.fx.float(x, y - 18, `+${pts}`, '#ffe08a', 22);
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
    this.fx.shake(boss ? 22 : 12);
    this.fx.hitStop(boss ? 220 : 90);
    this.fx.boom(e.x, e.y, boss ? 2.6 : 1.5);
    this.fx.float(e.x, e.y, boss ? `RUGBEARD SUNK +${Math.round(pts)}` : `SUNK +${Math.round(pts)}`,
      '#7dffa0', boss ? 32 : 26);
    this.cb.onSignal(boss ? 'boss-sunk' : 'enemy-sunk');
    // Only a boss is worth a plank. A patch for every pirate meant the
    // hull refilled faster than the sea could empty it, so the three
    // planks were decoration — you effectively could not lose until the
    // damage numbers ran away from you. Routine repairs come from
    // crates, where you have to earn them by breaking your dodge.
    if (boss && this.hp < this.config.hull) {
      this.hp++;
      this.cb.onHull(this.hp, false);
      this.fx.float(this.boatX, this.boatY - 60, 'HULL PATCHED', '#7dffa0', 22);
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
      if (b.x > W - b.r) { b.x = W - b.r; b.vx = -Math.abs(b.vx); }

      const dx = Math.abs(b.x - this.boatX);
      const dy = Math.abs(b.y - this.boatY);
      if (dx < hitR + b.r * 0.7 && dy < hitH + b.r * 0.7) {
        b.dead = true;
        if (b.kind === 'rice') this.collectSupply(b);
        else this.hullHit(b.x, b.y);
        continue;
      }
      // Near miss — a whisker of score for threading the needle. It has
      // to be an actual whisker: a wide band paid out on every barrel
      // that merely went past, which is just an income stream for not
      // playing. No combo either — dodging is not a hit.
      if (!b.scored && b.kind !== 'rice'
        && dy < hitH + b.r * 1.6 && dx < hitR + b.r * 1.3) {
        b.scored = true;
        this.score += Math.round(10 * this.scoreMul());
        this.fx.float(b.x, b.y - 20, 'CLOSE!', '#bfe3ef', 16);
      }
      if (b.y > H + b.r * 2) b.dead = true;
    }
    this.barrels = this.barrels.filter((b) => !b.dead);
  }

  private collectSupply(b: Barrel): void {
    this.stats.supplies++;
    this.bumpCombo();
    if (this.hp < this.config.hull) {
      this.hp++;
      this.cb.onHull(this.hp, false);
      this.fx.float(b.x, b.y - 24, 'PLANK REPAIRED', '#7dffa0', 22);
    } else {
      // Overflow value at full hull. Deliberately below what the same
      // few seconds spent shooting the pirate pays, so a crate is never
      // a better target than the ship — it's a repair you bank early.
      const pts = Math.round(120 * this.scoreMul());
      this.score += pts;
      this.fx.float(b.x, b.y - 24, `SUPPLIES +${pts}`, '#7dffa0', 22);
    }
    this.fx.puff(b.x, b.y, 14, '#ffffff');
    this.cb.onSignal('supply');
  }

  private breakBarrel(b: Barrel, byPlayer: boolean, chain = false): void {
    if (b.dead) return;
    // Crates are immune to shot (see updateBalls) and are only ever
    // taken by ramming, so nothing should reach here with one.
    if (b.kind === 'rice') return;
    b.dead = true;
    this.stats.barrels++;
    if (byPlayer) this.bumpCombo();
    const base = b.kind === 'powder' ? 60 : b.kind === 'spike' ? 45 : 30;
    const pts = Math.round(base * this.scoreMul() * (chain ? 1.5 : 1));
    this.score += pts;
    this.fx.float(b.x, b.y - 16, `+${pts}`, chain ? '#ffb347' : '#ffffff', 18);
    this.fx.splinter(b.x, b.y, b.kind);

    if (b.kind === 'powder') {
      // The reason to shoot DOWN instead of up: one keg clears a lane.
      this.cb.onSignal('powder-blast');
      this.fx.boom(b.x, b.y, 1.1);
      this.fx.shake(9);
      const R = 150 + W * 0.12;
      for (const o of this.barrels) {
        if (o.dead || o === b) continue;
        if (dhypot(o.x - b.x, o.y - b.y) < R) this.breakBarrel(o, byPlayer, true);
      }
      // A keg that goes up near the pirate hurts it properly. This is
      // the one reason to spend a reload on a barrel instead of on the
      // ship: kegs spawn high, near the hull that dropped them, so a
      // fast read up the screen turns their own volley back on them.
      // Still gated on the gunports — armour has to keep meaning
      // something or the ironclad's whole rhythm evaporates.
      const e = this.enemy;
      if (e && e.dying <= 0 && dhypot(e.x - b.x, e.y - b.y) < R + e.w * 0.3) {
        this.damageEnemy(e, 5, b.x, b.y, 1);
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
      if (ball.y < -40 || ball.x < -40 || ball.x > W + 40 || ball.y > H + 40) {
        ball.dead = true;
        continue;
      }

      for (const b of this.barrels) {
        if (b.dead) continue;
        // Shot passes clean through a supply crate. It used to break —
        // but crates fall down the same corridor you are firing up, so
        // a mighty ball aimed correctly at the pirate would delete your
        // only repair through no fault of your own. Ram them or let
        // them go; the gun has no opinion.
        if (b.kind === 'rice') continue;
        if (dhypot(b.x - ball.x, b.y - ball.y) > b.r + ball.r) continue;
        this.countHit(ball);
        // Spiked barrels have 2 hp, so a tap chips one and a charged
        // ball splits it — same "charge up for these" read the ping
        // used to teach, minus the special case that made a light shot
        // do literally nothing.
        b.hp -= ball.dmg;
        if (b.hp <= 0) this.breakBarrel(b, true);
        else {
          this.fx.puff(ball.x, ball.y, 7, '#cfd8e3');
          this.cb.onSignal('ping');
        }
        if (!ball.pierce) { ball.dead = true; break; }
      }
      if (ball.dead) continue;

      // Enemy shot-for-shot: a mighty ball swats incoming iron.
      for (const eb of this.eballs) {
        if (eb.dead) continue;
        if (dhypot(eb.x - ball.x, eb.y - ball.y) > eb.r + ball.r) continue;
        eb.dead = true;
        this.countHit(ball);
        this.fx.puff(ball.x, ball.y, 7, '#ffb347');
        this.bumpCombo();
        this.score += Math.round(40 * this.scoreMul());
        this.fx.float(eb.x, eb.y - 16, 'SWATTED!', '#ffb347', 18);
        if (!ball.pierce) { ball.dead = true; break; }
      }
      if (ball.dead) continue;

      const e = this.enemy;
      if (e && e.dying <= 0) {
        if (Math.abs(ball.x - e.x) < e.w * 0.42 && Math.abs(ball.y - e.y) < e.h * 0.40) {
          this.countHit(ball);
          this.damageEnemy(e, ball.dmg, ball.x, ball.y, ball.power);
          ball.dead = true;
        }
      }
    }
    this.balls = this.balls.filter((b) => !b.dead);
  }

  /**
   * Accuracy is per BALL, not per victim: a pierce shot through three
   * barrels is one hit off one shot. Counting only pirate hits scored
   * every barrel you popped as a miss, which read as a penalty for
   * playing the barrels the game asks you to play.
   */
  private countHit(ball: Ball): void {
    if (ball.hit) return;
    ball.hit = true;
    this.stats.hits++;
  }

  private updateEnemyBalls(dt: number): void {
    const hitR = this.hullW * 0.44;
    const hitH = this.hullH * 0.30;
    for (const b of this.eballs) {
      if (b.dead) continue;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.spin += dt * 7;
      if (b.y > H + 40 || b.x < -40 || b.x > W + 40) { b.dead = true; continue; }
      if (Math.abs(b.x - this.boatX) < hitR + b.r * 0.6 && Math.abs(b.y - this.boatY) < hitH + b.r * 0.6) {
        b.dead = true;
        this.hullHit(b.x, b.y);
      }
    }
    this.eballs = this.eballs.filter((b) => !b.dead);
  }

  // ── Damage ──

  private hullHit(x: number, y: number): void {
    const now = this.t;
    if (now < this.hurtUntil) return;
    this.hurtUntil = now + this.config.iFramesMs;
    // A drill still hits you — same shake, same siren, same broken
    // chain — it just can't sink you. Getting clipped while learning
    // should teach, not end the lesson and send you back to the menu.
    if (!this.drill) this.hp--;
    this.combo = 0;
    this.comboBank = 0;
    this.cb.onCombo(0, 1);
    this.cb.onHull(this.hp, true);
    this.cb.onSignal('hull-hit');
    this.fx.shake(18);
    this.fx.hitStop(90);
    this.fx.boom(x, y, 0.9);
    this.fx.splinter(x, y, 'wood');
    if (this.hp <= 0) this.endRound();
  }

  private bumpCombo(): void {
    this.combo++;
    this.comboBank++;
    this.lastHitAt = this.t;
    this.stats.bestCombo = Math.max(this.stats.bestCombo, this.combo);
    const bs = this.config.broadside;
    // Bank hits toward the next broadside rather than testing the raw
    // combo against a modulo. On the modulo, hits landed DURING a
    // broadside were thrown away — cross 24 while one was running and
    // the next was silently deferred to 36, so the better your chain
    // the worse your reward rate.
    if (!this.isBroadside() && this.comboBank >= bs.triggerCombo) {
      this.comboBank = 0;
      this.broadsideUntil = this.t + bs.durationMs;
      this.stats.broadsides++;
      this.cb.onBroadside(true);
      this.cb.onSignal('broadside');
      this.fx.float(W / 2, H * 0.45, 'BROADSIDE!', '#ffaa3c', 40);
    }
    this.cb.onCombo(this.combo, this.comboMul());
  }

  private endRound(): void {
    this.state = 'over';
    if (this.isBroadside()) {
      this.broadsideUntil = 0;
      this.cb.onBroadside(false);
    }
    this.cb.onEnd(Math.round(this.score), this.stats);
  }

  // ── Drill API ──
  // Everything the tutorial director needs to stage a lesson on the
  // real water. All of it is inert outside drill mode.

  /** Drop one barrel of a chosen kind at `xFrac` across the field. */
  drillBarrel(kind: BarrelKind, xFrac: number, speedMul = 1): void {
    if (!this.drill) return;
    this.spawnBarrel(W * Math.max(0.06, Math.min(0.94, xFrac)), kind, undefined, 0, speedMul);
  }

  /** Sail in one specific pirate with a fixed hull, outside the roster. */
  drillEnemy(kind: EnemyKind, hp: number): void {
    if (!this.drill) return;
    const spec = kind === 'boss' ? BOSS : ROSTER.find((r) => r.kind === kind) ?? ROSTER[0];
    const e = this.makeEnemy(spec, hp, false);
    e.dropAt = 2600;
    e.shootAt = 3200;
    e.portTimer = 1800;
    this.enemy = e;
    this.cb.onEnemyHealth(1, spec.name, false);
  }

  /** Clear the water without touching the boat or the hull. */
  drillClear(): void {
    if (!this.drill) return;
    this.barrels = [];
    this.eballs = [];
    this.balls = [];
    this.enemy = null;
    this.cb.onEnemyHealth(0, '', false);
  }

  /** Set the plank count directly, so a lesson can stage a repair. */
  setHull(n: number): void {
    if (!this.drill) return;
    this.hp = Math.max(0, Math.min(this.config.hull, Math.round(n)));
    this.cb.onHull(this.hp, false);
  }
}

export function blankStats(): RoundStats {
  return {
    pirates: 0, bosses: 0, barrels: 0, supplies: 0,
    bestCombo: 0, shots: 0, hits: 0, mighty: 0, broadsides: 0, distance: 0,
  };
}
