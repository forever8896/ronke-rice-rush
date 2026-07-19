// ═════════════════════════════════════════════════════════════
// SFX — tiny WebAudio synth. No samples, no deps: the whole game
// ships zero audio files. Every sound is an oscillator envelope.
// Call initAudio() from a user gesture (PLAY click) so the
// AudioContext isn't blocked by autoplay policy.
// ═════════════════════════════════════════════════════════════

let ctx: AudioContext | null = null;

export function initAudio(): void {
  if (ctx) {
    if (ctx.state === 'suspended') void ctx.resume();
    return;
  }
  try {
    ctx = new AudioContext();
  } catch {
    ctx = null; // no audio — game plays silent
  }
}

function blip(
  freq: number,
  durMs: number,
  type: OscillatorType = 'square',
  gainPeak = 0.12,
  freqEnd?: number,
): void {
  if (!ctx || ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, t0 + durMs / 1000);
  gain.gain.setValueAtTime(gainPeak, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + durMs / 1000);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + durMs / 1000 + 0.02);
}

export function sfxCatch(): void {
  blip(520, 120, 'square', 0.10, 780);
}

export function sfxPerfect(): void {
  blip(660, 90, 'square', 0.10, 990);
  setTimeout(() => blip(990, 140, 'square', 0.10, 1320), 70);
}

export function sfxGold(): void {
  blip(784, 90, 'triangle', 0.14, 1046);
  setTimeout(() => blip(1046, 100, 'triangle', 0.13, 1318), 80);
  setTimeout(() => blip(1568, 180, 'triangle', 0.12), 160);
}

export function sfxMiss(): void {
  blip(220, 260, 'sawtooth', 0.09, 110);
}

export function sfxGameOver(): void {
  blip(392, 180, 'square', 0.10, 330);
  setTimeout(() => blip(330, 180, 'square', 0.10, 262), 170);
  setTimeout(() => blip(262, 420, 'square', 0.10, 131), 340);
}
