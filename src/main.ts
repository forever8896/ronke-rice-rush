// ═════════════════════════════════════════════════════════════
// Ronke Boat Battle — entrypoint, screen routing, control wiring.
//
// Flow: title → camera → CALIBRATE (3-2-1, which also captures the
// player's neutral head position and tilt) → tutorial on first run →
// voyage → over → again.
//
// The three signals off one face:
//   headX  → steer      (dodge the barrels)
//   roll   → aim        (swing the cannon)
//   jaw    → charge/fire (open packs powder, close fires)
//
// ?mock=1 swaps the camera for mouse control (X steers, Y aims, hold
// to charge) — a dev rig for playing the loop without a webcam.
// ═════════════════════════════════════════════════════════════

import {
  FaceController,
  detectDeviceTier,
  configForTier,
  type FaceState,
} from './detection';
import { Game, DEFAULT_GAME_CONFIG, type Signal, type StageInfo } from './game';
import { buildBarrelBitmaps } from './sprites';
import {
  initAudio, isMuted, setMuted,
  sfxFire, sfxDryClick, sfxBarrelPop, sfxPowderBlast, sfxPing, sfxSupply,
  sfxEnemyHit, sfxEnemySunk, sfxBossIn, sfxBossSunk, sfxHullHit, sfxBroadside,
  sfxStage, sfxGameOver, startChargeSfx, stopChargeSfx,
  startMusic, stopMusic, startHeartbeat, stopHeartbeat,
} from './audio';
import './styles.css';

type ScreenName = 'title' | 'game' | 'over';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const refs = {
  app: $<HTMLDivElement>('app'),
  video: $<HTMLVideoElement>('video'),
  gameCanvas: $<HTMLCanvasElement>('game-canvas'),
  titleScreen: $<HTMLDivElement>('title-screen'),
  gameScreen: $<HTMLDivElement>('game-screen'),
  overScreen: $<HTMLDivElement>('over-screen'),
  playBtn: $<HTMLButtonElement>('play-btn'),
  titleBest: $<HTMLDivElement>('title-best'),
  titleStatus: $<HTMLDivElement>('title-status'),
  hudScore: $<HTMLSpanElement>('hud-score'),
  hudHull: $<HTMLDivElement>('hud-hull'),
  hudCombo: $<HTMLDivElement>('hud-combo'),
  enemyBar: $<HTMLDivElement>('enemy-bar'),
  enemyName: $<HTMLDivElement>('enemy-name'),
  enemyFill: $<HTMLDivElement>('enemy-fill'),
  stageBanner: $<HTMLDivElement>('stage-banner'),
  stageKicker: $<HTMLDivElement>('stage-kicker'),
  stageName: $<HTMLDivElement>('stage-name'),
  feverBanner: $<HTMLDivElement>('fever-banner'),
  feverBarFill: $<HTMLDivElement>('fever-bar-fill'),
  feedback: $<HTMLDivElement>('feedback'),
  calib: $<HTMLDivElement>('calib'),
  calibTitle: $<HTMLDivElement>('calib-title'),
  calibText: $<HTMLDivElement>('calib-text'),
  calibCount: $<HTMLDivElement>('calib-count'),
  overScore: $<HTMLSpanElement>('over-score'),
  overBest: $<HTMLDivElement>('over-best'),
  rankChip: $<HTMLDivElement>('rank-chip'),
  statsRow: $<HTMLDivElement>('stats-row'),
  shareBtn: $<HTMLButtonElement>('share-btn'),
  againBtn: $<HTMLButtonElement>('again-btn'),
  homeBtn: $<HTMLButtonElement>('home-btn'),
  lbTitle: $<HTMLDivElement>('lb-title'),
  lbTitleList: $<HTMLOListElement>('lb-title-list'),
  nameInput: $<HTMLInputElement>('name-input'),
  submitBtn: $<HTMLButtonElement>('submit-btn'),
  lbStatus: $<HTMLDivElement>('lb-status'),
  howBtn: $<HTMLButtonElement>('how-btn'),
  tutorial: $<HTMLDivElement>('tutorial'),
  tutSprites: $<HTMLDivElement>('tut-sprites'),
  tutTitle: $<HTMLDivElement>('tut-title'),
  tutText: $<HTMLDivElement>('tut-text'),
  tutHint: $<HTMLDivElement>('tut-hint'),
  tutDots: $<HTMLDivElement>('tut-dots'),
  tutSkip: $<HTMLButtonElement>('tut-skip'),
  tutLive: $<HTMLDivElement>('tut-live'),
  tutBoat: $<HTMLDivElement>('tut-boat'),
  tutNeedle: $<HTMLDivElement>('tut-needle'),
  tutChargeFill: $<HTMLDivElement>('tut-charge-fill'),
};

const MOCK = /[?&]mock=1/.test(location.search);

let detector: FaceController | null = null;
let game: Game | null = null;
let pumpRunning = false;

// ── Control state ──
// Calibration: whatever the player's head was doing during the count
// becomes centre. Nobody sits perfectly square to a webcam.
let neutralX = 0.5;
let neutralRoll = 0;
let smoothX = 0.5;
let smoothRoll = 0;
/** Live control values, also read by the tutorial gates. */
let steer = 0.5;
let aim = 0;
const STEER_GAIN = 2.6;
const ROLL_GAIN = 2.4;

// Mock rig
let mockX = 0.5;
let mockAim = 0;
let mockDownAt = 0;

// ── Sensitivity ──
type Sens = 'chill' | 'normal' | 'hair';
const SENS_KEY = 'ronke:sens';
const SENS_FACTOR: Record<Sens, number> = { chill: 1.25, normal: 1, hair: 0.75 };
const SENS_LABEL: Record<Sens, string> = {
  chill: 'mouth: chill 🧘',
  normal: 'mouth: normal',
  hair: 'mouth: hair-trigger ⚡',
};
const getSens = (): Sens => {
  const v = localStorage.getItem(SENS_KEY);
  return v === 'chill' || v === 'hair' ? v : 'normal';
};
let baseFireThreshold: number | null = null;

function applySensitivity(): void {
  if (!detector) return;
  baseFireThreshold ??= detector.getOpenThreshold();
  detector.setOpenThreshold(baseFireThreshold * SENS_FACTOR[getSens()]);
}

// ── Rank ladder — the competition hook, sea edition ──
const RANKS: Array<[number, string]> = [
  [0, '🪵 DECKHAND'],
  [2500, '🧭 HELMSMAN'],
  [6000, '⚓ QUARTERMASTER'],
  [12000, '💣 MASTER GUNNER'],
  [25000, '🏴‍☠️ PRIVATEER'],
  [50000, '👑 ADMIRAL RONKE'],
];
function rankForScore(score: number): string {
  let r = RANKS[0][1];
  for (const [min, name] of RANKS) if (score >= min) r = name;
  return r;
}
let lastScore = 0;
let lastRank = RANKS[0][1];
let lastPirates = 0;

const BEST_KEY = 'ronke:bestVoyage';
const loadBest = (): number => Number(localStorage.getItem(BEST_KEY) || 0);
const saveBest = (s: number): void => {
  if (s > loadBest()) localStorage.setItem(BEST_KEY, String(s));
};

function showScreen(name: ScreenName): void {
  refs.titleScreen.classList.toggle('hidden', name !== 'title');
  refs.gameScreen.classList.toggle('hidden', name !== 'game');
  refs.overScreen.classList.toggle('hidden', name !== 'over');
}

function setStatus(msg: string | null, isError = false): void {
  refs.titleStatus.textContent = msg ?? '';
  refs.titleStatus.classList.toggle('error', isError);
}

function setLoading(label: string | null): void {
  if (label === null) {
    refs.playBtn.disabled = false;
    refs.playBtn.textContent = 'SET SAIL';
    return;
  }
  refs.playBtn.disabled = true;
  refs.playBtn.textContent = label;
}

/** Desktop play-column constraint (html[data-gameplay]). */
function setGameplayColumn(on: boolean): void {
  document.documentElement.toggleAttribute('data-gameplay', on);
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

// ── HUD ──

function renderHull(hp: number, hit = false): void {
  refs.hudHull.textContent = '🪵'.repeat(Math.max(0, hp));
  if (hit) {
    refs.hudHull.classList.remove('lost');
    void refs.hudHull.offsetWidth;
    refs.hudHull.classList.add('lost');
  }
}

function shakeScreen(): void {
  refs.app.classList.remove('shake');
  void refs.app.offsetWidth;
  refs.app.classList.add('shake');
}

let feedbackTimer = 0;
function showFeedback(text: string, cls: string): void {
  refs.feedback.textContent = text;
  refs.feedback.className = `feedback ${cls}`;
  clearTimeout(feedbackTimer);
  feedbackTimer = window.setTimeout(() => refs.feedback.classList.add('hidden'), 700);
}

let stageTimer = 0;
function showStage(info: StageInfo): void {
  refs.stageKicker.textContent = info.boss
    ? `TIER ${info.tier} · BOSS`
    : `PIRATE ${info.index}`;
  refs.stageName.textContent = info.name;
  refs.stageBanner.classList.toggle('boss', info.boss);
  refs.stageBanner.classList.remove('hidden');
  void refs.stageBanner.offsetWidth;
  clearTimeout(stageTimer);
  stageTimer = window.setTimeout(() => refs.stageBanner.classList.add('hidden'), 1700);
}

// ── Control pump — one RAF, feeds the game and the tutorial ──

function faceState(): FaceState | null {
  return detector?.state ?? null;
}

function startPump(): void {
  if (pumpRunning) return;
  pumpRunning = true;
  let last = performance.now();

  const tick = (): void => {
    if (!pumpRunning) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (MOCK) {
      smoothX += (mockX - smoothX) * 0.4;
      steer = smoothX;
      aim = mockAim;
    } else {
      const f = faceState();
      const fresh = !!f && f.detected && now - f.lastDetectAt < 400;
      if (f && fresh) {
        smoothX += (f.headX - smoothX) * 0.45;
        smoothRoll += (f.roll - smoothRoll) * 0.4;
        steer = clamp01(0.5 + (smoothX - neutralX) * STEER_GAIN);
        aim = (smoothRoll - neutralRoll) * ROLL_GAIN;
      }
      game?.setFaceLost(!fresh);
    }

    if (game && game.getState() === 'playing') {
      game.setSteer(steer);
      game.setAim(aim);
      refs.hudScore.textContent = String(Math.round(game.getScore()));
      if (game.isBroadside()) {
        refs.feverBarFill.style.width = `${game.broadsideFraction() * 100}%`;
      }
    } else if (game && game.getState() !== 'playing' && !refs.titleScreen.classList.contains('hidden')) {
      // Title ambience: the sea keeps rolling behind the menu.
      game.renderIdle(dt);
    }

    // Tutorial live readout.
    if (!refs.tutorial.classList.contains('hidden')) {
      refs.tutBoat.style.left = `${steer * 100}%`;
      refs.tutNeedle.style.transform = `rotate(${aim * 57.3}deg)`;
      const f = faceState();
      const held = MOCK
        ? (mockDownAt ? now - mockDownAt : 0)
        : (f?.mouthOpen ? f.openMs : 0);
      refs.tutChargeFill.style.width = `${Math.min(100, (held / DEFAULT_GAME_CONFIG.fullChargeMs) * 100)}%`;
    }

    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

// ── Leaderboard client (fail-soft: no API → the board stays hidden) ──

const NAME_KEY = 'ronke:name';
let scoreSubmitted = false;

interface LbRow { name: string; score: number }

async function fetchTop(): Promise<LbRow[] | null> {
  try {
    const r = await fetch('/api/scores');
    if (!r.ok) return null;
    const data = (await r.json()) as { rows?: LbRow[] };
    return Array.isArray(data.rows) ? data.rows : null;
  } catch {
    return null;
  }
}

function renderLbList(el: HTMLOListElement, rows: LbRow[], highlight?: string): void {
  el.innerHTML = '';
  rows.forEach((row, i) => {
    const li = document.createElement('li');
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    const rank = document.createElement('span');
    rank.className = 'lb-rank';
    rank.textContent = medal;
    const name = document.createElement('span');
    name.className = 'lb-name';
    name.textContent = row.name;
    const score = document.createElement('span');
    score.className = 'lb-score';
    score.textContent = String(row.score);
    li.append(rank, name, score);
    if (highlight && row.name === highlight) li.classList.add('me');
    el.appendChild(li);
  });
}

async function refreshTitleLb(): Promise<void> {
  const rows = await fetchTop();
  if (!rows || rows.length === 0) {
    refs.lbTitle.classList.add('hidden');
    return;
  }
  renderLbList(refs.lbTitleList, rows.slice(0, 5), localStorage.getItem(NAME_KEY) ?? undefined);
  refs.lbTitle.classList.remove('hidden');
}

async function submitScore(): Promise<void> {
  const name = refs.nameInput.value.trim().slice(0, 14);
  if (name.length < 2) {
    refs.lbStatus.textContent = 'name needs at least 2 characters';
    return;
  }
  if (scoreSubmitted || lastScore <= 0) return;
  refs.submitBtn.disabled = true;
  refs.submitBtn.textContent = '…';
  try {
    const r = await fetch('/api/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, score: lastScore }),
    });
    if (!r.ok) throw new Error(String(r.status));
    const data = (await r.json()) as { rank?: number };
    scoreSubmitted = true;
    localStorage.setItem(NAME_KEY, name);
    refs.lbStatus.textContent = data.rank
      ? `you're #${data.rank} on the board 🏴‍☠️`
      : 'voyage logged 🏴‍☠️';
    refs.submitBtn.textContent = 'SENT ✓';
    void refreshTitleLb();
  } catch {
    refs.lbStatus.textContent = 'leaderboard unreachable — try again';
    refs.submitBtn.disabled = false;
    refs.submitBtn.textContent = 'SUBMIT';
  }
}

// ── Calibration: 3-2-1, and your resting head becomes centre ──

function runCalibration(): Promise<void> {
  return new Promise((resolve) => {
    if (MOCK) { resolve(); return; }
    refs.calib.classList.remove('hidden');
    refs.calibTitle.textContent = 'HOLD STILL, CAPTAIN';
    refs.calibText.textContent = 'sit square to the screen — this becomes your centre';
    const xs: number[] = [];
    const rolls: number[] = [];
    let n = 3;
    refs.calibCount.textContent = String(n);

    const sample = window.setInterval(() => {
      const f = faceState();
      if (f?.detected) {
        xs.push(f.headX);
        rolls.push(f.roll);
      }
    }, 40);

    const step = window.setInterval(() => {
      n--;
      if (n > 0) {
        refs.calibCount.textContent = String(n);
        if (n === 1) refs.calibText.textContent = 'ready…';
        return;
      }
      clearInterval(step);
      clearInterval(sample);
      if (xs.length > 4) {
        neutralX = median(xs);
        neutralRoll = median(rolls);
        smoothX = neutralX;
        smoothRoll = neutralRoll;
      }
      refs.calibCount.textContent = '⚓';
      refs.calibTitle.textContent = 'SET SAIL!';
      refs.calibText.textContent = 'move your head to steer · tilt to aim · chomp to fire';
      setTimeout(() => {
        refs.calib.classList.add('hidden');
        resolve();
      }, 750);
    }, 800);
  });
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ── Tutorial — gated on the player actually doing the thing ──

const TUT_KEY = 'ronke:boatTutorialSeen';
let forceTutorial = false;
/** Resolver armed by a gate that's waiting on a fire event. */
let tutFireResolve: ((power: number) => void) | null = null;

interface TutStep {
  title: string;
  text: string;
  hint: string;
  emoji?: string;
  sprites?: Array<{ kind: 'wood' | 'powder' | 'spike' | 'rice' }>;
  live?: boolean;
  /** Returns true once the player has demonstrated the mechanic. */
  gate?: () => boolean;
  /** Or: resolve on a fire of at least this power. */
  fireGate?: number;
}

function tutorialSteps(): TutStep[] {
  let wentLeft = false;
  let wentRight = false;
  let tiltedL = false;
  let tiltedR = false;
  return [
    {
      title: 'STEER WITH YOUR HEAD',
      text: 'Lean left and right — your boat follows. This is how you dodge everything the pirates throw down the sea.',
      hint: 'lean both ways to continue',
      live: true,
      gate: () => {
        if (steer < 0.3) wentLeft = true;
        if (steer > 0.7) wentRight = true;
        return wentLeft && wentRight;
      },
    },
    {
      title: 'TILT TO AIM',
      text: 'Tip your head like a curious monke — the cannon swings with it. Steering and aiming are separate: you will need both at once.',
      hint: 'tilt both ways to continue',
      live: true,
      gate: () => {
        if (aim < -0.55) tiltedL = true;
        if (aim > 0.55) tiltedR = true;
        return tiltedL && tiltedR;
      },
    },
    {
      title: 'CHOMP TO FIRE',
      text: 'Open your mouth to pack the powder, close it to FIRE. A quick chomp pops a barrel — but hold it open and let it go for a MIGHTY ball that punches through everything.',
      hint: 'hold your mouth open, then close it',
      live: true,
      fireGate: 0.8,
    },
    {
      title: 'READ THE SEA',
      text: 'Wooden barrels sink you. POWDER kegs chain-explode — shoot one to clear a lane. SPIKED barrels shrug off weak shots. Supply crates repair a plank: ram them, never shoot them.',
      hint: 'chomp (or tap) to continue',
      sprites: [{ kind: 'wood' }, { kind: 'powder' }, { kind: 'spike' }, { kind: 'rice' }],
    },
    {
      title: 'SINK THE PIRATES',
      text: 'They are here to stop your voyage. Ironclads only take damage when their PORTS OPEN. Every fifth captain is a boss — and Rugbeard rams.',
      hint: 'chomp (or tap) to continue',
      emoji: '🏴‍☠️',
    },
  ];
}

function renderTutSprites(step: TutStep): void {
  refs.tutSprites.innerHTML = '';
  if (step.emoji) {
    const d = document.createElement('div');
    d.className = 'tut-emoji';
    d.textContent = step.emoji;
    refs.tutSprites.appendChild(d);
    return;
  }
  if (!step.sprites) return;
  const bitmaps = buildBarrelBitmaps(96);
  for (const s of step.sprites) {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    c.className = 'tut-sprite';
    c.getContext('2d')!.drawImage(bitmaps[s.kind], 0, 0, 64, 64);
    refs.tutSprites.appendChild(c);
  }
}

async function runTutorial(): Promise<void> {
  const steps = tutorialSteps();
  refs.tutorial.classList.remove('hidden');
  let skipped = false;
  const skipPromise = new Promise<void>((res) => {
    refs.tutSkip.onclick = (): void => { skipped = true; res(); };
  });

  for (let i = 0; i < steps.length && !skipped; i++) {
    const step = steps[i];
    refs.tutTitle.textContent = step.title;
    refs.tutText.textContent = step.text;
    refs.tutHint.textContent = step.hint;
    refs.tutLive.classList.toggle('hidden', !step.live);
    refs.tutDots.innerHTML = steps
      .map((_, d) => `<span class="tut-dot${d === i ? ' on' : ''}"></span>`)
      .join('');
    renderTutSprites(step);

    if (step.gate) {
      await Promise.race([pollUntil(step.gate), skipPromise]);
    } else if (step.fireGate !== undefined) {
      await Promise.race([
        new Promise<void>((res) => {
          tutFireResolve = (power): void => {
            if (power >= step.fireGate!) { tutFireResolve = null; res(); }
          };
        }),
        skipPromise,
      ]);
      tutFireResolve = null;
    } else {
      await Promise.race([
        new Promise<void>((res) => { tutFireResolve = (): void => { tutFireResolve = null; res(); }; }),
        new Promise<void>((res) => {
          const onTap = (): void => {
            refs.tutorial.removeEventListener('pointerdown', onTap);
            res();
          };
          refs.tutorial.addEventListener('pointerdown', onTap);
        }),
        skipPromise,
      ]);
      tutFireResolve = null;
    }
    await new Promise((r) => setTimeout(r, 320));
  }

  refs.tutorial.classList.add('hidden');
  refs.tutLive.classList.add('hidden');
  tutFireResolve = null;
  forceTutorial = false;
  try { localStorage.setItem(TUT_KEY, '1'); } catch { /* ignore */ }
}

function pollUntil(fn: () => boolean): Promise<void> {
  return new Promise((res) => {
    const id = window.setInterval(() => {
      if (fn()) { clearInterval(id); res(); }
    }, 60);
  });
}

function needsTutorial(): boolean {
  return forceTutorial || localStorage.getItem(TUT_KEY) !== '1';
}

// ── Signals from the loop → sound + feedback ──

function handleSignal(s: Signal, value = 0): void {
  switch (s) {
    case 'charge':
      startChargeSfx(DEFAULT_GAME_CONFIG.fullChargeMs / 1000);
      break;
    case 'fire-light':
    case 'fire-mighty':
      stopChargeSfx();
      sfxFire(value);
      if (s === 'fire-mighty') showFeedback('MIGHTY!', 'perfect');
      break;
    case 'dry-click':
      stopChargeSfx();
      sfxDryClick();
      break;
    case 'barrel-pop': sfxBarrelPop(); break;
    case 'powder-blast': sfxPowderBlast(); break;
    case 'ping': sfxPing(); break;
    case 'supply': sfxSupply(); break;
    case 'enemy-hit': sfxEnemyHit(); break;
    case 'enemy-sunk':
      sfxEnemySunk();
      showFeedback('PIRATE SUNK!', 'good');
      break;
    case 'boss-in':
      sfxBossIn();
      showFeedback('RUGBEARD!', 'miss');
      break;
    case 'boss-sunk':
      sfxBossSunk();
      showFeedback('BOSS DOWN!', 'perfect');
      break;
    case 'hull-hit':
      sfxHullHit();
      shakeScreen();
      showFeedback('HULL BREACH!', 'miss');
      break;
    case 'broadside':
      sfxBroadside();
      break;
    case 'stage-up':
      sfxStage();
      break;
  }
}

// ── Game lifecycle ──

function makeGame(): Game {
  const g = new Game(refs.gameCanvas, DEFAULT_GAME_CONFIG, {
    onSignal: handleSignal,
    onHull: (hp, hit) => {
      renderHull(hp, hit);
      if (hp === 1) startHeartbeat(); else stopHeartbeat();
    },
    onCombo: (combo, mul) => {
      if (combo >= 3) {
        refs.hudCombo.textContent = `${combo}× CHAIN · ${mul}× LOOT`;
        refs.hudCombo.classList.remove('hidden');
      } else {
        refs.hudCombo.classList.add('hidden');
      }
    },
    onStage: (info) => showStage(info),
    onEnemyHealth: (frac, name, boss) => {
      if (frac <= 0 && !name) {
        refs.enemyBar.classList.add('hidden');
        return;
      }
      refs.enemyBar.classList.remove('hidden');
      refs.enemyBar.classList.toggle('boss', boss);
      refs.enemyName.textContent = name;
      refs.enemyFill.style.width = `${Math.max(0, frac) * 100}%`;
    },
    onBroadside: (active) => {
      document.body.classList.toggle('fever', active);
      refs.feverBanner.classList.toggle('hidden', !active);
    },
    onEnd: (score, stats) => {
      stopHeartbeat();
      stopChargeSfx();
      stopMusic();
      sfxGameOver();
      setGameplayColumn(false);
      document.body.classList.remove('fever');
      refs.feverBanner.classList.add('hidden');
      refs.enemyBar.classList.add('hidden');
      refs.hudCombo.classList.add('hidden');
      saveBest(score);
      refs.overScore.textContent = String(score);
      refs.overBest.textContent = `best: ${loadBest()} 🪙`;
      lastRank = rankForScore(score);
      lastScore = score;
      lastPirates = stats.pirates + stats.bosses;
      refs.rankChip.textContent = lastRank;
      scoreSubmitted = false;
      refs.submitBtn.disabled = false;
      refs.submitBtn.textContent = 'SUBMIT';
      refs.lbStatus.textContent = '';
      refs.nameInput.value = localStorage.getItem(NAME_KEY) ?? '';
      refs.statsRow.innerHTML = '';
      const stat = (value: string | number, label: string): void => {
        const el = document.createElement('div');
        el.className = 'stat';
        const b = document.createElement('b');
        b.textContent = String(value);
        const s = document.createElement('span');
        s.textContent = label;
        el.append(b, s);
        refs.statsRow.appendChild(el);
      };
      const acc = stats.shots > 0 ? Math.round((stats.hits / stats.shots) * 100) : 0;
      stat(stats.pirates, 'pirates sunk');
      stat(stats.bosses, 'bosses');
      stat(stats.barrels, 'barrels');
      stat(`${stats.bestCombo}×`, 'best chain');
      stat(stats.mighty, 'mighty shots');
      stat(`${acc}%`, 'accuracy');
      stat(`${stats.distance.toFixed(1)}nm`, 'sailed');
      showScreen('over');
    },
  });
  g.setCaptainSource(refs.video, faceState);
  return g;
}

function startGame(): void {
  setGameplayColumn(true);
  showScreen('game');
  requestAnimationFrame(async () => {
    if (!game) game = makeGame();
    renderHull(DEFAULT_GAME_CONFIG.hull);
    refs.hudScore.textContent = '0';
    refs.hudCombo.classList.add('hidden');
    refs.feverBanner.classList.add('hidden');
    refs.enemyBar.classList.add('hidden');
    document.body.classList.remove('fever');
    stopHeartbeat();
    startPump();
    await runCalibration();
    if (needsTutorial()) await runTutorial();
    game.start();
    startMusic();
  });
}

// ── Startup ──

async function startWithCamera(): Promise<void> {
  initAudio();
  setStatus(null);

  if (MOCK) {
    startGame();
    return;
  }

  const tier = detectDeviceTier();
  console.log(`[main] device tier: ${tier}`);

  if (!detector) {
    setLoading('LOADING MONKE…');
    detector = new FaceController(refs.video, configForTier(tier));
    try {
      await detector.init();
    } catch (e) {
      console.error('[main] detector init failed', e);
      setStatus('Detection failed to load — reload and try again.', true);
      setLoading(null);
      detector = null;
      return;
    }
  }

  setLoading('WAKING CAMERA…');
  try {
    await detector.startCamera();
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    console.error('[main] camera failed', e);
    setStatus(
      name === 'NotAllowedError'
        ? 'Camera permission denied — Ronke needs the camera to sail.'
        : 'Camera unavailable — is another app using it?',
      true,
    );
    detector.stop();
    detector = null;
    setLoading(null);
    return;
  }

  detector.onMouthOpen = (): void => {
    game?.startCharge();
  };
  detector.onMouthClose = (held: number): void => {
    const power = Math.min(1, held / DEFAULT_GAME_CONFIG.fullChargeMs);
    if (tutFireResolve) {
      stopChargeSfx();
      tutFireResolve(power);
      return;
    }
    game?.fire(held);
  };
  detector.start();
  document.documentElement.setAttribute('data-ar', '');
  setLoading(null);
  applySensitivity();
  startGame();
}

// ── Mock rig (?mock=1): mouse steers, aims and fires ──

if (MOCK) {
  window.addEventListener('pointermove', (e) => {
    mockX = e.clientX / window.innerWidth;
    mockAim = ((e.clientY / window.innerHeight) - 0.5) * 2 * DEFAULT_GAME_CONFIG.maxAim;
  });
  const down = (): void => {
    if (mockDownAt) return;
    mockDownAt = performance.now();
    game?.startCharge();
  };
  const up = (): void => {
    if (!mockDownAt) return;
    const held = performance.now() - mockDownAt;
    mockDownAt = 0;
    const power = Math.min(1, held / DEFAULT_GAME_CONFIG.fullChargeMs);
    if (tutFireResolve) { stopChargeSfx(); tutFireResolve(power); return; }
    game?.fire(held);
  };
  window.addEventListener('pointerdown', down);
  window.addEventListener('pointerup', up);
  window.addEventListener('keydown', (e) => { if (e.code === 'Space') down(); });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') up(); });
  console.log('[main] MOCK controls: mouse X steers, mouse Y aims, hold to charge');
}

// ── Buttons ──

refs.shareBtn.addEventListener('click', () => {
  const text =
    `I sailed ${lastScore} loot deep in RONKE BOAT BATTLE \u{1F6F6}\u{1F4A5} ` +
    `${lastPirates} pirates sunk · rank: ${lastRank}\n\n` +
    `steer with your head, fire with your mouth. can you out-sail me, monke? $RONKE`;
  const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
  window.open(url, '_blank', 'noopener');
});

refs.howBtn.addEventListener('click', () => {
  forceTutorial = true;
  setStatus('the drill will run before your next voyage');
});

refs.submitBtn.addEventListener('click', () => void submitScore());
refs.nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void submitScore();
});

refs.playBtn.addEventListener('click', () => void startWithCamera());
refs.againBtn.addEventListener('click', () => startGame());
refs.homeBtn.addEventListener('click', () => {
  game?.stop();
  stopMusic();
  stopHeartbeat();
  setGameplayColumn(false);
  document.body.classList.remove('fever');
  showScreen('title');
  refreshTitle();
  void refreshTitleLb();
});

// ── Sensitivity toggle ──
const sensBtn = $<HTMLButtonElement>('sens-btn');
const renderSens = (): void => { sensBtn.textContent = SENS_LABEL[getSens()]; };
sensBtn.addEventListener('click', () => {
  const order: Sens[] = ['chill', 'normal', 'hair'];
  const next = order[(order.indexOf(getSens()) + 1) % order.length];
  localStorage.setItem(SENS_KEY, next);
  renderSens();
  applySensitivity();
});
renderSens();

// ── Mute toggle ──
const muteBtn = $<HTMLButtonElement>('mute-btn');
const renderMute = (): void => { muteBtn.textContent = isMuted() ? '🔇' : '🔊'; };
muteBtn.addEventListener('click', () => {
  initAudio();
  setMuted(!isMuted());
  renderMute();
});
renderMute();

function refreshTitle(): void {
  const best = loadBest();
  refs.titleBest.textContent = best > 0 ? `best voyage: ${best} 🪙` : '';
}

// The sea rolls behind the title from the first frame.
game = makeGame();
// Mock rig only: hand the loop to the console for tuning.
if (MOCK) (window as unknown as { __game: Game }).__game = game;
startPump();
refreshTitle();
showScreen('title');
void refreshTitleLb();
