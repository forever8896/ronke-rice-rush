# Ronke Rice Rush 🐒🍙

A browser game for the [Ronke the Monke](https://ronkeverse.com/) community on Ronin.
Stick your tongue out at the camera to catch falling riceballs. You *are* the monke —
an MSPaint-style blue monke head is overlaid on your face, tracked live.

Built on the tongue-detection stack from the Lick'em festival game:
**MediaPipe FaceLandmarker** for face landmarks + a fine-tuned **MobileNetV2**
tongue classifier running fully on-device via TensorFlow.js. No frames ever
leave the browser.

## Play

- **PLAY** — camera mode. A quick distance check + 2-phase tongue calibration
  runs first, then riceballs fall. Flick your tongue to catch them at the ring.
- **Touch mode** — no camera; tap the riceballs instead.
- Timing tiers by distance from the ring centre: PERFECT (100) / NICE (60) / late (25).
- Combos: 3+ catches in a row multiply your rice (2×/3×/4×).
- Golden $RICE riceballs are rare and worth 3×.
- Miss a riceball and it's gone — 3 misses and Ronke goes back to sleep.

## Quickstart

```sh
npm install
npm run dev       # http://localhost:5173/
npm run build     # outputs to dist/
```

You need a webcam. iOS Safari requires HTTPS — use an ngrok/tailscale HTTPS
tunnel when testing on a phone.

### URL flags

- `?perf=low|mid|high|desktop` — override device-tier autodetection
- `?skip-calibrate` — skip personal-threshold calibration
- `?skip-distance` — skip the distance gate

## Repo map

```
src/
├── main.ts           Shell — screens, camera startup, calibration, HUD
├── game.ts           Riceball-catch loop (timing tiers, combo, lives)
├── detection.ts      TongueDetector (MediaPipe + TF.js) — inherited from Lick'em
├── distance-gate.ts  Pre-calibration face-distance check
├── ronke-overlay.ts  MSPaint blue-monke head overlay, landmark-anchored
├── riceballs.ts      Canvas-drawn onigiri sprites (normal + gold)
├── audio.ts          WebAudio synth SFX — zero audio files
└── styles.css        Global styles

public/
├── mediapipe/            Vendored FaceLandmarker WASM + model
├── tongue-model/         Mobile tongue classifier (TF.js GraphModel)
└── tongue-model-desktop/ Desktop-tier classifier
```

All detection assets are self-hosted so the game runs with no external CDNs.
