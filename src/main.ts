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
  initAudio, sfxCatch, sfxPerfect, sfxGold, sfxMiss, sfxGameOver,
  startMusic, stopMusic, startHeartbeat, stopHeartbeat, isMuted, setMuted,
} from './audio';
import { startTitleFx, stopTitleFx } from './title-fx';
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
  touchBtn: $<HTMLButtonElement>('touch-btn'),
  titleBest: $<HTMLDivElement>('title-best'),
  titleStatus: $<HTMLDivElement>('title-status'),
  hudScore: $<HTMLSpanElement>('hud-score'),
  hudLives: $<HTMLDivElement>('hud-lives'),
  hudCombo: $<HTMLDivElement>('hud-combo'),
  feverBanner: $<HTMLDivElement>('fever-banner'),
  feverBarFill: $<HTMLDivElement>('fever-bar-fill'),
  feedback: $<HTMLDivElement>('feedback'),
  overScore: $<HTMLSpanElement>('over-score'),
  overBest: $<HTMLDivElement>('over-best'),
  statsRow: $<HTMLDivElement>('stats-row'),
  againBtn: $<HTMLButtonElement>('again-btn'),
  homeBtn: $<HTMLButtonElement>('home-btn'),
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
        case 'rug-hit':
          sfxMiss();
          shakeScreen();
          showFeedback('RUGGED!', 'miss');
          break;
        case 'miss':
          sfxMiss();
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
      if (active) sfxGold(); // cheer + sparkle — the ARC has begun
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
  requestAnimationFrame(() => {
    if (!game) game = makeGame();
    renderLives(DEFAULT_GAME_CONFIG.lives);
    refs.hudScore.textContent = '0';
    refs.hudCombo.classList.add('hidden');
    refs.feverBanner.classList.add('hidden');
    document.body.classList.remove('fever');
    stopHeartbeat();
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
      setStatus('Detection failed to load — try touch mode below.', true);
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
        ? 'Camera permission denied — allow it or use touch mode.'
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

function startTouchOnly(): void {
  initAudio();
  if (detector) {
    detector.stop();
    detector = null;
  }
  detectionMode = false;
  refs.video.classList.add('hidden');
  document.documentElement.removeAttribute('data-ar');
  startGame();
}

// Touch/click catches in touch mode (and is a harmless extra in camera mode).
refs.gameCanvas.addEventListener('pointerdown', (e) => {
  if (!game || game.getState() !== 'playing') return;
  if (detectionMode) return; // tongue only — no tap-cheesing in camera mode
  // Canvas-local coords — the canvas may be a centered desktop column.
  const rect = refs.gameCanvas.getBoundingClientRect();
  game.lick(e.clientX - rect.left, e.clientY - rect.top);
});

// ── Buttons ──

refs.playBtn.addEventListener('click', () => void startWithCamera());
refs.touchBtn.addEventListener('click', startTouchOnly);
refs.againBtn.addEventListener('click', () => startGame());
refs.homeBtn.addEventListener('click', () => {
  game?.stop();
  stopMusic();
  stopHeartbeat();
  setGameplayColumn(false);
  document.body.classList.remove('fever');
  showScreen('title');
  refreshTitle();
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
