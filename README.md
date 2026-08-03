# Ronke Boat Battle 🛶💥

A browser game for the [Ronke the Monke](https://ronkeverse.com/) community on Ronin.
**Your whole head is the controller.** Ronke is at the helm of his boat, the sea scrolls
past, and the pirates are trying to stop the voyage.

- **Lean left/right** → the hull steers. Barrels roll down the sea; the only way past
  them is to physically move.
- **Tilt your head** → the deck gun swings. This is a *separate* axis from steering, so
  the dodge and the firing solution constantly fight each other: a keg on your left
  shoves you right while the pirate on your left needs you tilted left.
- **Open your mouth** → powder goes in. **Close it** → FIRE. A quick chomp pops a barrel;
  hold the gape and let it go for a MIGHTY ball that punches through everything.

Detection is **MediaPipe FaceLandmarker only** — nose tip for steering, cheek line for
tilt, the jawOpen blendshape for the gun. No custom model, no calibration beyond the
3-2-1 count at the start, fully on-device; no frames ever leave the browser.

The canonical Ronke head rides the deck with a see-through mouth window, and your *real*
mouth is blitted into his muzzle straight from the camera frame — his face, your jaw.
The feed itself is never displayed.

## The voyage

- **Pirates** sail in one after another, each tougher than the last: BARREL SKIFF →
  GUNBOAT → IRONCLAD → RAIDER SKIFF. Sink one and it patches a plank.
- **IRONCLADs** shrug off everything until their **PORTS OPEN** — be aimed and charged
  when the window comes.
- **Every fifth captain is CAPTAIN RUGBEARD**, a three-phase galleon boss: volleys with
  one gap, an armoured broadside, and a RAMMING SPEED charge where he's wide open. Beat
  him and the tier rolls over — the weather turns, a lateral **current** starts shoving
  the hull, and the pirates come back harder.
- **Barrels**: wood sinks you · **powder kegs** chain-explode (shoot one to clear a lane)
  · **spiked** barrels shrug off weak shots · **supply crates** repair a plank, so ram
  them and never shoot them.
- **BARRAGE** walls drop a row with exactly one gap. Pure positioning.
- A 12-hit chain lights **BROADSIDE**: triple shot, half reload, double loot.
- Three hull planks. Lose them all and the boat is splinters.

A first-run drill teaches each axis and won't advance until you've actually done it
(replayable from "how to play").

## Quickstart

```sh
npm install
npm run dev       # http://localhost:5173/
npm run build     # outputs to dist/
```

You need a webcam. iOS Safari requires HTTPS — use an ngrok/tailscale HTTPS tunnel when
testing on a phone.

### URL flags

- `?mock=1` — dev rig: mouse X steers, mouse Y aims, hold to charge. Also exposes the
  loop as `window.__game` for tuning and headless bot runs.
- `?perf=low|mid|high|desktop` — override device-tier autodetection

## Repo map

```
src/
├── main.ts        Shell — screens, camera startup, calibration, HUD, tutorial
├── game.ts        The loop — boat physics, barrels, pirates, boss, scoring
├── sea.ts         Procedural scrolling sea, wake, storms, currents
├── detection.ts   FaceController — headX / roll / jawOpen off FaceLandmarker
├── captain.ts     Ronke at the helm: aim readout + live mouth window
├── sprites.ts     Canvas-drawn barrels, cannon, cannonballs + PNG loader
├── audio.ts       Synthesised gunnery over the Ronke sample set
└── styles.css     Global styles

public/
├── sea/           Boat, three pirate hulls, Rugbeard's galleon, sea plate
├── mediapipe/     Vendored FaceLandmarker WASM + model (self-hosted)
├── ronke/         Ronke head states + badge art
├── sounds/        Music + sampled SFX
├── fonts/         Baloo 2 (self-hosted)
└── og.jpg         1200×630 social card — rebuild via scripts/make-og.sh
```

The boat and pirate art is Venice-generated (flux-2-pro / nano-banana-pro), keyed to
transparency and quantised. All assets are self-hosted so the game runs with no
external CDNs.
