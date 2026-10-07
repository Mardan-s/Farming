import * as THREE from 'three';
import { mulberry32 } from '../util';
import { CARRIAGE_OUT, INNER_SHOULDER, LANE_W, MEDIAN_HALF } from '../sim/road';

// Every texture in the game is painted procedurally on canvases at startup, so the whole game
// ships as a single HTML file with no image downloads.

export let maxAniso = 8;
export function setMaxAniso(n: number) { maxAniso = n; }

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')!] as const;
}

function tex(c: HTMLCanvasElement, srgb = true, repeat = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = maxAniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** Tileable value noise on a w×h grid with the given lattice period. */
function periodicNoise(w: number, h: number, period: number, seed: number, octaves = 4) {
  const out = new Float32Array(w * h);
  let amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const p = period * 2 ** o;
    const rnd = mulberry32(seed + o * 101);
    const lat = new Float32Array(p * p);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    for (let y = 0; y < h; y++) {
      const gy = (y / h) * p, iy = Math.floor(gy), fy = gy - iy;
      const uy = fy * fy * (3 - 2 * fy);
      for (let x = 0; x < w; x++) {
        const gx = (x / w) * p, ix = Math.floor(gx), fx = gx - ix;
        const ux = fx * fx * (3 - 2 * fx);
        const a = lat[(iy % p) * p + (ix % p)], b = lat[(iy % p) * p + ((ix + 1) % p)];
        const c = lat[((iy + 1) % p) * p + (ix % p)], d = lat[((iy + 1) % p) * p + ((ix + 1) % p)];
        out[y * w + x] += amp * (a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy);
      }
    }
    norm += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** Normal map from a height field (tileable). */
function normalFromHeight(hgt: Float32Array, w: number, h: number, strength: number) {
  const [c, g] = canvas(w, h);
  const img = g.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const l = hgt[y * w + ((x - 1 + w) % w)], r = hgt[y * w + ((x + 1) % w)];
    const u = hgt[((y - 1 + h) % h) * w + x], d = hgt[((y + 1) % h) * w + x];
    let nx = (l - r) * strength, ny = (u - d) * strength, nz = 1;
    const len = Math.hypot(nx, ny, nz);
    nx /= len; ny /= len; nz /= len;
    const k = (y * w + x) * 4;
    img.data[k] = (nx * 0.5 + 0.5) * 255;
    img.data[k + 1] = (ny * 0.5 + 0.5) * 255;
    img.data[k + 2] = (nz * 0.5 + 0.5) * 255;
    img.data[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return tex(c, false);
}

// ------------------------------------------------------------------ asphalt

/** Length of road one texture repeat covers (two 6 m dashes with 12 m gaps). */
export const ROAD_TEX_LEN = 36;
/** The asphalt texture spans one carriageway: from the median edge to the outer edge. */
export const ROAD_TEX_W = CARRIAGE_OUT - MEDIAN_HALF;

export function asphalt() {
  const W = 512, H = 1024;
  const pxPerM = W / ROAD_TEX_W, pyPerM = H / ROAD_TEX_LEN;
  const rnd = mulberry32(77);
  const n1 = periodicNoise(W, H, 8, 3, 5);
  const grit = new Float32Array(W * H);
  for (let i = 0; i < grit.length; i++) grit[i] = rnd();
  const hgt = new Float32Array(W * H);
  const [c, g] = canvas(W, H);
  const [rc, rg] = canvas(W, H);
  const img = g.createImageData(W, H);
  const rimg = rg.createImageData(W, H);
  const laneCentres = [INNER_SHOULDER + LANE_W * 0.5, INNER_SHOULDER + LANE_W * 1.5];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const m = x / pxPerM; // metres from the median edge
      const i = y * W + x;
      let v = 0.2 + n1[i] * 0.07 + (grit[i] - 0.5) * 0.09;
      let rough = 0.86 + (grit[i] - 0.5) * 0.1;
      // Polished, darker wheel tracks in each lane.
      for (const lc of laneCentres) {
        for (const off of [-0.95, 0.95]) {
          const d = Math.abs(m - (lc + off));
          const t = Math.exp(-(d * d) / 0.12);
          v -= t * 0.035;
          rough -= t * 0.16;
        }
      }
      // Dusty shoulders.
      if (m < INNER_SHOULDER || m > INNER_SHOULDER + LANE_W * 2) v += 0.025;
      if (grit[i] > 0.985) v += 0.12; // bright aggregate stones
      hgt[i] = grit[i] * 0.6 + n1[i] * 0.4;
      const b = Math.max(0, Math.min(1, v)) * 255;
      const k = i * 4;
      img.data[k] = b; img.data[k + 1] = b; img.data[k + 2] = b * 1.02; img.data[k + 3] = 255;
      const r = Math.max(0, Math.min(1, rough)) * 255;
      rimg.data[k] = r; rimg.data[k + 1] = r; rimg.data[k + 2] = r; rimg.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  rg.putImageData(rimg, 0, 0);
  // Repair patches and a crack sealed with tar.
  for (let p = 0; p < 5; p++) {
    g.fillStyle = `rgba(20,20,22,${0.25 + rnd() * 0.25})`;
    const pw = (0.6 + rnd() * 2) * pxPerM, ph = (1 + rnd() * 4) * pyPerM;
    g.fillRect(rnd() * (W - pw), rnd() * (H - ph), pw, ph);
  }
  g.strokeStyle = 'rgba(10,10,12,0.55)';
  g.lineWidth = 2;
  for (let k = 0; k < 4; k++) {
    let x = rnd() * W, y = rnd() * H;
    g.beginPath(); g.moveTo(x, y);
    for (let s = 0; s < 30; s++) { x += (rnd() - 0.5) * 10; y += rnd() * 14; g.lineTo(x, y); }
    g.stroke();
  }
  // Markings: solid inner and outer edge lines, dashed lane divider.
  const paint = (ctx: CanvasRenderingContext2D, col: string) => {
    ctx.fillStyle = col;
    const line = (mx: number, wid: number, y0: number, y1: number) => ctx.fillRect((mx - wid / 2) * pxPerM, y0 * pyPerM, wid * pxPerM, (y1 - y0) * pyPerM);
    line(INNER_SHOULDER - 0.1, 0.2, 0, ROAD_TEX_LEN);
    line(INNER_SHOULDER + LANE_W * 2 + 0.12, 0.25, 0, ROAD_TEX_LEN);
    line(INNER_SHOULDER + LANE_W, 0.15, 0, 6);
    line(INNER_SHOULDER + LANE_W, 0.15, 18, 24);
  };
  paint(g, 'rgba(236,236,228,0.92)');
  paint(rg, 'rgb(150,150,150)');
  // Worn paint: speckle the lines with asphalt.
  g.fillStyle = 'rgba(40,40,42,0.5)';
  for (let k = 0; k < 2500; k++) g.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2, 1 + rnd() * 2);
  return { map: tex(c), roughness: tex(rc, false), normal: normalFromHeight(hgt, W, H, 2.2) };
}

/** Plain concrete / yard asphalt. */
export function concrete(seed = 5, base = 0.42, slabs = true) {
  const W = 512, H = 512;
  const n = periodicNoise(W, H, 6, seed, 5);
  const rnd = mulberry32(seed);
  const [c, g] = canvas(W, H);
  const img = g.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const v = Math.max(0, Math.min(1, base + (n[i] - 0.5) * 0.18 + (rnd() - 0.5) * 0.06)) * 255;
    img.data[i * 4] = v; img.data[i * 4 + 1] = v * 0.99; img.data[i * 4 + 2] = v * 0.96; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  if (slabs) {
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 2;
    for (let k = 0; k <= 4; k++) {
      g.beginPath(); g.moveTo(0, (k * H) / 4); g.lineTo(W, (k * H) / 4); g.stroke();
      g.beginPath(); g.moveTo((k * W) / 4, 0); g.lineTo((k * W) / 4, H); g.stroke();
    }
    for (let k = 0; k < 10; k++) {
      g.fillStyle = `rgba(30,25,20,${0.08 + rnd() * 0.12})`;
      g.beginPath(); g.ellipse(rnd() * W, rnd() * H, 10 + rnd() * 50, 6 + rnd() * 30, rnd() * 3, 0, 7); g.fill();
    }
  }
  return tex(c);
}

// ------------------------------------------------------------------ nature

/** Grey-ish detail texture multiplied over the terrain's vertex colours (mean ~0.5). */
export function groundDetail() {
  const W = 512;
  const n = periodicNoise(W, W, 16, 9, 5);
  const rnd = mulberry32(9);
  const hgt = new Float32Array(W * W);
  const [c, g] = canvas(W, W);
  const img = g.createImageData(W, W);
  for (let i = 0; i < W * W; i++) {
    const blade = rnd();
    const v = 0.5 + (n[i] - 0.5) * 0.45 + (blade - 0.5) * 0.28;
    hgt[i] = v;
    img.data[i * 4] = v * 255 * 0.98;
    img.data[i * 4 + 1] = v * 255;
    img.data[i * 4 + 2] = v * 255 * 0.95;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return { map: tex(c, false), normal: normalFromHeight(hgt, W, W, 3) };
}

export function fieldTexture(kind: string) {
  const W = 256;
  const [c, g] = canvas(W, W);
  const rnd = mulberry32(kind.length * 13 + 1);
  const n = periodicNoise(W, W, 4, kind.length, 4);
  const img = g.createImageData(W, W);
  const pal: Record<string, [number[], number[], number]> = {
    wheat: [[212, 170, 86], [168, 128, 58], 16],
    rapeseed: [[246, 214, 40], [150, 160, 40], 16],
    green: [[86, 128, 46], [92, 74, 52], 16],
    plowed: [[110, 82, 58], [72, 52, 36], 16],
    stubble: [[196, 176, 124], [150, 130, 90], 32],
    sunflower: [[70, 104, 40], [236, 190, 34], 12],
  };
  const [a, b, rows] = pal[kind] ?? pal.green;
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const row = 0.5 + 0.5 * Math.cos((x / W) * rows * Math.PI * 2);
    let t = kind === 'plowed' ? row : kind === 'sunflower' ? (rnd() < 0.08 + row * 0.12 ? 1 : 0) : row * 0.55;
    t = Math.max(0, Math.min(1, t + (n[i] - 0.5) * 0.6 + (rnd() - 0.5) * 0.25));
    const k = i * 4;
    img.data[k] = a[0] + (b[0] - a[0]) * t;
    img.data[k + 1] = a[1] + (b[1] - a[1]) * t;
    img.data[k + 2] = a[2] + (b[2] - a[2]) * t;
    img.data[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return tex(c);
}

export function waterNormal() {
  const W = 256;
  const n = periodicNoise(W, W, 8, 31, 5);
  return normalFromHeight(n, W, W, 6);
}

/** Bark-free tree foliage speckle used as a subtle map on leaves. */
export function leafTexture() {
  const W = 128;
  const n = periodicNoise(W, W, 8, 12, 3);
  const rnd = mulberry32(3);
  const [c, g] = canvas(W, W);
  const img = g.createImageData(W, W);
  for (let i = 0; i < W * W; i++) {
    const v = 0.55 + (n[i] - 0.5) * 0.5 + (rnd() - 0.5) * 0.35;
    img.data[i * 4] = v * 255; img.data[i * 4 + 1] = v * 255; img.data[i * 4 + 2] = v * 255; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return tex(c, false);
}

// ------------------------------------------------------------------ buildings

/** Facade with windows; one texture tile is 3 floors × 3 windows (9 m × 9 m). */
export function facade(lit: boolean) {
  const W = 256;
  const [c, g] = canvas(W, W);
  const rnd = mulberry32(lit ? 8 : 4);
  g.fillStyle = lit ? '#000' : '#fff';
  g.fillRect(0, 0, W, W);
  if (!lit) {
    // Subtle plaster grime so walls aren't flat colour.
    for (let k = 0; k < 900; k++) {
      g.fillStyle = `rgba(0,0,0,${rnd() * 0.04})`;
      g.fillRect(rnd() * W, rnd() * W, 2 + rnd() * 12, 2 + rnd() * 12);
    }
    g.fillStyle = 'rgba(0,0,0,0.12)';
    for (let f = 0; f < 3; f++) g.fillRect(0, ((f + 1) * W) / 3 - 3, W, 3);
  }
  const cell = W / 3;
  for (let fy = 0; fy < 3; fy++) for (let fx = 0; fx < 3; fx++) {
    const x = fx * cell + cell * 0.28, y = fy * cell + cell * 0.22, w = cell * 0.44, h = cell * 0.5;
    if (lit) {
      if (rnd() < 0.45) {
        const warm = rnd();
        g.fillStyle = warm < 0.7 ? `rgb(255,${190 + rnd() * 40},${110 + rnd() * 50})` : 'rgb(180,210,255)';
        g.fillRect(x + 2, y + 2, w - 4, h - 4);
        g.fillStyle = 'rgba(0,0,0,0.45)';
        g.fillRect(x + w / 2 - 1, y, 2, h);
      }
      continue;
    }
    g.fillStyle = '#ddd';
    g.fillRect(x - 3, y - 3, w + 6, h + 8);
    const grad = g.createLinearGradient(x, y, x + w, y + h);
    grad.addColorStop(0, '#2b3946'); grad.addColorStop(0.5, '#56687a'); grad.addColorStop(1, '#1d2731');
    g.fillStyle = grad;
    g.fillRect(x, y, w, h);
    g.fillStyle = '#e9e9e9';
    g.fillRect(x + w / 2 - 1.5, y, 3, h);
    g.fillRect(x, y + h * 0.45, w, 3);
    if (rnd() < 0.5) { g.fillStyle = 'rgba(120,80,50,0.9)'; g.fillRect(x - 7, y - 2, 6, h + 4); g.fillRect(x + w + 1, y - 2, 6, h + 4); }
  }
  return tex(c, !lit ? true : true);
}

/** Corrugated metal cladding for warehouses, containers and barns. */
export function corrugated(base = '#c9ced4', ribs = 32) {
  const W = 256;
  const [c, g] = canvas(W, W);
  g.fillStyle = base;
  g.fillRect(0, 0, W, W);
  for (let i = 0; i < ribs; i++) {
    const x = (i * W) / ribs;
    const grad = g.createLinearGradient(x, 0, x + W / ribs, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0.22)'); grad.addColorStop(0.5, 'rgba(255,255,255,0.18)'); grad.addColorStop(1, 'rgba(0,0,0,0.22)');
    g.fillStyle = grad;
    g.fillRect(x, 0, W / ribs, W);
  }
  const rnd = mulberry32(ribs);
  for (let k = 0; k < 120; k++) { g.fillStyle = `rgba(80,60,40,${rnd() * 0.08})`; g.fillRect(rnd() * W, rnd() * W, 3 + rnd() * 20, 2 + rnd() * 40); }
  return tex(c);
}

// ------------------------------------------------------------------ trailers and signs

export const LIVERIES = [
  { name: 'ALPINA', sub: 'LOGISTIK · INTERNATIONAL', bg: '#f4f6f8', fg: '#1f6fd1', accent: '#e0322a' },
  { name: 'NORDFRACHT', sub: 'NORTHERN FREIGHT', bg: '#1d3557', fg: '#f1faee', accent: '#e63946' },
  { name: 'VERDE', sub: 'TRANSPORTES · FRESH', bg: '#2e7d32', fg: '#ffffff', accent: '#ffd54f' },
  { name: 'KRONA', sub: 'CARGO SOLUTIONS', bg: '#ffb703', fg: '#1b1b1b', accent: '#1b1b1b' },
  { name: 'ROSSO', sub: 'SPEDIZIONI', bg: '#b71c1c', fg: '#ffffff', accent: '#ffffff' },
  { name: 'EURO HAUL', sub: 'YOUR CARGO · OUR ROAD', bg: '#101820', fg: '#f2aa4c', accent: '#f2aa4c' },
];

/** Curtain-side or box-trailer side panel art. Wide canvas: 13.6 m × 2.7 m. */
export function trailerSide(livery: number, kind: 'curtain' | 'reefer') {
  const L = LIVERIES[livery % LIVERIES.length];
  const W = 1024, H = 204;
  const [c, g] = canvas(W, H);
  g.fillStyle = kind === 'reefer' ? '#f3f4f6' : L.bg;
  g.fillRect(0, 0, W, H);
  if (kind === 'reefer') {
    g.fillStyle = L.bg; g.fillRect(0, H * 0.72, W, H * 0.28);
    g.fillStyle = L.accent; g.fillRect(0, H * 0.68, W, 6);
  } else {
    // Diagonal accent swoosh.
    g.fillStyle = L.accent;
    g.beginPath(); g.moveTo(W * 0.62, H); g.lineTo(W * 0.78, 0); g.lineTo(W * 0.83, 0); g.lineTo(W * 0.67, H); g.fill();
  }
  g.fillStyle = kind === 'reefer' ? L.bg === '#f4f6f8' ? L.fg : L.bg : L.fg;
  g.font = `900 ${H * 0.36}px "Barlow Condensed", Impact, sans-serif`;
  g.textBaseline = 'middle';
  g.fillText(L.name, W * 0.06, H * 0.4);
  g.font = `600 ${H * 0.11}px "Barlow", Arial, sans-serif`;
  g.fillText(L.sub, W * 0.065, H * 0.66);
  if (kind === 'curtain') {
    // Curtain folds and tension straps.
    for (let x = 0; x < W; x += 7) {
      const s = Math.sin(x * 0.9) * 0.5 + 0.5;
      g.fillStyle = `rgba(0,0,0,${0.03 + s * 0.05})`;
      g.fillRect(x, 0, 3, H);
    }
    g.fillStyle = 'rgba(0,0,0,0.35)';
    for (let x = 30; x < W; x += 52) g.fillRect(x, 0, 4, H);
    g.fillStyle = 'rgba(180,180,180,0.8)';
    for (let x = 30; x < W; x += 52) g.fillRect(x - 1, H - 12, 6, 10);
  } else {
    g.fillStyle = 'rgba(0,0,0,0.12)';
    for (let x = 0; x < W; x += 64) g.fillRect(x, 0, 2, H);
  }
  return tex(c, true, false);
}

export function containerSide(color: string, label: string) {
  const W = 1024, H = 256;
  const [c, g] = canvas(W, H);
  g.fillStyle = color;
  g.fillRect(0, 0, W, H);
  for (let x = 0; x < W; x += 16) {
    const grad = g.createLinearGradient(x, 0, x + 16, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0.28)'); grad.addColorStop(0.5, 'rgba(255,255,255,0.14)'); grad.addColorStop(1, 'rgba(0,0,0,0.28)');
    g.fillStyle = grad; g.fillRect(x, 8, 16, H - 16);
  }
  g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(0, 0, W, 8); g.fillRect(0, H - 8, W, 8);
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.font = `800 ${H * 0.34}px "Barlow Condensed", Impact, sans-serif`;
  g.textBaseline = 'middle';
  g.fillText(label, W * 0.08, H * 0.5);
  const rnd = mulberry32(label.length);
  for (let k = 0; k < 200; k++) { g.fillStyle = `rgba(90,50,20,${rnd() * 0.12})`; g.fillRect(rnd() * W, rnd() * H, 2 + rnd() * 8, 2 + rnd() * 20); }
  return tex(c, true, false);
}

/** Blue motorway direction sign. */
export function gantrySign(lines: [string, string][], exit: string) {
  const W = 1024, H = 384;
  const [c, g] = canvas(W, H);
  g.fillStyle = '#0d4ea6';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = '#fff'; g.lineWidth = 10;
  g.strokeRect(14, 14, W - 28, H - 28);
  g.fillStyle = '#fff';
  g.textBaseline = 'middle';
  lines.forEach(([name, dist], i) => {
    const y = 105 + i * 120;
    g.font = '700 86px "Barlow", Arial, sans-serif';
    g.fillText(name, 60, y);
    g.font = '600 74px "Barlow", Arial, sans-serif';
    const w = g.measureText(dist).width;
    g.fillText(dist, W - 60 - w, y);
  });
  if (exit) {
    g.fillStyle = '#f2c500';
    g.fillRect(W - 250, H - 92, 200, 58);
    g.fillStyle = '#111';
    g.font = '700 46px "Barlow", Arial, sans-serif';
    g.fillText(exit, W - 236, H - 62);
  }
  return tex(c, true, false);
}

export function speedSign(limit: number) {
  const W = 256;
  const [c, g] = canvas(W, W);
  g.fillStyle = '#fff'; g.beginPath(); g.arc(W / 2, W / 2, W / 2 - 2, 0, 7); g.fill();
  g.strokeStyle = '#d0021b'; g.lineWidth = 30; g.beginPath(); g.arc(W / 2, W / 2, W / 2 - 18, 0, 7); g.stroke();
  g.fillStyle = '#111'; g.font = '800 110px "Barlow", Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(limit), W / 2, W / 2 + 6);
  return tex(c, true, false);
}

export function depotBoard(name: string, company: string, color: number) {
  const W = 1024, H = 256;
  const [c, g] = canvas(W, H);
  g.fillStyle = '#f7f7f5'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#' + color.toString(16).padStart(6, '0'); g.fillRect(0, 0, 40, H); g.fillRect(0, H - 30, W, 30);
  g.fillStyle = '#16181c'; g.textBaseline = 'middle';
  g.font = '800 104px "Barlow Condensed", Impact, sans-serif'; g.fillText(company.toUpperCase(), 80, 98);
  g.font = '600 52px "Barlow", Arial, sans-serif'; g.fillStyle = '#555'; g.fillText(name + ' · Depot', 82, 180);
  return tex(c, true, false);
}

/** Soft radial sprite for light glows and smoke puffs. */
export function radial(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  const W = 128;
  const [c, g] = canvas(W, W);
  const grad = g.createRadialGradient(W / 2, W / 2, 0, W / 2, W / 2, W / 2);
  grad.addColorStop(0, inner); grad.addColorStop(0.25, inner.replace(/[\d.]+\)$/, '0.6)')); grad.addColorStop(1, outer);
  g.fillStyle = grad; g.fillRect(0, 0, W, W);
  return tex(c, true, false);
}

export function smokeSprite() {
  const W = 128;
  const [c, g] = canvas(W, W);
  const rnd = mulberry32(4);
  for (let k = 0; k < 18; k++) {
    const x = W / 2 + (rnd() - 0.5) * W * 0.4, y = W / 2 + (rnd() - 0.5) * W * 0.4, r = W * (0.15 + rnd() * 0.2);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.18)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, W, W);
  }
  return tex(c, true, false);
}

export function plateTexture(text: string) {
  const W = 256, H = 56;
  const [c, g] = canvas(W, H);
  g.fillStyle = '#f5f5f0'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#1f3fa8'; g.fillRect(0, 0, 30, H);
  g.fillStyle = '#ffd700'; g.beginPath(); g.arc(15, 18, 7, 0, 7); g.fill();
  g.strokeStyle = '#111'; g.lineWidth = 3; g.strokeRect(1.5, 1.5, W - 3, H - 3);
  g.fillStyle = '#111'; g.font = '700 40px "Barlow Condensed", Arial, sans-serif'; g.textBaseline = 'middle';
  g.fillText(text, 42, H / 2 + 2);
  return tex(c, true, false);
}
