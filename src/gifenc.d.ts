// gifenc ships no types. Only the three entry points this game uses.
declare module 'gifenc' {
  export type GifPalette = number[][];

  export interface WriteFrameOpts {
    palette?: GifPalette;
    /** Frame delay in milliseconds. */
    delay?: number;
    transparent?: boolean;
    transparentIndex?: number;
    repeat?: number;
  }

  export interface GifEncoderHandle {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: WriteFrameOpts): void;
    finish(): void;
    bytes(): Uint8Array;
    reset(): void;
  }

  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): GifEncoderHandle;

  export function quantize(
    rgba: Uint8ClampedArray | Uint8Array,
    maxColors: number,
    opts?: { format?: 'rgb565' | 'rgb444' | 'rgba4444'; oneBitAlpha?: boolean; clearAlpha?: boolean },
  ): GifPalette;

  export function applyPalette(
    rgba: Uint8ClampedArray | Uint8Array,
    palette: GifPalette,
    format?: 'rgb565' | 'rgb444' | 'rgba4444',
  ): Uint8Array;
}
