import * as THREE from 'three';
import { mulberry32 } from '../util';

// Near-field trees built from alpha-tested foliage cards: a painted atlas of leaf clusters, fir
// fronds and poplar sprays laid around trunks and branches. Far away the cheaper solid crowns in
// scenery.ts take over.

let atlas: THREE.Texture | null = null;

/** 2×2 atlas: broadleaf cluster, fir frond, poplar spray, bush. */
export function foliageAtlas() {
  if (atlas) return atlas;
  const S = 1024, H = S / 2;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const rnd = mulberry32(17);
  const leaf = (x: number, y: number, len: number, wid: number, ang: number, hue: number, light: number) => {
    g.save();
    g.translate(x, y);
    g.rotate(ang);
    const grad = g.createLinearGradient(0, -wid, 0, wid);
    grad.addColorStop(0, `hsl(${hue},55%,${light + 10}%)`);
    grad.addColorStop(1, `hsl(${hue + 6},60%,${light - 6}%)`);
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, 0);
    g.quadraticCurveTo(len * 0.45, -wid, len, 0);
    g.quadraticCurveTo(len * 0.45, wid, 0, 0);
    g.fill();
    g.strokeStyle = `hsla(${hue},40%,${light + 18}%,0.5)`;
    g.lineWidth = 0.8;
    g.beginPath(); g.moveTo(1, 0); g.lineTo(len * 0.9, 0); g.stroke();
    g.restore();
  };
  const twig = (x0: number, y0: number, x1: number, y1: number, w: number) => {
    g.strokeStyle = '#3b2a1c';
    g.lineWidth = w;
    g.lineCap = 'round';
    g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo((x0 + x1) / 2 + (rnd() - 0.5) * 20, (y0 + y1) / 2, x1, y1); g.stroke();
  };

  // Broadleaf cluster (top-left).
  {
    const cx = H / 2, cy = H / 2;
    for (let k = 0; k < 9; k++) {
      const a = rnd() * Math.PI * 2;
      twig(cx, cy + 40, cx + Math.cos(a) * 170, cy + Math.sin(a) * 150, 3);
    }
    for (let k = 0; k < 900; k++) {
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 215;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.92;
      const inner = 1 - r / 215;
      leaf(x, y, 20 + rnd() * 16, 8 + rnd() * 5, rnd() * Math.PI * 2, 85 + rnd() * 30, 15 + rnd() * 12 + (1 - inner) * 7 - (y - cy) / 40);
    }
  }
  // Fir frond (top-right): a dense, tapering fan of needle sprays along a spine.
  {
    const ox = H, y = H / 2;
    const width = (t: number) => (1 - t * 0.8) * 200;
    // Solid silhouette first so the frond keeps its body when mipmapped far away.
    g.fillStyle = 'hsl(140,38%,13%)';
    g.beginPath();
    g.moveTo(ox + 8, y);
    for (let t = 0; t <= 1.001; t += 0.05) g.lineTo(ox + 10 + t * (H - 40), y - width(t) * 0.78 + Math.sin(t * 40) * 8);
    for (let t = 1; t >= -0.001; t -= 0.05) g.lineTo(ox + 10 + t * (H - 40), y + width(t) * 0.78 + Math.cos(t * 37) * 8);
    g.closePath();
    g.fill();
    twig(ox + 10, y, ox + H - 20, y + 6, 5);
    for (let t = 0; t < 1; t += 0.012) {
      const x = ox + 10 + t * (H - 40);
      for (const side of [-1, 1]) {
        const reach = width(t) * (0.55 + rnd() * 0.45);
        for (let n = 0; n < 7; n++) {
          const f = rnd();
          const px = x + f * 18, py = y + side * reach * f;
          g.strokeStyle = `hsl(${128 + rnd() * 28},${32 + rnd() * 22}%,${11 + rnd() * 16}%)`;
          g.lineWidth = 3;
          g.beginPath(); g.moveTo(px, py); g.lineTo(px + 14 + rnd() * 10, py + side * (8 + rnd() * 14)); g.stroke();
        }
      }
    }
  }
  // Poplar spray (bottom-left): tall, narrow, small leaves.
  {
    const cx = H / 2, top = H + 10;
    twig(cx, S - 10, cx, top + 30, 4);
    for (let k = 0; k < 1100; k++) {
      const t = rnd();
      const y = top + t * (H - 20);
      const w = Math.sin(t * Math.PI) * 140 + 20;
      const x = cx + (rnd() - 0.5) * 2 * w;
      leaf(x, y, 12 + rnd() * 10, 5 + rnd() * 4, rnd() * Math.PI * 2, 80 + rnd() * 22, 22 + rnd() * 16);
    }
  }
  // Bush (bottom-right).
  {
    const cx = H + H / 2, cy = H + H / 2;
    for (let k = 0; k < 700; k++) {
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 210;
      leaf(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.8 + 30, 14 + rnd() * 12, 6 + rnd() * 5, rnd() * Math.PI * 2, 85 + rnd() * 30, 18 + rnd() * 16);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  atlas = t;
  return t;
}

interface Card { cx: number; cy: number; cz: number; w: number; h: number; yaw: number; pitch: number; roll: number; cell: number; anchor: 'center' | 'base'; order?: THREE.EulerOrder }

/** Builds card quads with soft normals pointing away from the crown centre and AO-ish vertex colours. */
function cardsGeometry(cards: Card[], crown: THREE.Vector3, crownR: number) {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], col: number[] = [];
  const q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), n = new THREE.Vector3();
  for (const c of cards) {
    e.set(c.pitch, c.yaw, c.roll, c.order ?? 'YXZ');
    q.setFromEuler(e);
    const u0 = (c.cell % 2) * 0.5, v0 = c.cell < 2 ? 0.5 : 0;
    const corners: [number, number, number, number][] = c.anchor === 'base'
      ? [[0, -c.h / 2, u0, v0], [c.w, -c.h / 2, u0 + 0.5, v0], [c.w, c.h / 2, u0 + 0.5, v0 + 0.5], [0, c.h / 2, u0, v0 + 0.5]]
      : [[-c.w / 2, -c.h / 2, u0, v0], [c.w / 2, -c.h / 2, u0 + 0.5, v0], [c.w / 2, c.h / 2, u0 + 0.5, v0 + 0.5], [-c.w / 2, c.h / 2, u0, v0 + 0.5]];
    const verts = corners.map(([x, y, cu, cv]) => {
      v.set(x, y, 0).applyQuaternion(q).add(new THREE.Vector3(c.cx, c.cy, c.cz));
      n.copy(v).sub(crown);
      n.y += crownR * 0.35;
      n.normalize();
      const out = Math.min(1, v.distanceTo(crown) / crownR);
      const ao = 0.45 + 0.55 * Math.min(1, out * 0.8 + Math.max(0, (v.y - crown.y) / crownR) * 0.4);
      return { p: v.clone(), n: n.clone(), u: cu, w: cv, ao };
    });
    for (const k of [0, 1, 2, 0, 2, 3]) {
      const vt = verts[k];
      pos.push(vt.p.x, vt.p.y, vt.p.z);
      nor.push(vt.n.x, vt.n.y, vt.n.z);
      uv.push(vt.u, vt.w);
      col.push(vt.ao, vt.ao, vt.ao);
    }
  }
  return { pos, nor, uv, col };
}

function woodGeometry(segments: [THREE.Vector3, THREE.Vector3, number, number][]) {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], col: number[] = [];
  for (const [a, b, r0, r1] of segments) {
    const cyl = new THREE.CylinderGeometry(r1, r0, a.distanceTo(b), 6, 1, true).toNonIndexed();
    const dir = new THREE.Vector3().subVectors(b, a).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const m = new THREE.Matrix4().compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
    cyl.applyMatrix4(m);
    const p = cyl.attributes.position, nn = cyl.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nor.push(nn.getX(i), nn.getY(i), nn.getZ(i));
      // Bark sits in a dark corner of the atlas twig strokes; use a fixed dark tint instead.
      uv.push(0.255, 0.75);
      col.push(0.22, 0.16, 0.11);
    }
  }
  return { pos, nor, uv, col };
}

function finish(parts: { pos: number[]; nor: number[]; uv: number[]; col: number[] }[]) {
  const g = new THREE.BufferGeometry();
  const cat = (k: 'pos' | 'nor' | 'uv' | 'col') => parts.flatMap((p) => p[k]);
  g.setAttribute('position', new THREE.Float32BufferAttribute(cat('pos'), 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(cat('nor'), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(cat('uv'), 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cat('col'), 3));
  g.computeBoundingSphere();
  return g;
}

export function leafyBroadleaf(seed: number) {
  const rnd = mulberry32(seed);
  const crown = new THREE.Vector3(0, 7.2, 0), R = 4;
  const wood: [THREE.Vector3, THREE.Vector3, number, number][] = [[new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.1, 5.2, 0), 0.32, 0.22]];
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + rnd();
    const from = new THREE.Vector3(0.1, 3.6 + rnd() * 1.6, 0);
    wood.push([from, new THREE.Vector3(Math.cos(a) * 2.6, from.y + 1.6 + rnd() * 1.4, Math.sin(a) * 2.6), 0.14, 0.05]);
  }
  const cards: Card[] = [];
  for (let k = 0; k < 30; k++) {
    const a = rnd() * Math.PI * 2, r = 0.35 + Math.sqrt(rnd()) * 0.75, h = (rnd() - 0.35) * 1.4;
    cards.push({
      cx: Math.cos(a) * R * r, cy: crown.y + h * 2.6, cz: Math.sin(a) * R * r,
      w: 2.8 + rnd() * 1.1, h: 2.6 + rnd() * 1.0, yaw: rnd() * Math.PI * 2, pitch: (rnd() - 0.5) * 1.2, roll: rnd() * Math.PI, cell: 0, anchor: 'center',
    });
  }
  return finish([woodGeometry(wood), cardsGeometry(cards, crown, R)]);
}

export function leafyConifer(seed: number) {
  const rnd = mulberry32(seed);
  const crown = new THREE.Vector3(0, 7, 0), R = 3.4;
  const wood: [THREE.Vector3, THREE.Vector3, number, number][] = [[new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 13.5, 0), 0.3, 0.05]];
  const cards: Card[] = [];
  const tiers = 12;
  for (let t = 0; t < tiers; t++) {
    const f = t / (tiers - 1);
    const y = 2.0 + f * 10.8;
    const r = 3.4 * (1 - f) + 0.55;
    const n = 8 - Math.floor(f * 4);
    for (let k = 0; k < n; k++) {
      const yaw = (k / n) * Math.PI * 2 + t * 0.7 + rnd() * 0.4;
      // Fronds radiate from the trunk: laid flat (x), drooping (z), then turned around the trunk (y).
      cards.push({ cx: 0, cy: y, cz: 0, w: r * 1.15, h: r * 0.75 + 0.5, yaw, pitch: -Math.PI / 2, roll: -0.18 - rnd() * 0.3, cell: 1, anchor: 'base', order: 'YZX' });
    }
  }
  // A few upright fronds hanging around the trunk give the cone body from the side.
  for (let k = 0; k < 6; k++) {
    const yaw = (k / 6) * Math.PI * 2;
    cards.push({ cx: 0, cy: 6.5, cz: 0, w: 3.2, h: 9, yaw, pitch: 0, roll: -Math.PI / 2 + 0.06, cell: 1, anchor: 'base', order: 'YZX' });
  }
  cards.push({ cx: 0, cy: 13.3, cz: 0, w: 1.4, h: 2.2, yaw: 0, pitch: 0, roll: 0, cell: 3, anchor: 'center' });
  cards.push({ cx: 0, cy: 13.3, cz: 0, w: 1.4, h: 2.2, yaw: Math.PI / 2, pitch: 0, roll: 0, cell: 3, anchor: 'center' });
  return finish([woodGeometry(wood), cardsGeometry(cards, crown, R * 1.6)]);
}

export function leafyPoplar(seed: number) {
  const rnd = mulberry32(seed);
  const crown = new THREE.Vector3(0, 10, 0), R = 1.9;
  const wood: [THREE.Vector3, THREE.Vector3, number, number][] = [[new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 15, 0), 0.24, 0.05]];
  const cards: Card[] = [];
  for (let k = 0; k < 22; k++) {
    const a = rnd() * Math.PI * 2;
    cards.push({ cx: Math.cos(a) * 0.7, cy: 4.8 + rnd() * 10, cz: Math.sin(a) * 0.7, w: 2.4 + rnd(), h: 4.4 + rnd() * 1.5, yaw: rnd() * Math.PI, pitch: (rnd() - 0.5) * 0.3, roll: (rnd() - 0.5) * 0.2, cell: 2, anchor: 'center' });
  }
  return finish([woodGeometry(wood), cardsGeometry(cards, crown, R * 3)]);
}

export function leafyBush(seed: number) {
  const rnd = mulberry32(seed);
  const crown = new THREE.Vector3(0, 0.9, 0), R = 1.5;
  const cards: Card[] = [];
  for (let k = 0; k < 9; k++) {
    cards.push({ cx: (rnd() - 0.5) * 1.4, cy: 0.7 + rnd() * 0.6, cz: (rnd() - 0.5) * 1.4, w: 1.8 + rnd() * 0.6, h: 1.4 + rnd() * 0.4, yaw: rnd() * Math.PI, pitch: (rnd() - 0.5) * 0.6, roll: 0, cell: 3, anchor: 'center' });
  }
  return finish([cardsGeometry(cards, crown, R)]);
}
