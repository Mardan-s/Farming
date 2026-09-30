import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { box, mat } from './models';

// Extra world dressing: soft contact shadows, a pond, a windmill, hay, power lines, wild edges,
// birds, stars and moon, distant mountains, and night lights. All plain Lambert/Basic materials
// and textures drawn on canvases, so it runs on any phone GPU.

let rngSeed = 7;
export const rnd = () => ((rngSeed = (rngSeed * 16807) % 2147483647) / 2147483647);

function canvasTex(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft round shadow, dark in the middle. */
let blobTex: THREE.Texture | null = null;
function blobTexture() {
  blobTex ??= canvasTex(64, (g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, 'rgba(0,0,0,0.55)');
    r.addColorStop(0.55, 'rgba(0,0,0,0.3)');
    r.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, s, s);
  });
  return blobTex;
}

const blobMat = () => new THREE.MeshBasicMaterial({
  map: blobTexture(), transparent: true, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
});
let sharedBlobMat: THREE.MeshBasicMaterial | null = null;

/** A soft contact shadow under an object, w×d cells, lying on the ground. */
export function blob(w: number, d: number, opacity = 1) {
  sharedBlobMat ??= blobMat();
  const m = opacity === 1 ? sharedBlobMat : blobMat();
  m.opacity = opacity;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), m);
  mesh.position.y = 0.035;
  mesh.renderOrder = 1;
  return mesh;
}

/** A contact shadow placed at (x, z). */
export function blobAt(w: number, d: number, x: number, z: number, opacity = 1) {
  const b = blob(w, d, opacity);
  b.position.set(x, 0.035, z);
  return b;
}

/** Many contact shadows at once (under trees, bushes, bales). */
export function blobField(points: { x: number; z: number; r: number }[]) {
  sharedBlobMat ??= blobMat();
  const inst = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), sharedBlobMat, points.length);
  const m = new THREE.Matrix4();
  points.forEach((p, i) => inst.setMatrixAt(i, m.makeScale(p.r * 2, 1, p.r * 2).setPosition(p.x, 0.03, p.z)));
  inst.renderOrder = 1;
  return inst;
}

/** Warm glow sprite texture for lamps, the moon and headlight pools. */
let glowTex: THREE.Texture | null = null;
export function glowTexture() {
  glowTex ??= canvasTex(128, (g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, s, s);
  });
  return glowTex;
}

/**
 * Bakes a static group into one mesh per material, so a fence of 40 posts costs one draw call
 * instead of 40. Meshes with several materials or special render settings are left as they are.
 */
export function mergeStatic(group: THREE.Object3D) {
  group.updateMatrixWorld(true);
  const byMat = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; cast: boolean; receive: boolean }>();
  const merged: THREE.Mesh[] = [];
  group.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh || Array.isArray(m.material) || m.renderOrder !== 0) return;
    const mat = m.material as THREE.Material;
    if (mat.transparent) return;
    let g = m.geometry.clone().applyMatrix4(m.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    const e = byMat.get(mat) ?? { geos: [], cast: false, receive: false };
    e.geos.push(g);
    e.cast ||= m.castShadow;
    e.receive ||= m.receiveShadow;
    byMat.set(mat, e);
    merged.push(m);
  });
  for (const m of merged) m.removeFromParent();
  const out = new THREE.Group();
  for (const [mat, e] of byMat) {
    const geo = mergeGeometries(e.geos);
    if (!geo) continue;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = e.cast;
    mesh.receiveShadow = e.receive;
    out.add(mesh);
  }
  // Whatever wasn't merged stays, placed in world space.
  const rest = [...group.children];
  for (const c of rest) out.attach(c);
  return out;
}

// ---------- pond ----------

export interface Pond { group: THREE.Group; water: THREE.MeshLambertMaterial; ripples: THREE.Texture; cx: number; cz: number; rx: number; rz: number }

export function buildPond(cx: number, cz: number, rx: number, rz: number): Pond {
  const group = new THREE.Group();
  const shape = (sx: number, sz: number, y: number, material: THREE.Material) => {
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const wob = 1 + Math.sin(a * 3 + 1.3) * 0.08 + Math.sin(a * 5) * 0.05;
      pts.push(new THREE.Vector2(Math.cos(a) * sx * wob, Math.sin(a) * sz * wob));
    }
    const geo = new THREE.ShapeGeometry(new THREE.Shape(pts), 1).rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(cx, y, cz);
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  // Muddy bank, then the water.
  shape(rx + 0.7, rz + 0.6, 0.02, new THREE.MeshLambertMaterial({ color: 0x6d5a3c, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
  const ripples = canvasTex(128, (g, s) => {
    g.fillStyle = '#808080';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 260; i++) {
      const x = Math.random() * s, y = Math.random() * s, w = 4 + Math.random() * 16;
      g.strokeStyle = `rgba(255,255,255,${0.1 + Math.random() * 0.25})`;
      g.lineWidth = 1 + Math.random();
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + w / 2, y - 2, x + w, y);
      g.stroke();
    }
  });
  ripples.wrapS = ripples.wrapT = THREE.RepeatWrapping;
  ripples.repeat.set(rx / 1.5, rz / 1.5);
  const water = new THREE.MeshLambertMaterial({
    color: 0x3f7fa8, map: ripples, transparent: true, opacity: 0.9, emissive: 0x0d2a3c,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  shape(rx, rz, 0.045, water);
  // Reeds and cattails around the edge, lily pads on the water.
  const reedGeo = new THREE.ConeGeometry(0.03, 0.9, 4).translate(0, 0.45, 0);
  const reeds = new THREE.InstancedMesh(reedGeo, mat(0x5f8a3a), 90);
  const cattailGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.18, 6).translate(0, 0.95, 0);
  const cattails = new THREE.InstancedMesh(cattailGeo, mat(0x6b4526), 90);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  for (let i = 0; i < 90; i++) {
    const a = rnd() * Math.PI * 2;
    const k = 0.92 + rnd() * 0.22;
    const s = 0.6 + rnd() * 0.7;
    q.setFromEuler(e.set((rnd() - 0.5) * 0.3, rnd() * 3, (rnd() - 0.5) * 0.3));
    m.compose(new THREE.Vector3(cx + Math.cos(a) * rx * k, 0, cz + Math.sin(a) * rz * k), q, new THREE.Vector3(s, s, s));
    reeds.setMatrixAt(i, m);
    cattails.setMatrixAt(i, rnd() < 0.4 ? m : new THREE.Matrix4().makeScale(0, 0, 0));
  }
  const padGeo = new THREE.CircleGeometry(0.22, 10, 0.4, Math.PI * 2 - 0.4).rotateX(-Math.PI / 2);
  const pads = new THREE.InstancedMesh(padGeo, new THREE.MeshLambertMaterial({ color: 0x4f8f3a, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }), 14);
  for (let i = 0; i < 14; i++) {
    const a = rnd() * Math.PI * 2, k = 0.3 + rnd() * 0.5;
    m.compose(new THREE.Vector3(cx + Math.cos(a) * rx * k, 0.06, cz + Math.sin(a) * rz * k), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6), new THREE.Vector3(1, 1, 1).multiplyScalar(0.7 + rnd() * 0.8));
    pads.setMatrixAt(i, m);
  }
  reeds.castShadow = true;
  group.add(reeds, cattails, pads);
  return { group, water, ripples, cx, cz, rx, rz };
}

// ---------- windmill ----------

/** A classic farm water-pumping windmill; returns the rotor to spin. */
export function buildWindmill() {
  const g = new THREE.Group();
  const steel = 0x9aa0a6;
  const H = 6.2;
  // Four splayed legs with cross braces.
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const leg = box(g, 0.07, H, 0.07, steel, sx * 0.45, H / 2, sz * 0.45);
    leg.rotation.z = -sx * 0.07;
    leg.rotation.x = sz * 0.07;
  }
  for (let y = 1; y < H - 0.5; y += 1.4) {
    const w = 1.0 - (y / H) * 0.8;
    box(g, w * 1.1, 0.04, 0.04, steel, 0, y, w * 0.55);
    box(g, w * 1.1, 0.04, 0.04, steel, 0, y, -w * 0.55);
    box(g, 0.04, 0.04, w * 1.1, steel, w * 0.55, y, 0);
    box(g, 0.04, 0.04, w * 1.1, steel, -w * 0.55, y, 0);
  }
  box(g, 0.5, 0.08, 0.5, 0x7a7f84, 0, H, 0); // platform
  // Rotor: a ring of angled blades facing +x, plus a tail vane.
  const rotor = new THREE.Group();
  rotor.position.set(0.35, H + 0.35, 0);
  g.add(rotor);
  const bladeGeo = new THREE.BoxGeometry(0.02, 0.85, 0.2);
  bladeGeo.translate(0, 0.62, 0);
  const bladeMat = mat(0xd9d4c7);
  for (let i = 0; i < 18; i++) {
    const b = new THREE.Mesh(bladeGeo, bladeMat);
    b.rotation.x = (i / 18) * Math.PI * 2;
    b.rotation.y = 0.35;
    b.castShadow = true;
    rotor.add(b);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.18, 10).rotateZ(Math.PI / 2), mat(0x3a3a3a));
  rotor.add(hub);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.025, 4, 32).rotateY(Math.PI / 2), mat(0x8a8f94));
  rotor.add(ring);
  box(g, 1.3, 0.05, 0.05, 0x7a7f84, -0.5, H + 0.35, 0); // tail boom
  const vane = box(g, 0.02, 0.6, 0.9, 0xc8392b, -1.15, H + 0.4, 0);
  vane.rotation.y = Math.PI / 2;
  g.traverse(o => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return { group: g, rotor };
}

// ---------- hay bales ----------

export function buildBales(spots: { x: number; z: number; a: number; stacked?: boolean }[]) {
  const g = new THREE.Group();
  const side = new THREE.MeshLambertMaterial({ color: 0xd8b560 });
  const endTex = canvasTex(64, (c, s) => {
    c.fillStyle = '#c9a24f';
    c.fillRect(0, 0, s, s);
    c.strokeStyle = 'rgba(120,86,30,0.55)';
    for (let r = 4; r < s / 2; r += 4) { c.lineWidth = 1.2; c.beginPath(); c.arc(s / 2, s / 2, r, 0, Math.PI * 2); c.stroke(); }
  });
  const end = new THREE.MeshLambertMaterial({ map: endTex });
  const geo = new THREE.CylinderGeometry(0.55, 0.55, 1.1, 20);
  for (const p of spots) {
    const levels = p.stacked ? 2 : 1;
    for (let l = 0; l < levels; l++) {
      const bale = new THREE.Mesh(geo, [side, end, end]);
      bale.rotation.z = Math.PI / 2;
      bale.rotation.y = p.a;
      bale.position.set(p.x + (l ? 0.1 : 0), 0.55 + l * 1.05, p.z);
      bale.castShadow = true;
      bale.receiveShadow = true;
      g.add(bale);
    }
    g.add(blobAt(1.8, 1.8, p.x, p.z));
  }
  return g;
}

// ---------- power line ----------

export function buildPowerLine(x0: number, x1: number, z: number, step: number) {
  const g = new THREE.Group();
  const wood = 0x6b5238;
  const poles: number[] = [];
  for (let x = x0; x <= x1; x += step) poles.push(x);
  const H = 3.4;
  for (const x of poles) {
    box(g, 0.1, H, 0.1, wood, x, H / 2, z);
    box(g, 0.08, 0.08, 1.1, wood, x, H - 0.25, z);
    for (const o of [-0.45, 0, 0.45]) box(g, 0.05, 0.1, 0.05, 0xdcdcd2, x, H - 0.15, z + o);
    g.add(blobAt(0.6, 0.6, x, z, 0.8));
  }
  // Sagging wires between poles.
  const pts: number[] = [];
  for (let i = 0; i < poles.length - 1; i++) {
    for (const o of [-0.45, 0, 0.45]) {
      for (let k = 0; k < 10; k++) {
        const t0 = k / 10, t1 = (k + 1) / 10;
        const sag = (t: number) => H - 0.1 - Math.sin(t * Math.PI) * 0.45;
        pts.push(poles[i] + (poles[i + 1] - poles[i]) * t0, sag(t0), z + o, poles[i] + (poles[i + 1] - poles[i]) * t1, sag(t1), z + o);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x2a2a2a, transparent: true, opacity: 0.7 })));
  return g;
}

// ---------- wild edges: bushes, rocks, flowers ----------

export function buildWildEdges(spots: { x: number; z: number }[]) {
  const g = new THREE.Group();
  const bushBlobs: THREE.BufferGeometry[] = [];
  for (const [x, y, z, r] of [[0, 0.25, 0, 0.35], [0.25, 0.18, 0.1, 0.25], [-0.22, 0.2, -0.08, 0.27], [0.05, 0.36, -0.12, 0.22]]) {
    bushBlobs.push(new THREE.IcosahedronGeometry(r, 1).translate(x, y, z));
  }
  const bushGeo = mergeGeometries(bushBlobs)!;
  shadeByHeight(bushGeo, 0, 0.6);
  const rockGeo = new THREE.DodecahedronGeometry(0.25, 0);
  const flowerGeo = new THREE.OctahedronGeometry(0.06, 0).translate(0, 0.28, 0);
  const stemGeo = new THREE.CylinderGeometry(0.01, 0.01, 0.28, 3).translate(0, 0.14, 0);
  const nB = Math.floor(spots.length * 0.35), nR = Math.floor(spots.length * 0.2), nF = spots.length * 3;
  const bushes = new THREE.InstancedMesh(bushGeo, new THREE.MeshLambertMaterial({ vertexColors: true }), nB);
  const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshLambertMaterial({ flatShading: true }), nR);
  const flowers = new THREE.InstancedMesh(flowerGeo, new THREE.MeshLambertMaterial({ emissive: 0x222222 }), nF);
  const stems = new THREE.InstancedMesh(stemGeo, mat(0x4f7f34), nF);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
  const shadows: { x: number; z: number; r: number }[] = [];
  let b = 0, r = 0, f = 0;
  for (const p of spots) {
    if (b < nB && rnd() < 0.4) {
      const s = 0.7 + rnd() * 0.9;
      m.compose(new THREE.Vector3(p.x, 0, p.z), q.setFromAxisAngle(up, rnd() * 6), new THREE.Vector3(s, s * (0.8 + rnd() * 0.4), s));
      bushes.setMatrixAt(b, m);
      bushes.setColorAt(b++, c.setHSL(0.26 + rnd() * 0.06, 0.45, 0.3 + rnd() * 0.08));
      shadows.push({ x: p.x, z: p.z, r: 0.45 * s });
    } else if (r < nR && rnd() < 0.35) {
      const s = 0.6 + rnd() * 1.2;
      m.compose(new THREE.Vector3(p.x, 0.05, p.z), q.setFromEuler(new THREE.Euler(rnd(), rnd() * 6, rnd())), new THREE.Vector3(s, s * 0.6, s));
      rocks.setMatrixAt(r, m);
      rocks.setColorAt(r++, c.setHSL(0.1, 0.06, 0.45 + rnd() * 0.15));
    }
    for (let k = 0; k < 3 && f < nF; k++) {
      m.compose(new THREE.Vector3(p.x + (rnd() - 0.5) * 1.6, 0, p.z + (rnd() - 0.5) * 1.6), q.identity(), new THREE.Vector3(1, 0.7 + rnd() * 0.8, 1));
      flowers.setMatrixAt(f, m);
      stems.setMatrixAt(f, m);
      flowers.setColorAt(f++, c.setHex([0xf4d23c, 0xffffff, 0xd9534f, 0x9b6bd6, 0xf29ac2][Math.floor(rnd() * 5)]));
    }
  }
  bushes.count = b; rocks.count = r; flowers.count = f; stems.count = f;
  bushes.castShadow = rocks.castShadow = true;
  bushes.receiveShadow = rocks.receiveShadow = true;
  g.add(bushes, rocks, flowers, stems, blobField(shadows));
  return g;
}

/** Darker at the bottom, lighter on top: cheap fake ambient occlusion baked into vertex colors. */
export function shadeByHeight(geo: THREE.BufferGeometry, y0: number, y1: number, lo = 0.62, hi = 1.12) {
  const p = geo.getAttribute('position');
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const t = Math.min(1, Math.max(0, (p.getY(i) - y0) / (y1 - y0)));
    const k = lo + (hi - lo) * t;
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

// ---------- birds ----------

export class Birds {
  readonly mesh: THREE.InstancedMesh;
  private birds: { r: number; h: number; speed: number; phase: number; cx: number; cz: number; flap: number }[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();

  constructor(cx: number, cz: number, n = 12) {
    const geo = new THREE.BufferGeometry();
    // A shallow "V": two wings meeting at the body.
    geo.setAttribute('position', new THREE.Float32BufferAttribute([
      0, 0, 0, -0.18, 0, 0.55, 0.12, 0, 0.05,
      0, 0, 0, 0.12, 0, -0.05, -0.18, 0, -0.55,
    ], 3));
    geo.computeVertexNormals();
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0x2a2a2a, side: THREE.DoubleSide }), n);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < n; i++) {
      this.birds.push({ r: 14 + rnd() * 26, h: 13 + rnd() * 6, speed: 0.08 + rnd() * 0.06, phase: rnd() * Math.PI * 2, cx: cx + (rnd() - 0.5) * 20, cz: cz + (rnd() - 0.5) * 12, flap: rnd() * 6 });
    }
  }

  update(time: number, visible: boolean) {
    this.mesh.visible = visible;
    if (!visible) return;
    this.birds.forEach((b, i) => {
      const a = b.phase + time * b.speed;
      const x = b.cx + Math.cos(a) * b.r, z = b.cz + Math.sin(a) * b.r * 0.7;
      const heading = a + Math.PI / 2;
      const wing = 0.55 + Math.sin(time * 9 + b.flap) * 0.45;
      this.q.setFromEuler(new THREE.Euler(0, -heading, Math.sin(time * 0.7 + b.flap) * 0.2));
      this.m.compose(new THREE.Vector3(x, b.h + Math.sin(time * 1.3 + b.flap) * 0.4, z), this.q, new THREE.Vector3(1.4, 1, 1.4 * wing));
      this.mesh.setMatrixAt(i, this.m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------- night sky ----------

export function buildStars() {
  const n = 700;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2;
    const y = Math.abs(u) * 0.9 + 0.1;
    const r = Math.sqrt(1 - y * y);
    pos.set([Math.cos(a) * r * 380, y * 380, Math.sin(a) * r * 380], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false });
  const pts = new THREE.Points(geo, m);
  pts.frustumCulled = false;
  return pts;
}

export function buildMoon() {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xe8eeff, transparent: true, fog: false, depthWrite: false, opacity: 0 }));
  s.scale.set(34, 34, 1);
  const disc = new THREE.Sprite(new THREE.SpriteMaterial({
    map: canvasTex(64, (g, sz) => { g.fillStyle = '#f4f1e6'; g.beginPath(); g.arc(sz / 2, sz / 2, sz / 2 - 2, 0, Math.PI * 2); g.fill(); g.fillStyle = 'rgba(180,176,160,0.5)'; g.beginPath(); g.arc(sz * 0.38, sz * 0.42, 6, 0, 7); g.arc(sz * 0.62, sz * 0.6, 4, 0, 7); g.fill(); }),
    transparent: true, fog: false, depthWrite: false, opacity: 0,
  }));
  disc.scale.set(9, 9, 1);
  const g = new THREE.Group();
  g.add(s, disc);
  return { group: g, glow: s.material, disc: disc.material };
}

/** Far mountain ridges on the horizon; their color is blended toward the sky each frame. */
export function buildMountains(cx: number, cz: number) {
  const ring = (R: number, N: number, height: (a: number) => number) => {
    const pos: number[] = [];
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
      const x0 = cx + Math.cos(a0) * R, z0 = cz + Math.sin(a0) * R, x1 = cx + Math.cos(a1) * R, z1 = cz + Math.sin(a1) * R;
      const h0 = height(a0), h1 = height(a1);
      pos.push(x0, -8, z0, x1, -8, z1, x1, h1, z1, x0, -8, z0, x1, h1, z1, x0, h0, z0);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return geo;
  };
  const far = new THREE.MeshBasicMaterial({ color: 0x8aa0b0, fog: false, side: THREE.DoubleSide });
  const near = new THREE.MeshBasicMaterial({ color: 0x6f8a78, fog: false, side: THREE.DoubleSide });
  const g = new THREE.Group();
  g.add(
    new THREE.Mesh(ring(255, 96, a => 20 + Math.sin(a * 3.1) * 9 + Math.sin(a * 7.3 + 1) * 6 + Math.sin(a * 17.9) * 3 + Math.max(0, Math.sin(a * 2 + 0.5)) * 18), far),
    new THREE.Mesh(ring(215, 120, a => 9 + Math.sin(a * 5.3 + 2) * 4 + Math.sin(a * 11.1) * 2.5 + Math.sin(a * 23.7 + 0.4) * 1.2), near),
  );
  return { group: g, far, near };
}

// ---------- night lights ----------

/** Headlight beams and the pool of light they throw; attach to a vehicle facing +x. */
export function buildHeadlights(reach: number, front: number) {
  const g = new THREE.Group();
  const beamGeo = new THREE.ConeGeometry(1.4, reach, 16, 1, true).rotateZ(Math.PI / 2).translate(front + reach / 2, 0.7, 0);
  const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
    color: 0xfff2c8, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
  }));
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(reach * 1.1, 3.2).rotateX(-Math.PI / 2).translate(front + reach * 0.55, 0.05, 0), new THREE.MeshBasicMaterial({
    map: glowTexture(), color: 0xffe9b0, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  }));
  beam.renderOrder = 5;
  pool.renderOrder = 2;
  g.add(beam, pool);
  g.visible = false;
  return g;
}

/** A yard lamp post with a warm glow and light pool that switch on at night. */
export function buildLamp() {
  const g = new THREE.Group();
  box(g, 0.1, 3.2, 0.1, 0x3b3f44, 0, 1.6, 0);
  box(g, 0.7, 0.06, 0.06, 0x3b3f44, 0.3, 3.15, 0);
  box(g, 0.3, 0.12, 0.25, 0x2a2d31, 0.6, 3.08, 0);
  const bulbMat = new THREE.MeshBasicMaterial({ color: 0x777066 });
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), bulbMat);
  bulb.position.set(0.6, 3.0, 0);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffd79a, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
  glow.position.copy(bulb.position);
  glow.scale.set(2.4, 2.4, 1);
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(7, 7).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({
    map: glowTexture(), color: 0xffcf8a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  }));
  pool.position.set(0.6, 0.05, 0);
  g.add(bulb, glow, pool);
  g.add(blobAt(0.5, 0.5, 0, 0, 0.7));
  return { group: g, set(night: number) {
    bulbMat.color.setHex(night > 0.5 ? 0xfff0c8 : 0x777066);
    glow.material.opacity = night * 0.9;
    (pool.material as THREE.MeshBasicMaterial).opacity = night * 0.6;
  } };
}
