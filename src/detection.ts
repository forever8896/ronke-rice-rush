// ═════════════════════════════════════════════════════════════
// Face controller — MediaPipe FaceLandmarker, three signals.
//
// RONKE BOAT BATTLE needs the whole head, not just the jaw:
//
//   headX   nose tip, screen-space (mirrored) → steers the hull
//   roll    face tilt in radians              → aims the cannon
//   jawOpen blendshape → open/close edges     → charges + fires
//
// The three are deliberately independent: you dodge with where your
// head IS and aim with how your head is TILTED, which means the two
// fight each other constantly. That's the game.
//
// On-device only. No frames leave the browser.
// ═════════════════════════════════════════════════════════════

import { FilesetResolver, FaceLandmarker, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';

// Self-hosted MediaPipe assets (public/mediapipe/) so no CDN is a
// point of failure.
const WASM_URL = '/mediapipe/wasm';
const MODEL_URL = '/mediapipe/face_landmarker.task';

// Landmark indices on MediaPipe's 478-point mesh.
const NOSE_TIP = 1;
const UPPER_LIP = 13;
const LOWER_LIP = 14;
const LEFT_MOUTH = 78;
const RIGHT_MOUTH = 308;
// Cheek line — face width + roll. Named for where they land ON SCREEN
// once the selfie mirror is applied.
const FACE_LEFT_ON_SCREEN = 454;
const FACE_RIGHT_ON_SCREEN = 234;

export interface FaceState {
  detected: boolean;
  /** Raw jawOpen blendshape 0..1. */
  jawOpen: number;
  /** Hysteresis-stable "mouth is open" decision. */
  mouthOpen: boolean;
  /** ms the mouth has been continuously open (0 while closed). */
  openMs: number;
  /** Nose tip, screen space (mirrored): 0 = screen left, 1 = screen right. */
  headX: number;
  headY: number;
  /** Face roll in radians, screen space. + = top of head tilted right. */
  roll: number;
  // Mouth + face geometry in RAW normalized video coords (unmirrored) —
  // the captain overlay samples the video with these.
  mouthX: number;
  mouthY: number;
  faceWidth: number;
  /** Wall-clock ms of the last successful detection, for fade-out. */
  lastDetectAt: number;
}

export interface DetectionConfig {
  /** jawOpen needed to latch the mouth OPEN (rising edge). */
  openThreshold: number;
  /** Lower jawOpen that keeps it open once open (hysteresis). */
  sustainThreshold: number;
  /** Hard floor between shots — noise can't double-fire. */
  minFireGapMs: number;
  /** Min ms between FaceLandmarker inferences. */
  minDetectIntervalMs: number;
  videoWidth: { ideal: number; max: number };
  videoHeight: { ideal: number; max: number };
  videoFrameRate: { ideal: number; max: number };
}

const DEFAULT_CONFIG: DetectionConfig = {
  // jawOpen sits ~0.01-0.05 closed, ~0.15 slightly parted, 0.4+ on a
  // clear "aaah". 0.28 open / 0.18 sustain reads a deliberate gape
  // without latching on speech-level jaw motion.
  openThreshold: 0.28,
  sustainThreshold: 0.18,
  minFireGapMs: 160,
  minDetectIntervalMs: 40, // the landmarker is the only inference
  videoWidth: { ideal: 640, max: 1280 },
  videoHeight: { ideal: 480, max: 720 },
  videoFrameRate: { ideal: 30, max: 30 },
};

// ── Device tiering (camera res + inference cadence per class) ──
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
        minDetectIntervalMs: 90,
      };
    case 'mid':
      return {
        videoWidth: { ideal: 480, max: 640 },
        videoHeight: { ideal: 360, max: 480 },
        minDetectIntervalMs: 60,
      };
    case 'desktop':
      return {
        videoWidth: { ideal: 1280, max: 1920 },
        videoHeight: { ideal: 720, max: 1080 },
        minDetectIntervalMs: 33,
      };
    case 'high':
    default:
      return {};
  }
}

export class FaceController {
  private landmarker: FaceLandmarker | null = null;
  private video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private running = false;
  private lastVideoTime = -1;
  private lastInferAt = 0;
  private lastFireAt = 0;
  private openedAt = 0;
  private config: DetectionConfig;

  state: FaceState = {
    detected: false,
    jawOpen: 0,
    mouthOpen: false,
    openMs: 0,
    headX: 0.5,
    headY: 0.5,
    roll: 0,
    mouthX: 0.5,
    mouthY: 0.5,
    faceWidth: 0.25,
    lastDetectAt: 0,
  };

  /** Mouth crossed the open threshold — start charging the cannon. */
  onMouthOpen: (() => void) | null = null;
  /** Mouth closed again — FIRE, with how long it was held. */
  onMouthClose: ((heldMs: number) => void) | null = null;

  constructor(video: HTMLVideoElement, config: Partial<DetectionConfig> = {}) {
    this.video = video;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async init(): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    // 0.35 confidence keeps tracking alive through the head turns and
    // tilts this game demands; phantom faces still have to clear it.
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
    // the device, autoplay-policy stalls).
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
    if (this.state.mouthOpen) this.state.openMs = performance.now() - this.openedAt;
    setTimeout(this.tick, 8);
  };

  private process(result: FaceLandmarkerResult): void {
    const faces = result.faceLandmarks;
    if (!faces || faces.length === 0) {
      // Hold last-known state ~250ms — single-frame dropouts are the
      // rule at edges and turns, and blanking instantly makes the boat
      // twitch across the screen.
      const sinceLastSeen = performance.now() - this.state.lastDetectAt;
      if (sinceLastSeen > 250 || this.state.lastDetectAt === 0) {
        this.state.detected = false;
        if (this.state.mouthOpen) {
          // Face lost mid-charge: let the shot go rather than stranding it.
          this.state.mouthOpen = false;
          this.state.openMs = 0;
          this.onMouthClose?.(performance.now() - this.openedAt);
        }
        this.state.jawOpen = 0;
      }
      return;
    }

    const lm = faces[0];
    const vw = this.video.videoWidth || 640;
    const vh = this.video.videoHeight || 480;

    const upper = lm[UPPER_LIP];
    const lower = lm[LOWER_LIP];
    const left = lm[LEFT_MOUTH];
    const right = lm[RIGHT_MOUTH];
    const nose = lm[NOSE_TIP] ?? upper;
    const cheekL = lm[FACE_LEFT_ON_SCREEN];
    const cheekR = lm[FACE_RIGHT_ON_SCREEN];

    this.state.detected = true;
    this.state.mouthX = (left.x + right.x) / 2;
    this.state.mouthY = (upper.y + lower.y) / 2;
    // Steering reads the NOSE, not the mouth: the mouth centre swings
    // several pixels every time the jaw drops, which would make every
    // shot nudge the hull sideways.
    this.state.headX = 1 - nose.x; // selfie mirror
    this.state.headY = nose.y;

    if (cheekL && cheekR) {
      // Roll in true screen pixels (normalized coords are anisotropic),
      // measured after the mirror so + is "tilted right on screen".
      const dx = (cheekL.x - cheekR.x) * vw;
      const dy = (cheekR.y - cheekL.y) * vh;
      this.state.roll = Math.atan2(dy, dx);
      this.state.faceWidth = Math.hypot(cheekR.x - cheekL.x, cheekR.y - cheekL.y);
    }
    this.state.lastDetectAt = performance.now();

    // jawOpen blendshape → hysteresis → open/close edges.
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
    const now = performance.now();

    if (open && !wasOpen) {
      if (now - this.lastFireAt < this.config.minFireGapMs) return;
      this.state.mouthOpen = true;
      this.openedAt = now;
      this.state.openMs = 0;
      this.onMouthOpen?.();
    } else if (!open && wasOpen) {
      this.state.mouthOpen = false;
      this.lastFireAt = now;
      const held = now - this.openedAt;
      this.state.openMs = 0;
      this.onMouthClose?.(held);
    } else if (open) {
      this.state.openMs = now - this.openedAt;
    }
  }
}
