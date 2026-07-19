// ═════════════════════════════════════════════════════════════
// Ronke Rice Rush — entrypoint, screen routing, detection wiring.
//
// Flow: title → (camera + models load) → distance gate →
//       calibration → game → over → again.
// One game mode: flick your tongue to catch falling riceballs.
// Detection stack inherited from Lick'em (MediaPipe FaceLandmarker
// + custom tongue classifier); see src/detection.ts.
// ═════════════════════════════════════════════════════════════

import {
  TongueDetector,
  detectDeviceTier,
  configForTier,
} from './detection';
import { runDistanceGate } from './distance-gate';
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
import './styles.css';

type ScreenName = 'title' | 'calibrate' | 'game' | 'over';

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
  calibrateScreen: $<HTMLDivElement>('calibrate-screen'),
  gameScreen: $<HTMLDivElement>('game-screen'),
  overScreen: $<HTMLDivElement>('over-screen'),
  playBtn: $<HTMLButtonElement>('play-btn'),
  touchBtn: $<HTMLButtonElement>('touch-btn'),
  titleBest: $<HTMLDivElement>('title-best'),
  titleStatus: $<HTMLDivElement>('title-status'),
  calibratePhase: $<HTMLDivElement>('calibrate-phase'),
  calibrateTitle: $<HTMLDivElement>('calibrate-title'),
  calibrateSub: $<HTMLDivElement>('calibrate-sub'),
  calibrateTimer: $<HTMLDivElement>('calibrate-timer'),
  calibrateMeterFill: $<HTMLDivElement>('calibrate-meter-fill'),
  hudScore: $<HTMLDivElement>('hud-score'),
  hudLives: $<HTMLDivElement>('hud-lives'),
  hudCombo: $<HTMLDivElement>('hud-combo'),
  feedback: $<HTMLDivElement>('feedback'),
  overScore: $<HTMLSpanElement>('over-score'),
  overBest: $<HTMLDivElement>('over-best'),
  againBtn: $<HTMLButtonElement>('again-btn'),
  homeBtn: $<HTMLButtonElement>('home-btn'),
};

let detector: TongueDetector | null = null;
let detectionMode = false;
let game: Game | null = null;
let pumpRunning = false;
const ronkeState = makeRonkeOverlayState();

const BEST_KEY = 'ronke:bestScore';
const loadBest = (): number => Number(localStorage.getItem(BEST_KEY) || 0);
const saveBest = (s: number): void => {
  if (s > loadBest()) localStorage.setItem(BEST_KEY, String(s));
};

function showScreen(name: ScreenName): void {
  refs.titleScreen.classList.toggle('hidden', name !== 'title');
  refs.calibrateScreen.classList.toggle('hidden', name !== 'calibrate');
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

// ── Viewport projection (object-fit: cover + selfie mirror) ──

function projectVideoToViewport(
  xNorm: number,
  yNorm: number,
): { x: number; y: number } {
  const video = refs.video;
  const sw = video.videoWidth;
  const sh = video.videoHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (sw === 0 || sh === 0) return { x: vw / 2, y: vh / 2 };
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
  refs.ronkeCanvas.width = Math.round(window.innerWidth * dpr);
  refs.ronkeCanvas.height = Math.round(window.innerHeight * dpr);
  const ctx = refs.ronkeCanvas.getContext('2d');
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resizeRonkeCanvas);
resizeRonkeCanvas();

// ── HUD ──

function renderLives(lives: number): void {
  refs.hudLives.textContent = '🍙'.repeat(Math.max(0, lives));
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
      // Ronke overlay follows the face on every screen where the
      // camera is live — calibration included, it sells the bit.
      updateRonkeOverlay(ronkeState, detector.state, (x, y) =>
        projectVideoToViewport(x, y),
      );
      ronkeCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      paintRonke(ronkeCtx, ronkeState);
    }

    if (game && game.getState() === 'playing') {
      refs.hudScore.textContent = String(game.getScore());
      if (detectionMode && detector?.state.detected) {
        const proj = projectVideoToViewport(
          detector.state.tongueZoneX,
          detector.state.tongueZoneY,
        );
        if (smoothX === null || smoothY === null) {
          smoothX = proj.x;
          smoothY = proj.y;
        } else {
          smoothX += (proj.x - smoothX) * LERP;
          smoothY += (proj.y - smoothY) * LERP;
        }
        game.setZoneAbsolute(smoothX, smoothY);
        game.setTongueDetected(detector.state.tongueOut);
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
        case 'miss':
          sfxMiss();
          showFeedback('RICE LOST!', 'miss');
          break;
        case 'whiff':
          break;
      }
    },
    onLifeLost: (lives) => {
      renderLives(lives);
      if (lives === 1) startHeartbeat();
    },
    onComboChange: (combo, mul) => {
      if (combo >= 3) {
        refs.hudCombo.textContent = `${combo}× COMBO  (${mul}× rice)`;
        refs.hudCombo.classList.remove('hidden');
      } else {
        refs.hudCombo.classList.add('hidden');
      }
    },
    onEnd: (score) => {
      stopHeartbeat();
      stopMusic();
      sfxGameOver();
      saveBest(score);
      refs.overScore.textContent = String(score);
      refs.overBest.textContent = `best: ${loadBest()} 🍙`;
      showScreen('over');
    },
  });
}

function startGame(): void {
  showScreen('game');
  requestAnimationFrame(() => {
    if (!game) game = makeGame();
    renderLives(DEFAULT_GAME_CONFIG.lives);
    refs.hudScore.textContent = '0';
    refs.hudCombo.classList.add('hidden');
    stopHeartbeat();
    game.start();
    startMusic();
    startPump();
  });
}

// ── Calibration (ported from Lick'em, English-only) ──

const CALIBRATE_SESSION_KEY = 'ronke:personal-thresholds';
const CALIBRATE_PHASE_MS = 3000;
const CALIBRATE_COMPLY_SUSTAIN_MS = 300;
const CALIBRATE_COMPLY_TIMEOUT_MS = 8000;
const CALIBRATE_HOLD_BEAT_MS = 350;

const collectingRef: { current: 'tongue' | 'closed' | null } = { current: null };
const lastJawRef: { current: { j: number; detected: boolean; at: number } | null } =
  { current: null };

async function maybeRunCalibration(): Promise<void> {
  if (!detector) return;
  if (location.search.includes('skip-calibrate')) return;

  try {
    const cached = sessionStorage.getItem(CALIBRATE_SESSION_KEY);
    if (cached) {
      const parsed = JSON.parse(cached) as { fire: number; sustain: number };
      if (typeof parsed.fire === 'number' && typeof parsed.sustain === 'number') {
        detector.setPersonalThresholds(parsed.fire, parsed.sustain);
        return;
      }
    }
  } catch { /* private mode etc. */ }

  await runDistanceGate({
    detector,
    host: $('app'),
    tier: detectDeviceTier(),
    skip: location.search.includes('skip-distance'),
  });

  showScreen('calibrate');

  const tongueScores: number[] = [];
  const closedScores: number[] = [];
  const prevDebugCb = detector.onDebugSample;
  detector.onDebugSample = (s) => {
    if (collectingRef.current === 'tongue') tongueScores.push(s.r);
    else if (collectingRef.current === 'closed') closedScores.push(s.r);
    lastJawRef.current = { j: s.j, detected: s.d, at: performance.now() };
    prevDebugCb?.(s);
  };

  try {
    await runCalibrationPhase('tongue', tongueScores);
    await runCalibrationPhase('closed', closedScores);
  } finally {
    detector.onDebugSample = prevDebugCb;
    collectingRef.current = null;
  }

  // Thresholds from the two distributions: tongue median vs closed p95,
  // fire = midpoint, sustain ~8pp below. Falls back to defaults when the
  // distributions don't separate (see Lick'em calibration notes).
  const tongue = tongueScores.slice().sort((a, b) => a - b);
  const closed = closedScores.slice().sort((a, b) => a - b);
  const pct = (arr: number[], p: number): number =>
    arr.length === 0 ? NaN : arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
  const tongueMed = tongue.length >= 5 ? pct(tongue, 0.50) : NaN;
  const closedP95 = closed.length >= 5 ? pct(closed, 0.95) : NaN;

  let ok = false;
  if (Number.isFinite(tongueMed) && Number.isFinite(closedP95) && tongueMed - closedP95 > 0.10) {
    const fire = Math.max(0.12, Math.min(0.55, (tongueMed + closedP95) / 2));
    const sustain = Math.max(0.06, fire - 0.08);
    detector.setPersonalThresholds(fire, sustain);
    try {
      sessionStorage.setItem(CALIBRATE_SESSION_KEY, JSON.stringify({ fire, sustain }));
    } catch { /* ignore */ }
    console.log(`[calibrate] fire=${fire.toFixed(3)} sustain=${sustain.toFixed(3)}`);
    ok = true;
  } else {
    console.warn('[calibrate] insufficient separation — using defaults');
  }

  refs.calibratePhase.textContent = ok ? '✓' : '!';
  refs.calibrateTitle.textContent = ok ? 'Tongue locked in' : 'Using default tuning';
  refs.calibrateSub.textContent = ok
    ? 'Ronke knows your lick. Go get that rice.'
    : "Couldn't read your tongue clearly — playing with standard settings.";
  refs.calibrateTimer.textContent = '';
  refs.calibrateMeterFill.style.width = ok ? '100%' : '0%';
  await new Promise((r) => setTimeout(r, 1100));
}

async function runCalibrationPhase(
  phase: 'tongue' | 'closed',
  _bucket: number[],
): Promise<void> {
  refs.calibratePhase.textContent = phase === 'tongue' ? '1 / 2' : '2 / 2';
  refs.calibrateTitle.textContent = phase === 'tongue'
    ? 'Stick your tongue out'
    : 'Now close your mouth';
  refs.calibrateSub.textContent = phase === 'tongue'
    ? 'Hold it out like you want that rice'
    : 'Relax. Regular monke face.';
  refs.calibrateTimer.textContent = '';
  refs.calibrateMeterFill.style.width = '0%';

  // Pose-gated wait: no countdown until the player actually assumes the
  // pose (jawOpen crossing the detector's own gate, sustained 300ms).
  const jawGate = detector?.getConfig().minJawOpen ?? 0.05;
  const complying = (): boolean => {
    const s = lastJawRef.current;
    if (!s || !s.detected || performance.now() - s.at > 600) return false;
    return phase === 'tongue' ? s.j >= jawGate : s.j < jawGate;
  };
  const waitStart = performance.now();
  let sustainedSince: number | null = null;
  while (performance.now() - waitStart < CALIBRATE_COMPLY_TIMEOUT_MS) {
    if (complying()) {
      sustainedSince ??= performance.now();
      if (performance.now() - sustainedSince >= CALIBRATE_COMPLY_SUSTAIN_MS) break;
    } else {
      sustainedSince = null;
    }
    await new Promise((r) => setTimeout(r, 80));
  }

  refs.calibrateSub.textContent = 'Hold it…';
  await new Promise((r) => setTimeout(r, CALIBRATE_HOLD_BEAT_MS));

  collectingRef.current = phase;
  const start = performance.now();
  while (performance.now() - start < CALIBRATE_PHASE_MS) {
    const elapsed = performance.now() - start;
    const remain = Math.ceil((CALIBRATE_PHASE_MS - elapsed) / 1000);
    refs.calibrateTimer.textContent = String(Math.max(1, remain));
    refs.calibrateMeterFill.style.width = `${(elapsed / CALIBRATE_PHASE_MS) * 100}%`;
    await new Promise((r) => setTimeout(r, 80));
  }
  collectingRef.current = null;
}

// ── Camera / detection startup ──

async function startWithCamera(): Promise<void> {
  initAudio();
  setStatus(null);

  const tier = detectDeviceTier();
  console.log(`[main] device tier: ${tier}`);

  if (!detector) {
    setLoading('LOADING MONKE…');
    detector = new TongueDetector(refs.video, configForTier(tier));
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
  detector.onTongue = () => {
    if (!game || game.getState() !== 'playing') return;
    game.lick();
  };
  detector.start();
  refs.video.classList.remove('hidden');
  refs.video.classList.add('fullscreen');
  document.documentElement.setAttribute('data-ar', '');
  setLoading(null);
  startPump();

  await maybeRunCalibration();
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
  game.lick(e.clientX, e.clientY);
});

// ── Buttons ──

refs.playBtn.addEventListener('click', () => void startWithCamera());
refs.touchBtn.addEventListener('click', startTouchOnly);
refs.againBtn.addEventListener('click', () => startGame());
refs.homeBtn.addEventListener('click', () => {
  game?.stop();
  stopMusic();
  stopHeartbeat();
  showScreen('title');
  refreshTitle();
});

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
