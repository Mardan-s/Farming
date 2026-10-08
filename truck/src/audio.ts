import { Radio } from './radio';
import { EngineDSP } from './engineDsp';

// The soundscape, all synthesised in the browser:
// - a sample-level diesel (see engineDsp.ts) running in an AudioWorklet, with turbo and clatter
// - tyre roar and tread hum, wind that builds with speed, rain hiss outside / roof drumming inside
// - multi-tone air horn with vibrato, reverse beeper, indicator relay, gearshift clunks, air brakes,
//   brake squeal, expansion-joint thumps, crashes, the fifth wheel locking
// - passing traffic with pan and doppler, AI drivers honking at you
// - birds by day and crickets at night when you slow down
// Outside sounds go through a "cab" filter when you sit inside.

type Voice = { gain: GainNode; filter: BiquadFilterNode; pan?: StereoPannerNode };

export interface SoundState {
  rpm: number;
  load: number;
  speed: number;
  rain: number;
  horn: boolean;
  braking: number;
  indicator: boolean;
  interior: boolean;
  reverse: boolean;
  night: number;
}

export interface TrafficSound { pan: number; dist: number; closing: number; truck: boolean }

export class Audio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  /** Everything outside the cab: muffled when you sit inside. */
  private outside!: GainNode;
  private cabFilter!: BiquadFilterNode;
  private noise!: AudioBuffer;
  private engineNode: AudioWorkletNode | ScriptProcessorNode | null = null;
  private dsp: EngineDSP | null = null;
  private engineGain!: GainNode;
  private road!: Voice;
  private hum!: Voice;
  private wind!: Voice;
  private rainV!: Voice;
  private traffic: Voice[] = [];
  private hornGain!: GainNode;
  private hornOscs: OscillatorNode[] = [];
  private beepGain!: GainNode;
  private squeal!: { gain: GainNode; osc: OscillatorNode };
  volume = 0.8;
  /** Six for the straight-sixes, eight for the V8. */
  cylinders = 6;
  bigHorn = false;
  radio: Radio | null = null;
  private tick = 0;
  private tock = false;
  private lastBrake = 0;
  private lastSpeed = 0;
  private stopT = 0;
  private dropT = 0;
  private birdT = 2;
  private cricketT = 0;
  private beepT = 0;
  private interior = false;

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
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.cabFilter = ctx.createBiquadFilter();
    this.cabFilter.type = 'lowpass';
    this.cabFilter.frequency.value = 20000;
    this.outside = ctx.createGain();
    this.outside.connect(this.cabFilter).connect(this.master);
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    this.engineGain = ctx.createGain();
    this.engineGain.connect(this.master);
    void this.startEngine(ctx);

    this.road = this.noiseVoice('lowpass', 400, 0.6);
    this.hum = this.noiseVoice('bandpass', 600, 8);
    this.wind = this.noiseVoice('highpass', 900, 0.5);
    this.rainV = this.noiseVoice('highpass', 2500, 0.4);
    for (let k = 0; k < 3; k++) this.traffic.push(this.noiseVoice('bandpass', 700, 0.8, true));

    // Air horn: detuned sawtooths with a slow vibrato, shaped by two trumpet resonances.
    this.hornGain = ctx.createGain();
    this.hornGain.gain.value = 0;
    const lfo = ctx.createOscillator(), lfoG = ctx.createGain();
    lfo.frequency.value = 5.5; lfoG.gain.value = 2.5;
    lfo.connect(lfoG); lfo.start();
    const bell1 = ctx.createBiquadFilter(), bell2 = ctx.createBiquadFilter(), lp = ctx.createBiquadFilter();
    bell1.type = 'peaking'; bell1.frequency.value = 650; bell1.gain.value = 9; bell1.Q.value = 1.4;
    bell2.type = 'peaking'; bell2.frequency.value = 1500; bell2.gain.value = 6; bell2.Q.value = 2;
    lp.type = 'lowpass'; lp.frequency.value = 3200;
    for (const f of [185, 233, 277, 370]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f;
      lfoG.connect(o.detune);
      o.connect(bell1); o.start();
      this.hornOscs.push(o);
    }
    bell1.connect(bell2).connect(lp).connect(this.hornGain).connect(this.outside);

    // Reverse beeper, gated on and off in update().
    this.beepGain = ctx.createGain();
    this.beepGain.gain.value = 0;
    const beep = ctx.createOscillator();
    beep.type = 'square'; beep.frequency.value = 1150;
    const bf = ctx.createBiquadFilter(); bf.type = 'bandpass'; bf.frequency.value = 1150; bf.Q.value = 3;
    beep.connect(bf).connect(this.beepGain).connect(this.outside);
    beep.start();

    // Brake squeal at walking pace.
    const sq = ctx.createOscillator(), sg = ctx.createGain();
    sq.type = 'triangle'; sq.frequency.value = 2350; sg.gain.value = 0;
    sq.connect(sg).connect(this.outside);
    sq.start();
    this.squeal = { gain: sg, osc: sq };

    this.radio = new Radio(ctx, this.master);
  }

  /** The engine runs in an AudioWorklet; older browsers fall back to a ScriptProcessor. */
  private async startEngine(ctx: AudioContext) {
    try {
      if (!ctx.audioWorklet) throw new Error('no worklet');
      const src = `const EngineDSP = (${EngineDSP.toString()});
class EngineProc extends AudioWorkletProcessor {
  constructor() { super(); this.d = new EngineDSP(sampleRate); this.port.onmessage = (e) => Object.assign(this.d.p, e.data); }
  process(_i, o) { const ch = o[0]; if (ch && ch[0]) this.d.render(ch[0], ch[1]); return true; }
}
registerProcessor('diesel', EngineProc);`;
      const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ctx, 'diesel', { numberOfInputs: 0, outputChannelCount: [2] });
      node.connect(this.engineGain);
      this.engineNode = node;
    } catch {
      const dsp = new EngineDSP(ctx.sampleRate);
      const node = ctx.createScriptProcessor(1024, 0, 2);
      node.onaudioprocess = (e) => dsp.render(e.outputBuffer.getChannelData(0), e.outputBuffer.getChannelData(1));
      node.connect(this.engineGain);
      this.dsp = dsp;
      this.engineNode = node;
    }
  }

  private setEngine(p: Partial<EngineDSP['p']>) {
    if (this.dsp) Object.assign(this.dsp.p, p);
    else if (this.engineNode instanceof AudioWorkletNode) this.engineNode.port.postMessage(p);
  }

  private noiseVoice(type: BiquadFilterType, freq: number, q: number, pan = false): Voice {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    src.loopStart = Math.random();
    const filter = ctx.createBiquadFilter(); filter.type = type; filter.frequency.value = freq; filter.Q.value = q;
    const gain = ctx.createGain(); gain.gain.value = 0;
    let node: AudioNode = src.connect(filter).connect(gain);
    let p: StereoPannerNode | undefined;
    if (pan) { p = ctx.createStereoPanner(); node = node.connect(p); }
    node.connect(this.outside);
    src.start(0, Math.random() * 1.5);
    return { gain, filter, pan: p };
  }

  /** One-shot filtered noise burst. */
  private burst(type: BiquadFilterType, freq: number, dur: number, level: number, sweep = 0, delay = 0, dest?: AudioNode, q = 1) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(50, freq + sweep), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(level, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest ?? this.outside);
    src.start(t, Math.random()); src.stop(t + dur + 0.05);
  }

  /** One-shot tone with an exponential decay and optional pitch glide. */
  private tone(type: OscillatorType, f0: number, f1: number, dur: number, level: number, delay = 0, dest?: AudioNode, attack = 0.004) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(level, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest ?? this.outside);
    o.start(t); o.stop(t + dur + 0.05);
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.ctx) this.master.gain.value = v;
  }

  update(dt: number, s: SoundState) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const spd = Math.abs(s.speed);
    const inCab = s.interior;
    if (inCab !== this.interior) this.interior = inCab;
    // Sitting inside: the world is muffled and quieter, the engine loses its edge.
    this.cabFilter.frequency.setTargetAtTime(inCab ? 1100 : 20000, t, 0.15);
    this.outside.gain.setTargetAtTime(inCab ? 0.6 : 1, t, 0.15);
    this.setEngine({ rpm: s.rpm, load: s.load, cyl: this.cylinders, gain: inCab ? 0.85 : 1, muffle: inCab ? 1 : 0 });
    this.engineGain.gain.setTargetAtTime(0.55, t, 0.1);

    // Tyres: broadband roar plus a tread-pattern hum that rises in pitch with speed.
    this.road.gain.gain.setTargetAtTime(Math.min(0.22, spd * 0.0075) * (1 + s.rain * 0.4), t, 0.2);
    this.road.filter.frequency.setTargetAtTime(250 + spd * 22 + s.rain * 900, t, 0.2);
    this.hum.gain.gain.setTargetAtTime(Math.min(0.05, spd * 0.0018), t, 0.2);
    this.hum.filter.frequency.setTargetAtTime(120 + spd * 18, t, 0.2);
    // Wind builds with the square of speed.
    this.wind.gain.gain.setTargetAtTime(Math.min(0.12, (spd / 25) ** 2 * 0.09), t, 0.3);
    this.wind.filter.frequency.setTargetAtTime(600 + spd * 30, t, 0.3);
    // Rain: hiss outside, a drumming roof inside.
    this.rainV.gain.gain.setTargetAtTime(s.rain * (inCab ? 0.03 : 0.07), t, 0.5);
    if (s.rain > 0.1) {
      this.dropT -= dt;
      while (this.dropT <= 0) {
        this.dropT += 0.012 / s.rain + Math.random() * 0.02;
        this.burst('bandpass', inCab ? 900 + Math.random() * 1600 : 3000 + Math.random() * 3000, 0.025, (inCab ? 0.11 : 0.04) * Math.random(), 0, Math.random() * 0.02, this.master, 2);
      }
    }

    // Horn.
    this.hornGain.gain.setTargetAtTime(s.horn ? (this.bigHorn ? 0.13 : 0.08) : 0, t, s.horn ? 0.05 : 0.08);
    const notes = this.bigHorn ? [139, 175, 208, 277] : [185, 233, 277, 370];
    this.hornOscs.forEach((o, i) => o.frequency.setTargetAtTime(notes[i], t, 0.05));

    // Reverse beeper: half a second on, half off.
    if (s.reverse) { this.beepT = (this.beepT + dt) % 1; this.beepGain.gain.setTargetAtTime(this.beepT < 0.5 ? 0.05 : 0, t, 0.01); }
    else this.beepGain.gain.setTargetAtTime(0, t, 0.02);

    // Brakes: squeal at walking pace, then the classic air-brake sigh once stopped.
    const squealOn = s.braking > 0.25 && spd > 0.3 && spd < 3.5;
    this.squeal.gain.gain.setTargetAtTime(squealOn ? 0.012 : 0, t, 0.08);
    this.squeal.osc.frequency.setTargetAtTime(2300 + Math.sin(t * 9) * 60, t, 0.05);
    if (this.lastSpeed > 0.4 && spd <= 0.05) this.stopT = 0.35;
    if (this.stopT > 0) { this.stopT -= dt; if (this.stopT <= 0) this.airSigh(); }
    if (this.lastBrake > 0.4 && s.braking < 0.05 && spd > 2) this.burst('highpass', 3000, 0.35, 0.07, -1200, 0, this.outside);
    this.lastBrake = s.braking;
    this.lastSpeed = spd;

    // Indicator relay: a tick and a slightly lower tock.
    if (s.indicator) {
      this.tick -= dt;
      if (this.tick <= 0) {
        this.tick = 0.4;
        this.tock = !this.tock;
        this.burst('bandpass', this.tock ? 2400 : 3200, 0.025, 0.35, 0, 0, this.master, 4);
        this.tone('square', this.tock ? 900 : 1100, this.tock ? 900 : 1100, 0.012, 0.03, 0, this.master);
      }
    } else this.tick = 0;

    // Countryside ambience when slow: birds by day, crickets at night.
    const calm = Math.max(0, 1 - spd / 12) * (1 - s.rain);
    if (calm > 0.05) {
      if (s.night < 0.5) {
        this.birdT -= dt;
        if (this.birdT <= 0) { this.birdT = 1.5 + Math.random() * 4; this.bird(calm); }
      } else {
        this.cricketT -= dt;
        if (this.cricketT <= 0) { this.cricketT = 0.35 + Math.random() * 0.5; this.cricket(calm); }
      }
    }
  }

  /** Nearby traffic: one panned whoosh per close vehicle, pitched up on approach (doppler). */
  updateTraffic(cars: TrafficSound[]) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    cars.sort((a, b) => a.dist - b.dist);
    this.traffic.forEach((v, i) => {
      const c = cars[i];
      if (!c || c.dist > 90) { v.gain.gain.setTargetAtTime(0, t, 0.2); return; }
      const near = 1 / (1 + (c.dist * c.dist) / 140);
      v.gain.gain.setTargetAtTime(near * (c.truck ? 0.22 : 0.13), t, 0.08);
      v.filter.frequency.setTargetAtTime((c.truck ? 380 : 750) * (1 + c.closing * 0.012), t, 0.08);
      v.pan!.pan.setTargetAtTime(Math.max(-1, Math.min(1, c.pan)), t, 0.08);
    });
  }

  /** An AI driver leaning on the horn. */
  honk(pan: number, dist: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const level = 0.12 / (1 + dist / 25);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(this.outside);
    const len = 0.35 + Math.random() * 0.5;
    for (const f of [415, 523]) this.tone('square', f, f * 0.99, len, level, 0, p, 0.02);
    if (Math.random() < 0.5) for (const f of [415, 523]) this.tone('square', f, f, 0.25, level, len + 0.12, p, 0.02);
  }

  /** Expansion joints: a thump for each axle as it crosses. */
  joint(speed: number, axles: number[]) {
    if (!this.ctx || speed < 2) return;
    const lvl = Math.min(0.5, 0.15 + speed * 0.012);
    for (const a of axles) {
      const delay = a / speed;
      this.tone('sine', 85, 45, 0.18, lvl, delay, this.master);
      this.burst('lowpass', 500, 0.08, lvl * 0.6, 0, delay, this.master);
    }
  }

  private airSigh() {
    this.burst('highpass', 2800, 0.9, 0.14, -1500);
    this.burst('bandpass', 5200, 0.5, 0.05, 0, 0.05);
  }

  private bird(level: number) {
    const base = 2600 + Math.random() * 2400, n = 2 + Math.floor(Math.random() * 5);
    const pan = this.ctx!.createStereoPanner();
    pan.pan.value = Math.random() * 2 - 1;
    pan.connect(this.outside);
    for (let k = 0; k < n; k++) {
      const f = base * (0.85 + Math.random() * 0.3);
      this.tone('sine', f, f * (Math.random() < 0.5 ? 1.35 : 0.75), 0.07 + Math.random() * 0.06, 0.03 * level, k * (0.09 + Math.random() * 0.05), pan, 0.01);
    }
  }

  private cricket(level: number) {
    for (let k = 0; k < 3; k++) this.tone('sine', 4600, 4550, 0.025, 0.012 * level, k * 0.045, undefined, 0.003);
  }

  crash(strength: number) {
    const s = Math.min(1, 0.3 + strength);
    this.burst('lowpass', 700, 0.5, s, -500, 0, this.master);
    this.tone('sine', 90, 40, 0.4, s * 0.8, 0, this.master);
    // Metal: a few inharmonic, ringing partials.
    for (const f of [317, 762, 1390, 2210]) this.tone('triangle', f, f * 0.97, 0.5 + Math.random() * 0.6, 0.05 * s, Math.random() * 0.03, this.master);
    this.burst('highpass', 4000, 0.3, 0.2 * s, 0, 0.02, this.master);
  }

  cameraClick() {
    this.burst('bandpass', 5000, 0.04, 0.4, 0, 0, this.master, 3);
    this.burst('bandpass', 3000, 0.05, 0.25, 0, 0.09, this.master, 3);
  }

  /** Clunk of the fifth-wheel jaws locking, then the air lines hissing. */
  couple() {
    this.tone('sine', 120, 50, 0.3, 0.7, 0, this.master);
    this.burst('lowpass', 900, 0.15, 0.6, 0, 0.01, this.master);
    this.tone('triangle', 1200, 1150, 0.25, 0.05, 0.02, this.master);
    this.burst('highpass', 3000, 0.8, 0.12, -1200, 0.45);
  }

  /** Automated gearbox: a mechanical clunk and a small puff of air. */
  shiftHiss() {
    this.tone('sine', 140, 70, 0.08, 0.12, 0, this.master);
    this.burst('highpass', 3800, 0.16, 0.04, -1500, 0.04);
  }

  cash() {
    const ctx = this.ctx;
    if (!ctx) return;
    [880, 1320, 1760].forEach((f, i) => this.tone('triangle', f, f, 0.45, 0.15, i * 0.09, this.master));
    this.tone('sine', 2637, 2637, 0.8, 0.06, 0.3, this.master);
  }

  click() { this.burst('bandpass', 2000, 0.03, 0.2, 0, 0, this.master, 3); }
}
