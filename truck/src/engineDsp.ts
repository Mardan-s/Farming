// Sample-level diesel engine synthesis. Every cylinder firing is a short pressure pulse (a damped
// resonance plus combustion noise) that excites the exhaust and the chassis; the turbo spools up
// with load and whistles; at idle you hear the injector clatter. A V8 fires unevenly, which gives
// it its burble.
//
// The class must stay self-contained (no imports, no outer variables): its source text is also
// loaded into an AudioWorklet.

export class EngineDSP {
  p: { rpm: number; load: number; cyl: number; gain: number; muffle: number };
  private sr: number;
  private phase: number;
  private env: number;
  private since: number;
  private cylIdx: number;
  private seed: number;
  private spool: number;
  private turboPh: number;
  private clatter: number;
  private body: number;
  private bq: number[][];
  private delay: Float32Array;
  private dIdx: number;
  private hp: number;
  private hpPrev: number;
  private pulseAmp: number;
  private pulseTune: number;
  private knock: number;
  private gainS: number;
  /** Gain into the soft clipper. */
  drive: number;

  constructor(sampleRate: number) {
    // Fields are set here (not as class fields) so the class source runs standalone in a worklet.
    this.sr = sampleRate;
    this.p = { rpm: 600, load: 0, cyl: 6, gain: 0, muffle: 0 };
    this.phase = 0;
    this.env = 0;
    this.since = 0;
    this.cylIdx = 0;
    this.seed = 12345;
    this.spool = 0;
    this.turboPh = 0;
    this.clatter = 0;
    this.body = 0;
    this.bq = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    this.delay = new Float32Array(32);
    this.dIdx = 0;
    this.hp = 0;
    this.hpPrev = 0;
    this.pulseAmp = 1;
    this.pulseTune = 1;
    this.knock = 0;
    this.gainS = 0;
    this.drive = 0.8;
  }

  private rnd() {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  /** RBJ biquad, coefficients recomputed per block; state per slot. */
  private coeffs(type: number, f: number, q: number) {
    const w = (2 * Math.PI * Math.min(f, this.sr * 0.45)) / this.sr;
    const cs = Math.cos(w), al = Math.sin(w) / (2 * q);
    let b0, b1, b2;
    if (type === 0) { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; } // low-pass
    else if (type === 1) { b0 = al; b1 = 0; b2 = -al; } // band-pass
    else { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; } // high-pass
    const a0 = 1 + al;
    return [b0 / a0, b1 / a0, b2 / a0, (-2 * cs) / a0, (1 - al) / a0];
  }

  private run(slot: number, c: number[], x: number) {
    const s = this.bq[slot];
    const y = c[0] * x + c[1] * s[0] + c[2] * s[1] - c[3] * s[2] - c[4] * s[3];
    s[1] = s[0]; s[0] = x; s[3] = s[2]; s[2] = y;
    return y;
  }

  render(L: Float32Array, R: Float32Array | undefined) {
    const { rpm, load, cyl, gain, muffle } = this.p;
    const sr = this.sr;
    const fire = (rpm / 60) * (cyl / 2);
    const tau = 0.32 / Math.max(fire, 1);
    const decay = Math.exp(-1 / (tau * sr));
    const resF = 150 + load * 90 + rpm * 0.02;
    const exhaust = this.coeffs(0, (260 + load * 1500 + rpm * 0.3) * (1 - muffle * 0.55), 0.8);
    const bodyLow = this.coeffs(1, 92 + rpm * 0.01, 2.2);
    const bodyMid = this.coeffs(1, 330, 2.8);
    const hiss = this.coeffs(2, 3500, 0.7);
    const knockBand = this.coeffs(1, 1300, 1.6);
    const spoolTarget = Math.min(1, load * Math.max(0, rpm - 800) / 900);
    const spoolK = 1 - Math.exp(-1 / ((spoolTarget > this.spool ? 0.9 : 0.35) * sr));
    const level = gain * (0.3 + load * 0.7);
    const gainK = 1 - Math.exp(-1 / (0.05 * sr));
    const v8 = cyl === 8;
    const pattern = [1.3, 0.75, 1.05, 1.2, 0.7, 1.15, 0.85, 1.0];
    for (let i = 0; i < L.length; i++) {
      this.phase += fire / sr;
      if (this.phase >= 1) {
        // Next cylinder fires: slightly irregular timing and strength, like a real engine.
        this.phase -= 1 + (this.rnd() - 0.5) * (v8 ? 0.09 : 0.03);
        this.cylIdx = (this.cylIdx + 1) % cyl;
        this.pulseAmp = (0.8 + this.rnd() * 0.4) * (v8 ? pattern[this.cylIdx % 8] : 1);
        this.env = this.pulseAmp;
        // Each cylinder rings at a slightly different pitch, so the note never sounds synthetic.
        this.pulseTune = 0.9 + this.rnd() * 0.2;
        this.knock = 1;
        this.since = 0;
        this.clatter = 1;
      }
      this.since += 1 / sr;
      this.env *= decay;
      const noise = this.rnd() * 2 - 1;
      // The pulse: a damped knock at the manifold resonance, with combustion roar riding on it.
      const pulse = this.env * (Math.sin(2 * Math.PI * resF * this.pulseTune * this.since) * 0.7 + noise * (0.5 + load * 0.25));
      // A slower swell following the firing train gives the low rumble.
      this.body += (this.env - this.body) * 0.004;
      let x = this.run(0, exhaust, pulse + this.body * 0.9);
      x += this.run(1, bodyLow, x) * 0.9 + this.run(2, bodyMid, x) * 0.35;
      // Injector clatter: brittle ticks, most audible at idle and light load.
      this.clatter *= 0.993;
      const tick = this.run(3, hiss, noise) * this.clatter * (1 - load) * (rpm < 1300 ? 0.16 : 0.05) * (1 - muffle * 0.7);
      x += tick;
      // Combustion knock: the hard 'tak' at the start of each firing, loudest at idle.
      this.knock *= 0.985;
      x += this.run(4, knockBand, noise) * this.knock * (0.35 - load * 0.2) * (1 - muffle * 0.6);
      // Turbo: spools with load and revs, whistles, and breathes.
      this.spool += (spoolTarget - this.spool) * spoolK;
      this.turboPh += (1600 + this.spool * 5200) / sr;
      if (this.turboPh > 1) this.turboPh -= 1;
      x += Math.sin(2 * Math.PI * this.turboPh) * this.spool * this.spool * 0.035 * (1 - muffle * 0.6);
      x += noise * this.spool * 0.012;
      // DC block, level and soft saturation.
      this.hp = x - this.hpPrev + 0.995 * this.hp;
      this.hpPrev = x;
      this.gainS += (level - this.gainS) * gainK;
      const y = Math.tanh(this.hp * this.gainS * this.drive) * 0.8;
      L[i] = y;
      this.delay[this.dIdx] = y;
      if (R) R[i] = this.delay[(this.dIdx + 20) % 32] * 0.9 + y * 0.1;
      this.dIdx = (this.dIdx + 1) % 32;
    }
  }
}
