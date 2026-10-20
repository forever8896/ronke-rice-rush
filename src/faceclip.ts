// ═════════════════════════════════════════════════════════════
// Face clip recorder — ranked voyages only.
//
// A bot can produce valid inputs; it can't produce a face whose
// leaning, tilting and chomping matches those inputs frame for frame.
// So a ranked voyage records a small, low-frame-rate video of the
// player alongside the input log. It lives in memory on this device
// and is thrown away unless the run becomes the player's best of the
// week near the top of the board — then it is uploaded, privately, for
// the tournament owner to watch next to the server's replay.
//
// Each frame carries the sim step it was taken at, burned into the
// corner, and `sync` keeps the same pairing as data — so the reviewer's
// page can line the video up with the replay exactly, through pauses
// and hit-stops alike.
// ═════════════════════════════════════════════════════════════

const W = 240;
const H = 180;
const FPS = 10;
const BITRATE = 60_000;
/** One sync sample per this many ms of video. */
const SYNC_EVERY_MS = 250;

export interface FaceClip {
  blob: Blob;
  contentType: string;
  /** [ms into the video, sim step] pairs. */
  sync: Array<[number, number]>;
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
  private startedAt = 0;
  private lastDraw = 0;
  private lastSync = -Infinity;
  private sync: Array<[number, number]> = [];
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

  start(video: HTMLVideoElement): boolean {
    this.discard();
    const type = pickType();
    if (!type || !this.ctx || !video.videoWidth) return false;
    this.type = type;
    this.video = video;
    this.chunks = [];
    this.sync = [];
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
    const v = this.video;
    const c = this.ctx;
    // Centre-crop the camera to 4:3 and mirror it, so the player's left
    // is on the left — the same way they see their own lean.
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    const crop = Math.min(vw / W, vh / H);
    const sw = W * crop;
    const sh = H * crop;
    c.save();
    c.translate(W, 0);
    c.scale(-1, 1);
    c.drawImage(v, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, W, H);
    c.restore();
    c.fillStyle = 'rgba(0,0,0,0.6)';
    c.fillRect(0, H - 14, 92, 14);
    c.fillStyle = '#ffd94a';
    c.font = '11px monospace';
    c.fillText(`step ${step}`, 3, H - 3);

    const t = Math.round(now - this.startedAt);
    if (t - this.lastSync >= SYNC_EVERY_MS) {
      this.sync.push([t, step]);
      this.lastSync = t;
    }
  }

  /** Finish and hand back the clip, or null if nothing was recorded. */
  stop(): Promise<FaceClip | null> {
    const rec = this.rec;
    if (!rec || rec.state === 'inactive') return Promise.resolve(null);
    return new Promise((resolve) => {
      rec.onstop = (): void => {
        const contentType = this.type.split(';')[0];
        const blob = new Blob(this.chunks, { type: contentType });
        const sync = this.sync;
        this.rec = null;
        this.chunks = [];
        resolve(blob.size && sync.length ? { blob, contentType, sync } : null);
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
  }
}
