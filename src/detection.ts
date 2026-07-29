// ═════════════════════════════════════════════════════════════
// Mouth-open detection — MediaPipe FaceLandmarker only.
//
// The game pivoted from tongue-flicks to CHOMPS: you open your
// mouth to eat the falling rice. That kills the whole custom-
// classifier stack from Lick'em (TF.js, MobileNetV2 crops,
// per-user calibration, distance gate) — the jawOpen blendshape
// ships inside FaceLandmarker, is normalized per-face, and works
// at any sane distance and angle. One model, no training loop.
//
// On-device only. No frames leave the browser.
// ═════════════════════════════════════════════════════════════

import { FilesetResolver, FaceLandmarker, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';

// Self-hosted MediaPipe assets (public/mediapipe/) so no CDN is a
// point of failure — carried over from the original.
const WASM_URL = '/mediapipe/wasm';
const MODEL_URL = '/mediapipe/face_landmarker.task';

// Mouth landmark indices on MediaPipe's 478-point mesh.
const UPPER_LIP = 13;
const LOWER_LIP = 14;
const LEFT_MOUTH = 78;
const RIGHT_MOUTH = 308;
// Face geometry — forehead + cheek line for the Ronke overlay.
const FOREHEAD_TOP = 10;
const FACE_LEFT_ON_SCREEN = 454;
const FACE_RIGHT_ON_SCREEN = 234;

export interface MouthState {
  detected: boolean;        // a face is present
  /** Raw jawOpen blendshape 0..1. */
  jawOpen: number;
  /** Hysteresis-stable "mouth is open" decision. */
  mouthOpen: boolean;
  /** True when a fresh chomp can fire (re-arms when the mouth closes). */
  armed: boolean;
  // Mouth landmark positions in [0..1] (normalized video coords)
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  // Face geometry for the overlay, normalized video coords.
  foreheadX: number;
  foreheadY: number;
  faceLeftX: number;
  faceLeftY: number;
  faceRightX: number;
  faceRightY: number;
  /** Wall-clock ms of the last successful detection, for fade-out. */
  lastDetectAt: number;
}

export interface DetectionConfig {
  /** jawOpen needed to FIRE a chomp (rising edge). */
  openThreshold: number;
  /** Lower jawOpen that keeps mouthOpen asserted once open. */
  sustainThreshold: number;
  /** Hard floor between chomp fires — noise can't double-eat. */
  minFireGapMs: number;
  /** Min ms between FaceLandmarker inferences. */
  minDetectIntervalMs: number;
  videoWidth: { ideal: number; max: number };
  videoHeight: { ideal: number; max: number };
  videoFrameRate: { ideal: number; max: number };
}

const DEFAULT_CONFIG: DetectionConfig = {
  // jawOpen sits ~0.01-0.05 closed, ~0.15 slightly parted, 0.4+ on a
  // clear "aaah". 0.30 fire / 0.20 sustain reads a deliberate chomp
  // without firing on speech-level jaw motion.
  openThreshold: 0.30,
  sustainThreshold: 0.20,
  minFireGapMs: 220,
  minDetectIntervalMs: 50, // ~20Hz — landmarker is the only inference now
  videoWidth: { ideal: 640, max: 1280 },
  videoHeight: { ideal: 480, max: 720 },
  videoFrameRate: { ideal: 30, max: 30 },
};

// ── Device tiering (carried over: camera res + cadence per class) ──
export type DeviceTier = 'low' | 'mid' | 'high' | 'desktop';

export function detectDeviceTier(): DeviceTier {
  if (typeof location !== 'undefined') {
    const m = location.search.match(/[?&]perf=(low|mid|high|desktop)/);
    if (m) return m[1] as DeviceTier;
  }
  if (typeof navigator === 'undefined') return 'mid';
  const cores = navigator.hardwareConcurrency || 4;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const ua = navigator.userAgent || '';
  const oldAndroid = /Android\s*([0-9]+)/.exec(ua);
  const androidMajor = oldAndroid ? parseInt(oldAndroid[1], 10) : 99;

  const isMobileUa = /Android|iPhone|iPad|iPod/.test(ua);
  const fineCursor =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: fine)').matches
      : false;
  const noTouch =
    typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) === 0;
  if (!isMobileUa && fineCursor && noTouch) return 'desktop';

  if (cores <= 4) return 'low';
  if (typeof mem === 'number' && mem <= 2) return 'low';
  if (androidMajor <= 9) return 'low';
  if (cores <= 6) return 'mid';
  if (typeof mem === 'number' && mem <= 4) return 'mid';
  return 'high';
}

export function configForTier(tier: DeviceTier): Partial<DetectionConfig> {
  switch (tier) {
    case 'low':
      return {
        videoWidth: { ideal: 320, max: 480 },
        videoHeight: { ideal: 240, max: 360 },
        videoFrameRate: { ideal: 24, max: 24 },
        minDetectIntervalMs: 100,
      };
    case 'mid':
      return {
        videoWidth: { ideal: 480, max: 640 },
        videoHeight: { ideal: 360, max: 480 },
        minDetectIntervalMs: 70,
      };
    case 'desktop':
      return {
        videoWidth: { ideal: 1280, max: 1920 },
        videoHeight: { ideal: 720, max: 1080 },
        minDetectIntervalMs: 40,
      };
    case 'high':
    default:
      return {};
  }
}

export class MouthDetector {
  private landmarker: FaceLandmarker | null = null;
  private video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private running = false;
  private lastVideoTime = -1;
  private lastInferAt = 0;
  private lastFireAt = 0;
  private armed = true;
  private config: DetectionConfig;

  state: MouthState = {
    detected: false,
    jawOpen: 0,
    mouthOpen: false,
    armed: true,
    centerX: 0.5,
    centerY: 0.5,
    width: 0.2,
    height: 0.1,
    foreheadX: 0.5,
    foreheadY: 0.3,
    faceLeftX: 0.4,
    faceLeftY: 0.5,
    faceRightX: 0.6,
    faceRightY: 0.5,
    lastDetectAt: 0,
  };

  /** Fires once per mouth-open rising edge (the chomp). */
  onChomp: (() => void) | null = null;

  constructor(video: HTMLVideoElement, config: Partial<DetectionConfig> = {}) {
    this.video = video;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async init(): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    // 0.35 confidence keeps tracking alive through head turns (see the
    // original's tuning notes); phantom faces still have to clear it.
    const baseOpts = {
      runningMode: 'VIDEO' as const,
      numFaces: 1,
      minFaceDetectionConfidence: 0.35,
      minFacePresenceConfidence: 0.35,
      minTrackingConfidence: 0.35,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
    };
    try {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        ...baseOpts,
      });
    } catch (gpuErr) {
      console.warn('[detection] GPU init failed, falling back to CPU', gpuErr);
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
        ...baseOpts,
      });
    }
    console.log('[detection] FaceLandmarker ready');
  }

  async startCamera(): Promise<void> {
    const constraints: MediaStreamConstraints = {
      audio: false,
      video: {
        facingMode: 'user',
        width: this.config.videoWidth,
        height: this.config.videoHeight,
        frameRate: this.config.videoFrameRate,
      },
    };
    // Hard timeout against camera-startup hangs (another tab holding
    // the device, autoplay-policy stalls) — inherited from the original.
    const STARTUP_TIMEOUT_MS = 12000;
    const withTimeout = <T>(p: Promise<T>, label: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout>;
      return Promise.race<T>([
        p.finally(() => clearTimeout(timer)),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            const e = new Error(`camera startup timeout (${label})`);
            e.name = 'TimeoutError';
            reject(e);
          }, STARTUP_TIMEOUT_MS);
        }),
      ]);
    };
    this.stream = await withTimeout(
      navigator.mediaDevices.getUserMedia(constraints),
      'getUserMedia',
    );
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', 'true');
    this.video.muted = true;
    await withTimeout(this.video.play(), 'video.play');
  }

  start(): void {
    if (!this.landmarker) throw new Error('init() must finish before start()');
    this.running = true;
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  getConfig(): Readonly<DetectionConfig> {
    return this.config;
  }

  /** Sensitivity control — fire + sustain move together. */
  setOpenThreshold(fire: number): void {
    this.config.openThreshold = Math.max(0.12, Math.min(0.6, fire));
    this.config.sustainThreshold = Math.max(0.08, this.config.openThreshold - 0.10);
  }

  getOpenThreshold(): number {
    return this.config.openThreshold;
  }

  /** setTimeout-scheduled (not RAF) so inference never blocks paint. */
  private tick = (): void => {
    if (!this.running || !this.landmarker) return;
    const now = performance.now();
    const due = now - this.lastInferAt >= this.config.minDetectIntervalMs;
    if (due && this.video.readyState >= 2 && this.video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = this.video.currentTime;
      this.lastInferAt = now;
      try {
        const result = this.landmarker.detectForVideo(this.video, now);
        this.process(result);
      } catch (e) {
        console.warn('[detection] tick error', e);
      }
    }
    setTimeout(this.tick, 8);
  };

  private process(result: FaceLandmarkerResult): void {
    const faces = result.faceLandmarks;
    if (!faces || faces.length === 0) {
      // Hold last-known state ~250ms — single-frame dropouts are the
      // rule at edges/turns, and blanking instantly made everything
      // flicker in the original.
      const sinceLastSeen = performance.now() - this.state.lastDetectAt;
      if (sinceLastSeen > 250 || this.state.lastDetectAt === 0) {
        this.state.detected = false;
        this.state.mouthOpen = false;
        this.state.jawOpen = 0;
        this.armed = true;
        this.state.armed = true;
      }
      return;
    }

    const lm = faces[0];
    const upper = lm[UPPER_LIP];
    const lower = lm[LOWER_LIP];
    const left = lm[LEFT_MOUTH];
    const right = lm[RIGHT_MOUTH];

    const mouthWidth = Math.hypot(right.x - left.x, right.y - left.y);
    const mouthHeight = Math.hypot(lower.x - upper.x, lower.y - upper.y);

    this.state.detected = true;
    this.state.centerX = (left.x + right.x) / 2;
    this.state.centerY = (upper.y + lower.y) / 2;
    this.state.width = mouthWidth;
    this.state.height = mouthHeight;

    const forehead = lm[FOREHEAD_TOP];
    const faceLeft = lm[FACE_LEFT_ON_SCREEN];
    const faceRight = lm[FACE_RIGHT_ON_SCREEN];
    if (forehead) {
      this.state.foreheadX = forehead.x;
      this.state.foreheadY = forehead.y;
    }
    if (faceLeft) {
      this.state.faceLeftX = faceLeft.x;
      this.state.faceLeftY = faceLeft.y;
    }
    if (faceRight) {
      this.state.faceRightX = faceRight.x;
      this.state.faceRightY = faceRight.y;
    }
    this.state.lastDetectAt = performance.now();

    // jawOpen blendshape → hysteresis → chomp on the rising edge.
    let jawOpen = 0;
    const blendshapes = result.faceBlendshapes;
    if (blendshapes && blendshapes.length > 0) {
      for (const cat of blendshapes[0].categories) {
        if (cat.categoryName === 'jawOpen') {
          jawOpen = cat.score;
          break;
        }
      }
    }
    this.state.jawOpen = jawOpen;

    const wasOpen = this.state.mouthOpen;
    const gate = wasOpen ? this.config.sustainThreshold : this.config.openThreshold;
    const open = jawOpen >= gate;
    this.state.mouthOpen = open;

    if (open) {
      const fireNow = performance.now();
      if (this.armed && fireNow - this.lastFireAt >= this.config.minFireGapMs) {
        this.armed = false;
        this.state.armed = false;
        this.lastFireAt = fireNow;
        this.onChomp?.();
      }
    } else {
      // Mouth closed → re-arm for the next chomp.
      this.armed = true;
      this.state.armed = true;
    }
  }
}
