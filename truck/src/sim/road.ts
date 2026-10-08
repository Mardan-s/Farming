import { clamp, lerp, mulberry32, noise2, wrap } from '../util';

// The motorway is one big closed loop. Positions along it are measured by `s` (metres from the
// start), and sideways by `lat` (metres to the right of the centre line when travelling towards
// increasing s). Traffic drives on the right: +s traffic uses positive lat, -s traffic negative.

export const LANE_W = 3.75;
export const MEDIAN_HALF = 1.0;
export const INNER_SHOULDER = 0.75;
export const OUTER_SHOULDER = 2.5;
/** Outer edge of the asphalt, measured from the centre line. */
export const CARRIAGE_OUT = MEDIAN_HALF + INNER_SHOULDER + LANE_W * 2 + OUTER_SHOULDER;
/** Where the guard rail stands. */
export const RAIL_LAT = CARRIAGE_OUT + 0.65;
/** Half width of the concrete barrier in the median. */
export const BARRIER_HALF = 0.32;

/** Lane centre for a travel direction (+1 / -1) and lane index (0 = slow right lane, 1 = fast lane). */
export function laneLat(dir: number, lane: number) {
  const inner = MEDIAN_HALF + INNER_SHOULDER;
  const c = lane === 1 ? inner + LANE_W * 0.5 : inner + LANE_W * 1.5;
  return dir * c;
}

export interface RoadPoint { x: number; y: number; z: number; tx: number; tz: number }
export interface RoadHit { s: number; lat: number; y: number; dist: number }

const CELL = 64;
const REACH = 120;

export class Road {
  readonly n: number;
  readonly step: number;
  readonly length: number;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly tx: Float32Array;
  readonly tz: Float32Array;
  /** Signed curvature (1/m), positive when bending right. */
  readonly curv: Float32Array;
  private grid = new Map<number, number[]>();

  constructor(seed = 11, rx = 1450, rz = 1150) {
    const rnd = mulberry32(seed);
    const N = 18;
    const ctrl: number[][] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + (rnd() - 0.5) * 0.14;
      const r = 1 + 0.2 * noise2(Math.cos(a) * 1.3 + 5, Math.sin(a) * 1.3 + 5, seed);
      ctrl.push([Math.cos(a) * rx * r, Math.sin(a) * rz * r]);
    }
    // Dense uniform Catmull-Rom, then a light smoothing to take out any kinks.
    let dense: number[][] = [];
    const SUB = 64;
    for (let i = 0; i < N; i++) {
      const p0 = ctrl[(i - 1 + N) % N], p1 = ctrl[i], p2 = ctrl[(i + 1) % N], p3 = ctrl[(i + 2) % N];
      for (let k = 0; k < SUB; k++) {
        const t = k / SUB, t2 = t * t, t3 = t2 * t;
        const f = (a: number, b: number, c: number, d: number) =>
          0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
        dense.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
      }
    }
    for (let pass = 0; pass < 6; pass++) {
      const m = dense.length;
      dense = dense.map((p, i) => {
        const a = dense[(i - 1 + m) % m], b = dense[(i + 1) % m];
        return [p[0] * 0.5 + (a[0] + b[0]) * 0.25, p[1] * 0.5 + (a[1] + b[1]) * 0.25];
      });
    }
    const m = dense.length;
    const cum = new Float64Array(m + 1);
    for (let i = 0; i < m; i++) {
      const a = dense[i], b = dense[(i + 1) % m];
      cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    const total = cum[m];
    this.n = Math.round(total / 4);
    this.step = total / this.n;
    this.length = total;
    const n = this.n;
    this.px = new Float32Array(n); this.py = new Float32Array(n); this.pz = new Float32Array(n);
    this.tx = new Float32Array(n); this.tz = new Float32Array(n); this.curv = new Float32Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const s = i * this.step;
      while (cum[j + 1] < s) j++;
      const t = (s - cum[j]) / (cum[j + 1] - cum[j]);
      const a = dense[j], b = dense[(j + 1) % m];
      this.px[i] = lerp(a[0], b[0], t);
      this.pz[i] = lerp(a[1], b[1], t);
    }
    // Rolling hills along the route, periodic so the loop closes smoothly (grades stay under ~6%).
    const k1 = Math.max(1, Math.round(total / 1700)), k2 = Math.max(2, Math.round(total / 620));
    const ph1 = rnd() * 6.28, ph2 = rnd() * 6.28;
    for (let i = 0; i < n; i++) {
      const u = (i / n) * Math.PI * 2;
      this.py[i] = 24 + 10 * Math.sin(k1 * u + ph1) + 2.6 * Math.sin(k2 * u + ph2);
    }
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      const dx = this.px[b] - this.px[a], dz = this.pz[b] - this.pz[a];
      const l = Math.hypot(dx, dz) || 1;
      this.tx[i] = dx / l; this.tz[i] = dz / l;
    }
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      // Positive when the tangent swings towards the right normal (-tz, tx).
      const cross = this.tx[a] * this.tz[b] - this.tz[a] * this.tx[b];
      this.curv[i] = cross / (2 * this.step);
    }
    for (let i = 0; i < n; i++) {
      const b = (i + 1) % n;
      const minX = Math.min(this.px[i], this.px[b]) - REACH, maxX = Math.max(this.px[i], this.px[b]) + REACH;
      const minZ = Math.min(this.pz[i], this.pz[b]) - REACH, maxZ = Math.max(this.pz[i], this.pz[b]) + REACH;
      for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
        for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) {
          const key = this.key(cx, cz);
          let list = this.grid.get(key);
          if (!list) this.grid.set(key, (list = []));
          list.push(i);
        }
      }
    }
  }

  private key(cx: number, cz: number) { return (cx + 2048) * 4096 + (cz + 2048); }

  /** Interpolated centre-line point at distance s. */
  sample(s: number, out: RoadPoint): RoadPoint {
    const u = wrap(s, this.length) / this.step;
    const i = Math.floor(u) % this.n, b = (i + 1) % this.n, t = u - Math.floor(u);
    out.x = lerp(this.px[i], this.px[b], t);
    out.y = lerp(this.py[i], this.py[b], t);
    out.z = lerp(this.pz[i], this.pz[b], t);
    const tx = lerp(this.tx[i], this.tx[b], t), tz = lerp(this.tz[i], this.tz[b], t);
    const l = Math.hypot(tx, tz) || 1;
    out.tx = tx / l; out.tz = tz / l;
    return out;
  }

  heightAt(s: number) {
    const u = wrap(s, this.length) / this.step;
    const i = Math.floor(u) % this.n;
    return lerp(this.py[i], this.py[(i + 1) % this.n], u - Math.floor(u));
  }

  /** World position of a point given in road coordinates. */
  toWorld(s: number, lat: number, out: { x: number; y: number; z: number }) {
    const p = this.sample(s, tmp);
    out.x = p.x - p.tz * lat;
    out.z = p.z + p.tx * lat;
    out.y = p.y;
    return out;
  }

  /** Nearest point on the centre line, or null when further than ~120 m from the road. */
  locate(x: number, z: number): RoadHit | null {
    const list = this.grid.get(this.key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!list) return null;
    let best = Infinity, bi = -1, bt = 0;
    for (let k = 0; k < list.length; k++) {
      const i = list[k], b = (i + 1) % this.n;
      const ax = this.px[i], az = this.pz[i];
      const dx = this.px[b] - ax, dz = this.pz[b] - az;
      const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1);
      const ex = x - (ax + dx * t), ez = z - (az + dz * t);
      const d = ex * ex + ez * ez;
      if (d < best) { best = d; bi = i; bt = t; }
    }
    if (bi < 0) return null;
    const b = (bi + 1) % this.n;
    const cx = lerp(this.px[bi], this.px[b], bt), cz = lerp(this.pz[bi], this.pz[b], bt);
    const tx = this.px[b] - this.px[bi], tz = this.pz[b] - this.pz[bi];
    const tl = Math.hypot(tx, tz) || 1;
    const lat = ((x - cx) * -tz + (z - cz) * tx) / tl;
    return { s: (bi + bt) * this.step, lat, y: lerp(this.py[bi], this.py[b], bt), dist: Math.sqrt(best) };
  }

  /** Distance travelling forward (+s) from a to b. */
  ahead(a: number, b: number) { return wrap(b - a, this.length); }
  /** Signed shortest distance from a to b along the loop. */
  delta(a: number, b: number) {
    const d = wrap(b - a, this.length);
    return d > this.length / 2 ? d - this.length : d;
  }
}

const tmp: RoadPoint = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };
