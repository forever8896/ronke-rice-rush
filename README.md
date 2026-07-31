# Ronke Rice Rush 🐒🍙

A browser game for the [Ronke the Monke](https://ronkeverse.com/) community on Ronin.
**Open your mouth at the camera to eat the falling riceballs.** You *are* the monke —
the canonical Ronke head is overlaid on your face with a see-through mouth window,
tracked live. His eyes go wide every time you chomp. Everything except your mouth is
veiled over, so the screen reads as Ronke rather than as a webcam of you.

Detection is **MediaPipe FaceLandmarker only** — the jawOpen blendshape drives the
chomp, so there is no custom model, no calibration, and no training loop. Fully
on-device; no frames ever leave the browser.

## Play

- **PLAY** — camera only. Straight into the game: open wide to eat rice at the ring.
  Your mouth is the controller; there is no tap fallback.
- Timing tiers by distance from the ring centre: PERFECT (150) / NICE (100) / late (50).
- Combos multiply your rice (2×/3×/4×); every 10-combo ignites **RONKE ARC** —
  7 seconds of double points and denser rice. The arc is a pure reward window:
  no rugs spawn and rice you can't eat sinks for free, so it can't end your run.
- Golden $RICE riceballs are rare and worth 3×.
- **RUGs** fall among the rice — eat one and you get RUGGED (−100, combo gone).
- **BIG onigiri** drop in slowly and take 3 chomps — the last one bursts into a feast.
- Eat the **kasa** (straw hat) to wear it: it saves you from one missed riceball.
- Waves sweep across with a guaranteed gold at the end; late-game rice weaves as it falls.
- Miss a riceball and it splashes into the paddy — 3 misses and Ronke goes back to sleep.
- A first-run tutorial walks through all of it (replay via "how to play" on the title).

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

## Repo map

```
src/
├── main.ts           Shell — screens, camera startup, HUD, sensitivity
├── game.ts           Riceball-catch loop (tiers, combos, rugs, fever)
├── detection.ts      MouthDetector — MediaPipe FaceLandmarker + jawOpen chomp
├── ronke-overlay.ts  Canonical Ronke head overlay, mouth window, eye states
├── riceballs.ts      Canvas-drawn sprites (rice / gold / rug)
├── title-fx.ts       Ambient drifting riceballs on the title screen
├── audio.ts          Sample player (Lick'em SFX + music) with synth fallback
└── styles.css        Global styles

public/
├── mediapipe/        Vendored FaceLandmarker WASM + model (self-hosted)
├── ronke/            Ronke art (head states, badge, paddy backdrop)
├── sounds/           Music + SFX
├── fonts/            Baloo 2 (self-hosted)
└── og.jpg            1200×630 social card — rebuild via scripts/make-og.sh
```

All assets are self-hosted so the game runs with no external CDNs.
