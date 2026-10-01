import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { COMBINE_LEN, COMBINE_WID, HEADER_OFFSET, TOOL_LEN, type ToolKind } from '../game/config';
import { mat, mergeLocal, type ToolModel, type VehicleModel } from './models';
import { chrome, glass, paint } from './shine';

// Detailed machines built from primitives. Every model faces +x; 1 unit = 1 grid cell.
// Static parts are merged per material at the end (mergeLocal) so detail stays cheap to draw.

type Mat = THREE.Material | number;
const M = (c: Mat) => (typeof c === 'number' ? mat(c) : c);

function put(parent: THREE.Object3D, geo: THREE.BufferGeometry, c: Mat, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, shadow = true) {
  const mesh = new THREE.Mesh(geo, M(c));
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, rz);
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}
const bx = (p: THREE.Object3D, w: number, h: number, d: number, c: Mat, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
  put(p, new THREE.BoxGeometry(w, h, d), c, x, y, z, rx, ry, rz);
const rb = (p: THREE.Object3D, w: number, h: number, d: number, r: number, c: Mat, x: number, y: number, z: number) =>
  put(p, new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2)), c, x, y, z);
/** Cylinder along an axis. */
function cy(p: THREE.Object3D, r0: number, r1: number, len: number, c: Mat, x: number, y: number, z: number, axis: 'x' | 'y' | 'z' = 'y', seg = 12) {
  const g = new THREE.CylinderGeometry(r0, r1, len, seg);
  if (axis === 'x') g.rotateZ(-Math.PI / 2);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  return put(p, g, c, x, y, z);
}
/** A solid bar (square or round) from point a to point b, so parts always meet what they join. */
function link(p: THREE.Object3D, a: [number, number, number], b: [number, number, number], t: number, c: Mat, round = false) {
  const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
  const len = va.distanceTo(vb);
  const geo = round ? new THREE.CylinderGeometry(t / 2, t / 2, len, 10) : new THREE.BoxGeometry(t, len, t);
  const mesh = put(p, geo, c, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.sub(va).normalize());
  return mesh;
}

/** A side profile (x, y) extruded across z with rounded edges, centered on z = 0. */
function extrude(profile: [number, number][], depth: number, bevel = 0.025) {
  const shape = new THREE.Shape(profile.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 6 });
  g.translate(0, 0, -depth / 2);
  return g;
}

// ---------- decals ----------

const texCache = new Map<string, THREE.CanvasTexture>();
function canvasTex(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  let t = texCache.get(key);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  texCache.set(key, t);
  return t;
}

/** Side panel artwork: cooling vents, a pinstripe and a model badge. */
function sideDecal(key: string, badge: string, stripe = '#f4f1e8', vents = true) {
  return canvasTex(`side:${key}`, 256, 96, g => {
    if (vents) {
      g.fillStyle = 'rgba(20,20,20,0.85)';
      for (let i = 0; i < 6; i++) {
        g.beginPath();
        g.roundRect(170, 18 + i * 10, 70, 5, 2.5);
        g.fill();
      }
    }
    g.fillStyle = stripe;
    g.fillRect(0, 80, 256, 5);
    g.fillStyle = 'rgba(20,20,20,0.9)';
    g.fillRect(0, 86, 256, 2);
    g.font = 'bold 26px "Courier Prime", monospace';
    g.fillStyle = stripe;
    g.fillText(badge, 14, 60);
  });
}

/** Dark honeycomb grille. */
function grilleTex() {
  return canvasTex('grille', 64, 64, g => {
    g.fillStyle = '#141414';
    g.fillRect(0, 0, 64, 64);
    g.strokeStyle = '#3a3a3a';
    g.lineWidth = 1.5;
    for (let y = 0; y < 64; y += 6) for (let x = (y / 6) % 2 ? 3 : 0; x < 64; x += 6) g.strokeRect(x + 0.5, y + 0.5, 4, 4);
  });
}

function decalMat(tex: THREE.Texture) {
  return new THREE.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
}
const decalMats = new Map<THREE.Texture, THREE.MeshLambertMaterial>();
function decal(p: THREE.Object3D, tex: THREE.Texture, w: number, h: number, x: number, y: number, z: number, ry: number) {
  let m = decalMats.get(tex);
  if (!m) { m = decalMat(tex); decalMats.set(tex, m); }
  return put(p, new THREE.PlaneGeometry(w, h), m, x, y, z, 0, ry, 0, false);
}
/** The same decal on both sides of a body, reading correctly from each. */
function decalPair(p: THREE.Object3D, tex: THREE.Texture, w: number, h: number, x: number, y: number, halfWidth: number) {
  decal(p, tex, w, h, x, y, halfWidth + 0.004, 0);
  decal(p, tex, w, h, x, y, -halfWidth - 0.004, Math.PI);
}

// ---------- shared parts ----------

/** A lugged tire on a painted rim with a chrome hub; the group spins around z to roll. */
function wheel(parent: THREE.Object3D, r: number, width: number, x: number, z: number, rim: number, side: number) {
  const g = new THREE.Group();
  g.position.set(x, r, z);
  parent.add(g);
  const half = width / 2;
  const prof = [[r * 0.6, -half], [r * 0.88, -half], [r * 0.96, -half * 0.82], [r, -half * 0.5], [r, half * 0.5], [r * 0.96, half * 0.82], [r * 0.88, half], [r * 0.6, half]]
    .map(([a, b]) => new THREE.Vector2(a, b));
  put(g, new THREE.LatheGeometry(prof, 28).rotateX(Math.PI / 2), 0x1c1c1c, 0, 0, 0);
  // Chevron tread bars standing proud of the tire.
  const lugs = Math.max(12, Math.round(r * 46));
  const lugGeo = new THREE.BoxGeometry(r * 0.09, r * 0.09, half * 0.95);
  for (let i = 0; i < lugs; i++) {
    const a = (i / lugs) * Math.PI * 2;
    for (const s of [-1, 1]) {
      const l = put(g, lugGeo, 0x242424, Math.cos(a) * r * 1.0, Math.sin(a) * r * 1.0, s * half * 0.46, 0, s * 0.5, a, false);
      l.rotation.order = 'ZYX';
    }
  }
  // Rim barrel, dished center with holes, hub and wheel nuts.
  const rimMat = paint(rim, 0.12);
  put(g, new THREE.CylinderGeometry(r * 0.6, r * 0.6, width * 0.92, 20, 1, true).rotateX(Math.PI / 2), new THREE.MeshLambertMaterial({ color: rim, side: THREE.DoubleSide }), 0, 0, 0, 0, 0, 0, false);
  put(g, new THREE.CylinderGeometry(r * 0.58, r * 0.58, 0.02, 20).rotateX(Math.PI / 2), rimMat, 0, 0, side * half * 0.25);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    put(g, new THREE.CylinderGeometry(r * 0.07, r * 0.07, 0.025, 8).rotateX(Math.PI / 2), 0x151515, Math.cos(a) * r * 0.4, Math.sin(a) * r * 0.4, side * (half * 0.25 + 0.002), 0, 0, 0, false);
  }
  put(g, new THREE.CylinderGeometry(r * 0.2, r * 0.22, 0.07, 14).rotateX(Math.PI / 2), chrome(0xbfc3c6), 0, 0, side * (half * 0.25 + 0.035));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    put(g, new THREE.CylinderGeometry(0.012, 0.012, 0.03, 6).rotateX(Math.PI / 2), 0x8a8a8a, Math.cos(a) * r * 0.14, Math.sin(a) * r * 0.14, side * (half * 0.25 + 0.075), 0, 0, 0, false);
  }
  mergeLocal(g);
  g.userData.radius = r;
  return g;
}

/** Curved mudguard arc over a wheel. */
function fender(parent: THREE.Object3D, r: number, width: number, x: number, y: number, z: number, c: Mat, arc = Math.PI * 0.95) {
  // Theta PI points straight up once the cylinder is turned onto the z axis.
  const geo = new THREE.CylinderGeometry(r, r, width, 20, 1, true, Math.PI - arc / 2, arc);
  geo.rotateX(Math.PI / 2);
  return put(parent, geo, doubleSided(c), x, y, z);
}

const twoSided = new Map<Mat, THREE.Material>();
/** A double-sided twin of a material (for open shapes like mudguards), cached. */
function doubleSided(c: Mat) {
  let m = twoSided.get(c);
  if (!m) {
    m = typeof c === 'number' ? new THREE.MeshLambertMaterial({ color: c, side: THREE.DoubleSide }) : c.clone();
    m.side = THREE.DoubleSide;
    twoSided.set(c, m);
  }
  return m;
}

function lightsMat() {
  return new THREE.MeshLambertMaterial({ color: 0xfff4c2, emissive: 0xffe9a0, emissiveIntensity: 0 });
}
const TAIL = () => new THREE.MeshLambertMaterial({ color: 0xa01818, emissive: 0x600000, emissiveIntensity: 0.3 });
const AMBER = () => new THREE.MeshLambertMaterial({ color: 0xff9a1f, emissive: 0xff7a00, emissiveIntensity: 0.5 });

/**
 * Modern cab: tinted wraparound glass, black pillars and door frames, a white roof with
 * work lights and a beacon, mirrors on arms, a seat and steering wheel inside.
 */
function cab(p: THREE.Object3D, x: number, y: number, w: number, h: number, d: number, lights: THREE.Material, roofColor = 0xf2f2ee) {
  const black = 0x161616;
  // Interior first so it shows through the glass.
  bx(p, w * 0.35, 0.05, d * 0.4, 0x2a2a2a, x - w * 0.1, y + 0.16, 0); // seat
  bx(p, 0.05, 0.22, d * 0.4, 0x2a2a2a, x - w * 0.27, y + 0.28, 0); // backrest
  bx(p, 0.08, 0.14, d * 0.7, 0x222222, x + w * 0.38, y + 0.1, 0); // dashboard
  put(p, new THREE.TorusGeometry(0.07, 0.012, 6, 16), black, x + w * 0.22, y + 0.24, 0, 0, Math.PI / 2, -0.6);
  put(p, new RoundedBoxGeometry(w, h, d, 3, 0.06), glass(), x, y + h / 2, 0, 0, 0, 0, false);
  // Pillars and frames.
  for (const [px, pz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) bx(p, 0.035, h, 0.035, black, x + px * (w / 2 - 0.01), y + h / 2, pz * (d / 2 - 0.01));
  for (const s of [-1, 1]) {
    bx(p, 0.03, h, 0.02, black, x + w * 0.05, y + h / 2, s * (d / 2 + 0.002)); // B pillar
    bx(p, w, 0.03, 0.02, black, x, y + 0.02, s * (d / 2 + 0.002)); // sill
    bx(p, 0.025, 0.025, 0.012, 0xb5b8ba, x + w * 0.12, y + h * 0.55, s * (d / 2 + 0.012)); // handle
  }
  bx(p, 0.01, 0.01, d * 0.5, black, x + w / 2 + 0.005, y + h * 0.35, 0, 0.5); // wiper
  // Roof with a dark sun visor, work lights, beacon and antenna.
  rb(p, w + 0.12, 0.08, d + 0.12, 0.035, paint(roofColor, 0.1), x, y + h + 0.04, 0);
  bx(p, 0.06, 0.03, d + 0.1, 0x1e1e1e, x + w / 2 + 0.07, y + h + 0.02, 0);
  for (const z of [-0.36, -0.14, 0.14, 0.36]) bx(p, 0.03, 0.035, 0.07, lights, x + w / 2 + 0.07, y + h + 0.06, z * d, 0, 0, 0);
  for (const z of [-0.3, 0.3]) bx(p, 0.03, 0.035, 0.07, lights, x - w / 2 - 0.07, y + h + 0.06, z * d);
  const beacon = AMBER();
  put(p, new THREE.CylinderGeometry(0.03, 0.036, 0.06, 10), beacon, x - w * 0.3, y + h + 0.11, d * 0.32, 0, 0, 0, false);
  put(p, new THREE.CylinderGeometry(0.004, 0.004, 0.3, 4), black, x - w * 0.4, y + h + 0.22, -d * 0.35, 0, 0, 0, false);
  // Mirrors on arms.
  for (const s of [-1, 1]) {
    bx(p, 0.02, 0.02, 0.16, black, x + w * 0.46, y + h * 0.8, s * (d / 2 + 0.08));
    bx(p, 0.025, 0.12, 0.07, black, x + w * 0.48, y + h * 0.72, s * (d / 2 + 0.17));
    bx(p, 0.004, 0.1, 0.055, chrome(), x + w * 0.465, y + h * 0.72, s * (d / 2 + 0.17));
  }
  return beacon;
}

// ---------- tractor ----------

export function buildTractor(color = 0xc8392b): VehicleModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const red = paint(color, 0.1);
  const dark = 0x2e3134, black = 0x181818;
  const lights = lightsMat();
  const wheels = [
    wheel(body, 0.37, 0.24, -0.38, 0.43, 0xd9a400, 1), wheel(body, 0.37, 0.24, -0.38, -0.43, 0xd9a400, -1),
  ];
  // Front wheels sit in steering pivots together with their mudguards.
  const steer = [1, -1].map(s => {
    const piv = new THREE.Group();
    piv.position.set(0.53, 0, s * 0.35);
    body.add(piv);
    const w = wheel(piv, 0.23, 0.16, 0, 0, 0xd9a400, s);
    wheels.push(w);
    fender(piv, 0.27, 0.18, 0, 0.26, 0, red, Math.PI * 0.55);
    mergeLocal(piv, [w]);
    return piv;
  });
  // Chassis, engine block, front axle.
  bx(body, 1.12, 0.16, 0.32, dark, 0.12, 0.36, 0);
  bx(body, 0.55, 0.16, 0.28, 0x44484c, 0.35, 0.45, 0);
  bx(body, 0.1, 0.07, 0.62, dark, 0.53, 0.24, 0);
  cy(body, 0.065, 0.075, 0.64, dark, -0.38, 0.37, 0, 'z'); // rear axle housings out to the hubs
  for (const sgn of [-1, 1]) cy(body, 0.035, 0.035, 0.14, dark, 0.53, 0.24, sgn * 0.33); // front kingpins
  // Sloped hood with rounded edges.
  put(body, extrude([[-0.02, 0.44], [0.8, 0.44], [0.86, 0.5], [0.87, 0.62], [0.8, 0.7], [0.4, 0.765], [-0.02, 0.8]], 0.38, 0.03), red, 0, 0, 0);
  bx(body, 0.34, 0.012, 0.2, black, 0.52, 0.778, 0, 0, 0, 0.16); // top intake
  decalPair(body, sideDecal('tractor', 'HV 720'), 0.72, 0.27, 0.42, 0.6, 0.19 + 0.03);
  decal(body, grilleTex(), 0.32, 0.2, 0.903, 0.57, 0, Math.PI / 2);
  for (const z of [0.14, -0.14]) bx(body, 0.012, 0.045, 0.08, lights, 0.905, 0.67, z);
  // Front weight stack and carrier.
  bx(body, 0.06, 0.08, 0.3, dark, 0.93, 0.3, 0);
  for (let i = 0; i < 5; i++) rb(body, 0.045, 0.22, 0.48, 0.015, 0x3a3d40, 0.97 + i * 0.05, 0.36, 0);
  // Cab base, cab and steps.
  rb(body, 0.66, 0.12, 0.68, 0.04, red, -0.3, 0.6, 0);
  const beacon = cab(body, -0.3, 0.66, 0.58, 0.5, 0.62, lights);
  for (let i = 0; i < 3; i++) bx(body, 0.12, 0.02, 0.1, black, -0.12, 0.26 + i * 0.12, 0.36 + i * 0.012);
  cy(body, 0.01, 0.01, 0.45, chrome(), -0.03, 0.48, 0.38);
  // Rear mudguards with work and tail lights.
  for (const s of [-1, 1]) {
    fender(body, 0.43, 0.27, -0.38, 0.37, s * 0.43, red, Math.PI * 0.8);
    bx(body, 0.03, 0.05, 0.07, TAIL(), -0.82, 0.62, s * 0.5);
    bx(body, 0.05, 0.04, 0.07, AMBER(), -0.8, 0.68, s * 0.5);
  }
  // Exhaust stack with heat shield, and the air intake pre-cleaner.
  cy(body, 0.028, 0.028, 0.5, chrome(), 0.1, 1.0, 0.16);
  put(body, new THREE.CylinderGeometry(0.03, 0.028, 0.08, 10), chrome(), 0.12, 1.28, 0.16, 0, 0, -0.35);
  bx(body, 0.08, 0.2, 0.07, black, 0.1, 0.92, 0.19);
  cy(body, 0.045, 0.045, 0.18, black, 0.1, 0.92, -0.16);
  cy(body, 0.06, 0.05, 0.05, 0x333333, 0.1, 1.03, -0.16);
  // Fuel tank and battery box.
  rb(body, 0.34, 0.15, 0.13, 0.04, black, -0.02, 0.36, -0.27);
  bx(body, 0.16, 0.12, 0.1, dark, 0.2, 0.34, 0.25);
  // Three-point linkage, PTO, drawbar and hydraulic couplers.
  for (const s of [-1, 1]) bx(body, 0.34, 0.035, 0.035, dark, -0.78, 0.28, s * 0.14, 0, s * 0.12, 0);
  bx(body, 0.3, 0.035, 0.035, chrome(0xa8acb0), -0.76, 0.56, 0, 0, 0, -0.2);
  cy(body, 0.025, 0.025, 0.12, 0x999999, -0.72, 0.38, 0, 'x');
  bx(body, 0.2, 0.04, 0.08, dark, -0.8, 0.22, 0);
  for (const [z, c] of [[0.06, 0xc0392b], [0.1, 0x2e6fd0], [-0.06, 0xc0392b], [-0.1, 0x2e6fd0]] as const) cy(body, 0.012, 0.012, 0.04, c, -0.66, 0.66, z, 'x');
  mergeLocal(body, [...wheels, ...steer]);
  return { root, body, wheels, lights, steer, beacon };
}

// ---------- combine ----------

function buildHeader(width: number) {
  const g = new THREE.Group();
  const yel = paint(0xe3a822, 0.14);
  const grey = 0x6c7176;
  // Curved trough (open half cylinder), back wall, floor and cutter bar with guard teeth.
  const trough = new THREE.CylinderGeometry(0.2, 0.2, width, 16, 1, true, Math.PI, Math.PI * 0.9);
  trough.rotateX(Math.PI / 2);
  put(g, trough, new THREE.MeshLambertMaterial({ color: 0xc9951b, side: THREE.DoubleSide }), 0, 0.32, 0);
  rb(g, 0.08, 0.42, width, 0.02, yel, -0.22, 0.44, 0);
  bx(g, 0.4, 0.03, width, 0x8a6a1a, 0.08, 0.14, 0);
  bx(g, 0.05, 0.03, width, chrome(0x9aa0a5), 0.3, 0.13, 0);
  const tooth = new THREE.ConeGeometry(0.012, 0.09, 4).rotateZ(-Math.PI / 2);
  for (let z = -width / 2 + 0.04; z < width / 2; z += 0.07) put(g, tooth, 0x5a5f63, 0.35, 0.13, z, 0, 0, 0, false);
  // Auger tube with helical flighting.
  cy(g, 0.05, 0.05, width - 0.12, 0xb07c12, 0.02, 0.32, 0, 'z', 10);
  const flight = new THREE.BoxGeometry(0.02, 0.19, 0.035);
  for (let z = -width / 2 + 0.1; z < width / 2 - 0.1; z += 0.045) {
    const a = z * 9;
    put(g, flight, 0xd9a21c, 0.02, 0.32, z, a, 0, 0, false);
  }
  // Side walls, crop dividers and skid shoes.
  for (const s of [1, -1]) {
    put(g, extrude([[-0.26, 0.12], [0.3, 0.12], [0.42, 0.18], [0.1, 0.62], [-0.26, 0.66]], 0.04, 0.01), yel, 0, 0, s * (width / 2));
    put(g, new THREE.ConeGeometry(0.07, 0.34, 6), yel, 0.5, 0.18, s * (width / 2), 0, 0, -Math.PI / 2 - 0.25);
  }
  for (let z = -width / 2 + 0.5; z < width / 2 - 0.3; z += 1.1) bx(g, 0.4, 0.03, 0.08, grey, 0.05, 0.06, z, 0, 0, 0.08);
  // Reel with bats and spring tines; spins around z.
  const reel = new THREE.Group();
  reel.position.set(0.2, 0.68, 0);
  g.add(reel);
  cy(reel, 0.035, 0.035, width - 0.1, 0x7a5a10, 0, 0, 0, 'z', 8);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    bx(reel, 0.025, 0.025, width - 0.14, 0xe0b34a, Math.cos(a) * 0.21, Math.sin(a) * 0.21, 0);
    for (let t = -width / 2 + 0.15; t < width / 2 - 0.1; t += 0.18) {
      put(reel, new THREE.BoxGeometry(0.008, 0.1, 0.008), 0x666666, Math.cos(a) * 0.26, Math.sin(a) * 0.26, t, 0, 0, a, false);
    }
  }
  for (let k = 0; k < 3; k++) {
    const zz = -width / 2 + 0.1 + k * ((width - 0.2) / 2);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      bx(reel, 0.03, 0.21, 0.02, 0x7a5a10, Math.cos(a) * 0.105, Math.sin(a) * 0.105, zz, 0, 0, a - Math.PI / 2);
    }
  }
  // Reel arms.
  for (const s of [1, -1]) bx(g, 0.5, 0.04, 0.04, yel, -0.02, 0.7, s * (width / 2 - 0.06), 0, 0, -0.25);
  mergeLocal(reel);
  mergeLocal(g, [reel]);
  return { g, reel };
}

export function setHeader(model: VehicleModel, width: number) {
  if (model.headerWidth === width) return;
  if (model.header) model.body.remove(model.header);
  const { g, reel } = buildHeader(width);
  g.position.set(HEADER_OFFSET, 0, 0);
  model.body.add(g);
  model.header = g;
  model.reel = reel;
  model.headerWidth = width;
}

export function buildCombine(headerWidth: number): VehicleModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const L = COMBINE_LEN, W = COMBINE_WID;
  const yel = paint(0xe3a822, 0.1);
  const dark = 0x2b2b2b;
  const lights = lightsMat();
  const wheels = [
    wheel(body, 0.5, 0.34, 0.45, W / 2 - 0.02, 0xc9ccce, 1), wheel(body, 0.5, 0.34, 0.45, -W / 2 + 0.02, 0xc9ccce, -1),
  ];
  // Rear wheels steer (the other way round from a tractor).
  const steer = [1, -1].map(s => {
    const piv = new THREE.Group();
    piv.position.set(-0.85, 0, s * (W / 2 - 0.14));
    body.add(piv);
    wheels.push(wheel(piv, 0.3, 0.2, 0, 0, 0xc9ccce, s));
    return piv;
  });
  cy(body, 0.08, 0.08, W - 0.1, dark, 0.45, 0.5, 0, 'z'); // front drive axle
  cy(body, 0.05, 0.05, W - 0.3, dark, -0.85, 0.3, 0, 'z'); // rear steering axle
  for (const sgn of [-1, 1]) link(body, [-0.85, 0.46, sgn * 0.3], [-0.85, 0.3, sgn * 0.3], 0.07, dark);
  // Main body: a long side profile, sloping up to the engine at the back.
  put(body, extrude([[-1.25, 0.45], [0.92, 0.45], [0.98, 0.62], [0.98, 1.18], [0.4, 1.24], [-0.95, 1.3], [-1.25, 1.12]], W * 0.66, 0.04), yel, 0, 0, 0);
  bx(body, L * 0.7, 0.06, W * 0.7, dark, -0.15, 0.44, 0);
  decalPair(body, sideDecal('combine', 'HV 540', '#2b2b2b'), 1.3, 0.48, -0.2, 0.86, W * 0.33 + 0.04);
  // Access door outlines along the flanks.
  for (const s of [-1, 1]) for (const x of [-1.08, 0.12, 0.55]) bx(body, 0.012, 0.42, 0.01, 0x9a7414, x, 0.84, s * (W * 0.33 + 0.045));
  for (const s of [-1, 1]) fender(body, 0.56, 0.36, 0.45, 0.5, s * (W / 2 - 0.02), yel, Math.PI * 0.75);
  // Grain tank with flared extension walls and grain inside.
  rb(body, 1.15, 0.28, W * 0.7, 0.05, yel, -0.35, 1.42, 0);
  for (const s of [-1, 1]) {
    bx(body, 1.2, 0.2, 0.02, 0xc28d17, -0.35, 1.64, s * (W * 0.36 + 0.03), s * 0.35, 0, 0);
    bx(body, 0.02, 0.2, W * 0.78, 0xc28d17, -0.35 + s * 0.62, 1.64, 0, 0, 0, s * -0.35);
  }
  bx(body, 1.12, 0.02, W * 0.66, 0x3a2f1c, -0.35, 1.3, 0); // tank floor
  // Engine deck with a round radiator screen and exhaust.
  bx(body, 0.45, 0.14, W * 0.6, dark, -1.02, 1.36, 0);
  for (const s of [-1, 1]) {
    put(body, new THREE.TorusGeometry(0.17, 0.02, 6, 24), 0x2b2b2b, -1.0, 1.02, s * (W * 0.33 + 0.045), 0, 0, 0, false);
    decal(body, grilleTex(), 0.32, 0.32, -1.0, 1.02, s * (W * 0.33 + 0.05), s > 0 ? 0 : Math.PI);
  }
  cy(body, 0.035, 0.035, 0.34, chrome(), -0.85, 1.6, -0.3);
  // Straw chopper and twin spreader discs at the back.
  rb(body, 0.3, 0.42, W * 0.6, 0.05, 0x3a3a3a, -1.35, 0.68, 0);
  for (const z of [0.2, -0.2]) cy(body, 0.14, 0.14, 0.03, 0x555555, -1.5, 0.48, z, 'y', 14);
  for (const s of [-1, 1]) bx(body, 0.03, 0.06, 0.08, TAIL(), -1.28, 1.05, s * W * 0.33);
  // Feeder house down to the header.
  put(body, extrude([[0.85, 0.35], [1.35, 0.3], [1.35, 0.75], [0.85, 0.95]], 0.52, 0.02), yel, 0, 0, 0);
  // Cab on a platform with railings, a ladder, and a light bar.
  rb(body, 0.62, 0.1, 0.84, 0.03, yel, 0.62, 1.24, 0);
  const beacon = cab(body, 0.64, 1.29, 0.54, 0.56, 0.74, lights);
  for (let i = 0; i < 6; i++) bx(body, 0.03, 0.035, 0.07, lights, 0.95, 1.92, -0.3 + i * 0.12);
  for (const x of [0.32, 0.98]) cy(body, 0.01, 0.01, 0.3, chrome(), x, 1.44, W / 2 - 0.2);
  bx(body, 0.68, 0.012, 0.012, chrome(), 0.65, 1.58, W / 2 - 0.2);
  for (const z of [W / 2 - 0.06, W / 2 - 0.2]) bx(body, 0.012, 1.0, 0.012, 0x222222, 0.36, 0.84, z, 0, 0, -0.18);
  for (let i = 0; i < 6; i++) bx(body, 0.012, 0.012, 0.14, 0x222222, 0.4 - i * 0.03, 0.42 + i * 0.16, W / 2 - 0.13);
  const lightsFront = lights;
  void lightsFront;

  // Unloading auger: pivots at the rear left of the tank and swings out when unloading.
  const pipe = new THREE.Group();
  pipe.position.set(-0.55, 1.5, -W * 0.3);
  body.add(pipe);
  cy(pipe, 0.07, 0.07, 1.9, 0xb8841a, 0.95, 0, 0, 'x', 12);
  for (let i = 0; i < 4; i++) cy(pipe, 0.078, 0.078, 0.03, 0x8a6210, 0.3 + i * 0.45, 0, 0, 'x', 12);
  put(pipe, new THREE.CylinderGeometry(0.06, 0.09, 0.24, 10), 0x8a6210, 1.9, -0.12, 0);
  bx(pipe, 0.9, 0.015, 0.015, 0x333333, 0.5, 0.12, 0, 0, 0, 0.12);
  pipe.rotation.y = Math.PI * 0.94;
  mergeLocal(pipe);
  mergeLocal(body, [...wheels, ...steer, pipe]);
  // Grain heap in the tank, grown by the view as the tank fills.
  const grain = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1, W * 0.64), new THREE.MeshLambertMaterial({ color: 0xe2bf5a, flatShading: true }));
  grain.position.set(-0.35, 1.32, 0);
  grain.scale.y = 0.01;
  grain.visible = false;
  body.add(grain);
  const model: VehicleModel = { root, body, wheels, lights, pipe, steer, steerSign: -1, beacon, grain };
  setHeader(model, headerWidth);
  return model;
}

// ---------- root harvester ----------

export function buildRootHarvester(): VehicleModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const green = paint(0x2f7d3a, 0.1);
  const dark = 0x2b2b2b, black = 0x161616;
  const lights = lightsMat();
  const wheels = [
    wheel(body, 0.46, 0.32, 0.35, 0.62, 0x444444, 1), wheel(body, 0.46, 0.32, 0.35, -0.62, 0x444444, -1),
    wheel(body, 0.46, 0.32, -0.8, 0.62, 0x444444, 1), wheel(body, 0.46, 0.32, -0.8, -0.62, 0x444444, -1),
  ];
  put(body, extrude([[-1.25, 0.5], [0.9, 0.5], [0.95, 0.66], [0.9, 1.05], [-1.2, 1.1], [-1.28, 0.9]], 1.0, 0.04), green, 0, 0, 0);
  decalPair(body, sideDecal('root', 'HV R2', '#f4f1e8'), 1.2, 0.4, -0.25, 0.78, 0.5 + 0.04);
  for (const s of [-1, 1]) {
    fender(body, 0.52, 0.34, 0.35, 0.46, s * 0.62, green, Math.PI * 0.7);
    fender(body, 0.52, 0.34, -0.8, 0.46, s * 0.62, green, Math.PI * 0.7);
  }
  // Bunker with sloped walls, heaped with potatoes.
  for (const s of [-1, 1]) bx(body, 1.2, 0.5, 0.03, 0x256a30, -0.55, 1.35, s * 0.6, s * 0.18, 0, 0);
  bx(body, 0.03, 0.5, 1.2, 0x256a30, -1.15, 1.35, 0, 0, 0, 0.18);
  const tuber = new THREE.IcosahedronGeometry(0.06, 0);
  for (let i = 0; i < 70; i++) {
    const a = i * 2.39996, r = Math.sqrt(i / 70) * 0.5;
    put(body, tuber.clone().scale(1.2, 0.85, 1), 0xb58a52, -0.55 + Math.cos(a) * r, 1.34 + (0.5 - r) * 0.28 + (i % 3) * 0.01, Math.sin(a) * r, i, i * 2, 0, false);
  }
  // Sorting deck with rollers, and the elevator web climbing to the bunker.
  for (let i = 0; i < 7; i++) cy(body, 0.03, 0.03, 0.9, 0x555555, 0.35 - i * 0.07, 1.1, 0, 'z', 8);
  for (let i = 0; i < 10; i++) bx(body, 0.02, 0.02, 0.8, 0x3a3a3a, 0.9 - i * 0.07, 0.6 + i * 0.05, 0.58, 0, 0, 0);
  // Cab.
  rb(body, 0.62, 0.1, 0.8, 0.03, green, 0.55, 1.1, 0);
  cab(body, 0.56, 1.15, 0.52, 0.52, 0.7, lights);
  const beacon = AMBER();
  // Digging unit at the front: two rows of shares and discs.
  const digger = new THREE.Group();
  digger.position.set(HEADER_OFFSET, 0, 0);
  body.add(digger);
  rb(digger, 0.7, 0.28, 2.0, 0.04, green, 0, 0.38, 0);
  for (const z of [-0.5, 0.5]) {
    bx(digger, 0.42, 0.1, 0.46, 0x8c8c8c, 0.26, 0.1, z, 0, 0, -0.35);
    for (const s of [-1, 1]) cy(digger, 0.14, 0.14, 0.02, 0x9aa0a5, 0.35, 0.16, z + s * 0.2, 'z', 14);
  }
  bx(digger, 0.05, 0.05, 2.0, dark, 0.34, 0.5, 0);
  for (const s of [-1, 1]) bx(body, 0.03, 0.06, 0.08, TAIL(), -1.3, 0.95, s * 0.4);
  put(body, new THREE.CylinderGeometry(0.03, 0.036, 0.06, 10), beacon, 0.4, 1.8, 0.25, 0, 0, 0, false);
  void black;
  const pipe = new THREE.Group();
  pipe.position.set(-0.55, 1.6, -0.55);
  body.add(pipe);
  bx(pipe, 1.9, 0.12, 0.4, 0x3a3a3a, 0.95, 0, 0);
  for (let i = 0; i < 12; i++) bx(pipe, 0.03, 0.03, 0.38, 0x777777, 0.1 + i * 0.15, 0.07, 0);
  pipe.rotation.y = Math.PI * 0.94;
  mergeLocal(pipe);
  mergeLocal(digger);
  mergeLocal(body, [...wheels, pipe, digger]);
  return { root, body, wheels, lights, pipe, header: digger, beacon };
}

// ---------- implements ----------

export function buildTool(kind: ToolKind, width: number): ToolModel {
  const root = new THREE.Group();
  const len = TOOL_LEN[kind];
  const wheels: THREE.Group[] = [];
  const dark = 0x2e3134, steel = 0x9aa0a5;
  // Drawbar/headstock toward the tractor.
  bx(root, 0.45, 0.06, 0.08, dark, len / 2 - 0.08, 0.36, 0);
  bx(root, 0.08, 0.14, 0.26, dark, len / 2 + 0.12, 0.38, 0);
  let fill: THREE.Mesh | undefined;
  let tip: THREE.Group | undefined;
  const spin: THREE.Group[] = [];
  if (kind === 'plow') {
    const blue = paint(0x3d7fc0, 0.14);
    // Bodies step back diagonally; the main beam runs straight through the top of every leg.
    const n = Math.max(2, width * 2);
    const k = 0.3;
    const bodyAt = (i: number) => {
      const z = -width / 2 + (i + 0.5) * (width / n);
      return { x: 0.3 - (z + width / 2) * k, z };
    };
    const first = bodyAt(0), last = bodyAt(n - 1);
    const beamY = 0.5;
    link(root, [first.x + 0.12, beamY, first.z - 0.1], [last.x - 0.08, beamY, last.z + 0.05], 0.12, blue);
    // Headstock to the front of the beam, with a brace.
    link(root, [len / 2 + 0.1, 0.4, 0], [first.x + 0.1, beamY, first.z - 0.05], 0.1, blue);
    link(root, [len / 2 + 0.1, 0.4, 0.1], [bodyAt(Math.min(1, n - 1)).x, beamY, bodyAt(Math.min(1, n - 1)).z], 0.06, blue);
    const mould = new THREE.CylinderGeometry(0.2, 0.2, 0.24, 12, 1, true, 0, Math.PI / 2);
    const mouldMat = doubleSided(0xa9aeb2);
    for (let i = 0; i < n; i++) {
      const { x, z } = bodyAt(i);
      link(root, [x, beamY, z], [x - 0.02, 0.12, z], 0.05, blue); // leg
      put(root, mould, mouldMat, x - 0.2, 0.16, z, 0.15, 0, 0); // curved moldboard turning soil outward
      put(root, new THREE.ConeGeometry(0.05, 0.2, 4).rotateZ(-Math.PI / 2), 0x5a5f63, x + 0.06, 0.07, z + 0.02); // share point
      bx(root, 0.3, 0.14, 0.015, 0x6a6f73, x - 0.1, 0.1, z - 0.02); // landside
      link(root, [x + 0.05, beamY, z], [x + 0.2, 0.2, z - 0.05], 0.035, blue); // coulter arm
      cy(root, 0.12, 0.12, 0.015, 0xc9cdd0, x + 0.2, 0.17, z - 0.05, 'z', 16); // coulter disc
    }
    // Depth wheel on an arm off the end of the beam.
    const wz = last.z + 0.22, wx = last.x - 0.15, wr = 0.18;
    link(root, [last.x - 0.05, beamY, last.z + 0.05], [wx, beamY, wz - 0.08], 0.06, blue);
    link(root, [wx, beamY, wz - 0.08], [wx, wr, wz - 0.08], 0.05, blue);
    cy(root, 0.02, 0.02, 0.1, 0x888888, wx, wr, wz - 0.04, 'z');
    wheels.push(wheel(root, wr, 0.1, wx, wz, 0x3d7fc0, 1));
  } else if (kind === 'seeder') {
    const teal = paint(0x2a8a7a, 0.14);
    rb(root, 0.55, 0.38, width * 0.96, 0.05, teal, 0.02, 0.66, 0); // hopper
    rb(root, 0.58, 0.05, width * 0.98, 0.02, paint(0x35a894, 0.12), 0.02, 0.87, 0); // lid
    for (let i = 0; i < 4; i++) bx(root, 0.012, 0.012, 0.18, 0x333333, 0.3, 0.5 + i * 0.09, width * 0.3); // ladder
    bx(root, 0.12, 0.1, width, dark, -0.18, 0.34, 0);
    const n = width * 3;
    for (let i = 0; i < n; i++) {
      const z = -width / 2 + (i + 0.5) * (width / n);
      cy(root, 0.012, 0.012, 0.24, 0x333333, -0.18, 0.28, z); // seed tube
      cy(root, 0.09, 0.09, 0.02, 0xa8adb2, -0.24, 0.1, z + 0.02, 'z', 12); // disc opener
      cy(root, 0.05, 0.05, 0.05, 0x222222, -0.4, 0.06, z, 'z', 10); // press wheel
    }
    for (let z = -width / 2 + 0.1; z < width / 2; z += 0.18) bx(root, 0.012, 0.16, 0.012, 0x555555, -0.52, 0.1, z, 0, 0, 0.5); // harrow
    for (const sgn of [-1, 1]) {
      const hz = sgn * (width / 2 + 0.09);
      link(root, [-0.18, 0.34, sgn * (width / 2 - 0.05)], [0.02, 0.22, sgn * (width / 2 - 0.02)], 0.06, dark); // swing arm
      cy(root, 0.025, 0.025, 0.12, 0x888888, 0.02, 0.22, hz - sgn * 0.06, 'z'); // stub axle
      link(root, [0.02, 0.22, sgn * (width / 2 - 0.02)], [0.02, 0.5, sgn * (width * 0.46)], 0.05, dark); // strut to hopper
    }
    wheels.push(wheel(root, 0.22, 0.13, 0.02, width / 2 + 0.09, 0x777777, 1), wheel(root, 0.22, 0.13, 0.02, -width / 2 - 0.09, 0x777777, -1));
  } else if (kind === 'spreader') {
    const blue = paint(0x2e7dc2, 0.14);
    const wr = 0.28, wz = 0.62, ax = 0.1;
    // Chassis: two side rails joined to the drawbar, and an axle straight through to both hubs.
    for (const sgn of [-1, 1]) link(root, [0.5, 0.42, sgn * 0.12], [-0.4, 0.42, sgn * 0.34], 0.07, blue);
    bx(root, 0.07, 0.07, 0.72, blue, -0.4, 0.42, 0);
    bx(root, 0.07, 0.07, 0.36, blue, 0.5, 0.42, 0);
    cy(root, 0.035, 0.035, wz * 2, 0x3a3a3a, ax, wr, 0, 'z');
    for (const sgn of [-1, 1]) {
      link(root, [ax, 0.42, sgn * 0.3], [ax, wr, sgn * 0.3], 0.06, blue); // axle hanger
      fender(root, wr + 0.06, 0.18, ax, wr, sgn * wz, blue, Math.PI * 0.7);
      link(root, [ax, 0.42, sgn * 0.33], [ax, 0.56, sgn * (wz - 0.02)], 0.03, blue); // fender stay
    }
    // Hopper on four posts, with a mesh screen on top.
    const hy = 0.8, hh = 0.5;
    put(root, new THREE.CylinderGeometry(0.5, 0.18, hh, 4, 1, false, Math.PI / 4).scale(0.95, 1, 1.15), paint(0xd9dde0, 0.12), 0, hy, 0);
    bx(root, 0.72, 0.04, 0.84, blue, 0, hy + hh / 2 + 0.02, 0);
    decal(root, grilleTex(), 0.66, 0.78, 0, hy + hh / 2 + 0.045, 0, 0).rotation.x = -Math.PI / 2;
    for (const [px, pz] of [[0.26, 0.28], [0.26, -0.28], [-0.26, 0.28], [-0.26, -0.28]]) {
      link(root, [px, 0.42, pz], [px * 0.95, hy + 0.05, pz * 1.05], 0.05, blue);
    }
    // Outlet down to a gearbox, which drives the two spinning discs.
    bx(root, 0.14, 0.12, 0.14, 0x555555, 0, hy - hh / 2 - 0.06, 0);
    bx(root, 0.2, 0.1, 0.46, 0x3a3a3a, -0.28, 0.4, 0);
    link(root, [0, hy - hh / 2 - 0.1, 0], [-0.22, 0.42, 0], 0.08, 0x555555);
    for (const z of [0.17, -0.17]) {
      cy(root, 0.02, 0.02, 0.1, 0x777777, -0.3, 0.33, z);
      // Each disc spins on its own while spreading.
      const d = new THREE.Group();
      d.position.set(-0.3, 0.27, z);
      root.add(d);
      cy(d, 0.15, 0.15, 0.02, 0x666666, 0, 0, 0, 'y', 16);
      for (let v = 0; v < 4; v++) bx(d, 0.13, 0.035, 0.01, 0x333333, Math.cos(v * 1.57) * 0.07, 0.03, Math.sin(v * 1.57) * 0.07, 0, v * 1.57, 0);
      mergeLocal(d);
      spin.push(d);
    }
    wheels.push(wheel(root, wr, 0.14, ax, wz, 0x2e7dc2, 1), wheel(root, wr, 0.14, ax, -wz, 0x2e7dc2, -1));
  } else if (kind === 'roller') {
    const green = paint(0x2d7a3a, 0.14);
    bx(root, 0.3, 0.1, width, green, 0.22, 0.56, 0);
    for (const sgn of [-1, 1]) {
      link(root, [0.22, 0.56, sgn * (width / 2 - 0.03)], [-0.12, 0.26, sgn * (width / 2 + 0.02)], 0.07, green); // side arm to the axle
      cy(root, 0.05, 0.05, 0.06, 0x333333, -0.12, 0.26, sgn * (width / 2 + 0.02), 'z'); // bearing
    }
    // Ridged Cambridge rings.
    const ring = new THREE.TorusGeometry(0.24, 0.035, 6, 18).rotateY(Math.PI / 2);
    for (let z = -width / 2 + 0.06; z < width / 2 - 0.02; z += 0.09) put(root, ring, 0x6b7075, -0.12, 0.26, z, 0, 0, 0, false);
    cy(root, 0.2, 0.2, width - 0.06, 0x575c61, -0.12, 0.26, 0, 'z', 14);
  } else if (kind === 'weeder') {
    const orange = paint(0xd4652a, 0.14);
    bx(root, 0.18, 0.12, width, orange, 0.12, 0.52, 0);
    bx(root, 0.1, 0.08, width, orange, -0.1, 0.42, 0);
    // Rows of curved spring tines.
    const tine = new THREE.TorusGeometry(0.2, 0.008, 4, 10, Math.PI * 0.6);
    for (let row = 0; row < 3; row++) {
      for (let z = -width / 2 + 0.05 + row * 0.04; z < width / 2; z += 0.12) put(root, tine, 0x222222, -0.08 - row * 0.1, 0.26, z, 0, 0, Math.PI * 0.9, false);
    }
    for (const sgn of [-1, 1]) {
      const wz = sgn * (width / 2 - 0.2);
      link(root, [0.12, 0.52, wz - sgn * 0.07], [0.12, 0.14, wz - sgn * 0.07], 0.04, orange); // wheel leg
      cy(root, 0.02, 0.02, 0.08, 0x888888, 0.12, 0.14, wz - sgn * 0.04, 'z');
      wheels.push(wheel(root, 0.14, 0.08, 0.12, wz, 0x777777, sgn));
    }
  } else if (kind === 'sprayer') {
    const tank = paint(0xf2f2f2, 0.2);
    // Chassis, rounded tank with a fill lid, pump and a trussed boom with nozzles.
    bx(root, 0.95, 0.07, 0.7, dark, 0.1, 0.42, 0);
    put(root, new THREE.CapsuleGeometry(0.33, 0.55, 6, 16).rotateZ(Math.PI / 2), tank, 0.12, 0.82, 0);
    cy(root, 0.1, 0.1, 0.06, 0xd9a21c, 0.12, 1.17, 0);
    cy(root, 0.07, 0.07, 0.14, 0x333333, 0.6, 0.55, 0.18, 'x');
    const boomY = 0.62;
    bx(root, 0.06, 0.06, width, 0xd9a21c, -0.45, boomY, 0);
    bx(root, 0.03, 0.03, width, 0xd9a21c, -0.45, boomY + 0.2, 0);
    for (let z = -width / 2 + 0.1; z < width / 2; z += 0.35) bx(root, 0.02, 0.2, 0.02, 0xd9a21c, -0.45, boomY + 0.1, z, 0.5, 0, 0);
    for (let z = -width / 2 + 0.25; z < width / 2; z += 0.5) {
      bx(root, 0.02, 0.14, 0.02, 0x666666, -0.45, boomY - 0.1, z);
      cy(root, 0.018, 0.012, 0.03, 0x2e6fd0, -0.45, boomY - 0.18, z);
    }
    // Axle under the chassis out to both hubs, tank straps, and struts holding the boom.
    cy(root, 0.035, 0.035, 0.9, 0x3a3a3a, 0.1, 0.3, 0, 'z');
    for (const sgn of [-1, 1]) {
      link(root, [0.1, 0.42, sgn * 0.3], [0.1, 0.3, sgn * 0.3], 0.07, dark);
      link(root, [-0.37, 0.44, sgn * 0.25], [-0.45, boomY, sgn * 0.25], 0.05, dark);
      link(root, [-0.37, 0.44, sgn * 0.3], [-0.45, boomY + 0.2, sgn * Math.min(width / 2 - 0.1, 1.1)], 0.03, 0xd9a21c);
    }
    for (const x of [-0.12, 0.36]) put(root, new THREE.TorusGeometry(0.335, 0.02, 4, 20, Math.PI).rotateY(Math.PI / 2), 0x333333, x, 0.82, 0, 0, 0, 0, false);
    wheels.push(wheel(root, 0.3, 0.15, 0.1, 0.45, 0x333333, 1), wheel(root, 0.3, 0.15, 0.1, -0.45, 0x333333, -1));
  } else if (kind === 'planter') {
    const red = paint(0xc0392b, 0.14);
    bx(root, 0.3, 0.12, width, dark, 0.3, 0.45, 0);
    for (let i = 0; i < width; i++) {
      const z = -width / 2 + i + 0.5;
      put(root, new THREE.CylinderGeometry(0.46, 0.22, 0.5, 4, 1, false, Math.PI / 4).scale(1, 1, 1), red, 0, 0.9, z);
      rb(root, 0.68, 0.05, 0.68, 0.02, paint(0x8e2a1f, 0.12), 0, 1.16, z);
      // Ridging hood that shapes the potato row.
      put(root, new THREE.CylinderGeometry(0.17, 0.17, 0.4, 10, 1, true, 0, Math.PI).rotateZ(Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x6b6b6b, side: THREE.DoubleSide }), -0.5, 0.12, z);
      cy(root, 0.012, 0.012, 0.4, 0x333333, -0.2, 0.45, z);
      for (const o of [-0.22, 0.22]) link(root, [0.28, 0.46, z + o], [0.12, 0.68, z + o * 0.9], 0.05, dark); // hopper posts
      link(root, [0.2, 0.44, z], [-0.42, 0.24, z], 0.05, dark); // arm to the ridging hood
    }
    for (const sgn of [-1, 1]) {
      link(root, [0.3, 0.45, sgn * (width / 2 - 0.05)], [0.2, 0.22, sgn * (width / 2 - 0.02)], 0.06, dark);
      cy(root, 0.025, 0.025, 0.12, 0x888888, 0.2, 0.22, sgn * (width / 2 + 0.03), 'z');
    }
    wheels.push(wheel(root, 0.22, 0.12, 0.2, width / 2 + 0.1, 0x777777, 1), wheel(root, 0.22, 0.12, 0.2, -width / 2 - 0.1, 0x777777, -1));
  } else {
    // Tipping grain trailer: the box hinges at the back and tips up to unload.
    const green = paint(0x3f8a3a, 0.16);
    const W = 1.2, L = 1.75, H = 0.52, y0 = 0.44;
    const px = -0.1 - L / 2, py = y0 - 0.04; // hinge at the rear of the chassis
    tip = new THREE.Group();
    tip.position.set(px, py, 0);
    root.add(tip);
    const X = (x: number) => x - px, Y = (y: number) => y - py;
    bx(tip, L, 0.06, W, 0x2f6e2f, X(-0.1), Y(y0), 0);
    for (const sgn of [-1, 1]) {
      bx(tip, L, H, 0.04, green, X(-0.1), Y(y0 + H / 2), sgn * W / 2);
      bx(tip, L + 0.02, 0.04, 0.07, 0x2f6e2f, X(-0.1), Y(y0 + H), sgn * W / 2);
      for (let i = 0; i < 7; i++) bx(tip, 0.04, H, 0.02, 0x357a33, X(-0.1 - L / 2 + 0.12 + i * (L - 0.24) / 6), Y(y0 + H / 2), sgn * (W / 2 + 0.025));
      bx(tip, 0.03, 0.05, 0.1, TAIL(), X(-0.1 - L / 2 - 0.02), Y(y0 + 0.08), sgn * (W / 2 - 0.12));
    }
    bx(tip, 0.04, H, W, green, X(L / 2 - 0.1), Y(y0 + H / 2), 0);
    bx(tip, 0.04, H * 0.85, W, green, X(-L / 2 - 0.1), Y(y0 + H * 0.42), 0); // tailgate
    fill = new THREE.Mesh(new THREE.BoxGeometry(L - 0.1, 1, W - 0.1), new THREE.MeshLambertMaterial({ color: 0xe2bf5a, flatShading: true }));
    fill.position.set(X(-0.1), Y(y0), 0);
    fill.userData.base = Y(y0) + 0.01;
    fill.visible = false;
    fill.receiveShadow = true;
    tip.add(fill);
    mergeLocal(tip, [fill]);
    // Chassis, tipping ram and running gear stay put.
    bx(root, L + 0.1, 0.1, 0.16, dark, -0.1, y0 - 0.1, 0.3);
    bx(root, L + 0.1, 0.1, 0.16, dark, -0.1, y0 - 0.1, -0.3);
    cy(root, 0.05, 0.05, 0.3, chrome(0xb5b9bc), L / 2 - 0.15, y0 + 0.02, 0, 'y');
    for (const sgn of [-1, 1]) {
      fender(root, 0.3, 0.2, -0.1, 0.28, sgn * (W / 2 + 0.1), 0x222222, Math.PI * 0.7);
    }
    for (const x of [-0.42, 0.22]) {
      cy(root, 0.04, 0.04, W + 0.2, 0x2a2a2a, x, 0.26, 0, 'z'); // axle through both hubs
      for (const sgn of [-1, 1]) bx(root, 0.36, 0.05, 0.08, 0x3a3a3a, x, 0.31, sgn * 0.3); // leaf spring
      wheels.push(wheel(root, 0.26, 0.15, x, W / 2 + 0.1, 0xd8d8d8, 1), wheel(root, 0.26, 0.15, x, -W / 2 - 0.1, 0xd8d8d8, -1));
    }
  }
  void steel;
  mergeLocal(root, [...wheels, ...(tip ? [tip] : []), ...spin]);
  return { root, kind, width, wheels, fill, tip, spin: spin.length ? spin : undefined };
}
