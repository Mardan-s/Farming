import { Radio } from './radio';

// Synthesised sound: a six-cylinder diesel with turbo whistle, wind and tyre roar, air horn,
// air-brake hiss, indicator ticks, rain, crashes and a cash register for deliveries.

export class Audio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engine: { oscs: OscillatorNode[]; gain: GainNode; filter: BiquadFilterNode } | null = null;
  private turbo: { gain: GainNode; filter: BiquadFilterNode } | null = null;
  private road: { gain: GainNode; filter: BiquadFilterNode } | null = null;
  private rain: GainNode | null = null;
  private horn: GainNode | null = null;
  private noise!: AudioBuffer;
  volume = 0.8;
  /** Six for the straight-sixes, eight for the V8. */
  cylinders = 6;
  bigHorn = false;
  private hornOscs: OscillatorNode[] = [];
  private tick = 0;
  private lastBrake = 0;

  /** Must be called from a user gesture (browsers block audio until then). */
  start() {
    if (this.ctx) { void this.ctx.resume(); return; }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // Engine: firing-frequency sawtooth plus a sub-octave square, low-passed by load.
    const gain = ctx.createGain(); gain.gain.value = 0;
    const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 400; filter.Q.value = 2;
    const oscs = [ctx.createOscillator(), ctx.createOscillator(), ctx.createOscillator()];
    oscs[0].type = 'sawtooth'; oscs[1].type = 'square'; oscs[2].type = 'sawtooth';
    const mix = [0.5, 0.35, 0.18];
    oscs.forEach((o, i) => { const g = ctx.createGain(); g.gain.value = mix[i]; o.connect(g).connect(filter); o.start(); });
    filter.connect(gain).connect(this.master);
    this.engine = { oscs, gain, filter };
    // Turbo whistle and road/wind noise.
    this.turbo = this.noiseVoice('bandpass', 2400, 12, 0);
    this.road = this.noiseVoice('lowpass', 500, 0.7, 0);
    this.rain = this.noiseVoice('highpass', 1800, 0.5, 0).gain;
    // Air horn: two detuned sawtooths.
    const hg = ctx.createGain(); hg.gain.value = 0;
    const hf = ctx.createBiquadFilter(); hf.type = 'lowpass'; hf.frequency.value = 1800;
    for (const f of [185, 233, 277]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(hf); o.start(); this.hornOscs.push(o); }
    hf.connect(hg).connect(this.master);
    this.horn = hg;
    this.radio = new Radio(ctx, this.master);
  }

  radio: Radio | null = null;

  private noiseVoice(type: BiquadFilterType, freq: number, q: number, level: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
    const filter = ctx.createBiquadFilter(); filter.type = type; filter.frequency.value = freq; filter.Q.value = q;
    const gain = ctx.createGain(); gain.gain.value = level;
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
    return { gain, filter };
  }

  private burst(type: BiquadFilterType, freq: number, dur: number, level: number, sweep = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(50, freq + sweep), ctx.currentTime + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(); src.stop(ctx.currentTime + dur + 0.05);
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.ctx) this.master.gain.value = v;
  }

  update(dt: number, s: { rpm: number; load: number; speed: number; rain: number; horn: boolean; braking: number; indicator: boolean; interior: boolean }) {
    const ctx = this.ctx;
    if (!ctx || !this.engine) return;
    const t = ctx.currentTime;
    const fire = (s.rpm / 60) * (this.cylinders / 2); // four-stroke: half the cylinders fire per revolution
    this.engine.oscs[0].frequency.setTargetAtTime(fire, t, 0.04);
    this.engine.oscs[1].frequency.setTargetAtTime(fire / 2, t, 0.04);
    this.engine.oscs[2].frequency.setTargetAtTime(fire * 1.5, t, 0.04);
    const muffle = s.interior ? 0.7 : 1;
    this.engine.filter.frequency.setTargetAtTime((220 + s.load * 900 + s.rpm * 0.25) * muffle, t, 0.06);
    this.engine.gain.gain.setTargetAtTime((0.07 + s.load * 0.12) * muffle, t, 0.08);
    const spd = Math.abs(s.speed);
    this.turbo!.gain.gain.setTargetAtTime(s.load * Math.min(1, s.rpm / 1600) * 0.035, t, 0.15);
    this.turbo!.filter.frequency.setTargetAtTime(1800 + s.rpm * 1.4, t, 0.1);
    this.road!.gain.gain.setTargetAtTime(Math.min(0.16, spd * 0.006) * (s.interior ? 0.6 : 1), t, 0.2);
    this.road!.filter.frequency.setTargetAtTime(300 + spd * 25, t, 0.2);
    this.rain!.gain.setTargetAtTime(s.rain * 0.06, t, 0.5);
    this.horn!.gain.setTargetAtTime(s.horn ? (this.bigHorn ? 0.2 : 0.12) : 0, t, 0.03);
    // The triple air horn drops a fourth lower and spreads its chord.
    this.hornOscs.forEach((o, i) => o.frequency.setTargetAtTime((this.bigHorn ? [139, 175, 208] : [185, 233, 277])[i], t, 0.05));
    // The V8 has a deeper, burbling note.
    this.engine.oscs[1].frequency.setTargetAtTime(this.cylinders === 8 ? fire / 4 : fire / 2, t, 0.04);
    // Air brakes hiss when the pedal comes up after a firm stop.
    if (this.lastBrake > 0.3 && s.braking < 0.05) this.burst('highpass', 3500, 0.5, 0.18);
    this.lastBrake = s.braking;
    if (s.indicator) {
      this.tick -= dt;
      if (this.tick <= 0) { this.tick = 0.4; this.burst('bandpass', 3200, 0.03, 0.3); }
    } else this.tick = 0;
  }

  crash(strength: number) {
    this.burst('lowpass', 900, 0.5, Math.min(1, 0.3 + strength), -600);
    this.burst('bandpass', 2600, 0.25, Math.min(0.6, strength * 0.6));
  }

  cameraClick() { this.burst('bandpass', 5000, 0.05, 0.4); }

  /** Clunk of the fifth-wheel jaws locking, then the air lines hissing. */
  couple() {
    this.burst('lowpass', 300, 0.25, 0.9, -200);
    setTimeout(() => this.burst('highpass', 3000, 0.6, 0.15), 350);
  }

  shiftHiss() { this.burst('highpass', 4000, 0.18, 0.06, -2000); }

  cash() {
    const ctx = this.ctx;
    if (!ctx) return;
    [880, 1320, 1760].forEach((f, i) => {
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
      const g = ctx.createGain();
      const t0 = ctx.currentTime + i * 0.09;
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.15, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.4);
      o.connect(g).connect(this.master); o.start(t0); o.stop(t0 + 0.45);
    });
  }

  click() { this.burst('bandpass', 2000, 0.04, 0.2); }
}
