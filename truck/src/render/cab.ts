import * as THREE from 'three';
import { mulberry32 } from '../util';

// A sculpted cab-over shell, lofted from horizontal cross-sections: each slice is a rounded
// rectangle whose width, front, back and corner radii follow smooth height profiles. Window
// openings are left as real holes, filled by glass built from the same surface, and a painted
// panel texture adds door shut-lines, handles, ceramic window borders and the front lettering.
//
// Local frame matches the tractor: +z forward, +x is the LEFT side, y up.

export interface CabSpec { y0: number; H: number; zBack: number; model: number; profile?: CabProfile }

/** Height profiles for a custom shell, as (absolute y, value) pairs. */
export interface CabProfile {
  winY0: number;
  winY1: number;
  zFront: [number, number][];
  halfW: [number, number][];
  zBack: [number, number][];
  rFront: [number, number][];
  rBack: number;
  doorBack: number;
  /** Wheel-arch cut-out, or none. */
  arch: { z: number; y: number; r: number } | null;
  /** How far the windscreen bows forward in the middle. */
  bow: number;
  /** Model name across the front (cab-overs only). */
  lettering: boolean;
}

/** Monotone piecewise-smoothstep interpolation through (t, value) pairs. */
function curve(pts: [number, number][]) {
  return (t: number) => {
    if (t <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (t <= pts[i][0]) {
        const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
        const f = (t - t0) / (t1 - t0);
        return v0 + (v1 - v0) * f * f * (3 - 2 * f);
      }
    }
    return pts[pts.length - 1][1];
  };
}

/** Rear edge of the door (and side window), local z. */
export const DOOR_BACK = 3.98;

// Points per segment on one half of a slice, back centre round to front centre.
const SEG = { back: 3, backCorner: 4, side: 16, frontCorner: 7, front: 7 };

export class CabShape {
  readonly zFront: (t: number) => number;
  readonly halfW: (t: number) => number;
  private zBackC: (t: number) => number;
  private rFront: (t: number) => number;
  private rBack: (t: number) => number;
  readonly perRing: number;
  /** Window band as fractions of cab height. */
  readonly win: { t0: number; t1: number };
  readonly doorBack: number;
  readonly arch: { z: number; y: number; r: number } | null;
  readonly bow: number;
  readonly lettering: boolean;

  constructor(readonly spec: CabSpec) {
    const m = spec.model;
    const nose = m === 2 ? 5.27 : 5.24;
    // Profiles are given at absolute heights and converted to fractions of the shell height.
    const roof = spec.y0 + spec.H, winY0 = 2.47 + m * 0.08, winY1 = roof - 0.4;
    const pr: CabProfile = spec.profile ?? {
      winY0, winY1,
      zFront: [[spec.y0, nose - 0.16], [spec.y0 + 0.14, nose - 0.02], [1.4, nose], [2.34, nose - 0.03], [winY0, nose - 0.06], [winY1, nose - 0.24], [roof - 0.18, nose - 0.27], [roof - 0.05, nose - 0.36], [roof, nose - 0.48]],
      halfW: [[spec.y0, 1.2], [spec.y0 + 0.13, 1.25], [roof - 0.26, 1.25], [roof - 0.08, 1.21], [roof, 1.1]],
      zBack: [[spec.y0, spec.zBack + 0.03], [spec.y0 + 0.13, spec.zBack], [roof - 0.13, spec.zBack], [roof, spec.zBack + 0.09]],
      rFront: [[spec.y0, 0.17], [2.34, 0.21], [winY0 + 0.13, 0.31], [winY1, 0.3], [roof, 0.22]],
      rBack: 0.14, doorBack: DOOR_BACK, arch: { z: 3.9, y: 0.52, r: 0.7 }, bow: 0.05, lettering: true,
    };
    const t = (y: number) => (y - spec.y0) / spec.H;
    const at = (pts: [number, number][]) => curve(pts.map(([y, v]) => [t(y), v] as [number, number]));
    this.win = { t0: t(pr.winY0), t1: t(pr.winY1) };
    this.zFront = at(pr.zFront);
    this.halfW = at(pr.halfW);
    this.zBackC = at(pr.zBack);
    this.rFront = at(pr.rFront);
    const rb = pr.rBack;
    this.rBack = () => rb;
    this.doorBack = pr.doorBack;
    this.arch = pr.arch;
    this.bow = pr.bow;
    this.lettering = pr.lettering;
    this.perRing = 2 * (SEG.back + SEG.backCorner + SEG.side + SEG.frontCorner + SEG.front);
  }

  yAt(t: number) { return this.spec.y0 + t * this.spec.H; }
  tAt(y: number) { return (y - this.spec.y0) / this.spec.H; }

  /** Surface z of the cab front at lateral x and height y (follows the bow and the corners). */
  frontZ(x: number, y: number) {
    const t = Math.max(0, Math.min(1, (y - this.spec.y0) / this.spec.H));
    const r = this.ring(t);
    const ax = Math.abs(x);
    // Only the front half of the ring counts (corners and front face).
    let best: { x: number; z: number } | null = null;
    for (const p of r) {
      if (p.seg !== 'front' && p.seg !== 'frontCorner') continue;
      if (!best || Math.abs(Math.abs(p.x) - ax) < Math.abs(Math.abs(best.x) - ax)) best = p;
    }
    return best ? best.z : this.zFront(t);
  }

  /** Lean of the front face at height y (radians, top leaning back). */
  frontTilt(y: number) {
    const t = (y - this.spec.y0) / this.spec.H, e = 0.02;
    return -Math.atan((this.zFront(t - e) - this.zFront(t + e)) / (2 * e * this.spec.H));
  }

  /** Front face z at a height y, used to stick parts onto the cab front. */
  frontAt(y: number) { return this.zFront((y - this.spec.y0) / this.spec.H); }

  /**
   * One cross-section: perRing + 1 points from the back centre round the left side to the front
   * centre and back round the right side (the last point repeats the first, for the UV seam).
   * Each point carries the segment it belongs to and a parametric u.
   */
  ring(t: number) {
    const hw = this.halfW(t), zf = this.zFront(t), zb = this.zBackC(t), rf = this.rFront(t), rb = this.rBack(t);
    // Windscreen height: the front face bows forward a little.
    const bow = t > this.win.t0 - 0.05 && t < this.win.t1 + 0.04 ? this.bow : this.bow / 2;
    const half: { x: number; z: number; seg: string }[] = [];
    for (let i = 0; i < SEG.back; i++) half.push({ x: ((hw - rb) * i) / SEG.back, z: zb, seg: 'back' });
    for (let i = 0; i < SEG.backCorner; i++) {
      const a = -Math.PI / 2 + ((Math.PI / 2) * i) / SEG.backCorner;
      half.push({ x: hw - rb + Math.cos(a) * rb, z: zb + rb + Math.sin(a) * rb, seg: 'backCorner' });
    }
    for (let i = 0; i < SEG.side; i++) half.push({ x: hw, z: zb + rb + ((zf - rf - zb - rb) * i) / SEG.side, seg: 'side' });
    for (let i = 0; i < SEG.frontCorner; i++) {
      const a = ((Math.PI / 2) * i) / SEG.frontCorner;
      half.push({ x: hw - rf + Math.cos(a) * rf, z: zf - rf + Math.sin(a) * rf, seg: 'frontCorner' });
    }
    for (let i = 0; i < SEG.front; i++) {
      const x = (hw - rf) * (1 - i / SEG.front);
      half.push({ x, z: zf + bow * (1 - (x / (hw - rf)) ** 2), seg: 'front' });
    }
    const pts: { x: number; z: number; seg: string; side: number }[] = [];
    for (const p of half) pts.push({ ...p, side: 1 });
    pts.push({ x: 0, z: zf + bow, seg: 'front', side: 0 });
    for (let i = half.length - 1; i >= 1; i--) pts.push({ ...half[i], x: -half[i].x, side: -1 });
    pts.push({ ...pts[0] });
    return pts;
  }

  /** Front wheel arch cut into the lower sides. */
  isArch(t: number, p: { x: number; z: number }) {
    const a = this.arch;
    if (!a || Math.abs(p.x) < 1.0) return false;
    const dz = p.z - a.z, dy = this.yAt(t) - a.y;
    return dz * dz + dy * dy < a.r * a.r;
  }

  /** Is this point of the surface inside a window opening? */
  isWindow(t: number, p: { x: number; z: number; seg: string }) {
    const WIN = this.win;
    if (t < WIN.t0 || t > WIN.t1) return false;
    if (p.seg === 'front') return true;
    if (p.seg === 'frontCorner') return Math.abs(p.x) < this.halfW(t) - this.rFront(t) * 0.35;
    // Side windows run from just behind the corner back to the door's rear edge, with a falling sill.
    if (p.seg === 'side') {
      const db = this.doorBack;
      const sill = WIN.t0 + (p.z < db + 0.35 ? 0.06 * (1 - (p.z - db) / 0.35) : 0);
      return p.z > db + 0.02 && t >= sill;
    }
    return false;
  }
}

export interface CabBuild { shell: THREE.BufferGeometry; windscreen: THREE.BufferGeometry; sides: THREE.BufferGeometry[]; shape: CabShape }

export function buildCab(spec: CabSpec, lod: boolean): CabBuild {
  const shape = new CabShape(spec);
  const WIN = shape.win;
  const rows = lod ? 16 : 52;
  const ts: number[] = [];
  for (let i = 0; i <= rows; i++) ts.push(i / rows);
  // Extra rows exactly at the window edges keep the openings crisp.
  for (const t of [WIN.t0, WIN.t1]) if (t > 0 && t < 1 && !ts.some((x) => Math.abs(x - t) < 1e-6)) ts.push(t);
  ts.sort((a, b) => a - b);
  const P = shape.perRing + 1;
  const rings = ts.map((t) => shape.ring(t));
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  rings.forEach((r, j) => r.forEach((p, i) => {
    pos.push(p.x, shape.yAt(ts[j]), p.z);
    uv.push(i / (P - 1), ts[j]);
  }));
  const holes: boolean[] = [];
  for (let j = 0; j < rings.length - 1; j++) for (let i = 0; i < P - 1; i++) {
    // A quad is a hole if its centre lies in a window.
    const tm = (ts[j] + ts[j + 1]) / 2;
    const a = rings[j][i], b = rings[j][i + 1];
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, seg: a.seg === b.seg ? a.seg : a.seg === 'front' || b.seg === 'front' ? 'frontCorner' : a.seg };
    const hole = (!lod && shape.isWindow(tm, mid) && tm > WIN.t0 && tm < WIN.t1) || shape.isArch(tm, mid);
    holes.push(hole);
    if (hole) continue;
    const v00 = j * P + i, v10 = v00 + 1, v01 = v00 + P, v11 = v01 + 1;
    idx.push(v00, v11, v10, v00, v01, v11);
  }
  // Roof cap: a gentle dome over the top ring.
  const top = rings[rings.length - 1];
  const capCenter = pos.length / 3;
  const zMid = top.reduce((s, p) => s + p.z, 0) / top.length;
  pos.push(0, shape.yAt(1) + 0.04, zMid);
  uv.push(0.5, 1);
  const base = (rings.length - 1) * P;
  for (let i = 0; i < P - 1; i++) idx.push(capCenter, base + i, base + i + 1);
  const shell = new THREE.BufferGeometry();
  shell.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  shell.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  shell.setIndex(fixWinding(pos, idx, P));
  shell.computeVertexNormals();

  // Glass grids from the same surface, pushed out a hair.
  const glassGrid = (pick: (p: { x: number; z: number; seg: string }, t: number) => boolean) => {
    const gp: number[] = [], gi: number[] = [], guv: number[] = [];
    const gts: number[] = [];
    for (let k = 0; k <= 8; k++) gts.push(WIN.t0 + ((WIN.t1 - WIN.t0) * k) / 8);
    const cols: number[] = [];
    const mid = shape.ring((WIN.t0 + WIN.t1) / 2);
    mid.forEach((p, i) => { if (i < P - 1 && pick(p, (WIN.t0 + WIN.t1) / 2)) cols.push(i); });
    if (!cols.length) return new THREE.BufferGeometry();
    // Include one point either side so the glass overlaps the opening's edge.
    const c0 = Math.max(0, cols[0] - 1), c1 = Math.min(P - 1, cols[cols.length - 1] + 1);
    gts.forEach((t, j) => {
      const r = shape.ring(t);
      for (let i = c0; i <= c1; i++) {
        gp.push(r[i].x, shape.yAt(t), r[i].z);
        guv.push((i - c0) / (c1 - c0), j / 8);
      }
    });
    const n = c1 - c0 + 1;
    for (let j = 0; j < 8; j++) for (let i = 0; i < n - 1; i++) {
      const v00 = j * n + i, v10 = v00 + 1, v01 = v00 + n, v11 = v01 + 1;
      gi.push(v00, v11, v10, v00, v01, v11);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(guv, 2));
    g.setIndex(fixWinding(gp, gi, n));
    g.computeVertexNormals();
    const p = g.attributes.position, nn = g.attributes.normal;
    for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) + nn.getX(i) * 0.006, p.getY(i) + nn.getY(i) * 0.006, p.getZ(i) + nn.getZ(i) * 0.006);
    return g;
  };
  const windscreen = glassGrid((p, t) => (p.seg === 'front' || p.seg === 'frontCorner') && shape.isWindow(t, p));
  const sides = [1, -1].map((side) => glassGrid((p, t) => p.seg === 'side' && Math.sign(p.x) === side && shape.isWindow(t, p)));
  return { shell, windscreen, sides, shape };
}

/** Makes triangles face outwards (away from the cab's centre line). */
function fixWinding(pos: number[], idx: number[], _rowLen: number) {
  let out = 0, total = 0;
  for (let k = 0; k < idx.length && total < 200; k += 3 * 7) {
    const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
    const ux = pos[b] - ax, uy = pos[b + 1] - ay, uz = pos[b + 2] - az;
    const vx = pos[c] - ax, vy = pos[c + 1] - ay, vz = pos[c + 2] - az;
    const nx = uy * vz - uz * vy, nz = ux * vy - uy * vx;
    // Outward = away from the vertical axis through the cab's middle (x = 0, z ≈ 4.1).
    if (nx * ax + nz * (az - 4.1) > 0) out++;
    total++;
  }
  if (out >= total / 2) return idx;
  const flipped = idx.slice();
  for (let k = 0; k < flipped.length; k += 3) { const t = flipped[k + 1]; flipped[k + 1] = flipped[k + 2]; flipped[k + 2] = t; }
  return flipped;
}

// ------------------------------------------------------------------ panel texture

/** Paint overlay (multiplied by the paint colour) plus a matching groove/flake height map. */
export function panelTextures(shape: CabShape, name: string) {
  const WIN = shape.win;
  const T = (y: number) => shape.tAt(y);
  const W = 2048, H = 1024;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const hc = document.createElement('canvas');
  hc.width = W; hc.height = H;
  const hg = hc.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  hg.fillStyle = '#808080'; hg.fillRect(0, 0, W, H);
  const P = shape.perRing + 1;
  const Y = (t: number) => (1 - t) * H;
  // Locate parametric u for a given segment position on the mid ring.
  const mid = shape.ring(T(1.9));
  const uOf = (pred: (p: { x: number; z: number; seg: string; side: number }) => boolean) => {
    const out: number[] = [];
    mid.forEach((p, i) => { if (pred(p)) out.push((i / (P - 1)) * W); });
    return out;
  };
  // Ceramic frit around every window opening: solid black fading out in dots.
  const ring = shape.ring((WIN.t0 + WIN.t1) / 2);
  const winU = ring.map((p, i) => ({ u: (i / (P - 1)) * W, win: shape.isWindow((WIN.t0 + WIN.t1) / 2, p) }));
  g.fillStyle = '#0b0c0e';
  for (let i = 0; i < winU.length - 1; i++) {
    if (!winU[i].win && !winU[i + 1].win) continue;
    g.fillRect(winU[i].u - 18, Y(WIN.t1) - 22, winU[i + 1].u - winU[i].u + 36, Y(WIN.t0) - Y(WIN.t1) + 44);
  }
  // Door shut-lines on both sides, a handle recess and the step cover below.
  for (const side of [1, -1]) {
    const back = uOf((p) => p.side === side && p.seg === 'side' && Math.abs(p.z - shape.doorBack) < 0.07);
    const front = uOf((p) => p.side === side && p.seg === 'frontCorner');
    if (!back.length || !front.length) continue;
    const ub = back[0], uf = side > 0 ? front[0] + 14 : front[front.length - 1] - 14;
    const doorBottom = shape.lettering ? 1.32 : shape.spec.y0 + 0.07, handleY = shape.yAt(WIN.t0) - 0.15;
    for (const ctx of [g, hg]) {
      ctx.strokeStyle = ctx === g ? 'rgba(10,10,12,0.85)' : '#202020';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(ub, Y(WIN.t0 + 0.02)); ctx.lineTo(ub, Y(T(doorBottom))); ctx.lineTo(uf, Y(T(doorBottom))); ctx.lineTo(uf, Y(WIN.t0));
      ctx.stroke();
      // Handle recess.
      const hu = ub + (uf - ub) * 0.12;
      ctx.fillStyle = ctx === g ? 'rgba(20,20,24,0.9)' : '#303030';
      ctx.fillRect(hu - 28, Y(T(handleY)) - 9, 56, 18);
    }
  }
  // Front lettering across the grille top, in brushed metal.
  const fu = shape.lettering ? uOf((p) => p.side === 0)[0] : -1e4;
  g.font = '800 64px "Barlow Condensed", Impact, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const word = name.split(' ')[0].toUpperCase().split('').join(' ');
  const grad = g.createLinearGradient(0, Y(T(2.38)) - 30, 0, Y(T(2.38)) + 30);
  grad.addColorStop(0, '#f4f6f8'); grad.addColorStop(0.5, '#8a9098'); grad.addColorStop(1, '#e8ebee');
  // u runs right-to-left across the front as seen by someone facing the truck, so mirror the text.
  for (const [ctx, fill] of [[g, grad], [hg, '#c0c0c0']] as const) {
    ctx.save();
    ctx.translate(fu, Y(T(2.38)));
    ctx.scale(-1, 1);
    ctx.font = '800 64px "Barlow Condensed", Impact, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = fill;
    ctx.fillText(word, 0, 0);
    ctx.restore();
  }
  // Road grime: a faint darkening towards the bottom and in the corners.
  const grime = g.createLinearGradient(0, H, 0, H * 0.75);
  grime.addColorStop(0, 'rgba(60,50,40,0.35)'); grime.addColorStop(1, 'rgba(60,50,40,0)');
  g.fillStyle = grime;
  g.fillRect(0, H * 0.75, W, H * 0.25);
  // Metallic flake: fine noise in the height map only (under the clear coat).
  const img = hg.getImageData(0, 0, W, H);
  const rnd = mulberry32(3);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 10;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  hg.putImageData(img, 0, 0);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  return { map, height: hc };
}
