// ═════════════════════════════════════════════════════════════
// Tongue detection — MediaPipe FaceLandmarker for landmarks +
// custom-trained MobileNetV2 binary classifier for tongue/no-tongue.
// On-device only. No frames leave the phone.
// ═════════════════════════════════════════════════════════════

import { FilesetResolver, FaceLandmarker, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import * as tf from '@tensorflow/tfjs';

// Self-hosted MediaPipe assets — copied from
// node_modules/@mediapipe/tasks-vision/wasm/ to public/mediapipe/wasm/
// and the face_landmarker.task downloaded from storage.googleapis.com
// to public/mediapipe/. The festival venue's wifi might block or
// throttle either of those CDNs; serving the same bytes from our own
// origin removes both as a single point of failure for camera mode.
const WASM_URL = '/mediapipe/wasm';
const MODEL_URL = '/mediapipe/face_landmarker.task';
const TONGUE_MODEL_URL = '/tongue-model/model.json';
const TONGUE_MODEL_DESKTOP_URL = '/tongue-model-desktop/model.json';
const TONGUE_INPUT_SIZE = 224;

/** Yield to the browser event loop so paint frames can interleave with our work. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Mouth landmark indices on MediaPipe's 478-point mesh.
const UPPER_LIP = 13;        // upper lip lower inner edge
const LOWER_LIP = 14;        // lower lip upper inner edge — for openness calc
const LOWER_LIP_OUTER = 17;  // lower lip BOTTOM outer (chin-side) — for ROI top
const LEFT_MOUTH = 78;
const RIGHT_MOUTH = 308;
// Face geometry indices — used by the king-mode crown overlay.
// Landmark indices in MediaPipe Face Mesh are FACE-RELATIVE: 234 is on
// the face's left ear (= viewer's RIGHT in a non-mirrored frame). After
// our selfie-mirror projection the screen-X order flips, so we name
// these by their final on-screen position (LEFT_ON_SCREEN = projected
// 454; RIGHT_ON_SCREEN = projected 234). With the names matching the
// projected positions, the atan2(roll) computation comes out as 0 for
// an upright head — earlier code had the labels reversed and the crown
// rotated 180° because of it.
const FOREHEAD_TOP = 10;
const FACE_LEFT_ON_SCREEN = 454;   // face's right ear (viewer's left after mirror)
const FACE_RIGHT_ON_SCREEN = 234;  // face's left ear (viewer's right after mirror)

export interface MouthState {
  detected: boolean;        // a face is present
  openness: number;         // 0..1 (vertical lip gap / mouth width)
  tongueOut: boolean;       // current frame heuristic
  // True when a fresh onTongue fire is possible. Goes false on each
  // fire (rising edge consumed) and back true after tongueOut flips
  // false and the release counter expires. Used by the game's catch-
  // ready ring colour so the player visually sees "ready to catch"
  // vs "already used this protrusion, retract to flick again."
  armed: boolean;
  tongueScore: number;      // raw blendshape score 0..1 (for tuning visibility)
  // Top blendshapes for live diagnostics — only populated under ?perf-style use
  topBlends: Array<{ name: string; score: number }>;
  // Mouth landmark positions in [0..1] (normalized video coords)
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  // Where the tongue TIP lands when stuck out — normalized video coords.
  // For the AR lick zone (strips should fall onto this point).
  tongueZoneX: number;
  tongueZoneY: number;
  // Last sampled ROI rectangles in normalized coords (for ?roi visualizer)
  roiA: { x: number; y: number; w: number; h: number } | null;
  roiB: { x: number; y: number; w: number; h: number } | null;
  // ── Face geometry for the king-mode crown overlay ──
  // All normalized [0..1] in video-frame coords.
  foreheadX: number;
  foreheadY: number;
  faceLeftX: number;
  faceLeftY: number;
  faceRightX: number;
  faceRightY: number;
  // Wall-clock ms of the last successful face detection, for fade-out
  // when the player turns away from the camera.
  lastDetectAt: number;
}

/** Per-classifier-tick sample emitted to debug subscribers. */
export interface DebugSample {
  /** Wall-clock ms since detector init() (NOT performance.now()). */
  t: number;
  /** jawOpen blendshape, 0..1. 0 if no face. */
  j: number;
  /** Raw classifier sigmoid output, 0..1. 0 if jaw gate skipped inference. */
  r: number;
  /** EMA-smoothed classifier output, 0..1. */
  e: number;
  /** Final tongueOut decision after asymmetric hysteresis. */
  o: boolean;
  /** Armed flag — true means a rising edge will fire onTongue on next true frame. */
  a: boolean;
  /** True on the exact tick onTongue was called (the rising edge). */
  f: boolean;
  /** Whether MediaPipe currently has a face lock. */
  d: boolean;
}

export interface DetectionConfig {
  // jawOpen blendshape gate — runs the classifier only when mouth is open
  // (tongue physically can't be out otherwise). Saves inference cost.
  minJawOpen: number;
  // Lower jawOpen threshold used WHILE tongue is currently registered.
  // Sticking the tongue out compresses the jaw-open blendshape so the
  // raw value can dip below the entry gate even when the tongue is still
  // out. Asymmetric gate keeps the classifier running through that dip.
  minJawOpenSustain: number;
  // Classifier sigmoid output threshold for the rising edge — needed to
  // FIRE a tongue-out event. Higher to keep false positives down.
  minTongueScore: number;
  // Lower threshold used to MAINTAIN tongueOut once it's set. Wide
  // hysteresis band prevents single-frame dips from cycling Hold mode.
  minTongueScoreSustain: number;
  triggerHoldFrames: number;
  releaseFrames: number;
  /** Min ms between MediaPipe FaceLandmarker inferences (heavy, ~30ms each) */
  minDetectIntervalMs: number;
  /** Min ms between classifier inferences (lighter, ~5-10ms each) */
  minClassifyIntervalMs: number;
  /** EMA factor for smoothing classifier output (0..1, higher = more smoothing) */
  scoreSmoothing: number;
  /** Camera resolution constraints. Lowered on weak devices to stop throttling. */
  videoWidth: { ideal: number; max: number };
  videoHeight: { ideal: number; max: number };
  videoFrameRate: { ideal: number; max: number };
}

const DEFAULT_CONFIG: DetectionConfig = {
  // Entry gate. Dropped 0.14 → 0.05 — quick-flick licks (tongue darting
  // between barely-parted lips) often only push jawOpen to ~0.06–0.10,
  // never crossing the old 0.14 gate, so the classifier didn't run at
  // all and the dart was invisible to the system. 0.05 essentially
  // means "mouth not actively clenched"; a fully closed mouth still
  // sits at jawOpen ~0.01–0.03 so we still skip the cost path on
  // closed-mouth frames.
  minJawOpen: 0.05,
  // Sustain gate matches — quick tongue flicks barely separate the
  // lips, so we shouldn't drop tongueOut just because the jaw didn't
  // open all the way.
  minJawOpenSustain: 0.04,
  // Rising-edge threshold. Trained classifier outputs ~0.25 on quick
  // partial tongues (training data was mostly sustained extensions).
  // 0.28 catches them; neutral closed mouth still sits well below
  // 0.18 so the false-positive band stays usable. Combined with the
  // lowered jaw gate above, quick flicks now have a path through
  // both gates that they previously couldn't clear.
  minTongueScore: 0.28,
  // Sustain threshold drops to keep the hysteresis delta consistent.
  minTongueScoreSustain: 0.18,
  triggerHoldFrames: 1,
  // Re-arm after just 1 negative classifier frame (~60ms at the new
  // cadence) instead of 2 (~120ms). Letting rapid flick-flick patterns
  // fire on every flick was the second-most-common miss complaint —
  // players were retracting between licks but not for the full 120ms
  // window. Single-frame noise risk is acceptable; the rising-edge
  // gate uses raw classifier score and the jaw-open prereq.
  releaseFrames: 1,
  // Falling-edge default = 2 frames. Single-frame classifier dips
  // MediaPipe FaceLandmarker (~30ms on capable phones). 15Hz so the lick
  // zone tracks fast head turns without trailing. Weak-device override
  // below drops to ~10Hz.
  minDetectIntervalMs: 66,
  // Classifier (~5-10ms on WebGL). 17Hz default — was 12Hz, but the
  // worst-case "wait for next classifier tick" was the second-biggest
  // contributor to perceived input latency after the EMA-on-rising-
  // edge bug. Tighter cadence costs ~6ms more CPU per second on a
  // capable phone (negligible). Weak devices stay at slower cadence.
  minClassifyIntervalMs: 60,
  // EMA factor — 0.55 means ~half the new score, half the previous EMA.
  // Smooths single-frame dips without adding visible latency.
  scoreSmoothing: 0.55,
  // Default to 640×480 ideal — recovers detection accuracy at angle.
  // Browsers downgrade gracefully, but we explicitly downgrade on weak
  // devices via the tier system so the camera pipeline doesn't have to
  // burn cycles encoding a higher resolution it'll then throttle out of.
  videoWidth: { ideal: 640, max: 1280 },
  videoHeight: { ideal: 480, max: 720 },
  videoFrameRate: { ideal: 30, max: 30 },
};

// ── Device tiering ──
// Picks a camera resolution + detection cadence per device class. The
// goal is to keep the inference loop comfortable so the camera pipeline
// doesn't throttle (which then knocks the whole feature offline on
// weaker phones). 'low' loses some pixel density but the classifier is
// trained at 224×224 anyway — 320×240 source still yields a usable crop.
export type DeviceTier = 'low' | 'mid' | 'high' | 'desktop';

export function detectDeviceTier(): DeviceTier {
  // URL override — ?perf=low|mid|high|desktop — used by QA on a known
  // device to simulate what other tiers feel like. Bypasses heuristics.
  if (typeof location !== 'undefined') {
    const m = location.search.match(/[?&]perf=(low|mid|high|desktop)/);
    if (m) return m[1] as DeviceTier;
  }
  if (typeof navigator === 'undefined') return 'mid';
  const cores = navigator.hardwareConcurrency || 4;
  // deviceMemory is undefined on iOS; treat as "missing" not "low".
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const ua = navigator.userAgent || '';
  // Older Android devices identify with "Android 9", "Android 10" — these
  // are typically the throttling-prone class. Modern flagships report
  // hardwareConcurrency=8 anyway so we don't accidentally cap them.
  const oldAndroid = /Android\s*([0-9]+)/.exec(ua);
  const androidMajor = oldAndroid ? parseInt(oldAndroid[1], 10) : 99;

  // Desktop detection — no touch input + fine pointer + not an Android/iOS
  // UA. Desktop webcams typically sit further from the face than a phone
  // front-cam, so the mouth ROI ends up tiny in the frame. We treat
  // desktop as its own tier so we can request a much higher capture
  // resolution (1280×720) and keep the lip crop usable for the
  // classifier even when the face only fills ~20% of the frame.
  const isMobileUa = /Android|iPhone|iPad|iPod/.test(ua);
  const fineCursor =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: fine)').matches
      : false;
  const noTouch =
    typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) === 0;
  if (!isMobileUa && fineCursor && noTouch) return 'desktop';

  // Low tier triggers: very low core count OR low memory OR old Android.
  if (cores <= 4) return 'low';
  if (typeof mem === 'number' && mem <= 2) return 'low';
  if (androidMajor <= 9) return 'low';
  // Mid tier: 6 cores or 4GB memory phones — common Android mid-range.
  if (cores <= 6) return 'mid';
  if (typeof mem === 'number' && mem <= 4) return 'mid';
  return 'high';
}

/** Per-tier overrides applied on top of DEFAULT_CONFIG. */
export function configForTier(tier: DeviceTier): Partial<DetectionConfig> {
  switch (tier) {
    case 'low':
      return {
        // Drop camera resolution — 320×240 is well within the budget of
        // any phone that runs WebGL TFJS at all, and stops the camera
        // pipeline from being the throttling bottleneck.
        videoWidth: { ideal: 320, max: 480 },
        videoHeight: { ideal: 240, max: 360 },
        videoFrameRate: { ideal: 24, max: 24 },
        // ~8Hz landmarks, ~7Hz classifier. Still plenty for "is tongue out".
        minDetectIntervalMs: 120,
        minClassifyIntervalMs: 140,
      };
    case 'mid':
      return {
        videoWidth: { ideal: 480, max: 640 },
        videoHeight: { ideal: 360, max: 480 },
        videoFrameRate: { ideal: 30, max: 30 },
        minDetectIntervalMs: 90,
        minClassifyIntervalMs: 110,
      };
    case 'desktop':
      // Desktop webcams: face is small in frame (user sits further back
      // than a phone selfie). Push the capture up to 1280×720 so the
      // mouth ROI — typically ~10–15% of frame width — still hits
      // ~130–190 px wide before the 224× resize.
      //
      // A desktop-specific classifier (/tongue-model-desktop/) is
      // loaded for this tier — see init(). It's trained on actual
      // desktop-webcam captures so its outputs snap to 0/1 the same
      // way the mobile model does, but desktop debug captures showed
      // the EMA dipping briefly during steady holds (4s of held tongue
      // registered ~78% sustained, not 100%). To stop Hold mode from
      // stuttering on those dips we drop the sustain threshold to 0.10
      // (well above the mouth-open-no-tongue floor of ~0.02 the model
      // produces) and require 4 consecutive negative frames before
      // flipping tongueOut false — that's ~130ms of grace at the
      // faster desktop cadence. Quick Strip-mode retractions are still
      // detected because the rising edge uses raw, not EMA.
      return {
        videoWidth: { ideal: 1280, max: 1920 },
        videoHeight: { ideal: 720, max: 1080 },
        videoFrameRate: { ideal: 30, max: 30 },
        minDetectIntervalMs: 40,
        minClassifyIntervalMs: 33,
        minTongueScoreSustain: 0.10,
      };
    case 'high':
    default:
      return {};
  }
}

export class TongueDetector {
  private landmarker: FaceLandmarker | null = null;
  private classifier: tf.GraphModel | null = null;
  private classifierInput: HTMLCanvasElement;  // 224x224 crop fed to classifier
  private classifierCtx: CanvasRenderingContext2D;
  private video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private offscreen: HTMLCanvasElement;
  private running = false;
  private rafId = 0;
  private lastVideoTime = -1;
  private lastInferAt = 0;
  private lastClassifyAt = 0;
  // z is included so we can compute rotation-invariant 3D distances
  // between landmarks — yaw shrinks the 2D X-distance but the true 3D
  // distance is preserved.
  private cachedLm: { x: number; y: number; z?: number }[] | null = null;
  private cachedJawOpen = 0;

  private config: DetectionConfig;
  private holdCount = 0;
  private releaseCount = 0;
  // performance.now() of the last onTongue fire. Used as a hard min-
  // gap floor (250ms) so a noisy classifier or twitchy jaw during a
  // sustained protrusion can't re-fire onTongue mid-hold. Strip-mode
  // game.lick() runs unconditionally on onTongue, so this is the only
  // gate that survives all the upstream hysteresis edge cases.
  private lastFireAt = 0;
  private armed = true; // can fire when true
  // EMA of classifier output — smooths single-frame dips so Hold mode
  // doesn't bounce between true/false on borderline tongue positions.
  private smoothedTongueScore = 0;
  // Tracks jawOpen from the previous landmark inference so we can fire
  // the classifier IMMEDIATELY when jaw opens (event-driven), not wait
  // for the next cadence tick. Most-common miss mode: tongue lands in
  // the same ~50ms window as the mouth-open transition, but classifier
  // hadn't run yet because cadence wasn't due.
  private prevJawOpen = 0;
  // Reference timestamp for DebugSample.t — performance.now() at detector
  // init. Lets the debug capture page emit timestamps relative to a stable
  // origin, surviving navigations or tab switches.
  private debugTimeOrigin = 0;

  state: MouthState = {
    detected: false,
    openness: 0,
    tongueOut: false,
    armed: true,
    tongueScore: 0,
    topBlends: [],
    centerX: 0.5,
    centerY: 0.5,
    width: 0.2,
    height: 0.1,
    tongueZoneX: 0.5,
    tongueZoneY: 0.5,
    roiA: null,
    roiB: null,
    foreheadX: 0.5,
    foreheadY: 0.3,
    faceLeftX: 0.4,
    faceLeftY: 0.5,
    faceRightX: 0.6,
    faceRightY: 0.5,
    lastDetectAt: 0,
  };


  // Listeners
  onTongue: (() => void) | null = null;
  onError: ((msg: string) => void) | null = null;
  /**
   * Fires once per classifier tick with the raw decision inputs. Off by
   * default (production code leaves this null); the debug capture page
   * subscribes to record per-tick frame data for offline analysis.
   * `fired` is true on the same tick onTongue was called.
   */
  onDebugSample: ((s: DebugSample) => void) | null = null;

  constructor(video: HTMLVideoElement, config: Partial<DetectionConfig> = {}) {
    this.video = video;
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.offscreen = document.createElement('canvas');
    this.offscreen.width = 32;
    this.offscreen.height = 16;
    void this.offscreen; // kept for backward compat with older state references
    this.classifierInput = document.createElement('canvas');
    this.classifierInput.width = TONGUE_INPUT_SIZE;
    this.classifierInput.height = TONGUE_INPUT_SIZE;
    const cx = this.classifierInput.getContext('2d', { willReadFrequently: true });
    if (!cx) throw new Error('classifier canvas 2d unsupported');
    this.classifierCtx = cx;
  }

  async init(): Promise<void> {
    this.debugTimeOrigin = performance.now();
    // Force WebGL backend FIRST — TFJS sometimes defaults to CPU on weak
    // Android browsers which is 10x slower for our classifier.
    try {
      await tf.setBackend('webgl');
      await tf.ready();
    } catch (e) {
      console.warn('[detection] WebGL backend unavailable, falling back to CPU', e);
    }
    console.log(`[detection] TF backend: ${tf.getBackend()}`);

    // FaceLandmarker is REQUIRED — fail init if it doesn't load.
    // Classifier is optional — if it fails to load, fall back to a simple
    // jawOpen-based detector so camera mode still works.
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    // Confidence thresholds were 0.5 across the board (MediaPipe defaults).
    // Team feedback: detection drops near edges when head is turned. At
    // those moments MP correctly reports lower confidence (~0.4) and the
    // 0.5 gate kills the track even though there's still enough info to
    // follow the face. 0.35 keeps the track alive through head turns and
    // partial occlusion without bringing in noisy phantom faces (which
    // would have to clear the same 0.35 gate to spawn). Marginal cost.
    const baseOpts = {
      runningMode: 'VIDEO' as const,
      numFaces: 1,
      minFaceDetectionConfidence: 0.35,
      minFacePresenceConfidence: 0.35,
      minTrackingConfidence: 0.35,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: false,
    };
    this.landmarker = await this.initLandmarker(fileset, baseOpts);
    console.log('[detection] FaceLandmarker ready');

    // Load classifier in background — non-fatal if it fails.
    // GraphModel format (vs LayersModel) for Keras 3 compatibility.
    //
    // Desktop tier prefers /tongue-model-desktop/ — a model trained on
    // desktop-webcam-framed crops, where the mouth-interior visibility
    // pattern is different enough that the mobile-trained model can't
    // distinguish protruded tongue from resting tongue. If the desktop
    // model isn't shipped (or 404s in dev), we silently fall through to
    // the mobile model rather than disabling the classifier entirely.
    const desktopTier = detectDeviceTier() === 'desktop';
    try {
      if (desktopTier) {
        try {
          this.classifier = await tf.loadGraphModel(TONGUE_MODEL_DESKTOP_URL);
          console.log('[detection] Loaded desktop classifier');
        } catch (desktopErr) {
          // Log the real reason. We previously swallowed this and called it
          // "missing", which masked a format mismatch (the converter had
          // emitted layers-model when loadGraphModel only accepts graph-model)
          // for several training rounds.
          console.warn(
            '[detection] Desktop classifier load failed — falling back to mobile model',
            desktopErr,
          );
          this.classifier = await tf.loadGraphModel(TONGUE_MODEL_URL);
        }
      } else {
        this.classifier = await tf.loadGraphModel(TONGUE_MODEL_URL);
      }
      // Warm up to avoid first-frame lag
      const warm = tf.zeros([1, TONGUE_INPUT_SIZE, TONGUE_INPUT_SIZE, 3]);
      const out = (await this.classifier.executeAsync(warm)) as tf.Tensor;
      await out.data();
      warm.dispose();
      out.dispose();
      console.log(`[detection] Classifier ready (backend: ${tf.getBackend()})`);
    } catch (e) {
      console.warn('[detection] Classifier load failed — falling back to jawOpen-only detection', e);
      this.classifier = null;
    }
  }

  private async initLandmarker(
    fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>,
    baseOpts: object,
  ): Promise<FaceLandmarker> {
    try {
      return await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        ...baseOpts,
      });
    } catch (gpuErr) {
      console.warn('FaceLandmarker GPU init failed, falling back to CPU', gpuErr);
      return await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
        ...baseOpts,
      });
    }
  }

  async startCamera(): Promise<void> {
    // Resolution + framerate come from the device-tier override merged
    // into DetectionConfig. Browsers downgrade gracefully on top of
    // these constraints, but lowering "ideal" up-front prevents weak
    // devices from spending real cycles encoding a frame size they'd
    // then throttle out of.
    const constraints: MediaStreamConstraints = {
      audio: false,
      video: {
        facingMode: 'user',
        width: this.config.videoWidth,
        height: this.config.videoHeight,
        frameRate: this.config.videoFrameRate,
      },
    };
    // Hard timeout against camera-startup hangs. Seen in the wild:
    //   - On refresh with permission already granted, some browsers
    //     stall returning the stream when another tab still holds the
    //     device (no error, no resolve, just nothing).
    //   - video.play() can hang silently if the autoplay policy
    //     transiently rejects (esp. mobile Safari after a fresh page).
    // 12s is generous for a slow camera bring-up but short enough that
    // the UI can give the player an actionable error instead of an
    // eternal "Requesting camera…" spinner.
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
    void this.tick();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  /** Resolved DetectionConfig (defaults + tier overrides + caller overrides). */
  getConfig(): Readonly<DetectionConfig> {
    return this.config;
  }

  /** Resolved video track settings, once startCamera() has populated them. */
  getVideoTrackSettings(): MediaTrackSettings | null {
    if (!this.stream) return null;
    const tracks = this.stream.getVideoTracks();
    return tracks.length > 0 ? tracks[0].getSettings() : null;
  }

  /** Tune the fire threshold at runtime (used by per-user calibration). */
  setMinTongueScore(value: number): void {
    this.config.minTongueScore = Math.max(0.05, Math.min(0.95, value));
  }

  getMinTongueScore(): number {
    return this.config.minTongueScore;
  }

  /** Sustain threshold — the EMA value above which tongueOut stays
   *  asserted once raised. Set alongside minTongueScore by the
   *  calibration controller. */
  setMinTongueScoreSustain(value: number): void {
    this.config.minTongueScoreSustain = Math.max(0.03, Math.min(0.90, value));
  }

  /** Atomic override of both fire + sustain thresholds. Used by the
   *  per-user calibration controller so the asymmetric hysteresis
   *  delta stays internally consistent. */
  setPersonalThresholds(fire: number, sustain: number): void {
    this.setMinTongueScore(fire);
    this.setMinTongueScoreSustain(sustain);
  }

  setPerformanceLevel(_level: number): void {
    // Tracking responsiveness is gameplay-critical, so adaptive performance
    // levels intentionally do not slow detector cadence. Load shedding stays
    // in visual effects and overlay rendering instead.
  }

  /**
   * Detection scheduler — decoupled from RAF.
   * Two independent cadences:
   *   1. MediaPipe FaceLandmarker — slow (~30ms), starts around 10 Hz.
   *      Updates landmarks, jawOpen, ROI, and tongue zone.
   *   2. Classifier — light (~5-10ms), runs every 80ms (12 Hz) on the cached
   *      ROI from the most recent landmark inference.
   *
   * Using setTimeout (not RAF) means inference doesn't block paint frames —
   * the browser interleaves render at 60fps with our work.
   */
  private tick = async (): Promise<void> => {
    if (!this.running || !this.landmarker) return;

    const now = performance.now();
    const needLandmarks = now - this.lastInferAt >= this.config.minDetectIntervalMs;
    const videoReady = this.video.readyState >= 2;
    let landmarksRefreshed = false;

    if (videoReady && needLandmarks && this.video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = this.video.currentTime;
      this.lastInferAt = now;
      try {
        const result = this.landmarker.detectForVideo(this.video, now);
        this.processLandmarks(result);
        landmarksRefreshed = true;
      } catch (e) {
        console.warn('detection landmark tick error', e);
      }
      // Yield to event loop so render/paint can happen before classifier runs
      await yieldToEventLoop();
    }

    // Eager-classify trigger: jaw-open just transitioned true on this
    // landmark frame AND tongue isn't already registered. The player is
    // very likely starting a tongue extension right now — bypass the
    // classifier cadence gate and run inference on this exact frame so
    // the rising edge gets caught with minimum latency.
    const jawJustOpened =
      landmarksRefreshed &&
      this.prevJawOpen < this.config.minJawOpen &&
      this.cachedJawOpen >= this.config.minJawOpen &&
      !this.state.tongueOut;
    const needClassify = jawJustOpened
      || now - this.lastClassifyAt >= this.config.minClassifyIntervalMs;

    if (videoReady && needClassify && this.cachedLm) {
      this.lastClassifyAt = now;
      try {
        this.runClassifierAndFire();
      } catch (e) {
        console.warn('detection classify tick error', e);
      }
    }
    if (landmarksRefreshed) {
      this.prevJawOpen = this.cachedJawOpen;
    }

    // Re-schedule via setTimeout (not RAF) so detection is independent of paint frames
    setTimeout(this.tick, 8);
  };

  /** Light path — landmarks, jawOpen, ROI, tongue zone. Updates cached state. */
  private processLandmarks(result: FaceLandmarkerResult): void {
    const faces = result.faceLandmarks;
    if (!faces || faces.length === 0) {
      // Hysteresis: a single dropped MP frame at edges or under sharp
      // head turns is the rule, not the exception. Blanking detected=
      // false on the very first miss makes the lick zone disappear,
      // the king crown flicker, and the ROI cache reset — even though
      // the face is still right there and the next frame recovers it.
      // Hold the last-known state for ~250ms before declaring detection
      // lost so single-frame dropouts read as smooth tracking instead
      // of a jitter. lastDetectAt is already maintained on the success
      // path; we just reuse it here.
      const now = performance.now();
      const sinceLastSeen = now - this.state.lastDetectAt;
      if (sinceLastSeen > 250 || this.state.lastDetectAt === 0) {
        this.state.detected = false;
        this.cachedLm = null;
        this.cachedJawOpen = 0;
        this.state.tongueOut = false;
        this.holdCount = 0;
      }
      this.releaseCount++;
      if (this.releaseCount >= this.config.releaseFrames) {
        this.armed = true;
        this.state.armed = true;
      }
      return;
    }

    const lm = faces[0];
    this.cachedLm = lm;

    const upper = lm[UPPER_LIP];
    const lower = lm[LOWER_LIP];
    const left = lm[LEFT_MOUTH];
    const right = lm[RIGHT_MOUTH];

    const mouthWidth = Math.hypot(right.x - left.x, right.y - left.y);
    const mouthHeight = Math.hypot(lower.x - upper.x, lower.y - upper.y);
    const openness = mouthWidth > 0 ? mouthHeight / mouthWidth : 0;

    const cx = (left.x + right.x) / 2;
    const cy = (upper.y + lower.y) / 2;

    this.state.detected = true;
    this.state.openness = openness;
    this.state.centerX = cx;
    this.state.centerY = cy;
    this.state.width = mouthWidth;
    this.state.height = mouthHeight;

    // Face geometry — single-landmark forehead anchor + face-edge points
    // for the king crown overlay. Cheap to read; only a few extra indices.
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

    const lipBottom = lm[LOWER_LIP_OUTER] || lower;
    this.state.tongueZoneX = cx;
    this.state.tongueZoneY = lipBottom.y + mouthWidth * 0.10;

    // jawOpen blendshape — used as gate to skip classifier when mouth closed
    let jawOpen = 0;
    const blendshapes = result.faceBlendshapes;
    if (blendshapes && blendshapes.length > 0) {
      const cats = blendshapes[0].categories;
      for (const cat of cats) {
        if (cat.categoryName === 'jawOpen') {
          jawOpen = cat.score;
          break;
        }
      }
    }
    this.cachedJawOpen = jawOpen;

    // Cache ROI for the visualizer + the next classifier call
    this.computeRoi(lm);
  }

  /** Heavy path — runs the classifier on the cached ROI and fires onTongue. */
  private runClassifierAndFire(): void {
    if (!this.cachedLm) return;
    const jawOpen = this.cachedJawOpen;

    // Asymmetric jaw gate: once the tongue is currently registered, accept
    // a smaller jawOpen before skipping the classifier. Tongue protrusion
    // physically reduces the jaw-open blendshape — without this, tongueOut
    // bounces false the moment the tongue is at full extension.
    const wasOut = this.state.tongueOut;
    const jawGate = wasOut ? this.config.minJawOpenSustain : this.config.minJawOpen;

    let rawScore = 0;
    if (jawOpen >= jawGate) {
      if (this.classifier) {
        // crop is fast; classifier is the heavier part
        this.cropLipRegion(this.cachedLm);
        rawScore = this.classifyTongue();
      } else {
        rawScore = jawOpen;
      }
    }

    // EMA-smoothed score is maintained for the SUSTAIN gate only. The
    // rising edge uses RAW score so a player's tongue-flick fires on the
    // very first positive classifier frame instead of waiting for the
    // EMA to catch up. Previously the EMA was on both gates, which added
    // ~80ms of latency on every lick (raw 0.8 EMA'd down to 0.36 below
    // the 0.42 threshold, fired only on the next classifier tick).
    const a = this.config.scoreSmoothing;
    this.smoothedTongueScore = a * this.smoothedTongueScore + (1 - a) * rawScore;
    const smoothed = this.smoothedTongueScore;

    this.state.tongueScore = wasOut ? smoothed : rawScore;
    this.state.topBlends = [
      { name: 'jaw', score: jawOpen },
      { name: 'raw', score: rawScore },
      { name: 'ema', score: smoothed },
    ];

    // Asymmetric hysteresis on classifier confidence:
    //   • Rising edge — RAW score against the strict 0.42 threshold,
    //     so a fast tongue-flick fires on its first positive frame.
    //   • Sustain     — SMOOTHED score against the 0.32 sustain
    //     threshold, so a single-frame classifier dip doesn't drop
    //     tongueOut mid-Hold.
    const scoreGate = wasOut ? this.config.minTongueScoreSustain : this.config.minTongueScore;
    const referenceScore = wasOut ? smoothed : rawScore;
    const heuristic = jawOpen >= jawGate && referenceScore >= scoreGate;

    // Direct mapping: heuristic IS tongueOut. No hysteresis, no jaw-
    // close override — they added visual lag that made strip mode feel
    // unresponsive. The 250ms min-fire-gap below is the single safety
    // net for noise-driven re-fires; it doesn't affect the ring colour.
    this.state.tongueOut = heuristic;

    let firedThisTick = false;
    if (heuristic) {
      this.holdCount++;
      this.releaseCount = 0;
      // Min-fire-gap of 250ms: even if everything else (armed, hysteresis,
      // jaw override) conspires to re-arm during a held protrusion, the
      // onTongue callback can't physically fire again until 250ms have
      // passed since the last fire. Strip-mode game.lick() runs every
      // time onTongue fires, so without this floor a sustained hold with
      // any classifier noise was getting interpreted as multiple flicks.
      // 250ms is well below the ~330ms cadence of late-game strip spawn
      // so legitimate fast flicks still register.
      const now = performance.now();
      const minGapOk = now - this.lastFireAt >= 250;
      if (this.armed && this.holdCount >= this.config.triggerHoldFrames && minGapOk) {
        this.armed = false;
        this.state.armed = false;
        firedThisTick = true;
        this.lastFireAt = now;
        this.onTongue?.();
      }
    } else {
      this.holdCount = 0;
      this.releaseCount++;
      // Re-arm only after the falling-edge hysteresis has flipped
      // state.tongueOut FALSE. Otherwise a single classifier blip
      // during a sustained protrusion (heuristic true → false → true
      // over 2 ticks) re-armed and re-fired onTongue, which then
      // called lick() and caught another strip — so a continuous hold
      // in Strip mode was scoring multiple strips per actual flick.
      // Locking armed to the same gate that drives tongueOut means
      // one fire per real protrusion cycle, no matter how noisy the
      // classifier gets in the middle.
      if (this.releaseCount >= this.config.releaseFrames && !this.state.tongueOut) {
        this.armed = true;
        this.state.armed = true;
      }
    }

    // Debug emit — production code leaves onDebugSample null so this is
    // a single null-check per classifier tick (~17Hz) when off.
    if (this.onDebugSample) {
      this.onDebugSample({
        t: Math.round(performance.now() - this.debugTimeOrigin),
        j: jawOpen,
        r: rawScore,
        e: smoothed,
        o: heuristic,
        a: this.armed,
        f: firedThisTick,
        d: this.state.detected,
      });
    }
  }

  /**
   * Sample TWO ROIs and return per-pixel "tongue-pink fraction" for each.
   *
   * Critical insight: the resting tongue is always visible inside the mouth
   * opening when mouth is open, so sampling there can't distinguish "tongue
   * out" from "mouth open." The DIFFERENCE happens BELOW the lip outer edge:
   *   - Mouth open, no tongue: below-lip area = chin skin (low pink)
   *   - Tongue protruded: below-lip area = tongue surface (high pink)
   *
   * Offsets use mouthH (mouth opening height) so they scale naturally with
   * how open the mouth is — when mouth opens wider, offsets get bigger,
   * keeping the ROI just below the lip in proportion.
   */
  /**
   * Compute the lip-region ROI matching public/record.html (the same crop
   * the classifier was trained on) and store it on state.roiA for the
   * visualizer + zone tracking.
   *
   * Uses 3D Euclidean distance between mouth corners (x, y, AND z) so
   * head rotation doesn't pathologically shrink the ROI. The 2D X-diff
   * goes to ~0 (or even negative) at high yaw, while the 3D distance
   * stays roughly constant — that fixes the "had to face the camera
   * head-on for it to detect" complaint.
   */
  private computeRoi(lm: { x: number; y: number; z?: number }[]): void {
    const upper = lm[UPPER_LIP];
    const lower = lm[LOWER_LIP];
    const lipBottom = lm[LOWER_LIP_OUTER] || lower;
    const left = lm[LEFT_MOUTH];
    const right = lm[RIGHT_MOUTH];

    // 3D distance — survives yaw/pitch/roll. If z is missing on some
    // older runtime, defaults to 0 and the math degrades to 2D Euclidean
    // (still better than the raw X-diff we used before).
    const dx = right.x - left.x;
    const dy = right.y - left.y;
    const dz = (right.z ?? 0) - (left.z ?? 0);
    const mouthW = Math.hypot(dx, dy, dz);

    // 2D centre stays as projected — that's where we need to crop in
    // the actual image.
    const cx = (left.x + right.x) / 2;

    // Crop MUST match what record.html used at training time, otherwise
    // the lip occupies a different fraction of the 224×224 input than the
    // classifier ever saw and confidence collapses (desktop debug capture
    // showed raw scores stuck around 0.002 on a clearly held-out tongue
    // because we'd drifted to a 35% wider crop than training).
    // Training values: 0.85× mouthW, 0.06 floor, vertical pad 0.05/0.40.
    const roiW = Math.max(mouthW * 0.85, 0.06);
    const roiLeft = cx - roiW / 2;
    const aTop = upper.y - mouthW * 0.05;
    const aHeight = (lipBottom.y - upper.y) + mouthW * 0.40;
    this.state.roiA = { x: roiLeft, y: aTop, w: roiW, h: aHeight };
    this.state.roiB = null;
  }

  /**
   * Crop the lip ROI from the video into a 224x224 padded square canvas,
   * matching the same preprocessing public/record.html applied at training.
   * Pads to square first so aspect ratio is preserved (no stretching).
   * Assumes computeRoi() has already been called and set state.roiA.
   */
  private cropLipRegion(_lm: { x: number; y: number }[]): boolean {
    const roi = this.state.roiA;
    if (!roi) return false;
    const sw = this.video.videoWidth;
    const sh = this.video.videoHeight;
    if (sw === 0 || sh === 0) return false;
    const sx = Math.max(0, Math.floor(roi.x * sw));
    const sy = Math.max(0, Math.floor(roi.y * sh));
    const cw = Math.min(sw - sx, Math.floor(roi.w * sw));
    const ch = Math.min(sh - sy, Math.floor(roi.h * sh));
    if (cw < 16 || ch < 16) return false;
    const side = Math.max(cw, ch);
    const scale = TONGUE_INPUT_SIZE / side;
    const xo = (side - cw) / 2;
    const yo = (side - ch) / 2;
    this.classifierCtx.fillStyle = '#000';
    this.classifierCtx.fillRect(0, 0, TONGUE_INPUT_SIZE, TONGUE_INPUT_SIZE);
    this.classifierCtx.drawImage(
      this.video,
      sx, sy, cw, ch,
      xo * scale, yo * scale, cw * scale, ch * scale,
    );
    return true;
  }

  /** Run the trained classifier on the cropped lip region. Returns 0..1.
   *  GraphModel.execute (sync) is fine for sub-graphs without async ops like ours. */
  private classifyTongue(): number {
    if (!this.classifier) return 0;
    return tf.tidy(() => {
      // MobileNetV2 preprocess: scale to [-1, 1]
      const img = tf.browser.fromPixels(this.classifierInput);
      const norm = img.toFloat().div(127.5).sub(1).expandDims(0);
      const out = this.classifier!.execute(norm) as tf.Tensor;
      const score = out.dataSync()[0];
      return score;
    });
  }
}
