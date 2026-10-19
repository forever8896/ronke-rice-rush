// ═════════════════════════════════════════════════════════════
// Voyage clip — a shareable GIF of how the run ended.
//
// The game canvas is sampled into a ring buffer while you play, so
// what survives is always the LAST few seconds: the barrage you
// misread, the boss ram you didn't dodge. That's the bit worth
// showing, and a ring buffer means a twenty-minute run costs the same
// memory as a twenty-second one.
//
// Encoding is deliberately deferred to the game-over screen and then
// chunked across frames — quantising sixty frames in one go locks the
// tab for a second and a half right when the player wants to click
// something.
//
// Privacy: these frames contain the mouth window sampled from the
// camera, because that is what the game draws. Nothing is uploaded —
// the GIF is built in the page and handed to the player, who decides
// whether it goes anywhere.
// ═════════════════════════════════════════════════════════════

import { GIFEncoder, quantize, applyPalette } from 'gifenc';

/** Frames a second in the clip. */
const FPS = 10;
/** Seconds of tape kept behind the playhead. */
const SECONDS = 6;
const MAX_FRAMES = FPS * SECONDS;
/** Longest edge of the GIF, in px. */
const MAX_EDGE = 320;
/**
 * Palette size. The art is flat cel-shaded — big areas of one colour —
 * so 64 is visually indistinguishable from 128 here and takes roughly
 * a quarter off the file.
 */
const COLORS = 64;

export interface ClipProgress {
  (done: number, total: number): void;
}

export class ClipRecorder {
  private frames: Uint8ClampedArray[] = [];
  private scratch: HTMLCanvasElement;
  private sctx: CanvasRenderingContext2D | null;
  private w = 0;
  private h = 0;
  private nextAt = 0;
  private enabled = true;

  constructor() {
    this.scratch = document.createElement('canvas');
    this.sctx = this.scratch.getContext('2d', { willReadFrequently: true });
    if (!this.sctx) this.enabled = false;
  }

  /** Throw away the tape and start fresh. */
  reset(): void {
    this.frames = [];
    this.nextAt = 0;
  }

  hasClip(): boolean {
    return this.enabled && this.frames.length >= FPS; // at least a second
  }

  frameCount(): number {
    return this.frames.length;
  }

  /**
   * Sample the canvas if enough time has passed. Safe to call every
   * animation frame; it self-throttles to FPS.
   */
  capture(src: HTMLCanvasElement, now: number): void {
    if (!this.enabled || !this.sctx) return;
    if (now < this.nextAt) return;
    // Don't try to "catch up" after a stall — that would burn a whole
    // ring buffer of duplicate frames on one hitch.
    this.nextAt = now + 1000 / FPS;

    const sw = src.width;
    const sh = src.height;
    if (sw < 2 || sh < 2) return;

    if (this.w === 0) {
      const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
      // Even dimensions keep the scaler happy and the file tidy.
      this.w = Math.max(2, Math.round((sw * scale) / 2) * 2);
      this.h = Math.max(2, Math.round((sh * scale) / 2) * 2);
      this.scratch.width = this.w;
      this.scratch.height = this.h;
    }

    try {
      this.sctx.drawImage(src, 0, 0, sw, sh, 0, 0, this.w, this.h);
      const data = this.sctx.getImageData(0, 0, this.w, this.h).data;
      this.frames.push(new Uint8ClampedArray(data));
      if (this.frames.length > MAX_FRAMES) this.frames.shift();
    } catch {
      // A tainted canvas would throw here. Nothing in this game taints
      // one (all art is same-origin and getUserMedia streams don't
      // taint), but if it ever did, silently stop rather than spam.
      this.enabled = false;
      this.frames = [];
    }
  }

  /**
   * Encode the tape to a GIF, yielding to the browser between chunks
   * so the game-over screen stays responsive.
   */
  async encode(onProgress?: ClipProgress): Promise<Blob | null> {
    if (!this.hasClip()) return null;
    const frames = this.frames.slice();
    const total = frames.length;

    // One palette for the whole clip, sampled across it. Per-frame
    // palettes look marginally better but cost a quantise per frame and
    // make the file jump around; the sea barely changes hue anyway.
    const palette = quantize(sampleForPalette(frames), COLORS, { format: 'rgb565' });

    const gif = GIFEncoder();
    const delay = Math.round(1000 / FPS);
    for (let i = 0; i < total; i++) {
      const index = applyPalette(frames[i], palette, 'rgb565');
      gif.writeFrame(index, this.w, this.h, { palette, delay });
      onProgress?.(i + 1, total);
      // Yield every few frames — enough to keep the UI alive without
      // paying a task hop per frame.
      if (i % 4 === 3) await nextTick();
    }
    gif.finish();
    return new Blob([gif.bytes() as unknown as BlobPart], { type: 'image/gif' });
  }
}

/**
 * Concatenate a spread of frames for the palette pass. Quantising all
 * sixty would be slow and no more accurate — an even sample across the
 * clip already covers every scene it contains.
 */
function sampleForPalette(frames: Uint8ClampedArray[]): Uint8ClampedArray {
  const want = Math.min(6, frames.length);
  const step = Math.max(1, Math.floor(frames.length / want));
  const picked: Uint8ClampedArray[] = [];
  for (let i = 0; i < frames.length && picked.length < want; i += step) {
    picked.push(frames[i]);
  }
  const out = new Uint8ClampedArray(picked.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of picked) { out.set(f, at); at += f.length; }
  return out;
}

function nextTick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
