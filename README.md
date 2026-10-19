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
  GUNBOAT → IRONCLAD → RAIDER SKIFF.
- **IRONCLADs** shrug off everything until their **PORTS OPEN** — be aimed and charged
  when the window comes.
- **Every fifth captain is CAPTAIN RUGBEARD**, a three-phase galleon boss: volleys with
  one gap, an armoured broadside, and a RAMMING SPEED charge where he's wide open. Beat
  him and the tier rolls over — the weather turns, a lateral **current** starts shoving
  the hull, and the pirates come back harder.
- **Barrels**: wood sinks you · **powder kegs** chain-explode, and one popped high near a
  pirate hurts the pirate too · **spiked** barrels take more than one pop · **supply
  crates** repair a plank — your shot passes straight through them, so you have to ram.
- **BARRAGE** walls drop a row with exactly one gap. Pure positioning.
- A 12-hit chain lights **BROADSIDE**: triple shot, half reload, double loot.
- Three hull planks. Lose them all and the boat is splinters.

### How the loop pays

The economy is tuned so there is exactly one winning line — **shoot the ship**:

- **Sinking pays.** A pirate is worth more than every barrel it drops. In bot runs,
  ~88% of a score comes from hitting and sinking pirates, ~10% from barrels, and ~3%
  from simply staying alive. Barrels are the obstacle course you clear on the way; a
  powder keg is the one barrel worth spending a reload on.
- **The chain lapses.** Hits multiply your loot, but the multiplier expires after a few
  quiet seconds. There is no turtling for score — a bot that dodges perfectly and never
  fires earns about 5 points a second against a fighting bot's 225.
- **The only routine repair is a crate.** Not sinking, not reaching a boss. You have to
  break your dodge line and physically catch one.
- **Pirates press in.** A ship you can't finish attacks harder the longer it lives, so a
  stalemate ends the run rather than extending it.

### The drill

The first run opens a **playable tutorial**, not a slideshow. It runs the real loop with
the sea switched off and the hull made unsinkable, and a director puts one idea on the
water at a time — nine steps, each gated on you actually doing it:

take the helm → dodge three barrels → swing the gun → pop two barrels → split two spiked
ones with a charged ball → chain a powder keg → ram a supply crate to repair a plank →
sink an ironclad through its gunport window → keep the chain

Getting clipped during the drill still shakes the screen and breaks your chain; it just
can't end the lesson. Skippable, and replayable from "how to play".

### Your last stand

Every voyage records its final six seconds into a ring buffer and encodes them to a GIF
on the game-over screen (`gifenc`, 64 colours, ~10 fps). Nothing is uploaded — the clip
is built in the page and handed to you. **SAVE GIF** downloads it; **SHARE CLIP** opens
the OS share sheet where one exists (mobile), and otherwise saves it and says so, because
X's web-intent URL carries text but not media. The clip contains the mouth window sampled
from your camera, which the UI says plainly next to the buttons.

## Weekly tournament

Free play needs nothing. Ranked play is a weekly, paid-entry tournament on Ronin:

- **Sign in** with a Ronin wallet (a free signed message, no transaction).
- **Enter** by sending the entry fee in RONKE or RONKA to the treasury. The server reads
  the transfer receipt from Ronin and checks it — from *your* wallet, to the treasury,
  in an entry token, confirmed — and credits `floor(paid / price)` entries. A tx hash is
  credited once, ever. Payments that are still confirming are kept in the browser and
  retried, so a closed tab never loses one.
- **Sail ranked.** The server deals the voyage a seed and spends the entry. The browser
  records every step's input (steer, aim, mouth) — never the camera — and when the boat
  sinks it sends the log. The server **replays the log through the same rules** and that
  replayed score is the only one that counts; the client never sends a score at all.
- **Weeks** run Monday 00:00 UTC → Monday 00:00 UTC. Best ranked score per wallet;
  ties go to whoever got there first. Each token has its own pool: `RAKE_PERCENT` to the
  operator, the rest split by `PRIZE_SPLIT`; unfilled places roll into next week.
- **Payouts are manual.** The server holds no key that can move funds. Every run on the
  board can be watched (`?replay=<runId>`), and you watch the top runs before paying.

### What the anti-cheat does and doesn't do

The sim (`src/sim.ts`) is deterministic: fixed 60 Hz steps, a fixed 432×864 field, one
seeded RNG, and hand-rolled trig (`src/dmath.ts`) so Chrome, Safari and Node land on the
same bits. `npm test` checks live-vs-replay equality and the API's attack cases.

That stops: forged scores, edited logs, replaying a log on a different sea, using someone
else's ticket or payment, fast-forwarded runs, and the dev mouse rig (compiled out of
production). Runs also get **review flags** for inputs a face can't produce.

It does **not** prove a human played. A bot that feeds plausible inputs in real time
produces a valid log. That is what the pre-payout review of the top runs is for — and
why prize pools should stay at a size where that review is worth doing by hand.

### Weekly routine

```sh
vercel env pull .env.production.local --environment=production   # once
npm run admin -- status            # pools, board, review flags, replay links
npm run admin -- dq <week> <0xaddr> <reason>   # if a top run is a bot
npm run admin -- close <week>      # after Mon 01:10 UTC: freezes the payout sheet
# send each prize from the treasury wallet, then:
npm run admin -- paid <week> <rank> <SYMBOL> <txHash>
```

Configuration lives in Vercel env vars — see `.env.example`.

## Quickstart

```sh
npm install
npm run dev       # http://localhost:5173/
npm run build     # outputs to dist/
```

You need a webcam. iOS Safari requires HTTPS — use an ngrok/tailscale HTTPS tunnel when
testing on a phone.

### URL flags

- `?mock=1` — dev rig (dev server only, compiled out of production): mouse X steers,
  mouse Y aims, hold to charge. Also exposes the loop as `window.__game` and the
  recorder as `window.__clip` for tuning and bot runs.
- `?replay=<runId>` — watch a ranked voyage exactly as the server scored it
- `?perf=low|mid|high|desktop` — override device-tier autodetection

## Repo map

```
src/
├── main.ts        Shell — screens, camera startup, calibration, HUD, drill director
├── sim.ts         The rules — deterministic, DOM-free; shared with the server
├── dmath.ts       Engine-independent sin/cos/exp + seeded RNG for the sim
├── runlog.ts      Input log record / encode / replay
├── game.ts        Fixed-step loop, FX and rendering around the sim
├── tournament.ts  Ronin wallet, entry payments, ranked runs
├── clip.ts        Ring-buffer screen capture → GIF for the game-over clip
├── sea.ts         Procedural scrolling sea, wake, storms, currents
├── detection.ts   FaceController — headX / roll / jawOpen off FaceLandmarker
├── captain.ts     Ronke at the helm: aim readout + live mouth window
├── sprites.ts     Canvas-drawn barrels, cannon, cannonballs + PNG loader
├── audio.ts       Synthesised gunnery over the Ronke sample set
└── styles.css     Global styles

api/
├── auth.ts        Wallet sign-in (signed message → session token)
├── season.ts      Week, pools, prizes, board
├── entry.ts       Verify an entry-fee transfer on Ronin, credit entries
├── run.ts         Deal a ranked voyage; replay and score its log
└── _lib/          Config, Redis keys, chain reader, review flags

scripts/
├── season-admin.ts  Weekly status / disqualify / close / mark paid
└── test/            Replay determinism + API attack tests (npm test)

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
