// ═════════════════════════════════════════════════════════════
// Ronke Boat Battle — entrypoint, screen routing, control wiring.
//
// Flow: title → camera → CALIBRATE (3-2-1, which also captures the
// player's neutral head position and tilt) → tutorial on first run →
// voyage → over → again.
//
// The three signals off one face:
//   headX  → steer      (dodge the barrels)
//   roll   → aim        (swing the cannon)
//   jaw    → charge/fire (open packs powder, close fires)
//
// ?mock=1 swaps the camera for mouse control (X steers, Y aims, hold
// to charge) — a dev rig for playing the loop without a webcam. It is
// compiled out of production builds: with money on the board, a mouse
// is a cheat code.
//
// ?replay=<runId> plays back a ranked voyage from its server log.
// ═════════════════════════════════════════════════════════════

import {
  FaceController,
  detectDeviceTier,
  configForTier,
  type FaceState,
} from './detection';
import { Game, DEFAULT_GAME_CONFIG, type Signal, type StageInfo } from './game';
import { ClipRecorder } from './clip';
import { FaceClipRecorder } from './faceclip';
import {
  acceptOwnership, buyEntry, explorer, fetchReplay, fetchReview, fetchSeason, finishRun, formatAmount, uploadClip,
  retryPending, session, setEntriesPaused, setName, settleWeek, shortAddr, signIn, signOut, startRun, walletOptions,
  type SeasonInfo, type WalletVia,
} from './tournament';
import {
  initAudio, isMuted, setMuted,
  sfxFire, sfxDryClick, sfxBarrelPop, sfxPowderBlast, sfxPing, sfxSupply,
  sfxEnemyHit, sfxEnemySunk, sfxBossIn, sfxBossSunk, sfxHullHit, sfxBroadside,
  sfxStage, sfxGameOver, startChargeSfx, stopChargeSfx,
  startMusic, stopMusic, startHeartbeat, stopHeartbeat,
} from './audio';
import './styles.css';

type ScreenName = 'title' | 'game' | 'over';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const refs = {
  app: $<HTMLDivElement>('app'),
  video: $<HTMLVideoElement>('video'),
  gameCanvas: $<HTMLCanvasElement>('game-canvas'),
  titleScreen: $<HTMLDivElement>('title-screen'),
  gameScreen: $<HTMLDivElement>('game-screen'),
  overScreen: $<HTMLDivElement>('over-screen'),
  playBtn: $<HTMLButtonElement>('play-btn'),
  titleBest: $<HTMLDivElement>('title-best'),
  titleStatus: $<HTMLDivElement>('title-status'),
  hudScore: $<HTMLSpanElement>('hud-score'),
  hudHull: $<HTMLDivElement>('hud-hull'),
  hudCombo: $<HTMLDivElement>('hud-combo'),
  enemyBar: $<HTMLDivElement>('enemy-bar'),
  enemyName: $<HTMLDivElement>('enemy-name'),
  enemyFill: $<HTMLDivElement>('enemy-fill'),
  stageBanner: $<HTMLDivElement>('stage-banner'),
  stageKicker: $<HTMLDivElement>('stage-kicker'),
  stageName: $<HTMLDivElement>('stage-name'),
  feverBanner: $<HTMLDivElement>('fever-banner'),
  feverBarFill: $<HTMLDivElement>('fever-bar-fill'),
  feedback: $<HTMLDivElement>('feedback'),
  calib: $<HTMLDivElement>('calib'),
  calibTitle: $<HTMLDivElement>('calib-title'),
  calibText: $<HTMLDivElement>('calib-text'),
  calibCount: $<HTMLDivElement>('calib-count'),
  overScore: $<HTMLSpanElement>('over-score'),
  overBest: $<HTMLDivElement>('over-best'),
  rankChip: $<HTMLDivElement>('rank-chip'),
  statsRow: $<HTMLDivElement>('stats-row'),
  shareBtn: $<HTMLButtonElement>('share-btn'),
  againBtn: $<HTMLButtonElement>('again-btn'),
  homeBtn: $<HTMLButtonElement>('home-btn'),
  rankedResult: $<HTMLDivElement>('ranked-result'),
  tourney: $<HTMLElement>('tourney'),
  tEnds: $<HTMLDivElement>('t-ends'),
  tPools: $<HTMLDivElement>('t-pools'),
  tEscrow: $<HTMLDivElement>('t-escrow'),
  tNote: $<HTMLDivElement>('t-note'),
  tOwner: $<HTMLDivElement>('t-owner'),
  tBoard: $<HTMLOListElement>('t-board'),
  tEmpty: $<HTMLDivElement>('t-empty'),
  tConnect: $<HTMLButtonElement>('t-connect'),
  tEmail: $<HTMLButtonElement>('t-email'),
  tSignout: $<HTMLButtonElement>('t-signout'),
  tMe: $<HTMLDivElement>('t-me'),
  tMeLine: $<HTMLDivElement>('t-me-line'),
  tNameRow: $<HTMLDivElement>('t-name-row'),
  tName: $<HTMLInputElement>('t-name'),
  tNameBtn: $<HTMLButtonElement>('t-name-btn'),
  tBuy: $<HTMLDivElement>('t-buy'),
  tRanked: $<HTMLButtonElement>('t-ranked'),
  tStatus: $<HTMLDivElement>('t-status'),
  tLast: $<HTMLDivElement>('t-last'),
  tRulesBtn: $<HTMLButtonElement>('t-rules-btn'),
  rules: $<HTMLDivElement>('rules'),
  rulesBody: $<HTMLDivElement>('rules-body'),
  rulesClose: $<HTMLButtonElement>('rules-close'),
  replayBanner: $<HTMLDivElement>('replay-banner'),
  consent: $<HTMLDivElement>('consent'),
  consentYes: $<HTMLButtonElement>('consent-yes'),
  consentNo: $<HTMLButtonElement>('consent-no'),
  review: $<HTMLDivElement>('review'),
  reviewHead: $<HTMLDivElement>('review-head'),
  reviewVideo: $<HTMLVideoElement>('review-video'),
  reviewNone: $<HTMLDivElement>('review-none'),
  reviewClose: $<HTMLButtonElement>('review-close'),
  gSteer: $<HTMLElement>('g-steer'),
  gAim: $<HTMLElement>('g-aim'),
  gMouth: $<HTMLElement>('g-mouth'),
  howBtn: $<HTMLButtonElement>('how-btn'),
  tutorial: $<HTMLDivElement>('tutorial'),
  tutTitle: $<HTMLDivElement>('tut-title'),
  tutText: $<HTMLDivElement>('tut-text'),
  tutHint: $<HTMLDivElement>('tut-hint'),
  tutDots: $<HTMLDivElement>('tut-dots'),
  tutSkip: $<HTMLButtonElement>('tut-skip'),
  drillFlash: $<HTMLDivElement>('drill-flash'),
  clip: $<HTMLDivElement>('clip'),
  clipImg: $<HTMLImageElement>('clip-img'),
  clipSpinner: $<HTMLDivElement>('clip-spinner'),
  clipShare: $<HTMLButtonElement>('clip-share'),
  clipSave: $<HTMLButtonElement>('clip-save'),
  clipNote: $<HTMLDivElement>('clip-note'),
};

const MOCK = import.meta.env.DEV && /[?&]mock=1/.test(location.search);
const REPLAY_ID = new URLSearchParams(location.search).get('replay');
const REVIEW_ID = new URLSearchParams(location.search).get('review');

/** Films ranked voyages for the anti-bot review — see faceclip.ts. */
const faceRec = new FaceClipRecorder();
const CONSENT_KEY = 'ronke:clipConsent';

let detector: FaceController | null = null;
let game: Game | null = null;
let pumpRunning = false;

// ── Control state ──
// Calibration: whatever the player's head was doing during the count
// becomes centre. Nobody sits perfectly square to a webcam.
let neutralX = 0.5;
let neutralRoll = 0;
let smoothX = 0.5;
let smoothRoll = 0;
/** Live control values, also read by the tutorial gates. */
let steer = 0.5;
let aim = 0;
const STEER_GAIN = 2.6;
const ROLL_GAIN = 2.4;

// Mock rig
let mockX = 0.5;
let mockAim = 0;
let mockDown = false;

// ── Voyage clip ──
// Records the last few seconds of play into a GIF the player can keep
// or share. Everything happens in the page: no upload, no server.

const clipRecorder = new ClipRecorder();
let clipBlob: Blob | null = null;
let clipUrl: string | null = null;

/**
 * The canonical public address, read off the og:url meta tag so the
 * share text and the social card can never drift apart. Falls back to
 * wherever the page is actually served from.
 */
const GAME_URL =
  document.querySelector('meta[property="og:url"]')?.getAttribute('content')
  ?? `${location.origin}/`;
const GAME_DOMAIN = (() => {
  try { return new URL(GAME_URL).host; } catch { return location.host; }
})();

function clipFileName(): string {
  return `ronke-boat-battle-${lastScore}.gif`;
}

function releaseClip(): void {
  if (clipUrl) URL.revokeObjectURL(clipUrl);
  clipUrl = null;
  clipBlob = null;
  refs.clipImg.removeAttribute('src');
  refs.clipImg.classList.add('hidden');
}

/** Encode whatever is on the tape and show it on the over screen. */
async function buildClip(): Promise<void> {
  releaseClip();
  if (!clipRecorder.hasClip()) {
    refs.clip.classList.add('hidden');
    return;
  }
  refs.clip.classList.remove('hidden');
  refs.clipSpinner.classList.remove('hidden');
  refs.clipSpinner.textContent = 'rendering your clip…';
  refs.clipShare.disabled = true;
  refs.clipSave.disabled = true;
  try {
    const blob = await clipRecorder.encode((done, total) => {
      refs.clipSpinner.textContent = `rendering your clip… ${Math.round((done / total) * 100)}%`;
    });
    if (!blob) { refs.clip.classList.add('hidden'); return; }
    clipBlob = blob;
    clipUrl = URL.createObjectURL(blob);
    refs.clipImg.src = clipUrl;
    refs.clipImg.classList.remove('hidden');
    refs.clipSpinner.classList.add('hidden');
    refs.clipShare.disabled = false;
    refs.clipSave.disabled = false;
    const kb = Math.round(blob.size / 1024);
    refs.clipNote.textContent =
      `${kb} KB · stays on your device unless you share it · shows the mouth window from your camera`;
  } catch (e) {
    console.warn('[clip] encode failed', e);
    refs.clipSpinner.textContent = 'clip failed to render';
  }
}

function downloadClip(): void {
  if (!clipUrl) return;
  const a = document.createElement('a');
  a.href = clipUrl;
  a.download = clipFileName();
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * `withLink` adds the address to the body. X's intent takes the link as
 * its own `url` parameter and appends it for you — passing it in both
 * places prints the domain twice — but the OS share sheet has no such
 * field, so there the body has to carry it.
 */
function shareText(withLink: boolean): string {
  return (
    `I sailed ${lastScore} loot deep in RONKE BOAT BATTLE \u{1F6F6}\u{1F4A5} ` +
    `${lastPirates} pirates sunk · rank: ${lastRank}\n\n` +
    `steer with your head, fire with your mouth. can you out-sail me, monke? $RONKE` +
    (withLink ? `\n${GAME_DOMAIN}` : '')
  );
}

/**
 * Hand the GIF to the OS share sheet when there is one — that is the
 * only path that can actually attach the file to a post, since X's
 * web-intent URL takes text but no media. Everywhere else, save it and
 * say so, so the button never silently does nothing.
 */
async function shareClip(): Promise<void> {
  if (!clipBlob) return;
  const file = new File([clipBlob], clipFileName(), { type: 'image/gif' });
  const payload = { files: [file], text: shareText(true), title: 'Ronke Boat Battle' };
  if (navigator.canShare?.(payload) && navigator.share) {
    try {
      await navigator.share(payload);
      return;
    } catch (e) {
      // AbortError just means they closed the sheet — not a failure.
      if ((e as Error)?.name === 'AbortError') return;
      console.warn('[clip] share failed, saving instead', e);
    }
  }
  downloadClip();
  refs.clipNote.textContent =
    'saved to your device — attach it to your post yourself (the web share sheet can\u2019t carry files here)';
}

// ── Rank ladder — the competition hook, sea edition ──
const RANKS: Array<[number, string]> = [
  [0, '🪵 DECKHAND'],
  [2500, '🧭 HELMSMAN'],
  [6000, '⚓ QUARTERMASTER'],
  [12000, '💣 MASTER GUNNER'],
  [25000, '🏴‍☠️ PRIVATEER'],
  [50000, '👑 ADMIRAL RONKE'],
];
function rankForScore(score: number): string {
  let r = RANKS[0][1];
  for (const [min, name] of RANKS) if (score >= min) r = name;
  return r;
}
let lastScore = 0;
let lastRank = RANKS[0][1];
let lastPirates = 0;

const BEST_KEY = 'ronke:bestVoyage';
const loadBest = (): number => Number(localStorage.getItem(BEST_KEY) || 0);
const saveBest = (s: number): void => {
  if (s > loadBest()) localStorage.setItem(BEST_KEY, String(s));
};

function showScreen(name: ScreenName): void {
  refs.titleScreen.classList.toggle('hidden', name !== 'title');
  refs.gameScreen.classList.toggle('hidden', name !== 'game');
  refs.overScreen.classList.toggle('hidden', name !== 'over');
}

function setStatus(msg: string | null, isError = false): void {
  refs.titleStatus.textContent = msg ?? '';
  refs.titleStatus.classList.toggle('error', isError);
}

function setLoading(label: string | null): void {
  if (label === null) {
    refs.playBtn.disabled = false;
    refs.playBtn.textContent = 'SET SAIL';
    return;
  }
  refs.playBtn.disabled = true;
  refs.playBtn.textContent = label;
}

/** Desktop play-column constraint (html[data-gameplay]). */
function setGameplayColumn(on: boolean): void {
  document.documentElement.toggleAttribute('data-gameplay', on);
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

// ── HUD ──

function renderHull(hp: number, hit = false): void {
  refs.hudHull.textContent = '🪵'.repeat(Math.max(0, hp));
  if (hit) {
    refs.hudHull.classList.remove('lost');
    void refs.hudHull.offsetWidth;
    refs.hudHull.classList.add('lost');
  }
}

function shakeScreen(): void {
  refs.app.classList.remove('shake');
  void refs.app.offsetWidth;
  refs.app.classList.add('shake');
}

let feedbackTimer = 0;
function showFeedback(text: string, cls: string): void {
  refs.feedback.textContent = text;
  refs.feedback.className = `feedback ${cls}`;
  clearTimeout(feedbackTimer);
  feedbackTimer = window.setTimeout(() => refs.feedback.classList.add('hidden'), 700);
}

let stageTimer = 0;
function showStage(info: StageInfo): void {
  refs.stageKicker.textContent = info.boss
    ? `TIER ${info.tier} · BOSS`
    : `PIRATE ${info.index}`;
  refs.stageName.textContent = info.name;
  refs.stageBanner.classList.toggle('boss', info.boss);
  refs.stageBanner.classList.remove('hidden');
  void refs.stageBanner.offsetWidth;
  clearTimeout(stageTimer);
  stageTimer = window.setTimeout(() => refs.stageBanner.classList.add('hidden'), 1700);
}

// ── Control pump — one RAF, feeds the game and the tutorial ──

function faceState(): FaceState | null {
  return detector?.state ?? null;
}

function startPump(): void {
  if (pumpRunning) return;
  pumpRunning = true;
  let last = performance.now();

  const tick = (): void => {
    if (!pumpRunning) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (MOCK) {
      smoothX += (mockX - smoothX) * 0.4;
      steer = smoothX;
      aim = mockAim;
    } else {
      const f = faceState();
      const fresh = !!f && f.detected && now - f.lastDetectAt < 400;
      if (f && fresh) {
        smoothX += (f.headX - smoothX) * 0.45;
        smoothRoll += (f.roll - smoothRoll) * 0.4;
        steer = clamp01(0.5 + (smoothX - neutralX) * STEER_GAIN);
        aim = (smoothRoll - neutralRoll) * ROLL_GAIN;
      }
      game?.setFaceLost(!fresh);
    }

    if (game && game.getState() === 'playing') {
      game.setSteer(steer);
      game.setAim(aim);
      if (!drillActive) clipRecorder.capture(refs.gameCanvas, now);
      faceRec.frame(game.getSteps(), now);
      refs.hudScore.textContent = String(Math.round(game.getScore()));
      if (game.isBroadside()) {
        refs.feverBarFill.style.width = `${game.broadsideFraction() * 100}%`;
      }
    } else if (game && game.getState() !== 'playing' && !refs.titleScreen.classList.contains('hidden')) {
      // Title ambience: the sea keeps rolling behind the menu.
      game.renderIdle(dt);
    }

    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

// ── Weekly tournament ──
// Free play never touches any of this. A ranked voyage needs a signed-
// in Ronin wallet and an entry; the server deals the seed, and when
// the boat sinks it replays the recorded inputs to get the score. The
// number on the player's own screen is never sent.

let season: SeasonInfo | null = null;
/** Set while a ranked voyage is on the water. */
let rankedRun: { runId: string } | null = null;
let lastWasRanked = false;
let replayMode = false;

function tStatus(msg: string, isError = false): void {
  refs.tStatus.textContent = msg;
  refs.tStatus.classList.toggle('error', isError);
}

function countdown(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${m % 60}m`;
}

const ordinal = (i: number): string => ['1st', '2nd', '3rd'][i] ?? `${i + 1}th`;

async function refreshTourney(): Promise<void> {
  season = await fetchSeason();
  const s = season;
  if (!s) {
    refs.tourney.classList.add('hidden');
    return;
  }
  refs.tourney.classList.remove('hidden');
  refs.tEnds.textContent = `week ${s.season} · closes in ${countdown(s.endsAt - Date.now())} (Mon 00:00 UTC)`;
  refs.tEscrow.innerHTML = '';
  const escrowLink = document.createElement('a');
  escrowLink.href = `${s.explorer}/address/${s.tournament}`;
  escrowLink.target = '_blank';
  escrowLink.rel = 'noopener';
  escrowLink.textContent = shortAddr(s.tournament);
  refs.tEscrow.append(`🔒 pools held by the tournament contract ${s.chainId === 2020 ? '' : '(SAIGON TESTNET) '}`, escrowLink);

  refs.tPools.innerHTML = '';
  for (const t of s.tokens) {
    const el = document.createElement('div');
    el.className = 't-pool';
    const b = document.createElement('b');
    b.textContent = `${formatAmount(BigInt(t.pool), t.decimals)} ${t.symbol}`;
    const sub = document.createElement('span');
    sub.textContent = t.prizes.map((p, i) => `${ordinal(i)} ${formatAmount(BigInt(p), t.decimals)}`).join(' · ');
    el.append(b, sub);
    refs.tPools.appendChild(el);
  }

  const me = s.me?.address;
  refs.tBoard.innerHTML = '';
  s.board.forEach((row, i) => {
    const li = document.createElement('li');
    const rank = document.createElement('span');
    rank.className = 'lb-rank';
    rank.textContent = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    const name = document.createElement('span');
    name.className = 'lb-name';
    name.textContent = row.name ?? shortAddr(row.address);
    const score = document.createElement('span');
    score.className = 'lb-score';
    score.textContent = row.score.toLocaleString('en-US');
    li.append(rank, name, score);
    if (row.runId) {
      // Every ranked voyage on the board can be watched — the same
      // replay the server scored.
      const watch = document.createElement('span');
      watch.className = 'lb-watch';
      watch.textContent = '▶';
      li.appendChild(watch);
      li.classList.add('watch');
      li.title = 'watch this voyage';
      li.addEventListener('click', () => { location.search = `?replay=${row.runId}`; });
    }
    if (me && row.address === me) li.classList.add('me');
    refs.tBoard.appendChild(li);
  });
  refs.tEmpty.classList.toggle('hidden', s.board.length > 0);

  if (session() && !s.me) signOut();
  if (s.me) {
    refs.tConnect.classList.add('hidden');
    refs.tMe.classList.remove('hidden');
    const n = s.me.entries;
    refs.tMeLine.innerHTML = '';
    const who = document.createElement('span');
    who.textContent = `${s.me.name ?? shortAddr(s.me.address)} · `;
    const ent = document.createElement('span');
    ent.className = 't-entries';
    ent.textContent = `${n} ${n === 1 ? 'entry' : 'entries'}`;
    const best = document.createElement('span');
    best.textContent = s.me.best !== null
      ? ` · best ${s.me.best.toLocaleString('en-US')}${s.me.rank ? ` (#${s.me.rank})` : ''}`
      : '';
    refs.tMeLine.append(who, ent, best);
    refs.tNameRow.classList.toggle('hidden', !!s.me.name);

    refs.tBuy.innerHTML = '';
    // One entry costs the same in every token: the anchor's fixed price,
    // or its USD equivalent at today's DEX price, locked in when you enter.
    for (const t of s.tokens) {
      if (t.mode === 'closed') continue;
      const btn = document.createElement('button');
      btn.className = 'submit-btn';
      const amount = BigInt(t.price);
      btn.textContent = amount > 0n
        ? `ENTER · ${t.mode === 'quoted' ? '≈' : ''}${formatAmount(amount, t.decimals)} ${t.symbol}`
        : `ENTER · ${t.symbol} (no price)`;
      btn.addEventListener('click', () => void payEntry(t.symbol));
      btn.disabled = s.paused || amount === 0n;
      refs.tBuy.appendChild(btn);
    }
    // Fees land in this week's pool, so the entries they buy are for this week.
    const left = s.endsAt - Date.now();
    const anchorTok = s.tokens.find((t) => t.symbol === s.anchor);
    const perEntry = anchorTok?.usd ? ` · one entry ≈ $${anchorTok.usd.toFixed(2)} in any token` : '';
    refs.tNote.textContent = s.paused
      ? 'new entries are paused'
      : left < 2 * 3600_000
        ? `⚠ this week closes in ${countdown(left)} — entries bought now are only good until then`
        : `entries are for this week’s tournament${perEntry}`;
    renderOwner(s);
    refs.tRanked.disabled = n <= 0;
    refs.tRanked.textContent = n > 0 ? `RANKED VOYAGE (${n} left)` : 'RANKED VOYAGE';
  } else {
    refs.tMe.classList.add('hidden');
    refs.tOwner.classList.add('hidden');
    refs.tConnect.classList.remove('hidden');
    const opts = await walletOptions();
    refs.tConnect.textContent = opts.extension ? 'CONNECT RONIN WALLET' : 'GET RONIN WALLET';
    refs.tEmail.classList.toggle('hidden', !opts.email);
  }
  if (s.me) refs.tEmail.classList.add('hidden');

  refs.tLast.innerHTML = '';
  if (s.last && s.last.payouts.length) {
    const head = document.createElement('div');
    head.textContent = `Week ${s.last.season} winners:`;
    refs.tLast.appendChild(head);
    for (const p of s.last.payouts) {
      const t = s.tokens.find((x) => x.symbol === p.symbol);
      const line = document.createElement('div');
      line.textContent = `${ordinal(p.rank - 1)} ${shortAddr(p.address)} · ${formatAmount(BigInt(p.amount), t?.decimals ?? 18)} ${p.symbol} · `;
      if (p.paidTx) {
        const a = document.createElement('a');
        a.href = `${explorer()}/tx/${p.paidTx}`;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'paid ✓';
        line.appendChild(a);
      } else {
        line.append('payout pending');
      }
      refs.tLast.appendChild(line);
    }
  }
  refs.tLast.classList.toggle('hidden', refs.tLast.childElementCount === 0);
}

/**
 * Owner controls, shown only to the escrow's owner (or the wallet it's
 * being handed to). The contract enforces who may call; this is just
 * the button.
 */
function renderOwner(s: SeasonInfo): void {
  const me = s.me?.address;
  refs.tOwner.innerHTML = '';
  const isOwner = me === s.owner;
  const isNext = me === s.pendingOwner;
  refs.tOwner.classList.toggle('hidden', !isOwner && !isNext);
  if (isNext) {
    const btn = document.createElement('button');
    btn.className = 'submit-btn';
    btn.textContent = 'ACCEPT TOURNAMENT OWNERSHIP';
    btn.addEventListener('click', () => void ownerAction(btn, () => acceptOwnership(s), 'ownership accepted ✓'));
    refs.tOwner.append('This wallet has been offered ownership of the tournament contract.', btn);
    return;
  }
  if (!isOwner) return;
  // Entries switch: the contract's pause covers new entries only.
  const gate = document.createElement('button');
  gate.className = 'submit-btn';
  gate.textContent = s.paused ? 'OPEN ENTRIES' : 'PAUSE NEW ENTRIES';
  gate.addEventListener('click', () => void ownerAction(gate, () => setEntriesPaused(s, !s.paused),
    s.paused ? 'entries are open ✓' : 'new entries paused ✓'));
  refs.tOwner.append(s.paused ? 'Owner: entries are paused.' : 'Owner: entries are open.', gate);
  if (!s.settle) {
    const note = document.createElement('div');
    note.textContent = 'Nothing to settle yet — last week settles here 70 min after Monday 00:00 UTC.';
    refs.tOwner.appendChild(note);
    return;
  }
  const plan = s.settle;
  const btn = document.createElement('button');
  btn.className = 'submit-btn';
  btn.textContent = `SETTLE WEEK ${plan.week} ON CHAIN`;
  btn.addEventListener('click', () => void ownerAction(btn, () => settleWeek(s, (m) => tStatus(m)), `week ${plan.week} paid out ✓`));
  refs.tOwner.append(
    `Owner: week ${plan.week} is ready. Watch each winner's face clip against the replay first, and disqualify any bot with the admin script — once settled, it's final.`,
  );
  plan.winners.forEach((w, i) => {
    const line = document.createElement('div');
    const a = document.createElement('a');
    a.href = `?review=${plan.runs[i]}`;
    a.textContent = 'review ▶';
    line.append(`${ordinal(i)} ${shortAddr(w)} · ${plan.scores[i].toLocaleString('en-US')} · `, a);
    refs.tOwner.appendChild(line);
  });
  for (const k of plan.skipped) {
    const line = document.createElement('div');
    line.textContent = `passed over: ${shortAddr(k.address)} · ${k.score.toLocaleString('en-US')} — ${k.reason}`;
    line.style.opacity = '0.7';
    refs.tOwner.appendChild(line);
  }
  refs.tOwner.appendChild(btn);
}

async function ownerAction(btn: HTMLButtonElement, fn: () => Promise<string>, done: string): Promise<void> {
  btn.disabled = true;
  try {
    await fn();
    tStatus(done);
  } catch (e) {
    tStatus(walletError(e), true);
  } finally {
    await refreshTourney();
  }
}

async function connectWallet(via: WalletVia): Promise<void> {
  if (via === 'extension' && !(await walletOptions()).extension) {
    window.open('https://wallet.roninchain.com/', '_blank', 'noopener');
    return;
  }
  refs.tConnect.disabled = true;
  refs.tEmail.disabled = true;
  tStatus(via === 'stash'
    ? 'finish logging in in the Ronin Stash window, then approve the sign-in (free, moves nothing)…'
    : 'approve the connection and sign-in in your wallet (free, moves nothing)…');
  try {
    await signIn(via);
    tStatus('signed in ✓');
    await refreshTourney();
    void retryPending((m) => tStatus(m));
  } catch (e) {
    tStatus(walletError(e), true);
  } finally {
    refs.tConnect.disabled = false;
    refs.tEmail.disabled = false;
  }
}

async function payEntry(symbol: string): Promise<void> {
  const s = season;
  const token = s?.tokens.find((t) => t.symbol === symbol);
  if (!s || !token) return;
  const buttons = [...refs.tBuy.querySelectorAll('button'), refs.tRanked];
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const entries = await buyEntry(s, token, (m) => tStatus(m));
    tStatus(`entry credited ✓ — you have ${entries}`);
  } catch (e) {
    tStatus(walletError(e), true);
  } finally {
    await refreshTourney();
  }
}

/** Wallet rejections arrive as code 4001; everything else carries a message. */
function walletError(e: unknown): string {
  const err = e as { code?: number; message?: string };
  if (err?.code === 4001) return 'cancelled in your wallet';
  return err?.message?.split('\n')[0] ?? 'something went wrong';
}

function renderRules(): void {
  const s = season;
  refs.rulesBody.innerHTML = '';
  const ul = document.createElement('ul');
  const item = (text: string, link?: { href: string; label: string }): void => {
    const li = document.createElement('li');
    li.textContent = text;
    if (link) {
      const a = document.createElement('a');
      a.href = link.href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = link.label;
      li.append(' ', a);
    }
    ul.appendChild(li);
  };
  const anchorTok = s?.tokens.find((t) => t.symbol === s.anchor);
  const anchorText = anchorTok ? `${formatAmount(BigInt(anchorTok.price), anchorTok.decimals)} ${anchorTok.symbol}` : '—';
  const others = s ? s.tokens.filter((t) => t.mode === 'quoted').map((t) => t.symbol) : [];
  const contract = s ? { href: `${s.explorer}/address/${s.tournament}`, label: 'view the contract' } : undefined;
  item(`One entry = one ranked voyage. An entry costs ${anchorText}${others.length ? `, or the same value in ${others.join(' or ')} at the current DEX price (from GeckoTerminal), locked in for 10 minutes when you enter` : ''}. It's paid from your wallet straight into the tournament contract — not to any person.`, contract);
  item('Each week runs Monday 00:00 UTC to the next Monday 00:00 UTC. Entries are for the week you buy them in. Your best ranked score of the week counts; on a tie, whoever got there first ranks higher.');
  if (s) {
    item(`Each token has its own pool, made of that week's entry fees and held by the contract. When the week is settled the contract itself pays ${s.rakePercent}% to the operator and the rest to the winners: ${s.split.map((p, i) => `${ordinal(i)} ${p}%`).join(', ')}. With fewer winners than places, the places that are filled share the whole prize. These numbers are fixed in the contract and cannot be changed.`);
  }
  item('The contract has no withdraw: a pool can only go to that week\'s winners and the fixed operator cut. If a week is ever left unsettled for 30 days, every entrant can claim their own fees back from the contract directly.');
  item('Scores are never taken from your screen. The server deals every voyage its sea, records your inputs, and replays them to compute the score. Anyone can watch any run on the board.');
  item('Ranked voyages film a small, low-resolution video of your face. It stays on your device unless the run becomes your best of the week in the top 10; then it\'s uploaded privately, watched only by the tournament owner next to the replay, and deleted when the week is paid out. A top run without its face clip can\'t win a prize.');
  item('The operator names the winners from the board, and only wallets that entered that week can be named. Each winning run is checked against its face clip: runs that show non-human input — bots, scripts, injected or edited controls — are disqualified.');
  item('Leaving a ranked voyage before your boat sinks forfeits it. Entry fees are not refundable except through the 30-day rule above.');
  item('Practice voyages are never filmed: there, your camera never leaves your device.');
  refs.rulesBody.appendChild(ul);
}

function startRanked(): void {
  if (!season?.me || season.me.entries <= 0) {
    showScreen('title');
    tStatus('no entries left — buy one to sail ranked', true);
    return;
  }
  if (!MOCK && !FaceClipRecorder.supported()) {
    tStatus('this browser can\'t record the face clip ranked play needs — try Chrome, Edge or Safari', true);
    return;
  }
  let agreed = false;
  try { agreed = localStorage.getItem(CONSENT_KEY) === '1'; } catch { /* ask */ }
  if (!agreed) {
    refs.consent.classList.remove('hidden');
    return;
  }
  void startWithCamera(true);
}

/** Send a finished ranked voyage for scoring and show the verdict. */
async function submitRanked(runId: string): Promise<void> {
  const log = game?.getLog();
  const clip = await faceRec.stop();
  if (!log) return;
  refs.rankedResult.textContent = '⏳ verifying your voyage with the server…';
  try {
    const r = await finishRun(runId, log);
    const rank = r.rank ? ` · #${r.rank} this week` : '';
    const verdict = `✅ VERIFIED ${r.score.toLocaleString('en-US')}${rank}${r.best ? ' · new best!' : ''}`;
    refs.rankedResult.textContent = verdict;
    if (r.clip) {
      // A top run: its face clip goes up so it can be put forward for a prize.
      if (!clip) {
        refs.rankedResult.textContent = `${verdict} · ⚠ no face clip was recorded, so this run can't win a prize`;
      } else {
        refs.rankedResult.textContent = `${verdict} · uploading your face clip…`;
        try {
          await uploadClip(runId, r.week, clip, (pct) => {
            refs.rankedResult.textContent = `${verdict} · uploading your face clip… ${Math.round(pct)}%`;
          });
          refs.rankedResult.textContent = `${verdict} · face clip saved for review ✓`;
        } catch (e) {
          refs.rankedResult.textContent = `${verdict} · ⚠ face clip failed to upload (${(e as Error).message}) — keep this tab open and sail again to retry`;
        }
      }
    }
  } catch (e) {
    refs.rankedResult.textContent = `⚠ ${(e as Error).message}`;
  }
  void refreshTourney();
}

async function startReplay(id: string): Promise<void> {
  const rep = await fetchReplay(id);
  if (!rep) {
    setStatus('That replay could not be found.', true);
    history.replaceState(null, '', location.pathname);
    return;
  }
  replayMode = true;
  refs.replayBanner.textContent =
    `▶ REPLAY · ${rep.name ?? shortAddr(rep.addr)} · ${rep.score.toLocaleString('en-US')}`;
  refs.replayBanner.classList.remove('hidden');
  setGameplayColumn(true);
  showScreen('game');
  resetHud();
  requestAnimationFrame(() => {
    game?.startReplay(rep.seed, rep.log);
    startMusic();
  });
}

/**
 * Owner review: the face clip plays, and the server's replay of the same
 * voyage follows its playhead step for step. The gauges show the inputs
 * that were scored, so a face that isn't doing what the inputs say
 * stands out.
 */
async function startReview(id: string): Promise<void> {
  let data;
  try {
    data = await fetchReview(id);
  } catch (e) {
    setStatus(`${(e as Error).message} — sign in with the owner wallet first.`, true);
    history.replaceState(null, '', location.pathname);
    return;
  }
  replayMode = true;
  refs.reviewHead.textContent = `REVIEW · ${data.name ?? shortAddr(data.addr)} · ${data.score.toLocaleString('en-US')}`;
  refs.review.classList.remove('hidden');
  setGameplayColumn(true);
  showScreen('game');
  resetHud();
  const g = game;
  if (!g) return;
  const clip = data.clip;
  refs.reviewNone.classList.toggle('hidden', !!clip);
  refs.reviewVideo.classList.toggle('hidden', !clip);
  if (!clip) {
    // No clip: show the replay at normal speed; it can't win anyway.
    g.startReplay(data.seed, data.log);
    return;
  }
  g.startReplay(data.seed, data.log, true);
  refs.reviewVideo.src = clip.url;
  const sync = clip.sync;
  const stepAt = (ms: number): number => {
    // Interpolate between the [ms, step] samples around the playhead.
    let lo = 0;
    let hi = sync.length - 1;
    if (ms <= sync[0][0]) return sync[0][1];
    if (ms >= sync[hi][0]) return sync[hi][1];
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (sync[mid][0] <= ms) lo = mid; else hi = mid;
    }
    const [t0, s0] = sync[lo];
    const [t1, s1] = sync[hi];
    return Math.round(s0 + ((s1 - s0) * (ms - t0)) / Math.max(1, t1 - t0));
  };
  const follow = (): void => {
    if (refs.review.classList.contains('hidden')) return;
    g.seekReplay(stepAt(refs.reviewVideo.currentTime * 1000));
    const input = g.replayInput();
    if (input) {
      refs.gSteer.style.left = `${input.steer / 10}%`;
      refs.gAim.style.left = `${50 + (input.aim / 1050) * 50}%`;
      refs.gMouth.textContent = input.mouth ? 'OPEN' : 'closed';
      refs.gMouth.classList.toggle('open', input.mouth);
    }
    requestAnimationFrame(follow);
  };
  requestAnimationFrame(follow);
}

function leaveReview(): void {
  refs.review.classList.add('hidden');
  refs.reviewVideo.pause();
  refs.reviewVideo.removeAttribute('src');
  replayMode = false;
  game?.stop();
  setGameplayColumn(false);
  showScreen('title');
  history.replaceState(null, '', location.pathname);
  void refreshTourney();
}

function leaveReplay(): void {
  replayMode = false;
  refs.replayBanner.classList.add('hidden');
  history.replaceState(null, '', location.pathname);
}

// ── Calibration: 3-2-1, and your resting head becomes centre ──

function runCalibration(): Promise<void> {
  return new Promise((resolve) => {
    if (MOCK) { resolve(); return; }
    refs.calib.classList.remove('hidden');
    refs.calibTitle.textContent = 'HOLD STILL, CAPTAIN';
    refs.calibText.textContent = 'sit square to the screen — this becomes your centre';
    const xs: number[] = [];
    const rolls: number[] = [];
    let n = 3;
    refs.calibCount.textContent = String(n);

    const sample = window.setInterval(() => {
      const f = faceState();
      if (f?.detected) {
        xs.push(f.headX);
        rolls.push(f.roll);
      }
    }, 40);

    const step = window.setInterval(() => {
      n--;
      if (n > 0) {
        refs.calibCount.textContent = String(n);
        if (n === 1) refs.calibText.textContent = 'ready…';
        return;
      }
      clearInterval(step);
      clearInterval(sample);
      if (xs.length > 4) {
        neutralX = median(xs);
        neutralRoll = median(rolls);
        smoothX = neutralX;
        smoothRoll = neutralRoll;
      }
      refs.calibCount.textContent = '⚓';
      refs.calibTitle.textContent = 'SET SAIL!';
      refs.calibText.textContent = 'move your head to steer · tilt to aim · chomp to fire';
      setTimeout(() => {
        refs.calib.classList.add('hidden');
        resolve();
      }, 750);
    }, 800);
  });
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ── Drill — a playable tutorial ──
//
// The old version was five cards of prose over a frozen screen, with a
// cartoon boat on a fake track. This runs the REAL loop in drill mode:
// the sea sends nothing on its own, the hull can't be lost, and the
// director below puts exactly one idea on the water at a time and
// waits for the player to actually do it. You learn the gun by firing
// the gun.

const TUT_KEY = 'ronke:boatDrillSeen';
let forceTutorial = false;

/** Signals counted for the current step. Reset at every step boundary. */
const tally = {
  hullHits: 0, barrelPops: 0, powderBlasts: 0, supplies: 0,
  enemySunk: 0, shots: 0, mighty: 0,
};
let drillActive = false;

function resetTally(): void {
  tally.hullHits = 0; tally.barrelPops = 0; tally.powderBlasts = 0;
  tally.supplies = 0; tally.enemySunk = 0; tally.shots = 0; tally.mighty = 0;
}

/** Fed from handleSignal so the director can watch the real loop. */
function drillObserve(s: Signal): void {
  if (!drillActive) return;
  switch (s) {
    case 'hull-hit': tally.hullHits++; break;
    case 'barrel-pop': tally.barrelPops++; break;
    case 'powder-blast': tally.powderBlasts++; break;
    case 'supply': tally.supplies++; break;
    case 'enemy-sunk': tally.enemySunk++; break;
    case 'fire-light': tally.shots++; break;
    case 'fire-mighty': tally.shots++; tally.mighty++; break;
  }
}

let flashTimer = 0;
function drillFlash(text: string, bad = false): void {
  refs.drillFlash.textContent = text;
  refs.drillFlash.className = `drill-flash${bad ? ' bad' : ''}`;
  void refs.drillFlash.offsetWidth;
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => refs.drillFlash.classList.add('hidden'), 900);
}

interface DrillStep {
  title: string;
  text: string;
  /** Live hint; may re-read progress counters. */
  hint: () => string;
  /** Stage the water for this lesson. */
  setup?: (g: Game) => void;
  /** Called every frame — keep the lesson stocked. */
  tick?: (g: Game) => void;
  /** True once the player has demonstrated it. */
  done: (g: Game) => boolean;
  /** Shown big and green on completion. */
  cheer?: string;
}

/** Drop a barrel roughly in the player's lane, so it must be dodged. */
function lanePinnedToBoat(g: Game): number {
  const side = Math.random() < 0.5 ? -1 : 1;
  return Math.max(0.08, Math.min(0.92, g.boatFraction() + side * 0.04));
}

function drillSteps(): DrillStep[] {
  let leftDone = false, rightDone = false;
  let tiltL = false, tiltR = false;
  let dodged = 0, pending = false;

  return [
    {
      title: 'TAKE THE HELM',
      text: 'Lean left and right. The whole boat follows your head — this is how you dodge everything the sea throws at you.',
      hint: () => (leftDone !== rightDone ? 'now the other way' : 'lean both ways'),
      done: () => {
        if (steer < 0.3) leftDone = true;
        if (steer > 0.7) rightDone = true;
        return leftDone && rightDone;
      },
      cheer: 'HELM IS YOURS',
    },
    {
      title: 'DODGE',
      text: 'Barrels roll down the sea at you. You cannot shoot your way out of a bad position — move the boat.',
      hint: () => `let ${3 - dodged} more past you`,
      setup: (g) => { dodged = 0; pending = false; g.setHull(3); },
      tick: (g) => {
        if (g.liveBarrels() === 0) {
          if (pending) {
            if (tally.hullHits > 0) { resetTally(); drillFlash('WATCH THE LANE', true); }
            else { dodged++; if (dodged < 3) drillFlash('CLEAN!'); }
          }
          g.drillBarrel('wood', lanePinnedToBoat(g), 1);
          pending = true;
        }
      },
      done: () => dodged >= 3,
      cheer: 'NICE SAILING',
    },
    {
      title: 'SWING THE GUN',
      text: 'Now tilt your head like a curious monke. The cannon swings with the tilt — watch the dashed tracer. Steering and aiming are separate axes, and you will need both at once.',
      hint: () => (tiltL !== tiltR ? 'now tilt the other way' : 'tilt both ways'),
      setup: (g) => g.drillClear(),
      done: () => {
        if (aim < -0.55) tiltL = true;
        if (aim > 0.55) tiltR = true;
        return tiltL && tiltR;
      },
      cheer: 'GUN IS LIVE',
    },
    {
      title: 'CHOMP TO FIRE',
      text: 'Open your mouth to pack the powder, close it to FIRE. Put the tracer on a barrel and chomp.',
      hint: () => `pop ${2 - tally.barrelPops} more`,
      setup: (g) => { resetTally(); g.drillClear(); },
      tick: (g) => {
        if (g.liveBarrels() === 0) g.drillBarrel('wood', 0.2 + Math.random() * 0.6, 0.5);
      },
      done: () => tally.barrelPops >= 2,
      cheer: 'GOOD SHOOTING',
    },
    {
      title: 'HOLD FOR A MIGHTY BALL',
      text: 'Hold the gape and let it go for a MIGHTY ball that punches straight through. SPIKED barrels shrug off a quick chomp — these need the charge.',
      hint: () => `split ${2 - tally.barrelPops} more`,
      setup: (g) => { resetTally(); g.drillClear(); },
      tick: (g) => {
        if (g.liveBarrels() === 0) g.drillBarrel('spike', 0.2 + Math.random() * 0.6, 0.5);
      },
      done: () => tally.barrelPops >= 2,
      cheer: 'MIGHTY!',
    },
    {
      title: 'POWDER KEGS',
      text: 'Kegs chain-explode. One shot clears a whole lane — and a keg popped high, next to a pirate, hurts the pirate too. This is the one barrel worth a reload.',
      hint: () => 'set off a keg',
      setup: (g) => {
        resetTally();
        g.drillClear();
        for (let i = 0; i < 3; i++) g.drillBarrel('powder', 0.32 + i * 0.18, 0.42);
      },
      tick: (g) => {
        if (g.liveBarrels() === 0 && tally.powderBlasts === 0) {
          for (let i = 0; i < 3; i++) g.drillBarrel('powder', 0.32 + i * 0.18, 0.42);
        }
      },
      done: () => tally.powderBlasts >= 1,
      cheer: 'BOOM',
    },
    {
      title: 'SUPPLY CRATES',
      text: 'A plank is gone. Crates are your only repair — and your shot passes straight through them, so you have to catch one with the boat.',
      hint: () => 'ram the crate',
      setup: (g) => { resetTally(); g.drillClear(); g.setHull(2); },
      tick: (g) => {
        if (g.liveBarrels() === 0) g.drillBarrel('rice', 0.15 + Math.random() * 0.7, 0.5);
      },
      done: () => tally.supplies >= 1,
      cheer: 'PLANK REPAIRED',
    },
    {
      title: 'SINK THE PIRATE',
      text: 'This is the job — pirates are where the loot is, and everything else is just the way there. An IRONCLAD only takes damage when its PORTS OPEN: charge while it is shut, fire the instant it opens.',
      hint: () => 'sink the ironclad',
      setup: (g) => { resetTally(); g.drillClear(); g.setHull(3); g.drillEnemy('ironclad', 16); },
      // If the pirate ever leaves without being sunk, send another —
      // this step has no other exit and must not be able to deadlock.
      tick: (g) => { if (!g.enemyAlive() && tally.enemySunk === 0) g.drillEnemy('ironclad', 16); },
      done: () => tally.enemySunk >= 1,
      cheer: 'PIRATE SUNK!',
    },
    {
      title: 'KEEP THE CHAIN',
      text: 'Every hit builds your chain: 12 in a row lights BROADSIDE — triple shot, half reload, double loot. Stop shooting for a few seconds and the chain lapses. Keep the gun busy.',
      hint: () => 'chomp to set sail',
      setup: (g) => { resetTally(); g.drillClear(); },
      done: () => tally.shots >= 1,
      cheer: 'SET SAIL!',
    },
  ];
}

async function runDrill(): Promise<void> {
  const g = game;
  if (!g) return;
  const steps = drillSteps();
  drillActive = true;
  resetTally();
  refs.tutorial.classList.remove('hidden');
  g.start({ drill: true });

  let skipped = false;
  const skipPromise = new Promise<void>((res) => {
    refs.tutSkip.onclick = (): void => { skipped = true; res(); };
  });

  for (let i = 0; i < steps.length && !skipped; i++) {
    const step = steps[i];
    refs.tutTitle.textContent = step.title;
    refs.tutText.textContent = step.text;
    refs.tutDots.innerHTML = steps
      .map((_, d) => `<span class="drill-dot${d === i ? ' on' : d < i ? ' done' : ''}"></span>`)
      .join('');
    step.setup?.(g);
    // Write the hint before the poll loop starts, or the previous
    // step's counter stays on screen until the first tick.
    refs.tutHint.textContent = step.hint();

    await Promise.race([
      new Promise<void>((res) => {
        const id = window.setInterval(() => {
          if (g.getState() !== 'playing') { clearInterval(id); res(); return; }
          step.tick?.(g);
          refs.tutHint.textContent = step.hint();
          if (step.done(g)) { clearInterval(id); res(); }
        }, 60);
      }),
      skipPromise,
    ]);

    if (!skipped) {
      if (step.cheer) drillFlash(step.cheer);
      await new Promise((r) => setTimeout(r, 850));
    }
  }

  drillActive = false;
  g.drillClear();
  g.stop();
  refs.tutorial.classList.add('hidden');
  refs.drillFlash.classList.add('hidden');
  refs.tutSkip.onclick = null;
  try { localStorage.setItem(TUT_KEY, '1'); } catch { /* ignore */ }
  forceTutorial = false;
}

function needsTutorial(): boolean {
  return forceTutorial || localStorage.getItem(TUT_KEY) !== '1';
}


// ── Signals from the loop → sound + feedback ──

function handleSignal(s: Signal, value = 0): void {
  drillObserve(s);
  switch (s) {
    case 'charge':
      startChargeSfx(DEFAULT_GAME_CONFIG.fullChargeMs / 1000);
      break;
    case 'fire-light':
    case 'fire-mighty':
      stopChargeSfx();
      sfxFire(value);
      if (s === 'fire-mighty') showFeedback('MIGHTY!', 'perfect');
      break;
    case 'dry-click':
      stopChargeSfx();
      sfxDryClick();
      break;
    case 'barrel-pop': sfxBarrelPop(); break;
    case 'powder-blast': sfxPowderBlast(); break;
    case 'ping': sfxPing(); break;
    case 'supply': sfxSupply(); break;
    case 'enemy-hit': sfxEnemyHit(); break;
    case 'enemy-sunk':
      sfxEnemySunk();
      showFeedback('PIRATE SUNK!', 'good');
      break;
    case 'boss-in':
      sfxBossIn();
      showFeedback('RUGBEARD!', 'miss');
      break;
    case 'boss-sunk':
      sfxBossSunk();
      showFeedback('BOSS DOWN!', 'perfect');
      break;
    case 'hull-hit':
      sfxHullHit();
      shakeScreen();
      showFeedback('HULL BREACH!', 'miss');
      break;
    case 'broadside':
      sfxBroadside();
      break;
    case 'stage-up':
      sfxStage();
      break;
  }
}

// ── Game lifecycle ──

function makeGame(): Game {
  const g = new Game(refs.gameCanvas, DEFAULT_GAME_CONFIG, {
    onSignal: handleSignal,
    onHull: (hp, hit) => {
      renderHull(hp, hit);
      if (hp === 1) startHeartbeat(); else stopHeartbeat();
    },
    onCombo: (combo, mul) => {
      if (combo >= 3) {
        refs.hudCombo.textContent = `${combo}× CHAIN · ${mul}× LOOT`;
        refs.hudCombo.classList.remove('hidden');
      } else {
        refs.hudCombo.classList.add('hidden');
      }
    },
    onStage: (info) => showStage(info),
    onEnemyHealth: (frac, name, boss) => {
      if (frac <= 0 && !name) {
        refs.enemyBar.classList.add('hidden');
        return;
      }
      refs.enemyBar.classList.remove('hidden');
      refs.enemyBar.classList.toggle('boss', boss);
      refs.enemyName.textContent = name;
      refs.enemyFill.style.width = `${Math.max(0, frac) * 100}%`;
    },
    onBroadside: (active) => {
      document.body.classList.toggle('fever', active);
      refs.feverBanner.classList.toggle('hidden', !active);
    },
    onEnd: (score, stats) => {
      stopHeartbeat();
      stopChargeSfx();
      stopMusic();
      sfxGameOver();
      setGameplayColumn(false);
      document.body.classList.remove('fever');
      refs.feverBanner.classList.add('hidden');
      refs.enemyBar.classList.add('hidden');
      refs.hudCombo.classList.add('hidden');
      if (!replayMode) saveBest(score);
      refs.overScore.textContent = String(score);
      refs.overBest.textContent = `best: ${loadBest()} 🪙`;
      lastRank = rankForScore(score);
      lastScore = score;
      lastPirates = stats.pirates + stats.bosses;
      refs.rankChip.textContent = lastRank;
      lastWasRanked = !!rankedRun;
      if (rankedRun) {
        const run = rankedRun;
        rankedRun = null;
        void submitRanked(run.runId);
      } else if (replayMode) {
        refs.rankedResult.textContent = 'replay of a server-verified voyage';
      } else {
        refs.rankedResult.textContent = season ? 'practice voyage — not ranked. the weekly tournament is in port.' : '';
      }
      refs.againBtn.textContent = replayMode ? 'WATCH AGAIN' : lastWasRanked ? 'RANKED AGAIN' : 'SAIL AGAIN';
      refs.statsRow.innerHTML = '';
      const stat = (value: string | number, label: string): void => {
        const el = document.createElement('div');
        el.className = 'stat';
        const b = document.createElement('b');
        b.textContent = String(value);
        const s = document.createElement('span');
        s.textContent = label;
        el.append(b, s);
        refs.statsRow.appendChild(el);
      };
      const acc = stats.shots > 0 ? Math.round((stats.hits / stats.shots) * 100) : 0;
      stat(stats.pirates, 'pirates sunk');
      stat(stats.bosses, 'bosses');
      stat(stats.barrels, 'barrels');
      stat(`${stats.bestCombo}×`, 'best chain');
      stat(stats.mighty, 'mighty shots');
      stat(`${acc}%`, 'accuracy');
      stat(`${stats.distance.toFixed(1)}nm`, 'sailed');
      showScreen('over');
      void buildClip();
    },
  });
  g.setCaptainSource(refs.video, faceState);
  return g;
}

function resetHud(): void {
  renderHull(DEFAULT_GAME_CONFIG.hull);
  refs.hudScore.textContent = '0';
  refs.hudCombo.classList.add('hidden');
  refs.feverBanner.classList.add('hidden');
  refs.enemyBar.classList.add('hidden');
  document.body.classList.remove('fever');
  stopHeartbeat();
  releaseClip();
  refs.clip.classList.add('hidden');
  clipRecorder.reset();
}

function startGame(ranked = false): void {
  setGameplayColumn(true);
  showScreen('game');
  requestAnimationFrame(async () => {
    if (!game) game = makeGame();
    resetHud();
    startPump();
    await runCalibration();
    if (needsTutorial()) await runDrill();
    if (ranked) {
      // The entry is spent here, after the countdown and any drill, so
      // nothing before the first barrel can cost a paid voyage.
      // The camera must be live before an entry is spent — no camera, no clip.
      if (!MOCK && !refs.video.videoWidth) {
        setGameplayColumn(false);
        showScreen('title');
        tStatus('camera not ready — ranked voyages need it for the face clip', true);
        return;
      }
      try {
        const run = await startRun();
        rankedRun = { runId: run.runId };
        game.start({ seed: run.seed, record: true });
        if (!MOCK) faceRec.start(refs.video);
      } catch (e) {
        rankedRun = null;
        setGameplayColumn(false);
        showScreen('title');
        tStatus((e as Error).message, true);
        void refreshTourney();
        return;
      }
    } else {
      rankedRun = null;
      faceRec.discard();
      game.start();
    }
    startMusic();
  });
}

// ── Startup ──

async function startWithCamera(ranked = false): Promise<void> {
  initAudio();
  setStatus(null);

  if (MOCK) {
    startGame(ranked);
    return;
  }

  const tier = detectDeviceTier();
  console.log(`[main] device tier: ${tier}`);

  if (!detector) {
    setLoading('LOADING MONKE…');
    detector = new FaceController(refs.video, configForTier(tier));
    try {
      await detector.init();
    } catch (e) {
      console.error('[main] detector init failed', e);
      setStatus('Detection failed to load — reload and try again.', true);
      setLoading(null);
      detector = null;
      return;
    }
  }

  setLoading('WAKING CAMERA…');
  try {
    await detector.startCamera();
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    console.error('[main] camera failed', e);
    setStatus(
      name === 'NotAllowedError'
        ? 'Camera permission denied — Ronke needs the camera to sail.'
        : 'Camera unavailable — is another app using it?',
      true,
    );
    detector.stop();
    detector = null;
    setLoading(null);
    return;
  }

  // The sim times the charge itself, in game time — all it needs is
  // whether the mouth is open on each step.
  detector.onMouthOpen = (): void => {
    game?.setMouth(true);
  };
  detector.onMouthClose = (): void => {
    game?.setMouth(false);
  };
  detector.start();
  document.documentElement.setAttribute('data-ar', '');
  setLoading(null);
  startGame(ranked);
}

// ── Mock rig (?mock=1): mouse steers, aims and fires ──

if (MOCK) {
  window.addEventListener('pointermove', (e) => {
    mockX = e.clientX / window.innerWidth;
    mockAim = ((e.clientY / window.innerHeight) - 0.5) * 2 * DEFAULT_GAME_CONFIG.maxAim;
  });
  const down = (): void => {
    if (mockDown) return;
    mockDown = true;
    game?.setMouth(true);
  };
  const up = (): void => {
    if (!mockDown) return;
    mockDown = false;
    game?.setMouth(false);
  };
  window.addEventListener('pointerdown', down);
  window.addEventListener('pointerup', up);
  window.addEventListener('keydown', (e) => { if (e.code === 'Space') down(); });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') up(); });
  console.log('[main] MOCK controls: mouse X steers, mouse Y aims, hold to charge');
}

// ── Buttons ──

refs.shareBtn.addEventListener('click', () => {
  const url =
    `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText(false))}` +
    `&url=${encodeURIComponent(GAME_URL)}`;
  window.open(url, '_blank', 'noopener');
});

refs.clipShare.addEventListener('click', () => void shareClip());
refs.clipSave.addEventListener('click', () => downloadClip());

refs.howBtn.addEventListener('click', () => {
  forceTutorial = true;
  setStatus('the drill will run before your next voyage');
});

refs.tConnect.addEventListener('click', () => void connectWallet('extension'));
refs.tEmail.addEventListener('click', () => void connectWallet('stash'));
refs.tSignout.addEventListener('click', () => {
  signOut();
  tStatus('signed out');
  void refreshTourney();
});
refs.tRanked.addEventListener('click', () => startRanked());
refs.tRulesBtn.addEventListener('click', () => {
  renderRules();
  refs.rules.classList.remove('hidden');
});
refs.rulesClose.addEventListener('click', () => refs.rules.classList.add('hidden'));
refs.consentYes.addEventListener('click', () => {
  try { localStorage.setItem(CONSENT_KEY, '1'); } catch { /* asked again next time */ }
  refs.consent.classList.add('hidden');
  startRanked();
});
refs.consentNo.addEventListener('click', () => refs.consent.classList.add('hidden'));
refs.reviewClose.addEventListener('click', () => leaveReview());
const saveName = async (): Promise<void> => {
  try {
    await setName(refs.tName.value);
    tStatus('name saved ✓');
    await refreshTourney();
  } catch (e) {
    tStatus((e as Error).message, true);
  }
};
refs.tNameBtn.addEventListener('click', () => void saveName());
refs.tName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void saveName();
});

refs.playBtn.addEventListener('click', () => void startWithCamera());
refs.againBtn.addEventListener('click', () => {
  if (replayMode && REPLAY_ID) void startReplay(REPLAY_ID);
  else if (lastWasRanked) startRanked();
  else startGame();
});
refs.homeBtn.addEventListener('click', () => {
  game?.stop();
  stopMusic();
  stopHeartbeat();
  if (replayMode) leaveReplay();
  setGameplayColumn(false);
  document.body.classList.remove('fever');
  showScreen('title');
  refreshTitle();
  void refreshTourney();
});

// ── Mute toggle ──
const muteBtn = $<HTMLButtonElement>('mute-btn');
const renderMute = (): void => { muteBtn.textContent = isMuted() ? '🔇' : '🔊'; };
muteBtn.addEventListener('click', () => {
  initAudio();
  setMuted(!isMuted());
  renderMute();
});
renderMute();

function refreshTitle(): void {
  const best = loadBest();
  refs.titleBest.textContent = best > 0 ? `best voyage: ${best} 🪙` : '';
}

// The sea rolls behind the title from the first frame.
game = makeGame();
// Mock rig only: hand the loop to the console for tuning.
if (MOCK) {
  const w = window as unknown as { __game: Game; __clip: ClipRecorder };
  w.__game = game;
  w.__clip = clipRecorder;
}
startPump();
refreshTitle();
showScreen('title');
void refreshTourney().then(() => retryPending((m) => tStatus(m)));
if (REVIEW_ID) void startReview(REVIEW_ID);
else if (REPLAY_ID) void startReplay(REPLAY_ID);
