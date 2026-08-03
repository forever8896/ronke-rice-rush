// ═════════════════════════════════════════════════════════════
// Audio — synthesised gunnery over the Ronke sample set.
//
// Cannons, splintering barrels and powder blasts are all noise-and-
// envelope work, so they're synthesised in WebAudio: no download, no
// decode wait, and the boom can scale continuously with how long the
// player held their mouth open (a sampled boom can't).
//
// The Venice-generated samples that still fit the sea carry the rest:
//
//   gold             shrine bell → supply crate recovered
//   fever            taiko roll + gong → BROADSIDE / boss arrival
//   splash           water → barrels going into the drink
//   lose             sad flute → the boat is splinters
//   heartbeat-*      looped on the last plank
//   music-ronke-1/2  60s loopable arcade tracks, one per voyage
//
// Mute persists in localStorage.
// ═════════════════════════════════════════════════════════════

const SAMPLE_URLS: Record<string, string[]> = {
  gold: ['/sounds/gold.mp3'],
  fever: ['/sounds/fever.mp3'],
  splash: ['/sounds/splash.mp3'],
  heartbeat: ['/sounds/heartbeat-1.mp3', '/sounds/heartbeat-2.mp3'],
  lose: ['/sounds/lose.mp3'],
  music: ['/sounds/music-ronke-1.mp3', '/sounds/music-ronke-2.mp3'],
};

const MUTE_KEY = 'ronke:muted';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let musicGain: GainNode | null = null;
let musicSource: AudioBufferSourceNode | null = null;
let heartbeatSource: AudioBufferSourceNode | null = null;
let noiseBuf: AudioBuffer | null = null;
const buffers: Record<string, AudioBuffer[]> = {};
let loadKicked = false;

export function isMuted(): boolean {
  return localStorage.getItem(MUTE_KEY) === '1';
}

export function setMuted(m: boolean): void {
  localStorage.setItem(MUTE_KEY, m ? '1' : '0');
  if (master && ctx) master.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, 0.02);
}

/** Call from a user gesture (SET SAIL) so autoplay policy allows it. */
export function initAudio(): void {
  if (ctx) {
    if (ctx.state === 'suspended') void ctx.resume();
    kickLoad();
    return;
  }
  try {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = isMuted() ? 0 : 1;
    master.connect(ctx.destination);
    musicGain = ctx.createGain();
    musicGain.gain.value = 0.36;
    musicGain.connect(master);
    // 2s of white noise, reused by every crack, boom and splash.
    const len = Math.floor(ctx.sampleRate * 2);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  } catch {
    ctx = null; // no audio — the game plays silent
    return;
  }
  kickLoad();
}

function kickLoad(): void {
  if (loadKicked || !ctx) return;
  loadKicked = true;
  for (const [name, urls] of Object.entries(SAMPLE_URLS)) {
    buffers[name] = [];
    urls.forEach((url) => {
      fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
        .then((ab) => ctx!.decodeAudioData(ab))
        .then((buf) => buffers[name].push(buf))
        .catch((e) => console.warn(`[audio] failed to load ${url}`, e));
    });
  }
}

function playSample(name: string, gain = 1, rate = 1): AudioBufferSourceNode | null {
  if (!ctx || !master || ctx.state !== 'running') return null;
  const takes = buffers[name];
  if (!takes || takes.length === 0) return null;
  const src = ctx.createBufferSource();
  src.buffer = takes[Math.floor(Math.random() * takes.length)];
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(g).connect(master);
  src.start();
  return src;
}

// ── Synth building blocks ──

/** Filtered noise burst: cracks, splinters, blasts. */
function noise(
  durS: number,
  peak: number,
  type: BiquadFilterType,
  f0: number,
  f1: number,
  q = 1,
): void {
  if (!ctx || !master || !noiseBuf || ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const filt = ctx.createBiquadFilter();
  filt.type = type;
  filt.Q.value = q;
  filt.frequency.setValueAtTime(f0, t0);
  filt.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t0 + durS);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0008, t0 + durS);
  src.connect(filt).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + durS + 0.05);
}

/** Pitched body: the thump under a boom, bells, horns. */
function tone(
  freq: number,
  freqEnd: number,
  durS: number,
  peak: number,
  type: OscillatorType = 'sine',
  delay = 0,
): void {
  if (!ctx || !master || ctx.state !== 'running') return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t0 + durS);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0008, t0 + durS);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + durS + 0.05);
}

// ── Gunnery ──

/** The shot. `power` 0..1 turns a pop into a MIGHTY boom. */
export function sfxFire(power: number): void {
  const p = Math.max(0, Math.min(1, power));
  noise(0.16 + p * 0.5, 0.42 + p * 0.3, 'lowpass', 2600 - p * 1200, 160 - p * 90);
  tone(140 - p * 70, 34 - p * 14, 0.22 + p * 0.42, 0.4 + p * 0.28, 'sine');
  if (p > 0.75) {
    tone(70, 28, 0.7, 0.3, 'triangle', 0.02);
    noise(0.9, 0.16, 'lowpass', 700, 90);
  }
}

/** Trigger pulled mid-reload. */
export function sfxDryClick(): void {
  noise(0.05, 0.18, 'bandpass', 2400, 1400, 6);
}

/** Barrel bursting into splinters. */
export function sfxBarrelPop(): void {
  noise(0.19, 0.34, 'bandpass', 1500, 420, 1.4);
  tone(300, 110, 0.13, 0.16, 'square');
}

/** Powder keg chain — the payoff shot. */
export function sfxPowderBlast(): void {
  noise(0.75, 0.55, 'lowpass', 1900, 70);
  tone(110, 26, 0.8, 0.45, 'sine');
  tone(220, 48, 0.35, 0.2, 'sawtooth', 0.01);
}

/** Iron on iron — armour turned the shot. */
export function sfxPing(): void {
  tone(1850, 1200, 0.22, 0.16, 'triangle');
  tone(2760, 1900, 0.16, 0.09, 'sine', 0.01);
  noise(0.09, 0.12, 'bandpass', 3600, 2400, 8);
}

/** Ball into pirate timber. */
export function sfxEnemyHit(): void {
  noise(0.16, 0.3, 'lowpass', 1200, 260);
  tone(190, 80, 0.16, 0.22, 'square');
}

export function sfxEnemySunk(): void {
  if (!playSample('splash', 0.7, 0.85)) noise(0.5, 0.3, 'lowpass', 900, 120);
  tone(240, 60, 0.6, 0.3, 'sawtooth');
  noise(0.6, 0.3, 'lowpass', 1400, 90);
}

export function sfxSupply(): void {
  if (!playSample('gold', 0.9)) {
    tone(880, 1320, 0.18, 0.16, 'triangle');
    tone(1320, 1760, 0.22, 0.10, 'sine', 0.06);
  }
}

/** Something hit the hull. */
export function sfxHullHit(): void {
  noise(0.42, 0.5, 'lowpass', 700, 60);
  tone(90, 34, 0.4, 0.4, 'square');
  tone(240, 70, 0.25, 0.18, 'sawtooth', 0.03);
}

/** Boss horn — three descending blasts. */
export function sfxBossIn(): void {
  playSample('fever', 0.8);
  tone(150, 140, 0.5, 0.3, 'sawtooth');
  tone(112, 106, 0.6, 0.3, 'sawtooth', 0.35);
  tone(84, 76, 1.1, 0.34, 'sawtooth', 0.75);
}

export function sfxBossSunk(): void {
  playSample('fever', 1.0);
  for (let i = 0; i < 5; i++) {
    setTimeout(() => {
      noise(0.7, 0.4, 'lowpass', 1800 - i * 200, 70);
      tone(130 - i * 14, 30, 0.7, 0.32, 'sine');
    }, i * 220);
  }
}

export function sfxBroadside(): void {
  if (!playSample('fever', 0.9)) tone(520, 1040, 0.4, 0.2, 'triangle');
}

export function sfxStage(): void {
  tone(440, 660, 0.14, 0.14, 'triangle');
  tone(660, 880, 0.18, 0.12, 'triangle', 0.1);
}

export function sfxGameOver(): void {
  if (!playSample('lose', 1.0)) {
    tone(392, 330, 0.2, 0.16, 'square');
    tone(330, 262, 0.2, 0.16, 'square', 0.18);
    tone(262, 131, 0.5, 0.16, 'square', 0.36);
  }
}

// ── Charge whine — runs while the mouth is open ──

let chargeOsc: OscillatorNode | null = null;
let chargeGain: GainNode | null = null;

export function startChargeSfx(durS: number): void {
  if (!ctx || !master || ctx.state !== 'running' || chargeOsc) return;
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(120, t0);
  osc.frequency.exponentialRampToValueAtTime(680, t0 + durS);
  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.setValueAtTime(500, t0);
  filt.frequency.exponentialRampToValueAtTime(2400, t0 + durS);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(0.10, t0 + durS * 0.8);
  osc.connect(filt).connect(g).connect(master);
  osc.start(t0);
  chargeOsc = osc;
  chargeGain = g;
}

export function stopChargeSfx(): void {
  if (!ctx || !chargeOsc || !chargeGain) return;
  const t = ctx.currentTime;
  chargeGain.gain.cancelScheduledValues(t);
  chargeGain.gain.setValueAtTime(Math.max(0.0001, chargeGain.gain.value), t);
  chargeGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
  const osc = chargeOsc;
  setTimeout(() => { try { osc.stop(); } catch { /* already stopped */ } }, 120);
  chargeOsc = null;
  chargeGain = null;
}

// ── Music ──

let musicRetryTimer = 0;

export function startMusic(): void {
  if (!ctx || !musicGain || musicSource) return;
  const takes = buffers['music'];
  if (!takes || takes.length === 0) {
    clearTimeout(musicRetryTimer);
    musicRetryTimer = window.setTimeout(startMusic, 500);
    return;
  }
  const src = ctx.createBufferSource();
  src.buffer = takes[Math.floor(Math.random() * takes.length)];
  src.loop = true;
  src.connect(musicGain);
  musicGain.gain.setValueAtTime(0, ctx.currentTime);
  musicGain.gain.linearRampToValueAtTime(0.36, ctx.currentTime + 1.2);
  src.start();
  musicSource = src;
}

export function stopMusic(fadeMs = 800): void {
  clearTimeout(musicRetryTimer);
  if (!ctx || !musicGain || !musicSource) return;
  const src = musicSource;
  musicSource = null;
  musicGain.gain.setTargetAtTime(0, ctx.currentTime, fadeMs / 4000);
  setTimeout(() => { try { src.stop(); } catch { /* already stopped */ } }, fadeMs + 100);
}

// ── Heartbeat on the last plank ──

export function startHeartbeat(): void {
  if (!ctx || heartbeatSource) return;
  const src = playSample('heartbeat', 0.85);
  if (src) {
    src.loop = true;
    heartbeatSource = src;
  }
}

export function stopHeartbeat(): void {
  if (heartbeatSource) {
    try { heartbeatSource.stop(); } catch { /* already stopped */ }
    heartbeatSource = null;
  }
}
