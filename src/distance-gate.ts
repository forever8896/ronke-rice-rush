// ═════════════════════════════════════════════════════════════
// Distance gate — makes sure the player's face (and therefore the
// mouth ROI the classifier crops) is inside the trained-model
// envelope before calibration measures their score distribution.
// Ported from Lick'em; strings inlined (English only).
//
// The detector reports face positions in CAMERA FRAME coords; the
// verdict bands below are fractions of camera frame width per tier.
// ═════════════════════════════════════════════════════════════

import type { TongueDetector, DeviceTier } from './detection';

const FACE_W_RANGE: Record<DeviceTier, { min: number; max: number }> = {
  desktop: { min: 0.18, max: 0.42 },
  high:    { min: 0.16, max: 0.62 },
  mid:     { min: 0.16, max: 0.62 },
  low:     { min: 0.14, max: 0.65 },
};

/** Visual "fit your face here" oval size, fraction of viewport width. */
const OVAL_VW: Record<DeviceTier, number> = {
  desktop: 0.30,
  high:    0.70,
  mid:     0.70,
  low:     0.70,
};

const HOLD_FRAMES = 12;
const READY_FALLBACK_MS = 4500;

export type DistanceVerdict = 'too-far' | 'too-close' | 'in-range';

export interface DistanceGateOptions {
  detector: TongueDetector;
  host: HTMLElement;
  tier: DeviceTier;
  /** Optional URL flag to skip the gate (e.g. ?skip-distance). */
  skip?: boolean;
}

const COPY: Record<DistanceVerdict, { title: string; sub: string }> = {
  'too-far':   { title: 'Come closer, monke', sub: 'Move your face into the oval' },
  'too-close': { title: 'Whoa — step back', sub: 'Your face fills too much of the frame' },
  'in-range':  { title: 'Perfect. Hold it…', sub: 'Ronke sees you' },
};

export function classifyDistance(faceWFracOfCam: number, tier: DeviceTier): DistanceVerdict {
  const r = FACE_W_RANGE[tier];
  if (!Number.isFinite(faceWFracOfCam) || faceWFracOfCam < r.min) return 'too-far';
  if (faceWFracOfCam > r.max) return 'too-close';
  return 'in-range';
}

export async function runDistanceGate(opts: DistanceGateOptions): Promise<void> {
  if (opts.skip) return;

  const overlay = document.createElement('div');
  overlay.className = 'distance-gate';
  overlay.dataset.verdict = 'too-far';
  overlay.dataset.tier = opts.tier;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-live', 'polite');
  overlay.style.setProperty('--target-w', `${Math.round(OVAL_VW[opts.tier] * 100)}vw`);
  overlay.innerHTML = `
    <div class="distance-gate-target" aria-hidden="true"></div>
    <div class="distance-gate-card">
      <div class="distance-gate-title" id="distance-gate-title">${COPY['too-far'].title}</div>
      <div class="distance-gate-sub" id="distance-gate-sub">${COPY['too-far'].sub}</div>
      <button class="distance-gate-ready" id="distance-gate-ready" type="button" style="display:none">I'm framed — go</button>
    </div>
  `;
  opts.host.appendChild(overlay);
  document.documentElement.setAttribute('data-distance-gate', '');

  const titleEl = overlay.querySelector('#distance-gate-title') as HTMLElement;
  const subEl = overlay.querySelector('#distance-gate-sub') as HTMLElement;
  const readyBtn = overlay.querySelector('#distance-gate-ready') as HTMLButtonElement;

  let inRangeFrames = 0;
  let lastVerdict: DistanceVerdict | null = null;
  let fallbackShown = false;
  const startedAt = performance.now();

  return new Promise<void>((resolve) => {
    const prevDebugCb = opts.detector.onDebugSample;
    const finish = (): void => {
      opts.detector.onDebugSample = prevDebugCb;
      overlay.remove();
      document.documentElement.removeAttribute('data-distance-gate');
      resolve();
    };
    readyBtn.addEventListener('click', finish, { once: true });

    opts.detector.onDebugSample = (s) => {
      prevDebugCb?.(s);
      const state = opts.detector.state;
      // Math.abs is load-bearing: faceLeftX/faceRightX are raw un-mirrored
      // MediaPipe coords whose signed difference is negative (see Lick'em
      // history — the gate never passed without it).
      const faceWFracOfCam = Math.abs(state.faceRightX - state.faceLeftX);
      const verdict = classifyDistance(faceWFracOfCam, opts.tier);

      if (verdict !== lastVerdict) {
        overlay.dataset.verdict = verdict;
        titleEl.textContent = COPY[verdict].title;
        subEl.textContent = COPY[verdict].sub;
        lastVerdict = verdict;
      }

      if (verdict === 'in-range') {
        inRangeFrames++;
        if (inRangeFrames >= HOLD_FRAMES) {
          finish();
          return;
        }
      } else {
        inRangeFrames = 0;
      }

      if (!fallbackShown && performance.now() - startedAt > READY_FALLBACK_MS) {
        fallbackShown = true;
        readyBtn.style.display = '';
      }
    };
  });
}
