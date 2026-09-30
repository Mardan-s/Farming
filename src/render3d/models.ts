import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { shineOn } from './shine';

// Low-poly models built from primitives. Every model faces +x; 1 unit = 1 grid cell.

const mats = new Map<number, THREE.MeshLambertMaterial>();
/** Shared matte material per color. Lambert shading works on every mobile GPU we've seen;
 * the physically based material failed to compile on some Android phones. */
export function mat(color: number, _roughness?: number, _metalness?: number) {
  let m = mats.get(color);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color });
    mats.set(color, m);
  }
  return m;
}

/**
 * Bakes a group's static meshes into one mesh per material, in the group's own space, leaving the
 * `skip` subtrees (wheels, reels, augers) alone. A tire of 40 tread lugs becomes one draw call.
 */
export function mergeLocal(group: THREE.Object3D, skip: THREE.Object3D[] = []) {
  group.updateMatrixWorld(true);
  const inv = group.matrixWorld.clone().invert();
  const skipSet = new Set(skip);
  const byMat = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; cast: boolean; receive: boolean }>();
  const done: THREE.Mesh[] = [];
  const m4 = new THREE.Matrix4();
  const visit = (o: THREE.Object3D) => {
    for (const c of o.children) {
      if (skipSet.has(c)) continue;
      const m = c as THREE.Mesh;
      if (m.isMesh && !Array.isArray(m.material)) {
        let g = m.geometry.clone().applyMatrix4(m4.multiplyMatrices(inv, m.matrixWorld));
        if (g.index) g = g.toNonIndexed();
        for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
        if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
        const e = byMat.get(m.material) ?? { geos: [], cast: false, receive: false };
        e.geos.push(g);
        e.cast ||= m.castShadow;
        e.receive ||= m.receiveShadow;
        byMat.set(m.material, e);
        done.push(m);
      }
      visit(c);
    }
  };
  visit(group);
  if (done.length < 2) return;
  for (const m of done) m.removeFromParent();
  for (const [material, e] of byMat) {
    const geo = mergeGeometries(e.geos);
    if (!geo) continue;
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = e.cast;
    mesh.receiveShadow = e.receive;
    group.add(mesh);
  }
}

function add(parent: THREE.Object3D, mesh: THREE.Mesh, x: number, y: number, z: number) {
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

export function box(parent: THREE.Object3D, w: number, h: number, d: number, color: number | THREE.Material, x: number, y: number, z: number) {
  const m = typeof color === 'number' ? mat(color) : color;
  return add(parent, new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m), x, y, z);
}


/** Rounded box, for painted body panels. */
export function rbox(parent: THREE.Object3D, w: number, h: number, d: number, radius: number, color: number | THREE.Material, x: number, y: number, z: number) {
  const m = typeof color === 'number' ? mat(color) : color;
  return add(parent, new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(radius, w / 2, h / 2, d / 2)), m), x, y, z);
}

const GLASS = 0x9fd3ea;
export interface VehicleModel {
  root: THREE.Group;
  body: THREE.Group;
  wheels: THREE.Group[];
  lights: THREE.MeshLambertMaterial;
  header?: THREE.Group;
  reel?: THREE.Object3D;
  pipe?: THREE.Group;
  headerWidth?: number;
  /** Steering pivots (front wheels on a tractor, rear wheels on a combine). */
  steer?: THREE.Group[];
  /** -1 when the steering wheels are at the back. */
  steerSign?: number;
}

export interface ToolModel {
  root: THREE.Group;
  kind: string;
  width: number;
  fill?: THREE.Mesh;
  wheels: THREE.Group[];
}

// ---------- scenery ----------

// ---------- building textures ----------

function stripeTex(key: string, draw: (g: CanvasRenderingContext2D, s: number) => void, rx: number, ry: number) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  draw(c.getContext('2d')!, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.anisotropy = 4;
  t.name = key;
  return t;
}
/** Vertical corrugated sheet metal (greyscale; tinted by the material color). */
const corrugated = (rx: number, ry: number) => stripeTex('corr', (g, s) => {
  for (let x = 0; x < s; x++) {
    const v = 0.78 + 0.22 * Math.sin((x / s) * Math.PI * 2 * 8);
    g.fillStyle = `rgb(${Math.round(255 * v)},${Math.round(255 * v)},${Math.round(255 * v)})`;
    g.fillRect(x, 0, 1, s);
  }
  g.fillStyle = 'rgba(0,0,0,0.12)';
  g.fillRect(0, s - 3, s, 3);
}, rx, ry);
/** Horizontal clapboard siding. */
const siding = (rx: number, ry: number) => stripeTex('siding', (g, s) => {
  g.fillStyle = '#fff';
  g.fillRect(0, 0, s, s);
  for (let y = 0; y < s; y += 16) {
    const grad = g.createLinearGradient(0, y, 0, y + 16);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.85, '#e4e0d8');
    grad.addColorStop(1, '#9a968e');
    g.fillStyle = grad;
    g.fillRect(0, y, s, 16);
  }
}, rx, ry);
/** Staggered roof shingles. */
const shingles = (rx: number, ry: number) => stripeTex('shingle', (g, s) => {
  g.fillStyle = '#d8d8d8';
  g.fillRect(0, 0, s, s);
  for (let y = 0; y < s; y += 16) {
    for (let x = (y / 16) % 2 ? -16 : 0; x < s; x += 32) {
      const v = 190 + Math.floor(Math.random() * 50);
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(x + 1, y + 1, 30, 14);
    }
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(0, y + 14, s, 2);
  }
}, rx, ry);

export function buildSilo(radius: number) {
  const g = new THREE.Group();
  const h = 3.4;
  const steel = shineOn(new THREE.MeshLambertMaterial({ color: 0xc9d0d6, map: corrugated(10, 3) }), 0.25);
  add(g, new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.1, radius * 1.14, 0.18, 28), mat(0xa9a79f)), 0, 0.09, 0); // concrete pad
  add(g, new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, h, 32, 1, true), steel), 0, 0.18 + h / 2, 0);
  for (let i = 0; i <= 6; i++) {
    add(g, new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.012, radius * 1.012, 0.05, 32, 1, true), mat(0x98a1a8)), 0, 0.2 + (h / 6) * i, 0);
  }
  // Ribbed conical roof with a vent cap and a walkway rail.
  const roofMat = shineOn(new THREE.MeshLambertMaterial({ color: 0xbfc6cc, map: corrugated(12, 1) }), 0.25);
  add(g, new THREE.Mesh(new THREE.ConeGeometry(radius * 1.05, 1.0, 32, 1, true), roofMat), 0, 0.18 + h + 0.5, 0);
  add(g, new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 0.25, 14), mat(0x9aa4ab)), 0, 0.18 + h + 1.05, 0);
  add(g, new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.22, 14), mat(0xaab3ba)), 0, 0.18 + h + 1.28, 0);
  const rail = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.55, 0.015, 4, 24), mat(0xe0b000));
  rail.rotation.x = Math.PI / 2;
  add(g, rail, 0, 0.18 + h + 0.72, 0);
  // Caged ladder up the side.
  const lx = radius + 0.1;
  for (const z of [-0.12, 0.12]) box(g, 0.03, h + 0.4, 0.03, 0x8a8f94, lx, 0.2 + (h + 0.4) / 2, z);
  for (let y = 0.4; y < h + 0.5; y += 0.22) box(g, 0.02, 0.02, 0.26, 0x8a8f94, lx, y, 0);
  for (let y = 1.4; y < h + 0.5; y += 0.45) {
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.012, 4, 14, Math.PI), mat(0x8a8f94));
    hoop.rotation.set(Math.PI / 2, 0, -Math.PI / 2);
    add(g, hoop, lx + 0.02, y, 0);
  }
  for (const a of [-0.6, 0, 0.6]) {
    const bar = box(g, 0.012, h - 1.0, 0.012, 0x8a8f94, lx + 0.02 + Math.cos(a) * 0.2, 1.4 + (h - 1.0) / 2 - 0.1, Math.sin(a) * 0.2);
    bar.castShadow = false;
  }
  // Fill pipe with a hopper at the bottom.
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, h + 1.4, 10), shineOn(new THREE.MeshLambertMaterial({ color: 0xb5bcc2 }), 0.3));
  pipe.rotation.z = 0.35;
  add(g, pipe, -radius - 0.35, (h + 1.4) / 2 - 0.1, radius * 0.4);
  add(g, new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.12, 0.4, 4, 1, false, Math.PI / 4), mat(0x8c9399)), -radius - 0.95, 0.35, radius * 0.4);
  mergeLocal(g);
  return g;
}

export function buildShed(w: number, d: number, wall = 0xa6463a, roof = 0x6f7a80, style: 'barn' | 'house' = 'barn') {
  const g = new THREE.Group();
  const h = 1.6;
  const house = style === 'house';
  const wallMat = new THREE.MeshLambertMaterial({ color: wall, map: house ? siding(1, 6) : corrugated(w * 2.2, 1) });
  box(g, w, h, d, wallMat, 0, h / 2, 0);
  // Gable ends (triangles) with UVs so the texture carries up.
  const top = h + 0.9;
  const gable = new THREE.BufferGeometry();
  gable.setAttribute('position', new THREE.Float32BufferAttribute([
    -w / 2, h, -d / 2, -w / 2, h, d / 2, -w / 2, top - 0.08, 0,
    w / 2, h, d / 2, w / 2, h, -d / 2, w / 2, top - 0.08, 0,
  ], 3));
  gable.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 0.45, 0, 0, 1, 0, 0.5, 0.45], 2));
  gable.computeVertexNormals();
  const gableMat = wallMat.clone();
  gableMat.side = THREE.DoubleSide;
  add(g, new THREE.Mesh(gable, gableMat), 0, 0, 0);
  // Two roof panels with a ridge cap and gutters.
  const slope = Math.hypot(d / 2 + 0.18, top - h);
  const ang = Math.atan2(top - h, d / 2 + 0.18);
  const roofMat = shineOn(new THREE.MeshLambertMaterial({ color: roof, map: house ? shingles(w * 1.5, slope * 3) : corrugated(w * 2.4, 1) }), house ? 0 : 0.18);
  for (const s of [-1, 1]) {
    const panel = box(g, w + 0.3, 0.05, slope, roofMat, 0, (h + top) / 2 + 0.02, s * (d / 4 + 0.09));
    panel.rotation.x = s * ang;
    const gutter = box(g, w + 0.3, 0.05, 0.06, 0x7a7f84, 0, h - 0.02, s * (d / 2 + 0.2));
    gutter.castShadow = false;
  }
  box(g, w + 0.32, 0.06, 0.12, 0x5d6368, 0, top + 0.02, 0);
  // Corner trim.
  for (const [x, z] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) box(g, 0.06, h, 0.06, 0xf2efe6, x * w / 2, h / 2, z * d / 2);
  if (!house) {
    // Big sliding door with a white X-braced frame, its track, and small windows.
    const door = new THREE.MeshLambertMaterial({ color: 0x7a2a20, map: corrugated(4, 1) });
    box(g, w * 0.44, h * 0.86, 0.04, door, 0, h * 0.43, d / 2 + 0.02);
    const W = w * 0.44, H = h * 0.86;
    for (const [x, y, bw, bh] of [[0, H, W, 0.06], [0, 0.03, W, 0.06], [-W / 2, H / 2, 0.06, H], [W / 2, H / 2, 0.06, H], [0, H / 2, W, 0.05]]) box(g, bw, bh, 0.03, 0xf2efe6, x, y, d / 2 + 0.05);
    const diag = Math.hypot(W, H / 2);
    for (const [sy, sgn] of [[H * 0.25, 1], [H * 0.25, -1], [H * 0.75, 1], [H * 0.75, -1]]) {
      const b = box(g, diag, 0.045, 0.03, 0xf2efe6, 0, sy, d / 2 + 0.05);
      b.rotation.z = sgn * Math.atan2(H / 2, W);
    }
    box(g, w * 0.95, 0.05, 0.05, 0x3a3a3a, 0, h * 0.9, d / 2 + 0.06);
    for (const x of [-w * 0.36, w * 0.36]) {
      box(g, 0.34, 0.28, 0.03, 0x2c3e48, x, h * 0.62, d / 2 + 0.02);
      box(g, 0.4, 0.04, 0.05, 0xf2efe6, x, h * 0.46, d / 2 + 0.03);
    }
    box(g, 0.34, 0.34, 0.03, 0x2c3e48, w / 2 + 0.01, top - 0.55, 0).rotation.y = Math.PI / 2; // hayloft
  }
  mergeLocal(g);
  return g;
}

export function buildFarmhouse() {
  const g = buildShed(2.6, 2.2, 0xefe6d2, 0x8a3b30, 'house');
  for (const x of [-0.7, 0.7]) {
    box(g, 0.5, 0.5, 0.05, GLASS, x, 1.0, 1.11);
    box(g, 0.58, 0.06, 0.08, 0xffffff, x, 0.72, 1.12); // sill
    box(g, 0.12, 0.52, 0.04, 0x3f6b4a, x - 0.33, 1.0, 1.12); // shutters
    box(g, 0.12, 0.52, 0.04, 0x3f6b4a, x + 0.33, 1.0, 1.12);
  }
  box(g, 0.3, 0.9, 0.3, 0x7a4a3a, 0.8, 2.3, -0.4); // chimney
  // Porch: deck, posts and a little roof over the door.
  box(g, 1.6, 0.12, 0.8, 0x9a7b5a, 0, 0.06, 1.5);
  for (const x of [-0.72, 0.72]) box(g, 0.07, 1.25, 0.07, 0xffffff, x, 0.7, 1.84);
  const pr = box(g, 1.8, 0.07, 1.0, 0x8a3b30, 0, 1.36, 1.5);
  pr.rotation.x = 0.18;
  box(g, 0.5, 0.95, 0.05, 0x6b3a2a, 0, 0.55, 1.11); // door
  // Garden: picket fence and a flower bed.
  for (let i = 0; i < 9; i++) box(g, 0.05, 0.35, 0.05, 0xffffff, -1.6 + i * 0.4, 0.17, 2.15);
  box(g, 3.3, 0.04, 0.03, 0xffffff, 0, 0.26, 2.15);
  box(g, 0.9, 0.1, 0.25, 0x5a4030, -1.05, 0.05, 1.95);
  box(g, 0.9, 0.1, 0.25, 0x5a4030, 1.05, 0.05, 1.95);
  for (let i = 0; i < 10; i++) {
    const f = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 4), mat([0xe0525a, 0xf4d23c, 0xffffff, 0xb46bd6][i % 4]));
    f.position.set((i < 5 ? -1.45 : 0.65) + (i % 5) * 0.2, 0.17, 1.92 + ((i * 7) % 3) * 0.04);
    g.add(f);
  }
  return g;
}

export function buildElevator(w: number, d: number) {
  const g = new THREE.Group();
  box(g, w, 0.1, d, 0x9e9e96, 0, 0.05, 0);
  for (let i = 0; i < 4; i++) {
    const x = -w / 2 + 1.6 + i * 2.5;
    add(g, new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 5, 20), mat(0xdfe3e6)), x, 2.5, -d / 2 + 2.2);
    add(g, new THREE.Mesh(new THREE.ConeGeometry(1.14, 0.7, 20), mat(0xb5bcc2)), x, 5.35, -d / 2 + 2.2);
  }
  box(g, 0.8, 7, 0.8, 0x8c9399, w / 2 - 1.2, 3.5, -d / 2 + 2.2); // leg tower
  box(g, w * 0.95, 0.25, 0.3, 0x8c9399, 0, 5.6, -d / 2 + 2.2); // conveyor gallery
  box(g, 4.6, 1.5, 2, 0x3e6fa8, -w / 2 + 3, 0.75, d / 2 - 1.4); // office
  box(g, 4.8, 0.12, 2.2, 0x2c4f7a, -w / 2 + 3, 1.56, d / 2 - 1.4);
  box(g, 4.4, 1.9, 2.4, 0xd7d2c4, w / 2 - 3, 0.95, d / 2 - 1.3); // drive-through pit
  box(g, 3.2, 1.6, 0.05, 0x2b2b2b, w / 2 - 3, 0.8, d / 2 - 0.08);
  return g;
}

/** Darker undersides and sunlit tops, baked into vertex colors. */
function shadeCrown(geo: THREE.BufferGeometry, y0: number, y1: number) {
  const p = geo.getAttribute('position');
  const n = geo.getAttribute('normal');
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const t = Math.min(1, Math.max(0, (p.getY(i) - y0) / (y1 - y0)));
    const k = (0.55 + 0.6 * t) * (0.9 + 0.12 * n.getY(i));
    col[i * 3] = k * 0.97; col[i * 3 + 1] = k; col[i * 3 + 2] = k * 0.9;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

/** Instanced low-poly trees. */
export function buildTrees(points: { x: number; z: number; s: number; v: number }[]) {
  const group = new THREE.Group();
  const trunkGeo = new THREE.CylinderGeometry(0.08, 0.13, 0.8, 7);
  // Lumpy broadleaf crown: several jittered blobs merged together.
  const blobs: THREE.BufferGeometry[] = [];
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const [x, y, z, r] of [[0, 0, 0, 0.62], [0.35, -0.1, 0.1, 0.45], [-0.3, -0.05, -0.2, 0.48], [0.05, 0.3, -0.1, 0.45], [-0.1, -0.15, 0.35, 0.42]]) {
    const g = new THREE.IcosahedronGeometry(r, 1);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const k = 1 + (rnd() - 0.5) * 0.18;
      p.setXYZ(i, p.getX(i) * k + x, p.getY(i) * k + y, p.getZ(i) * k + z);
    }
    blobs.push(g);
  }
  const crownGeo = mergeGeometries(blobs)!;
  crownGeo.computeVertexNormals();
  shadeCrown(crownGeo, -0.6, 0.75);
  const pineGeo = mergeGeometries([0, 1, 2].map(i => {
    const g = new THREE.ConeGeometry(0.62 - i * 0.14, 0.9, 9);
    g.translate(0, -0.45 + i * 0.5, 0);
    return g;
  }))!;
  shadeCrown(pineGeo, -0.9, 1.3);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), points.length);
  const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshLambertMaterial({ vertexColors: true }), points.length);
  const pines = new THREE.InstancedMesh(pineGeo, new THREE.MeshLambertMaterial({ flatShading: true, vertexColors: true }), points.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const c = new THREE.Color();
  let nc = 0, np = 0;
  points.forEach((p, i) => {
    const birch = p.v >= 0.3 && p.v < 0.42;
    m.compose(new THREE.Vector3(p.x, 0.4 * p.s * (birch ? 1.3 : 1), p.z), q, new THREE.Vector3(p.s * (birch ? 0.8 : 1), p.s * (birch ? 1.3 : 1), p.s * (birch ? 0.8 : 1)));
    trunks.setMatrixAt(i, m);
    trunks.setColorAt(i, c.setHex(birch ? 0xe6e1d6 : 0x6b4a2f));
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.v * 7);
    if (p.v < 0.3) {
      m.compose(new THREE.Vector3(p.x, 1.4 * p.s, p.z), q, new THREE.Vector3(p.s, p.s, p.s));
      pines.setMatrixAt(np, m);
      pines.setColorAt(np++, c.setHex(0x2f6b3a).multiplyScalar(0.85 + p.v));
    } else {
      m.compose(new THREE.Vector3(p.x, 1.25 * p.s, p.z), q, new THREE.Vector3(p.s, p.s * 0.9, p.s));
      crowns.setMatrixAt(nc, m);
      crowns.setColorAt(nc++, birch ? c.setHex(0x8fbf4f) : c.setHex([0x3f8f3f, 0x4f9c45, 0x36803a, 0x5a9a3a][Math.floor(p.v * 10) % 4]));
    }
    q.identity();
  });
  crowns.count = nc;
  pines.count = np;
  for (const mesh of [trunks, crowns, pines]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
