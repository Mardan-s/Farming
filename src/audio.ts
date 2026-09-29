// Tiny synthesized sound effects so the game ships without audio files.

let ctx: AudioContext | null = null;
let muted = false;

export function setMuted(m: boolean) { muted = m; }

export function unlockAudio() {
  if (ctx) { if (ctx.state === 'suspended') void ctx.resume(); return; }
  try {
    ctx = new AudioContext();
  } catch {
    ctx = null;
  }
}

function tone(freq: number, dur: number, type: OscillatorType, vol: number, delay = 0, slideTo?: number) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

let noiseBuf: AudioBuffer | null = null;
function noise() {
  if (!ctx) return null;
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

let rain: { gain: GainNode } | null = null;

/** Continuous rain hiss; level 0 turns it off. */
export function setRain(level: number) {
  if (!ctx) return;
  const buf = noise();
  if (!buf) return;
  if (!rain) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1400;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start();
    rain = { gain };
  }
  rain.gain.gain.setTargetAtTime(muted ? 0 : level * 0.05, ctx.currentTime, 0.8);
}

function thunder() {
  if (!ctx || muted) return;
  const buf = noise();
  if (!buf) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 220;
  const gain = ctx.createGain();
  const t = ctx.currentTime;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.5, t + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
  src.connect(filter).connect(gain).connect(ctx.destination);
  src.start(t);
  src.stop(t + 2.3);
}

export const sfx = {
  thunder,
  tap: () => tone(660, 0.06, 'sine', 0.08),
  select: () => { tone(520, 0.07, 'triangle', 0.1); tone(780, 0.09, 'triangle', 0.08, 0.05); },
  confirm: () => { tone(440, 0.08, 'triangle', 0.1); tone(660, 0.08, 'triangle', 0.1, 0.07); tone(880, 0.12, 'triangle', 0.09, 0.14); },
  error: () => tone(180, 0.18, 'square', 0.05, 0, 120),
  cash: () => { tone(1320, 0.07, 'square', 0.04); tone(1760, 0.18, 'square', 0.04, 0.07); },
  corner: () => tone(900, 0.05, 'sine', 0.07),
  goal: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 'triangle', 0.09, i * 0.09)),
  buy: () => { tone(300, 0.08, 'sawtooth', 0.05, 0, 600); tone(900, 0.12, 'triangle', 0.08, 0.08); },
};
