// ═════════════════════════════════════════════════════════════
// Ronke Rice Rush — entrypoint, screen routing, detection wiring.
//
// Flow: title → camera → game → over → again. No calibration, no
// distance gate — mouth-open (chomp) detection runs off MediaPipe's
// jawOpen blendshape alone, which is normalized per-face and robust
// at any distance. Open wide to eat the falling rice.
// ═════════════════════════════════════════════════════════════

import {
  MouthDetector,
  detectDeviceTier,
  configForTier,
} from './detection';
import { Game, DEFAULT_GAME_CONFIG, type CatchKind } from './game';
import {
  makeRonkeOverlayState,
  updateRonkeOverlay,
  paintRonke,
} from './ronke-overlay';
import {
  initAudio, sfxCatch, sfxPerfect, sfxGold, sfxRug, sfxFever, sfxSplash,
  sfxGameOver, startMusic, stopMusic, startHeartbeat, stopHeartbeat,
  isMuted, setMuted,
} from './audio';
import { startTitleFx, stopTitleFx } from './title-fx';
import { buildRiceballBitmaps } from './riceballs';
import './styles.css';

type ScreenName = 'title' | 'game' | 'over';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const refs = {
  video: $<HTMLVideoElement>('video'),
  ronkeCanvas: $<HTMLCanvasElement>('ronke-canvas'),
  gameCanvas: $<HTMLCanvasElement>('game-canvas'),
  titleScreen: $<HTMLDivElement>('title-screen'),
  gameScreen: $<HTMLDivElement>('game-screen'),
  overScreen: $<HTMLDivElement>('over-screen'),
  playBtn: $<HTMLButtonElement>('play-btn'),
  titleBest: $<HTMLDivElement>('title-best'),
  titleStatus: $<HTMLDivElement>('title-status'),
  hudScore: $<HTMLSpanElement>('hud-score'),
  hudLives: $<HTMLDivElement>('hud-lives'),
  hudCombo: $<HTMLDivElement>('hud-combo'),
  hudHat: $<HTMLDivElement>('hud-hat'),
  feverBanner: $<HTMLDivElement>('fever-banner'),
  feverBarFill: $<HTMLDivElement>('fever-bar-fill'),
  feedback: $<HTMLDivElement>('feedback'),
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
};

let detector: MouthDetector | null = null;
let detectionMode = false;
let game: Game | null = null;
let pumpRunning = false;
const ronkeState = makeRonkeOverlayState();
/** performance.now() of the last chomp fire — drives the 200ms green
 *  "your chomp landed" ring pulse (armed flips false the same tick it
 *  fires, so without this the ring never visibly goes green). */
let lastChompAt = 0;

// ── Detection sensitivity ──
// Player-tunable multiplier on the jawOpen fire threshold. 'hair'
// chomps on a slightly parted mouth, 'chill' wants a clear open-wide.
type Sens = 'chill' | 'normal' | 'hair';
const SENS_KEY = 'ronke:sens';
const SENS_FACTOR: Record<Sens, number> = { chill: 1.25, normal: 1, hair: 0.75 };
const SENS_LABEL: Record<Sens, string> = {
  chill: 'detection: chill 🧘',
  normal: 'detection: normal',
  hair: 'detection: hair-trigger ⚡',
};
const getSens = (): Sens => {
  const v = localStorage.getItem(SENS_KEY);
  return v === 'chill' || v === 'hair' ? v : 'normal';
};
/** Detector's default fire threshold, captured before any scaling. */
let baseFireThreshold: number | null = null;

function applySensitivity(): void {
  if (!detector) return;
  baseFireThreshold ??= detector.getOpenThreshold();
  detector.setOpenThreshold(baseFireThreshold * SENS_FACTOR[getSens()]);
  console.log(`[sens] ${getSens()} → fire=${detector.getOpenThreshold().toFixed(3)}`);
}

// ── Rank ladder — the competition hook. Community-flavoured titles
// climbing toward TRUE RONKE; shown on the over screen and baked into
// the share text so scores are comparable at a glance.
const RANKS: Array<[number, string]> = [
  [0, '🌱 RICE PEASANT'],
  [500, '🌾 RICE FARMER'],
  [1500, '🍙 RICE COOK'],
  [3500, '⚔️ RICE SAMURAI'],
  [7000, '👑 RICE SHOGUN'],
  [14000, '🐒 TRUE RONKE'],
];
function rankForScore(score: number): string {
  let r = RANKS[0][1];
  for (const [min, name] of RANKS) if (score >= min) r = name;
  return r;
}
let lastScore = 0;
let lastRank = RANKS[0][1];

const BEST_KEY = 'ronke:bestScore';
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
    refs.playBtn.textContent = 'PLAY';
    return;
  }
  refs.playBtn.disabled = true;
  refs.playBtn.textContent = label;
}

// ── Projection (object-fit: cover + selfie mirror) ──
// Uses the video's ACTUAL displayed rect, not the window — on desktop
// the gameplay column is narrower than the viewport (data-gameplay
// media block), and the video, canvases, and HUD all share that rect.
// A rect-based projection therefore lands in canvas-local coordinates
// for free — the same lesson the original Lick'em learned the hard way.

function projectVideoToViewport(
  xNorm: number,
  yNorm: number,
): { x: number; y: number } {
  const video = refs.video;
  const sw = video.videoWidth;
  const sh = video.videoHeight;
  const rect = video.getBoundingClientRect();
  const vw = rect.width || window.innerWidth;
  const vh = rect.height || window.innerHeight;
  if (sw === 0 || sh === 0 || vw === 0 || vh === 0) {
    return { x: vw / 2, y: vh / 2 };
  }
  const scale = Math.max(vw / sw, vh / sh);
  const dispW = sw * scale;
  const dispH = sh * scale;
  const xOffset = (vw - dispW) / 2;
  const yOffset = (vh - dispH) / 2;
  let x = xNorm * dispW + xOffset;
  const y = yNorm * dispH + yOffset;
  x = vw - x; // selfie mirror (video has transform: scaleX(-1))
  return { x, y };
}

// ── Ronke overlay canvas sizing ──

function resizeRonkeCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = refs.ronkeCanvas.clientWidth || window.innerWidth;
  const h = refs.ronkeCanvas.clientHeight || window.innerHeight;
  refs.ronkeCanvas.width = Math.round(w * dpr);
  refs.ronkeCanvas.height = Math.round(h * dpr);
  const ctx = refs.ronkeCanvas.getContext('2d');
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resizeRonkeCanvas);
resizeRonkeCanvas();

/** Toggle the desktop play-column constraint (html[data-gameplay]).
 *  Canvas CSS sizes change without a window resize event, so kick one
 *  so the game + overlay canvases re-measure their rects. */
function setGameplayColumn(on: boolean): void {
  document.documentElement.toggleAttribute('data-gameplay', on);
  requestAnimationFrame(() => {
    resizeRonkeCanvas();
    window.dispatchEvent(new Event('resize'));
  });
}

// ── HUD ──

function renderLives(lives: number, hit = false): void {
  refs.hudLives.textContent = '🍙'.repeat(Math.max(0, lives));
  if (hit) {
    refs.hudLives.classList.remove('lost');
    void refs.hudLives.offsetWidth; // restart the pop animation
    refs.hudLives.classList.add('lost');
  }
}

/** Brief screen shake — used on misses and rug licks. */
const appEl = $<HTMLDivElement>('app');
function shakeScreen(): void {
  appEl.classList.remove('shake');
  void appEl.offsetWidth;
  appEl.classList.add('shake');
}

let feedbackTimer = 0;
function showFeedback(text: string, cls: string): void {
  refs.feedback.textContent = text;
  refs.feedback.className = `feedback ${cls}`;
  clearTimeout(feedbackTimer);
  feedbackTimer = window.setTimeout(() => {
    refs.feedback.classList.add('hidden');
  }, 700);
}

// ── Render pump: zone tracking + ronke overlay + HUD, 60fps ──

function startPump(): void {
  if (pumpRunning) return;
  pumpRunning = true;
  let smoothX: number | null = null;
  let smoothY: number | null = null;
  const LERP = 0.5;
  const ronkeCtx = refs.ronkeCanvas.getContext('2d')!;

  const tick = (): void => {
    if (!pumpRunning) return;

    if (detectionMode && detector) {
      // Ronke overlay follows the face whenever the camera is live.
      updateRonkeOverlay(ronkeState, detector.state, (x, y) =>
        projectVideoToViewport(x, y),
      );
      ronkeCtx.clearRect(
        0, 0,
        refs.ronkeCanvas.clientWidth || window.innerWidth,
        refs.ronkeCanvas.clientHeight || window.innerHeight,
      );
      paintRonke(ronkeCtx, ronkeState);
    }

    if (game && game.getState() === 'playing') {
      refs.hudScore.textContent = String(game.getScore());
      if (game.isFever()) {
        refs.feverBarFill.style.width = `${game.feverFraction() * 100}%`;
      }
      if (detectionMode && detector?.state.detected) {
        // The catch zone IS the mouth — rice falls into it.
        const proj = projectVideoToViewport(
          detector.state.centerX,
          detector.state.centerY,
        );
        if (smoothX === null || smoothY === null) {
          smoothX = proj.x;
          smoothY = proj.y;
        } else {
          smoothX += (proj.x - smoothX) * LERP;
          smoothY += (proj.y - smoothY) * LERP;
        }
        game.setZoneAbsolute(smoothX, smoothY);
        // Ring-green semantics from the original: green while a fresh
        // chomp is possible (armed) or briefly after one landed — then
        // back to gold even if the mouth stays open, cueing the player
        // to close and chomp again.
        const open = detector.state.mouthOpen;
        const inPulse = performance.now() - lastChompAt < 200;
        game.setTongueDetected(open && (detector.state.armed || inPulse));
      } else if (detectionMode) {
        smoothX = null;
        smoothY = null;
        game.setZoneHidden();
      }
    }

    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ── Leaderboard client ──
// Talks to /api/scores (Vercel function + Upstash sorted set). Every
// call is fail-soft: no API (local dev) or no KV → the leaderboard UI
// just stays hidden and the game plays on, like the original.

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
      ? `you're #${data.rank} on the board 🏆`
      : 'score submitted 🏆';
    refs.submitBtn.textContent = 'SENT ✓';
    void refreshTitleLb();
  } catch {
    refs.lbStatus.textContent = 'leaderboard unreachable — try again';
    refs.submitBtn.disabled = false;
    refs.submitBtn.textContent = 'SUBMIT';
  }
}

// ── Tutorial — first-run walkthrough of every mechanic ──
// Interactive where it matters: the first card waits for an actual
// chomp so the input clicks before rice falls.
// Re-watchable from the title screen ("how to play").

const TUT_KEY = 'ronke:tutorialSeen';
let forceTutorial = false;
let tutorialChompResolve: (() => void) | null = null;

interface TutStep {
  title: string;
  text: string;
  sprites: Array<{ type: 'rice' | 'gold' | 'rug' | 'hat'; scale?: number }>;
  emoji?: string;
  needsChomp?: boolean;
}

function tutorialSteps(): TutStep[] {
  return [
    {
      title: 'CHOMP!',
      text: 'Open your mouth WIDE — that is your chomp. Try one right now!',
      sprites: [],
      emoji: '😮',
      needsChomp: true,
    },
    {
      title: 'EAT THE RICE',
      text: 'Chomp when rice reaches your ring — dead centre is PERFECT. Golden $RICE pays 3×.',
      sprites: [{ type: 'rice' }, { type: 'gold' }],
    },
    {
      title: 'NEVER EAT THE RUG',
      text: 'Rugs cost points and break your combo. Let them fall — dodging is free.',
      sprites: [{ type: 'rug' }],
    },
    {
      title: 'FEASTS & KASA',
      text: 'BIG onigiri take 3 chomps and burst into a feast. Eat the straw kasa to wear it — it saves one missed rice.',
      sprites: [{ type: 'rice', scale: 1.5 }, { type: 'hat' }],
    },
    {
      title: 'RONKE ARC',
      text: 'A 10-combo ignites the ARC: double points, denser rice, no rugs — and misses cost you nothing while it burns. Eat what you can. Become TRUE RONKE.',
      sprites: [],
      emoji: '🔥',
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
  const bitmaps = buildRiceballBitmaps(96);
  for (const s of step.sprites) {
    const c = document.createElement('canvas');
    const px = Math.round(72 * (s.scale ?? 1));
    c.width = px;
    c.height = px;
    c.className = 'tut-sprite';
    c.getContext('2d')!.drawImage(bitmaps[s.type], 0, 0, px, px);
    refs.tutSprites.appendChild(c);
  }
}

async function runTutorial(): Promise<void> {
  const steps = tutorialSteps();
  refs.tutorial.classList.remove('hidden');
  let skipped = false;
  const skipPromise = new Promise<void>((res) => {
    refs.tutSkip.onclick = () => { skipped = true; res(); };
  });

  for (let i = 0; i < steps.length && !skipped; i++) {
    const step = steps[i];
    refs.tutTitle.textContent = step.title;
    refs.tutText.textContent = step.text;
    refs.tutHint.textContent = step.needsChomp
      ? 'chomp to continue'
      : 'chomp (or tap) to continue';
    refs.tutDots.innerHTML = steps
      .map((_, d) => `<span class="tut-dot${d === i ? ' on' : ''}"></span>`)
      .join('');
    renderTutSprites(step);

    // Advance on chomp (camera) or tap — whichever lands first.
    await Promise.race([
      new Promise<void>((res) => { tutorialChompResolve = res; }),
      new Promise<void>((res) => {
        const onTap = (): void => { refs.tutorial.removeEventListener('pointerdown', onTap); res(); };
        // Chomp-only for the first step: taps skip accidentally otherwise.
        if (!step.needsChomp) {
          refs.tutorial.addEventListener('pointerdown', onTap);
        }
      }),
      skipPromise,
    ]);
    tutorialChompResolve = null;
    // Small beat so one chomp can't blow through two cards.
    await new Promise((r) => setTimeout(r, 350));
  }

  refs.tutorial.classList.add('hidden');
  tutorialChompResolve = null;
  forceTutorial = false;
  try { localStorage.setItem(TUT_KEY, '1'); } catch { /* ignore */ }
}

function needsTutorial(): boolean {
  return forceTutorial || localStorage.getItem(TUT_KEY) !== '1';
}

// ── Game lifecycle ──

function makeGame(): Game {
  return new Game(refs.gameCanvas, DEFAULT_GAME_CONFIG, {
    onCatch: (kind: CatchKind, _points: number, gold: boolean) => {
      const inCombo = (game?.getCombo() ?? 0) >= 3;
      switch (kind) {
        case 'perfect':
          if (gold) sfxGold(); else sfxPerfect();
          if (!inCombo) showFeedback(gold ? '$RICE!' : 'PERFECT!', 'perfect');
          break;
        case 'good':
          if (gold) sfxGold(); else sfxCatch();
          if (!inCombo) showFeedback(gold ? '$RICE!' : 'NICE', 'good');
          break;
        case 'late':
          if (gold) sfxGold(); else sfxCatch();
          break;
        case 'big-hit':
          sfxCatch();
          break;
        case 'big-burst':
          sfxGold();
          showFeedback('FEAST!', 'perfect');
          break;
        case 'hat-catch':
          sfxPerfect();
          showFeedback('KASA GET!', 'good');
          break;
        case 'hat-save':
          sfxPerfect();
          showFeedback('HAT SAVE!', 'good');
          break;
        case 'rug-hit':
          sfxRug();
          shakeScreen();
          showFeedback('RUGGED!', 'miss');
          break;
        case 'miss':
          sfxSplash();
          shakeScreen();
          showFeedback('RICE LOST!', 'miss');
          break;
        case 'whiff':
          break;
      }
    },
    onLifeLost: (lives) => {
      renderLives(lives, true);
      if (lives === 1) startHeartbeat();
    },
    onComboChange: (combo, mul) => {
      if (combo >= 3) {
        refs.hudCombo.textContent = `${combo}× COMBO · ${mul}× RICE`;
        refs.hudCombo.classList.remove('hidden');
      } else {
        refs.hudCombo.classList.add('hidden');
      }
    },
    onFever: (active) => {
      document.body.classList.toggle('fever', active);
      refs.feverBanner.classList.toggle('hidden', !active);
      if (active) sfxFever(); // taiko roll into the gong — the ARC begins
    },
    onShield: (held) => {
      refs.hudHat.classList.toggle('hidden', !held);
    },
    onEnd: (score, stats) => {
      stopHeartbeat();
      stopMusic();
      sfxGameOver();
      setGameplayColumn(false);
      document.body.classList.remove('fever');
      refs.feverBanner.classList.add('hidden');
      saveBest(score);
      refs.overScore.textContent = String(score);
      refs.overBest.textContent = `best: ${loadBest()} 🍙`;
      lastRank = rankForScore(score);
      refs.rankChip.textContent = lastRank;
      lastScore = score;
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
      stat(stats.catches, 'caught');
      stat(`${stats.bestCombo}×`, 'best combo');
      stat(stats.fevers, 'ronke arcs');
      stat(stats.bigBursts, 'feasts');
      stat(stats.rugsHit, 'rugged');
      showScreen('over');
      if (!detectionMode) startTitleFx(refs.ronkeCanvas);
    },
  });
}

function startGame(): void {
  stopTitleFx(refs.ronkeCanvas);
  setGameplayColumn(true);
  showScreen('game');
  requestAnimationFrame(async () => {
    if (!game) game = makeGame();
    renderLives(DEFAULT_GAME_CONFIG.lives);
    refs.hudScore.textContent = '0';
    refs.hudCombo.classList.add('hidden');
    refs.feverBanner.classList.add('hidden');
    refs.hudHat.classList.add('hidden');
    document.body.classList.remove('fever');
    stopHeartbeat();
    if (needsTutorial()) await runTutorial();
    game.start();
    startMusic();
    startPump();
  });
}

// ── Camera / detection startup ──

async function startWithCamera(): Promise<void> {
  initAudio();
  setStatus(null);

  const tier = detectDeviceTier();
  console.log(`[main] device tier: ${tier}`);

  if (!detector) {
    setLoading('LOADING MONKE…');
    detector = new MouthDetector(refs.video, configForTier(tier));
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
        ? 'Camera permission denied — Ronke needs the camera to chomp.'
        : 'Camera unavailable — is another app using it?',
      true,
    );
    detector.stop();
    detector = null;
    setLoading(null);
    return;
  }

  detectionMode = true;
  stopTitleFx(refs.ronkeCanvas);
  detector.onChomp = () => {
    lastChompAt = performance.now();
    if (tutorialChompResolve) {
      tutorialChompResolve();
      return;
    }
    if (!game || game.getState() !== 'playing') return;
    game.lick();
  };
  detector.start();
  refs.video.classList.remove('hidden');
  refs.video.classList.add('fullscreen');
  document.documentElement.setAttribute('data-ar', '');
  setLoading(null);
  startPump();

  // jawOpen is normalized per-face — no calibration, no distance gate.
  // Straight into the rice.
  applySensitivity();
  startGame();
}

// ── Buttons ──

// Share the run on X — prefilled intent, no backend needed. The rank
// ladder makes scores comparable across the community.
refs.shareBtn.addEventListener('click', () => {
  const text =
    `I just ate ${lastScore} rice in RONKE RICE RUSH \u{1F359} ` +
    `rank: ${lastRank}\n\ncan you out-chomp me, monke? $RONKE`;
  const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
  window.open(url, '_blank', 'noopener');
});

refs.howBtn.addEventListener('click', () => {
  forceTutorial = true;
  setStatus('tutorial will play before your next round');
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
  if (!detectionMode) startTitleFx(refs.ronkeCanvas);
});

// ── Sensitivity toggle — cycles chill → normal → hair-trigger ──
const sensBtn = $<HTMLButtonElement>('sens-btn');
const renderSens = (): void => {
  sensBtn.textContent = SENS_LABEL[getSens()];
};
sensBtn.addEventListener('click', () => {
  const order: Sens[] = ['chill', 'normal', 'hair'];
  const next = order[(order.indexOf(getSens()) + 1) % order.length];
  localStorage.setItem(SENS_KEY, next);
  renderSens();
  applySensitivity(); // live-applies if the detector is already up
});
renderSens();

// ── Mute toggle — fixed corner button, persists across sessions ──
const muteBtn = $<HTMLButtonElement>('mute-btn');
const renderMute = (): void => {
  muteBtn.textContent = isMuted() ? '🔇' : '🔊';
};
muteBtn.addEventListener('click', () => {
  initAudio(); // safe: this IS a user gesture
  setMuted(!isMuted());
  renderMute();
});
renderMute();

function refreshTitle(): void {
  const best = loadBest();
  refs.titleBest.textContent = best > 0 ? `best: ${best} 🍙` : '';
}

refreshTitle();
showScreen('title');
startTitleFx(refs.ronkeCanvas);
void refreshTitleLb();
