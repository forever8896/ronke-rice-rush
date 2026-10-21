// ═════════════════════════════════════════════════════════════
// Head track: the anti-bot evidence for ranked voyages. Numbers only.
//
// Ten times a second during a ranked voyage, three numbers the face
// tracker already computes for the controls (head position, head tilt,
// jaw opening) are noted against the sim step, plus the calibration
// centre. No image, no video, no face geometry: nothing that identifies
// a person. It travels with the input log when the voyage is scored.
//
// The server checks that the scored inputs actually follow from this
// track by the game's own formulas, and that the track moves the way a
// human head does. A script that sends inputs straight to the game
// would have to forge a believable track that agrees with every one.
// ═════════════════════════════════════════════════════════════

import type { FaceState } from './detection';

/** Samples per second. */
const RATE = 10;

/** [sim step, headX×1000, roll mrad, jawOpen×1000]; headX -1 = no face in view. */
export type TrackSample = [number, number, number, number];

export interface HeadTrack {
  /** The calibration centre the controls were measured from. */
  calib: { headX: number; roll: number };
  s: TrackSample[];
}

export class HeadTracker {
  private samples: TrackSample[] = [];
  private calib = { headX: 0.5, roll: 0 };
  private lastAt = -Infinity;
  private on = false;

  start(calib: { headX: number; roll: number }): void {
    this.samples = [];
    this.calib = { ...calib };
    this.lastAt = -Infinity;
    this.on = true;
  }

  /** Called every animation frame of a ranked voyage. */
  sample(step: number, face: FaceState | null, now: number): void {
    if (!this.on || now - this.lastAt < 1000 / RATE) return;
    this.lastAt = now;
    const fresh = !!face && face.detected && now - face.lastDetectAt < 400;
    this.samples.push(fresh && face
      ? [step, Math.round(face.headX * 1000), Math.round(face.roll * 1000), Math.round(face.jawOpen * 1000)]
      : [step, -1, 0, 0]);
  }

  stop(): HeadTrack | null {
    if (!this.on) return null;
    this.on = false;
    return { calib: this.calib, s: this.samples };
  }
}
