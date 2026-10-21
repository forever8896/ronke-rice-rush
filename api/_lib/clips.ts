// ═════════════════════════════════════════════════════════════
// Face clips — the proof a person sailed the voyage.
//
// During a ranked voyage the browser records a small video of the
// player's MOUTH AND JAW only (never the eyes or full face) plus a head
// track: the tracker's head position, tilt and jaw, as numbers. It stays on their device unless the run becomes their
// best of the week AND sits in the top CLIP_RANK — then it's uploaded
// to a PRIVATE Vercel Blob store. Only the tournament owner can watch
// it (through a short-lived presigned URL), side by side with the
// server's replay of the same run. Every clip of a week is deleted
// when that week is paid out.
//
// A run with no clip can still sit on the board, but it is never put
// forward for a prize.
// ═════════════════════════════════════════════════════════════

import { del, head, issueSignedToken, presignUrl } from '@vercel/blob';

/** Runs that finish at or above this rank upload their clip. */
export const CLIP_RANK = 10;
/** A 60-minute voyage at the recorder's bitrate is ~25 MB; leave headroom. */
export const CLIP_MAX_BYTES = 64 * 1024 * 1024;
export const CLIP_TYPES = ['video/webm', 'video/mp4'];
/** How long a review link works. */
const VIEW_TTL_MS = 60 * 60 * 1000;

export function clipPath(week: number, runId: string, contentType: string): string {
  return `clips/${week}/${runId}.${contentType === 'video/mp4' ? 'mp4' : 'webm'}`;
}

/** What the handlers need from the blob store — tests pass a fake. */
export interface ClipStore {
  /** Size of an uploaded clip, or null if it isn't there. */
  size(pathname: string): Promise<number | null>;
  remove(pathnames: string[]): Promise<void>;
  /** A short-lived URL the owner's browser can play directly. */
  viewUrl(pathname: string): Promise<string>;
}

let clipStore: ClipStore | null = null;

export function getClips(): ClipStore {
  clipStore ??= {
    async size(pathname) {
      try {
        return (await head(pathname)).size;
      } catch {
        return null;
      }
    },
    async remove(pathnames) {
      if (pathnames.length) await del(pathnames);
    },
    async viewUrl(pathname) {
      const validUntil = Date.now() + VIEW_TTL_MS;
      const token = await issueSignedToken({ pathname, operations: ['get'], validUntil });
      return (await presignUrl(token, { operation: 'get', pathname, access: 'private', validUntil })).presignedUrl;
    },
  };
  return clipStore;
}

export function setClips(c: ClipStore): void {
  clipStore = c;
}

/** Stored once a clip has landed: where it is and how to line it up with the replay. */
export interface ClipRecord {
  pathname: string;
  size: number;
  contentType: string;
  /** [ms into the video, sim step] samples, for syncing video and replay. */
  sync: Array<[number, number]>;
  /** [ms, headX×1000, roll mrad, jawOpen×1000]; headX -1 = no face in view. */
  pose: Array<[number, number, number, number]>;
  /** Calibration centre the player's controls were measured from. */
  calib: { headX: number; roll: number };
  at: number;
}

/** A run that has earned the right to upload its clip. */
export interface ClipWanted {
  addr: string;
  week: number;
  steps: number;
}
