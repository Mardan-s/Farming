// In-cab radio: three stations of endlessly generated music, synthesised live with WebAudio.
// A look-ahead scheduler queues sixteenth notes a moment before they play.

export interface Station { name: string; genre: string }
export const STATIONS: Station[] = [
  { name: 'Alpen FM', genre: 'lo-fi beats' },
  { name: 'Autobahn Wave', genre: 'synthwave' },
  { name: 'Route 66', genre: 'truckers’ blues' },
];

const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);

export class Radio {
  station = -1;
  private out: GainNode;
  private tone: BiquadFilterNode;
  private verb: ConvolverNode;
  private verbSend: GainNode;
  private noise: AudioBuffer;
  private next = 0;
  private step = 0;
  private timer: number | null = null;
  private rnd = Math.random;
  private melodyNote = 0;

  constructor(private ctx: AudioContext, dest: AudioNode) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 16000;
    this.out.connect(this.tone).connect(dest);
    // Synthetic room reverb from decaying noise.
    this.verb = ctx.createConvolver();
    const len = ctx.sampleRate * 2.2;
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    }
    this.verb.buffer = ir;
    this.verbSend = ctx.createGain();
    this.verbSend.gain.value = 0.25;
    this.verbSend.connect(this.verb).connect(this.out);
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const n = this.noise.getChannelData(0);
    for (let i = 0; i < n.length; i++) n[i] = Math.random() * 2 - 1;
  }

  /** Cycles Off → station 1 → 2 → 3 → Off. Returns the new station (or -1 for off). */
  cycle() {
    this.tune(this.station + 1 >= STATIONS.length ? -1 : this.station + 1);
    return this.station;
  }

  tune(i: number) {
    this.station = i;
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(i < 0 ? 0 : 0.5, t, 0.15);
    if (i >= 0 && this.timer == null) {
      this.next = t + 0.1;
      this.step = 0;
      this.timer = window.setInterval(() => this.schedule(), 40);
    }
    if (i < 0 && this.timer != null) { clearInterval(this.timer); this.timer = null; }
    this.static();
  }

  /** In the cab the radio is clear; outside you hear it muffled through the doors. */
  setPlace(inCab: boolean, volume: number) {
    const t = this.ctx.currentTime;
    this.tone.frequency.setTargetAtTime(inCab ? 16000 : 900, t, 0.3);
    if (this.station >= 0) this.out.gain.setTargetAtTime((inCab ? 0.5 : 0.28) * volume, t, 0.3);
  }

  private get bpm() { return [80, 108, 96][this.station]; }

  private schedule() {
    const sixteenth = 60 / this.bpm / 4;
    while (this.next < this.ctx.currentTime + 0.15) {
      // Lo-fi and blues swing their off-beat sixteenths.
      const swing = this.station === 1 ? 0 : (this.step % 2 ? sixteenth * (this.station === 2 ? 0.33 : 0.15) : 0);
      this.play(this.step, this.next + swing);
      this.next += sixteenth;
      this.step = (this.step + 1) % (16 * 16);
    }
  }

  // ---------------------------------------------------------------- instruments

  private env(g: GainNode, t: number, a: number, peak: number, d: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  private osc(type: OscillatorType, f: number, t: number, a: number, peak: number, d: number, cutoff = 20000, detune = 0, verb = 0) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.detune.value = detune;
    const flt = this.ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.value = cutoff;
    const g = this.ctx.createGain();
    this.env(g, t, a, peak, d);
    o.connect(flt).connect(g).connect(this.out);
    if (verb) { const s = this.ctx.createGain(); s.gain.value = verb; g.connect(s).connect(this.verbSend); }
    o.start(t);
    o.stop(t + a + d + 0.05);
  }

  private hit(t: number, type: BiquadFilterType, f: number, peak: number, d: number, q = 1, verb = 0) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const flt = this.ctx.createBiquadFilter();
    flt.type = type; flt.frequency.value = f; flt.Q.value = q;
    const g = this.ctx.createGain();
    this.env(g, t, 0.002, peak, d);
    src.connect(flt).connect(g).connect(this.out);
    if (verb) { const s = this.ctx.createGain(); s.gain.value = verb; g.connect(s).connect(this.verbSend); }
    src.start(t, this.rnd() * 0.5);
    src.stop(t + d + 0.05);
  }

  private kick(t: number, peak = 0.9) {
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = this.ctx.createGain();
    this.env(g, t, 0.002, peak, 0.32);
    o.connect(g).connect(this.out);
    o.start(t); o.stop(t + 0.4);
  }

  private snare(t: number, peak = 0.35, verb = 0.3) {
    this.hit(t, 'bandpass', 1800, peak, 0.18, 0.8, verb);
    this.osc('triangle', 190, t, 0.002, peak * 0.6, 0.08);
  }

  private chord(notes: number[], t: number, dur: number, kind: 'keys' | 'pad' | 'organ') {
    for (const n of notes) {
      const f = midi(n);
      if (kind === 'keys') {
        this.osc('sine', f, t, 0.01, 0.07, dur, 3000, 0, 0.4);
        this.osc('triangle', f * 2, t, 0.005, 0.015, dur * 0.5, 2500, 4);
      } else if (kind === 'pad') {
        this.osc('sawtooth', f, t, dur * 0.3, 0.035, dur * 0.9, 1400, -8, 0.6);
        this.osc('sawtooth', f, t, dur * 0.3, 0.035, dur * 0.9, 1400, 8, 0.6);
      } else {
        this.osc('square', f, t, 0.01, 0.03, dur, 1800, 0, 0.3);
        this.osc('sine', f * 2, t, 0.01, 0.03, dur, 4000, 0, 0.3);
      }
    }
  }

  // ---------------------------------------------------------------- stations

  private play(step: number, t: number) {
    const s16 = step % 16, bar = Math.floor(step / 16);
    const beat = 60 / this.bpm;
    if (this.station === 0) {
      // Lo-fi: lazy jazz chords, dusty drums, a wandering pentatonic melody.
      const prog = [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [48, 52, 55, 59]];
      const root = [41, 40, 38, 36][bar % 4];
      if (s16 === 0) this.chord(prog[bar % 4], t, beat * 3.6, 'keys');
      if (s16 === 10) this.chord(prog[bar % 4].slice(1), t, beat * 1.2, 'keys');
      if (s16 === 0 || s16 === 7 || s16 === 10) this.kick(t, 0.7);
      if (s16 === 4 || s16 === 12) this.snare(t, 0.22, 0.25);
      if (s16 % 2 === 0) this.hit(t, 'highpass', 7000, s16 % 4 === 2 ? 0.05 : 0.03, 0.04);
      if (s16 === 0 || s16 === 8) this.osc('sine', midi(root), t, 0.01, 0.35, beat * 1.8, 500);
      if (s16 % 4 === 2 && this.rnd() < 0.55) this.melody(t, [72, 74, 76, 79, 81, 84], 'triangle', beat * 0.9, 0.06);
      if (this.rnd() < 0.08) this.hit(t, 'highpass', 3000, 0.02, 0.01);
    } else if (this.station === 1) {
      // Synthwave: four-on-the-floor, gated snare, saw pads and a running arpeggio.
      const prog = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
      const ch = prog[bar % 4];
      if (s16 === 0) this.chord(ch, t, beat * 4, 'pad');
      if (s16 % 4 === 0) this.kick(t, 0.8);
      if (s16 === 4 || s16 === 12) this.snare(t, 0.35, 0.8);
      if (s16 % 2 === 1) this.hit(t, 'highpass', 8000, 0.04, 0.05);
      if (s16 % 2 === 0) this.osc('sawtooth', midi(ch[0] - 24), t, 0.005, 0.18, beat * 0.4, 700);
      const arp = [ch[0], ch[1], ch[2], ch[0] + 12][s16 % 4] + 12;
      this.osc('square', midi(arp), t, 0.003, 0.035, beat * 0.22, 2600, 0, 0.5);
      if (bar % 8 >= 4 && s16 % 4 === 0 && this.rnd() < 0.7) this.melody(t, [69, 72, 74, 76, 79, 81], 'sawtooth', beat * 0.9, 0.05);
    } else if (this.station === 2) {
      // Twelve-bar shuffle in E: walking bass, organ stabs, backbeat.
      const form = [0, 0, 0, 0, 5, 5, 0, 0, 7, 5, 0, 7];
      const r = 40 + form[bar % 12];
      if (s16 === 2 || s16 === 10) this.chord([r + 12, r + 16, r + 19, r + 22], t, beat * 0.5, 'organ');
      if (s16 % 4 === 0) {
        const walk = [0, 4, 7, 9][s16 / 4];
        this.osc('triangle', midi(r + walk - 12), t, 0.005, 0.3, beat * 0.8, 900);
      }
      if (s16 === 0 || s16 === 8) this.kick(t, 0.6);
      if (s16 === 4 || s16 === 12) this.snare(t, 0.28, 0.35);
      if (s16 % 4 === 0 || s16 % 4 === 3) this.hit(t, 'highpass', 6000, 0.035, 0.05);
      if (s16 % 4 === 0 && this.rnd() < 0.4) this.melody(t, [64, 67, 69, 70, 71, 74, 76], 'sawtooth', beat * 0.7, 0.04, r - 40);
    }
  }

  private melody(t: number, scale: number[], type: OscillatorType, dur: number, peak: number, shift = 0) {
    this.melodyNote = Math.max(0, Math.min(scale.length - 1, this.melodyNote + Math.round((this.rnd() - 0.5) * 3)));
    this.osc(type, midi(scale[this.melodyNote] + shift), t, 0.02, peak, dur, 3200, 0, 0.5);
  }

  /** A burst of tuning static between stations. */
  private static() {
    this.hit(this.ctx.currentTime, 'bandpass', 2500, 0.12, 0.25, 0.4);
  }
}
