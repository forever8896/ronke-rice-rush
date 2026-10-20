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

- **Sign in** with the Ronin Wallet — extension or the Ronin app's browser, through Sky
  Mavis's `@sky-mavis/tanto-connect` — or with email through **Ronin Stash** (Privy
  cross-app connect). Same pair, same versions, as the Ronkeverse site. A free signed
  message, no transaction; smart-account signatures (ERC-1271/6492) are checked on chain.
  `.npmrc` sets `legacy-peer-deps` because Privy pins exact `viem`/`ox` peers.
- **Enter** by paying into the **RonkeTournament escrow contract** (`contracts/`), never to
  a person: approve, then `enter(token, 1)`. The server credits a ranked voyage only from
  the contract's own `Entered` event — emitted by the configured escrow, naming *your*
  wallet, confirmed — and each tx is credited once, ever. Entries still confirming are
  kept in the browser and retried, so a closed tab never loses one.
- **Sail ranked.** The server deals the voyage a seed and spends the entry. The browser
  records every step's input (steer, aim, mouth) — never the camera — and when the boat
  sinks it sends the log. The server **replays the log through the same rules** and that
  replayed score is the only one that counts; the client never sends a score at all.
- **Weeks** run Monday 00:00 UTC → Monday 00:00 UTC, counted identically by the server and
  the contract. Best ranked score per wallet; ties go to whoever got there first.
- **Payouts are the contract's job.** 70 minutes after the bell the owner presses SETTLE
  in the game (owner panel, shown only to the owner's wallet). The escrow pays its fixed
  10% rake and the rest to the winners by its fixed split — filled places share the
  whole prize if fewer than three placed. Winners must have entered that week.

### Face clips — the anti-bot check

A bot can produce valid inputs; it can't produce a face whose leaning, tilting and
chomping matches them frame for frame. So ranked voyages are filmed:

- The browser records a 240×180, 10 fps video of the player (`src/faceclip.ts`, ~24 kbps,
  ~11 MB/hour), each frame stamped with the sim step it was taken at.
- It stays on the device unless the run becomes the player's **best of the week in the
  top 10**; then it goes straight from the browser to a **private** Vercel Blob store
  (`ronke-face-clips`), on an upload token the server issues for that one file only.
  One clip per player per week — a new best replaces it, a beaten run's late upload is refused.
- Only the contract owner can watch: the owner panel links each proposed winner to
  `?review=<runId>`, which plays the clip (short-lived presigned URL) with the server's
  replay slaved to its playhead and gauges showing the scored inputs.
- **A run without a clip is never put forward for a prize** — the settle plan skips it
  and says so. Every clip of a week is deleted when that week's settle() is recorded.
- Players agree to this once, on a consent sheet, before their first ranked voyage.
  Practice voyages are never filmed.

### Entry pricing — one price, three tokens

An entry is **10 000 RONKE** (the contract's fixed-price anchor), or the **same USD value**
in RONKA or HORSKE. Prices come from GeckoTerminal's Ronin DEX prices — the source the casino
indexer and the Horske backend already use. When a player picks RONKA or HORSKE, the server
signs a quote (`/api/quote`) with the quote key: *this player may enter with this token at
this unit price until this time* (10 min; the contract caps it at 30). `enterQuoted()` checks
the signature, and that the quote is for this chain, this contract, this player and token.

- The quote key can only sign entry prices. It can't move a pool; the owner can replace it
  with `setQuoter` at once. Its private key lives only in Vercel (`QUOTER_PRIVATE_KEY`, sensitive).
- Amounts are rounded **up** to a whole token, so a quote never undercuts the anchor.
- No live price (API down >15 min) → no quote. RONKE entries still work.
- Pools stay per token; winners are paid from every pool.

### The escrow's guarantees (`contracts/src/RonkeTournament.sol`)

- Rake (max 10%) and split are set at deployment and **can never change**.
- **No withdraw.** A pool leaves only via `settle` (winners + rake) or `refund`.
- A week **unsettled 30 days** after it ends becomes refundable: every entrant reclaims
  exactly what they paid, straight from the contract. Settling is then locked out.
- Ownership is two-step (`Ownable2Step`) and can't be renounced. `rescue` returns only
  tokens sent by mistake — never more than the surplus above what the pools are owed.
- Fee-on-transfer safe: pools count what actually arrived.
- `forge test` (in `contracts/`): 23 tests incl. a 2,000-run fuzz that settle always
  empties the pool exactly, pays exactly the rake, and gives the winners the rest.
- Same toolchain as the casino contracts on Ronin: solc 0.8.28, EVM `paris`, OZ 5.1.0.

What it does **not** remove: the owner chooses the winners (scoring is off-chain). That
choice is constrained to wallets that entered, and every board run can be replayed by
anyone against the open-source sim. **Get an independent review before large pools.**

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
npm run admin -- status            # on-chain pools, board, review flags, replay links
npm run admin -- dq <week> <0xaddr> <reason>   # if a top run is a bot — BEFORE settling
# then, after Mon 01:10 UTC: open the game with the owner wallet → SETTLE WEEK n ON CHAIN
```

### Deploying the escrow

```sh
cd contracts
# contracts/.env.deployer holds a throwaway deployer key (git-ignored) — fund it with RON for gas
set -a; . ./.env.deployer; set +a
# Saigon rehearsal (test tokens, minted to MINT_TO):
FEE_RECIPIENT=0x… FINAL_OWNER=0x… MINT_TO=0x…,0x… \
  forge script script/DeploySaigon.s.sol --rpc-url saigon --broadcast --legacy --with-gas-price 21gwei
# Mainnet (rake/split are permanent — double-check SPLIT_BPS):
FEE_RECIPIENT=0x… FINAL_OWNER=0x… SPLIT_BPS=5000,3000,2000 PRICE_RONKE=… PRICE_RONKA=… \
  forge script script/DeployMainnet.s.sol --rpc-url ronin --broadcast --legacy --with-gas-price 21gwei
```

FINAL_OWNER then accepts ownership from the game's owner panel (two-step hand-over).

### Live deployments

| Saigon testnet (202601) | address |
|---|---|
| RonkeTournament | `0x902D6466712592A701E14Cd7eF4f986cF36eEd5F` |
| tRONKE — fixed 10 000 / entry | `0x20D51bdf8EE2EFAEb7c16B1ab2a7cB69De1EeF6C` |
| tRONKA — quoted | `0xd6cBB3D044AC5eabd938236C4AF49434b97B065f` |
| tHORSKE — quoted | `0x2a6f291853B778cE23135913B25c461324227822` |
| quote key (address) | `0x0f838F04442F0Aa2314cdDE3c90Ac49C7fB9417D` |

Test tokens borrow their mainnet twins' prices (the 4th `ENTRY_TOKENS` field). An earlier
Saigon escrow, `0x3390bbf9…aE12`, is retired; its one test entry is refundable after 30 days.

Ronin requires a 21 gwei legacy gas price — add `--legacy --with-gas-price 21gwei` to
`forge script` / `cast send`, or the node answers "transaction underpriced".

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
