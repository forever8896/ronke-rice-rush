// ═════════════════════════════════════════════════════════════
// Anti-bot clip recorder — ranked voyages only.
//
// A bot can produce valid inputs; it can't produce a real jaw that
// opens and shuts on those inputs, or a head whose measured lean and
// tilt line up with the steering and aim the server scored. So a
// ranked voyage records two things alongside the input log:
//
//   • a small video of the MOUTH AND JAW only — cropped around the lips
//     and chin from the face tracker's own geometry, so the eyes and
//     upper face are never in frame. Not a recognisable portrait.
//   • a head track: the tracker's head position, tilt and jaw opening,
//     10 times a second, plus the calibration centre — numbers, no
//     pixels — which the review page turns back into steer and aim with
//     the game's own formula and plots against the scored inputs.
//
// It lives in memory on this device and is thrown away unless the run
// becomes the player's best of the week near the top of the board.
// Each frame carries the sim step it was taken at, and `sync` keeps the
// same pairing as data, so the review lines video, track and replay up.
// ═════════════════════════════════════════════════════════════

import type { FaceState } from './detection';

const W = 192;
const H = 144;
const FPS = 10;
const BITRATE = 45_000;
/** One sync sample per this many ms of video. */
const SYNC_EVERY_MS = 250;
/** Crop width as a fraction of the face width: lips plus cheeks, no eyes. */
const CROP_FACE_W = 0.62;
/** Shift the crop down from the lip centre, as a fraction of face width, to take in the chin. */
const CROP_DROP = 0.1;

export interface FaceClip {
  blob: Blob;
  contentType: string;
  /** [ms into the video, sim step] pairs. */
  sync: Array<[number, number]>;
  /** [ms, headX×1000, roll×1000 (mrad), jawOpen×1000], or [ms, -1, 0, 0] with no face. */
  pose: Array<[number, number, number, number]>;
  /** The calibration centre the controls were measured from. */
  calib: { headX: number; roll: number };
}

function pickType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of ['video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4']) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return null;
}

export class FaceClipRecorder {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d');
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private video: HTMLVideoElement | null = null;
  private face: (() => FaceState | null) | null = null;
  private calib = { headX: 0.5, roll: 0 };
  private startedAt = 0;
  private lastDraw = 0;
  private lastSync = -Infinity;
  private sync: Array<[number, number]> = [];
  private pose: Array<[number, number, number, number]> = [];
  private type = '';

  constructor() {
    this.canvas.width = W;
    this.canvas.height = H;
  }

  /** Whether this browser can record at all. */
  static supported(): boolean {
    return pickType() !== null && typeof HTMLCanvasElement.prototype.captureStream === 'function';
  }

  get recording(): boolean {
    return !!this.rec && this.rec.state === 'recording';
  }

  start(video: HTMLVideoElement, face: () => FaceState | null, calib: { headX: number; roll: number }): boolean {
    this.discard();
    const type = pickType();
    if (!type || !this.ctx || !video.videoWidth) return false;
    this.type = type;
    this.video = video;
    this.face = face;
    this.calib = { ...calib };
    this.chunks = [];
    this.sync = [];
    this.pose = [];
    this.lastSync = -Infinity;
    const stream = this.canvas.captureStream(FPS);
    this.rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: BITRATE });
    this.rec.ondataavailable = (e): void => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.rec.start(1000);
    this.startedAt = performance.now();
    this.lastDraw = 0;
    return true;
  }

  /** Called every animation frame with the sim step on screen. */
  frame(step: number, now: number): void {
    if (!this.recording || !this.ctx || !this.video) return;
    if (now - this.lastDraw < 1000 / FPS) return;
    this.lastDraw = now;
    const t = Math.round(now - this.startedAt);
    const c = this.ctx;
    const f = this.face?.() ?? null;
    const fresh = !!f && f.detected && now - f.lastDetectAt < 400;

    if (fresh && f) {
      this.drawMouth(c, this.video, f);
      this.pose.push([t, Math.round(f.headX * 1000), Math.round(f.roll * 1000), Math.round(f.jawOpen * 1000)]);
    } else {
      // No face in view: say so on the frame itself, and in the track.
      c.fillStyle = '#0b1220';
      c.fillRect(0, 0, W, H);
      c.fillStyle = '#ff8f80';
      c.font = '12px monospace';
      c.fillText('no face', W / 2 - 24, H / 2);
      this.pose.push([t, -1, 0, 0]);
    }
    c.fillStyle = 'rgba(0,0,0,0.6)';
    c.fillRect(0, H - 14, 92, 14);
    c.fillStyle = '#ffd94a';
    c.font = '11px monospace';
    c.fillText(`step ${step}`, 3, H - 3);

    if (t - this.lastSync >= SYNC_EVERY_MS) {
      this.sync.push([t, step]);
      this.lastSync = t;
    }
  }

  /**
   * Lips, cheeks and chin, from the tracker's own mouth point and face
   * width: wide enough to see the jaw work, short enough that the eyes
   * are never in frame. Mirrored, the way the player sees themselves.
   */
  private drawMouth(c: CanvasRenderingContext2D, v: HTMLVideoElement, f: FaceState): void {
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    const sw = Math.max(16, f.faceWidth * CROP_FACE_W * vw);
    const sh = sw * (H / W);
    const sx = f.mouthX * vw - sw / 2;
    const sy = f.mouthY * vh + f.faceWidth * CROP_DROP * vw - sh / 2;
    c.save();
    c.fillStyle = '#0b1220';
    c.fillRect(0, 0, W, H);
    c.translate(W, 0);
    c.scale(-1, 1);
    try {
      c.drawImage(v, sx, sy, sw, sh, 0, 0, W, H);
    } catch {
      // Frame not decodable this tick; the dark fill stands.
    }
    c.restore();
  }

  /** Finish and hand back the clip, or null if nothing was recorded. */
  stop(): Promise<FaceClip | null> {
    const rec = this.rec;
    if (!rec || rec.state === 'inactive') return Promise.resolve(null);
    return new Promise((resolve) => {
      rec.onstop = (): void => {
        const contentType = this.type.split(';')[0];
        const blob = new Blob(this.chunks, { type: contentType });
        const { sync, pose, calib } = this;
        this.rec = null;
        this.chunks = [];
        resolve(blob.size && sync.length ? { blob, contentType, sync, pose, calib } : null);
      };
      rec.stop();
    });
  }

  /** Drop anything recorded without keeping it. */
  discard(): void {
    if (this.rec && this.rec.state !== 'inactive') {
      this.rec.onstop = null;
      this.rec.stop();
    }
    this.rec = null;
    this.chunks = [];
    this.sync = [];
    this.pose = [];
  }
}
