// ═════════════════════════════════════════════════════════════
// Audio — Ronke-world samples (Venice-generated: elevenlabs music
// + sound-effects models) played through vanilla WebAudio.
//
//   chomp-1..2       bite on every catch (random take)
//   gold             shrine-bell ding for golden $RICE
//   rug              record-scratch fail for RUGGED
//   fever            taiko roll → gong for RONKE ARC
//   splash           rice hitting the paddy water (a miss)
//   lose             sad flute game-over jingle
//   heartbeat-*      looped while on the last life
//   music-ronke-1/2  60s loopable Japanese-arcade tracks, one
//                    random pick per round
//
// Samples load in the background after initAudio(); until a buffer
// is ready each effect falls back to a synth blip so the game is
// never silent. Mute persists in localStorage.
// ═════════════════════════════════════════════════════════════

const SAMPLE_URLS: Record<string, string[]> = {
  chomp: ['/sounds/chomp-1.mp3', '/sounds/chomp-2.mp3'],
  gold: ['/sounds/gold.mp3'],
  rug: ['/sounds/rug.mp3'],
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
const buffers: Record<string, AudioBuffer[]> = {};
let loadKicked = false;

export function isMuted(): boolean {
  return localStorage.getItem(MUTE_KEY) === '1';
}

export function setMuted(m: boolean): void {
  localStorage.setItem(MUTE_KEY, m ? '1' : '0');
  if (master && ctx) {
    master.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, 0.02);
  }
}

/** Call from a user gesture (PLAY click) so autoplay policy allows it. */
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
    musicGain.gain.value = 0.45;
    musicGain.connect(master);
  } catch {
    ctx = null; // no audio — game plays silent
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

/** Play a random loaded take of the named sample. Returns false if none ready. */
function playSample(name: string, gain = 1, dest?: AudioNode): AudioBufferSourceNode | null {
  if (!ctx || !master || ctx.state !== 'running') return null;
  const takes = buffers[name];
  if (!takes || takes.length === 0) return null;
  const buf = takes[Math.floor(Math.random() * takes.length)];
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(g).connect(dest ?? master);
  src.start();
  return src;
}

// Synth fallback for the pre-load window — same envelope helper as v1.
function blip(freq: number, durMs: number, type: OscillatorType = 'square', gainPeak = 0.12, freqEnd?: number): void {
  if (!ctx || !master || ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, t0 + durMs / 1000);
  g.gain.setValueAtTime(gainPeak, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + durMs / 1000);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + durMs / 1000 + 0.02);
}

// ── Public SFX API ──

export function sfxCatch(): void {
  if (!playSample('chomp', 0.9)) blip(520, 120, 'square', 0.10, 780);
}

export function sfxPerfect(): void {
  // Chomp + a bright synth sparkle on top — layering reads extra-juicy.
  if (!playSample('chomp', 1.0)) blip(660, 90, 'square', 0.10, 990);
  blip(990, 140, 'triangle', 0.07, 1320);
}

export function sfxGold(): void {
  playSample('chomp', 0.9);
  if (!playSample('gold', 0.9)) blip(1046, 200, 'triangle', 0.13, 1568);
}

export function sfxRug(): void {
  if (!playSample('rug', 0.9)) blip(220, 260, 'sawtooth', 0.09, 110);
}

export function sfxFever(): void {
  if (!playSample('fever', 1.0)) blip(1046, 300, 'triangle', 0.13, 1568);
}

export function sfxSplash(): void {
  if (!playSample('splash', 0.9)) blip(300, 200, 'sine', 0.08, 120);
}

export function sfxGameOver(): void {
  if (!playSample('lose', 1.0)) {
    blip(392, 180, 'square', 0.10, 330);
    setTimeout(() => blip(330, 180, 'square', 0.10, 262), 170);
    setTimeout(() => blip(262, 420, 'square', 0.10, 131), 340);
  }
}

// ── Music loop ──

let musicRetryTimer = 0;

export function startMusic(): void {
  if (!ctx || !musicGain || musicSource) return;
  const takes = buffers['music'];
  if (!takes || takes.length === 0) {
    // Buffers still decoding — retry until one lands (max ~10s).
    clearTimeout(musicRetryTimer);
    musicRetryTimer = window.setTimeout(startMusic, 500);
    return;
  }
  const buf = takes[Math.floor(Math.random() * takes.length)];
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.connect(musicGain);
  musicGain.gain.setValueAtTime(0, ctx.currentTime);
  musicGain.gain.linearRampToValueAtTime(0.45, ctx.currentTime + 1.2);
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

// ── Heartbeat — looped while on the last life ──

export function startHeartbeat(): void {
  if (!ctx || heartbeatSource) return;
  const src = playSample('heartbeat', 0.9);
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
