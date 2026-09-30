import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { COMBINE_LEN, COMBINE_WID, HEADER_OFFSET, TOOL_LEN, type ToolKind } from '../game/config';

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

function cyl(parent: THREE.Object3D, r: number, len: number, color: number, x: number, y: number, z: number, axis: 'x' | 'y' | 'z', seg = 14) {
  const mesh = add(parent, new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), mat(color)), x, y, z);
  if (axis === 'z') mesh.rotation.x = Math.PI / 2;
  if (axis === 'x') mesh.rotation.z = Math.PI / 2;
  return mesh;
}

/** Rounded box, for painted body panels. */
export function rbox(parent: THREE.Object3D, w: number, h: number, d: number, radius: number, color: number | THREE.Material, x: number, y: number, z: number) {
  const m = typeof color === 'number' ? mat(color) : color;
  return add(parent, new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(radius, w / 2, h / 2, d / 2)), m), x, y, z);
}

/** A tire with a metal rim and tread lugs; the returned group spins around z to roll. */
function wheel(parent: THREE.Object3D, r: number, width: number, x: number, z: number, hub: number) {
  const g = new THREE.Group();
  g.position.set(x, r, z);
  parent.add(g);
  cyl(g, r * 0.93, width, 0x1b1b1b, 0, 0, 0, 'z', 24);
  cyl(g, r * 0.6, width * 1.02, hub, 0, 0, 0, 'z', 16).material = mat(hub, 0.35, 0.6);
  cyl(g, r * 0.22, width * 1.08, 0x9a9a9a, 0, 0, 0, 'z', 10).material = mat(0x9a9a9a, 0.3, 0.9);
  const lugs = Math.max(10, Math.round(r * 40));
  for (let i = 0; i < lugs; i++) {
    const a = (i / lugs) * Math.PI * 2;
    for (const side of [-1, 1]) {
      const t = box(g, r * 0.16, r * 0.1, width * 0.46, 0x242424, Math.cos(a) * r * 0.95, Math.sin(a) * r * 0.95, side * width * 0.25);
      t.rotation.z = a;
      t.rotation.y = side * 0.35; // chevron tread
      t.castShadow = false;
    }
  }
  g.userData.radius = r;
  return g;
}

const GLASS = 0x9fd3ea;
const LIGHT_OFF = 0xfff4c2;
const glassMat = () => new THREE.MeshLambertMaterial({ color: 0x5f8aa0, transparent: true, opacity: 0.55 });

function headlights(parent: THREE.Object3D, x: number, y: number, zs: number[]) {
  const m = new THREE.MeshLambertMaterial({ color: LIGHT_OFF, emissive: 0xffe9a0, emissiveIntensity: 0 });
  for (const z of zs) box(parent, 0.04, 0.07, 0.1, m, x, y, z).castShadow = false;
  return m;
}

/** Curved mudguard over a wheel. */
function fender(parent: THREE.Object3D, r: number, width: number, x: number, y: number, z: number, color: number) {
  const geo = new THREE.CylinderGeometry(r, r, width, 16, 1, true, -Math.PI / 2, Math.PI);
  const m = new THREE.Mesh(geo, mat(color));
  (m.material as THREE.MeshLambertMaterial).side = THREE.DoubleSide;
  m.rotation.x = Math.PI / 2;
  return add(parent, m, x, y, z);
}

/** Cab: pillars, tinted glass, roof with an amber beacon, mirrors. */
function cab(parent: THREE.Object3D, x: number, y: number, w: number, h: number, d: number, roof: number) {
  add(parent, new THREE.Mesh(new RoundedBoxGeometry(w * 0.96, h, d * 0.96, 2, 0.04), glassMat()), x, y + h / 2, 0);
  for (const [px, pz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    cyl(parent, 0.022, h, 0x1e1e1e, x + (px * w) / 2, y + h / 2, (pz * d) / 2, 'y', 6);
  }
  rbox(parent, w + 0.1, 0.07, d + 0.1, 0.03, roof, x, y + h + 0.035, 0);
  const beacon = add(parent, new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.06, 10), new THREE.MeshLambertMaterial({ color: 0xff9a1f, emissive: 0xff7a00, emissiveIntensity: 0.4 })), x - w * 0.3, y + h + 0.1, d * 0.3);
  beacon.castShadow = false;
  for (const side of [-1, 1]) {
    box(parent, 0.02, 0.02, 0.12, 0x1e1e1e, x + w * 0.45, y + h * 0.75, side * (d / 2 + 0.06));
    box(parent, 0.02, 0.1, 0.06, 0x1e1e1e, x + w * 0.45, y + h * 0.7, side * (d / 2 + 0.13));
  }
}

export interface VehicleModel {
  root: THREE.Group;
  body: THREE.Group;
  wheels: THREE.Group[];
  lights: THREE.MeshLambertMaterial;
  header?: THREE.Group;
  reel?: THREE.Object3D;
  pipe?: THREE.Group;
  headerWidth?: number;
}

export function buildTractor(color = 0xc8392b): VehicleModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const wheels = [
    wheel(body, 0.36, 0.22, -0.38, 0.42, 0xe0b000), wheel(body, 0.36, 0.22, -0.38, -0.42, 0xe0b000),
    wheel(body, 0.22, 0.15, 0.52, 0.34, 0xe0b000), wheel(body, 0.22, 0.15, 0.52, -0.34, 0xe0b000),
  ];
  rbox(body, 1.25, 0.18, 0.36, 0.05, 0x2b2b2b, 0.05, 0.32, 0); // chassis
  rbox(body, 0.82, 0.34, 0.42, 0.08, color, 0.36, 0.56, 0); // hood
  rbox(body, 0.7, 0.04, 0.3, 0.02, 0x2b2b2b, 0.38, 0.735, 0); // hood vent
  rbox(body, 0.06, 0.26, 0.34, 0.03, 0x2a2a2a, 0.78, 0.52, 0); // grille
  for (let i = 0; i < 4; i++) box(body, 0.065, 0.02, 0.3, 0x444444, 0.79, 0.43 + i * 0.055, 0).castShadow = false;
  rbox(body, 0.12, 0.18, 0.34, 0.03, 0x3a3a3a, 0.86, 0.34, 0); // front weights
  for (const z of [0.42, -0.42]) fender(body, 0.42, 0.26, -0.38, 0.38, z, color);
  rbox(body, 0.6, 0.14, 0.64, 0.04, color, -0.34, 0.5, 0); // cab base
  cab(body, -0.34, 0.57, 0.56, 0.48, 0.6, 0xf2f2f2);
  cyl(body, 0.032, 0.5, 0xb8b8b8, 0.6, 0.92, 0.16, 'y', 10).material = mat(0xb8b8b8, 0.25, 0.9); // exhaust
  cyl(body, 0.04, 0.05, 0x333333, 0.6, 1.18, 0.16, 'y', 10);
  box(body, 0.1, 0.03, 0.12, 0x2b2b2b, -0.05, 0.28, 0.34); // step
  box(body, 0.12, 0.12, 0.3, 0x2b2b2b, -0.72, 0.36, 0); // rear hitch
  const lights = headlights(body, 0.82, 0.62, [0.14, -0.14]);
  for (const w of wheels) mergeLocal(w);
  mergeLocal(body, wheels);
  return { root, body, wheels, lights };
}

function buildHeader(width: number) {
  const g = new THREE.Group();
  rbox(g, 0.5, 0.2, width, 0.05, 0xd9a21c, -0.02, 0.28, 0); // trough
  rbox(g, 0.22, 0.34, width, 0.04, 0xc28d17, -0.2, 0.42, 0); // back wall
  box(g, 0.1, 0.04, width, 0x9aa0a5, 0.26, 0.16, 0).material = mat(0x9aa0a5, 0.3, 0.9); // cutter bar
  cyl(g, 0.07, width - 0.1, 0xb07c12, 0.02, 0.32, 0, 'z', 10); // auger
  for (const z of [width / 2, -width / 2]) {
    const plate = rbox(g, 0.62, 0.36, 0.05, 0.02, 0xc28d17, 0.02, 0.36, z);
    plate.rotation.y = 0;
    const divider = add(g, new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.3, 4), mat(0xd9a21c)), 0.34, 0.2, z);
    divider.rotation.z = -Math.PI / 2;
  }
  const reel = new THREE.Group();
  reel.position.set(0.18, 0.66, 0);
  g.add(reel);
  cyl(reel, 0.035, width - 0.1, 0x7a5a10, 0, 0, 0, 'z', 8);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const bat = box(reel, 0.025, 0.025, width - 0.14, 0xe0b34a, Math.cos(a) * 0.2, Math.sin(a) * 0.2, 0);
    bat.castShadow = false;
    for (let t = -width / 2 + 0.2; t < width / 2 - 0.1; t += 0.35) {
      const tine = box(reel, 0.01, 0.08, 0.01, 0x666666, Math.cos(a) * 0.24, Math.sin(a) * 0.24, t);
      tine.rotation.z = a;
      tine.castShadow = false;
    }
  }
  for (const z of [width / 2 - 0.1, -width / 2 + 0.1]) box(reel, 0.42, 0.03, 0.03, 0x7a5a10, 0, 0, z).castShadow = false;
  mergeLocal(reel);
  mergeLocal(g, [reel]);
  return { g, reel };
}

export function buildCombine(headerWidth: number): VehicleModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const L = COMBINE_LEN, W = COMBINE_WID;
  const wheels = [
    wheel(body, 0.48, 0.3, 0.45, W / 2 - 0.04, 0x3a3a3a), wheel(body, 0.48, 0.3, 0.45, -W / 2 + 0.04, 0x3a3a3a),
    wheel(body, 0.3, 0.2, -0.82, W / 2 - 0.12, 0x3a3a3a), wheel(body, 0.3, 0.2, -0.82, -W / 2 + 0.12, 0x3a3a3a),
  ];
  const paint = 0xe3a822;
  rbox(body, L * 0.86, 0.78, W * 0.7, 0.1, paint, -0.12, 0.86, 0); // main body
  rbox(body, L * 0.5, 0.08, W * 0.72, 0.03, 0x2b2b2b, -0.2, 0.44, 0); // lower trim
  for (const z of [W / 2 - 0.02, -W / 2 + 0.02]) fender(body, 0.52, 0.34, 0.45, 0.46, z, paint);
  // Grain tank with flared top and extensions.
  rbox(body, L * 0.5, 0.26, W * 0.66, 0.05, 0xc98f16, -0.35, 1.37, 0);
  rbox(body, L * 0.54, 0.06, W * 0.74, 0.02, 0xb07c12, -0.35, 1.53, 0);
  box(body, L * 0.46, 0.02, W * 0.58, 0x5a4a22, -0.35, 1.5, 0);
  // Straw chopper / spreader at the back.
  rbox(body, 0.3, 0.45, W * 0.6, 0.05, 0x3a3a3a, -1.1, 0.7, 0);
  for (const z of [0.18, -0.18]) cyl(body, 0.12, 0.03, 0x555555, -1.26, 0.52, z, 'y', 10);
  // Cab up front with stairs and railings.
  rbox(body, 0.56, 0.12, 0.72, 0.03, paint, 0.62, 1.26, 0);
  cab(body, 0.62, 1.32, 0.5, 0.46, 0.64, 0xf5f5f5);
  for (let i = 0; i < 4; i++) box(body, 0.14, 0.02, 0.12, 0x2b2b2b, 0.25 + i * 0.02, 0.5 + i * 0.2, W / 2 - 0.05);
  cyl(body, 0.012, 0.9, 0x2b2b2b, 0.32, 0.95, W / 2 + 0.02, 'y', 6);
  rbox(body, 0.5, 0.3, 0.52, 0.05, paint, 0.82, 0.74, 0); // feeder house
  cyl(body, 0.04, 0.35, 0xb8b8b8, -0.7, 1.72, -0.35, 'y', 8).material = mat(0xb8b8b8, 0.25, 0.9); // exhaust
  const lights = headlights(body, 0.9, 1.62, [0.22, -0.22]);

  // Unloading auger: pivots at the rear left of the tank and swings out when unloading.
  const pipe = new THREE.Group();
  pipe.position.set(-0.55, 1.5, -W * 0.3);
  body.add(pipe);
  cyl(pipe, 0.07, 1.9, 0xb8841a, 0.95, 0, 0, 'x', 10);
  const spout = add(pipe, new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.22, 10), mat(0x8a6210)), 1.9, -0.1, 0);
  spout.castShadow = true;
  pipe.rotation.y = Math.PI * 0.94; // folded back along the body

  for (const w of wheels) mergeLocal(w);
  mergeLocal(pipe);
  mergeLocal(body, [...wheels, pipe]);
  const model: VehicleModel = { root, body, wheels, lights, pipe };
  setHeader(model, headerWidth);
  return model;
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

/** Self-propelled root harvester: digger at the front, sorting deck and bunker behind. */
export function buildRootHarvester(): VehicleModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const wheels = [
    wheel(body, 0.45, 0.3, 0.35, 0.62, 0x333333), wheel(body, 0.45, 0.3, 0.35, -0.62, 0x333333),
    wheel(body, 0.45, 0.3, -0.8, 0.62, 0x333333), wheel(body, 0.45, 0.3, -0.8, -0.62, 0x333333),
  ];
  box(body, 2.1, 0.55, 1.1, 0x2f7d3a, -0.2, 0.8, 0); // chassis body
  box(body, 1.2, 0.6, 1.2, 0x2f7d3a, -0.55, 1.35, 0); // bunker walls
  box(body, 1.1, 0.05, 1.1, 0x5a4630, -0.55, 1.6, 0); // soil/crop in bunker
  const glass = new THREE.MeshLambertMaterial({ color: 0x6f9fb8, transparent: true, opacity: 0.6 });
  box(body, 0.55, 0.5, 0.7, glass, 0.55, 1.35, 0);
  box(body, 0.6, 0.06, 0.78, 0xf5f5f5, 0.55, 1.63, 0);
  box(body, 0.9, 0.1, 0.9, 0x555555, 0.2, 1.1, 0); // sorting deck
  // Digging unit at the front.
  const digger = new THREE.Group();
  digger.position.set(HEADER_OFFSET, 0, 0);
  body.add(digger);
  box(digger, 0.7, 0.25, 2.0, 0x2f7d3a, 0, 0.35, 0);
  for (const z of [-0.5, 0.5]) {
    const share = box(digger, 0.4, 0.12, 0.5, 0x8c8c8c, 0.25, 0.1, z);
    share.rotation.z = -0.35;
  }
  const lights = headlights(body, 0.85, 1.45, [0.25, -0.25]);
  const pipe = new THREE.Group();
  pipe.position.set(-0.55, 1.6, -0.55);
  body.add(pipe);
  box(pipe, 1.9, 0.12, 0.4, 0x3a3a3a, 0.95, 0, 0); // unloading conveyor
  pipe.rotation.y = Math.PI * 0.94;
  for (const w of wheels) mergeLocal(w);
  mergeLocal(pipe);
  mergeLocal(digger);
  mergeLocal(body, [...wheels, pipe, digger]);
  return { root, body, wheels, lights, pipe, header: digger };
}

export interface ToolModel {
  root: THREE.Group;
  kind: string;
  width: number;
  fill?: THREE.Mesh;
  wheels: THREE.Group[];
}

export function buildTool(kind: ToolKind, width: number): ToolModel {
  const root = new THREE.Group();
  const len = TOOL_LEN[kind];
  const wheels: THREE.Group[] = [];
  const tongue = box(root, 0.5, 0.06, 0.08, 0x3a3a3a, len / 2 - 0.1, 0.35, 0);
  tongue.castShadow = false;
  if (kind === 'plow') {
    box(root, 0.16, 0.14, width, 0x3d7fc0, 0.15, 0.42, 0); // beam
    box(root, 0.5, 0.1, 0.18, 0x3d7fc0, 0.3, 0.4, 0);
    const n = width * 2;
    for (let i = 0; i < n; i++) {
      const z = -width / 2 + (i + 0.5) * (width / n);
      const disc = cyl(root, 0.17, 0.04, 0xc9cdd0, -0.2, 0.2, z, 'z', 12);
      disc.rotation.y = 0.5;
      box(root, 0.05, 0.25, 0.05, 0x555555, -0.12, 0.35, z);
    }
  } else if (kind === 'seeder') {
    box(root, 0.55, 0.36, width * 0.96, 0x2a8a7a, 0, 0.62, 0); // hopper
    box(root, 0.5, 0.04, width * 0.9, 0x35a894, 0, 0.82, 0);
    box(root, 0.12, 0.1, width, 0x444444, -0.2, 0.3, 0);
    const n = width * 2;
    for (let i = 0; i < n; i++) {
      const z = -width / 2 + (i + 0.5) * (width / n);
      cyl(root, 0.1, 0.05, 0x333333, -0.32, 0.1, z, 'z', 10);
    }
    wheels.push(wheel(root, 0.22, 0.12, 0, width / 2 + 0.08, 0x777777), wheel(root, 0.22, 0.12, 0, -width / 2 - 0.08, 0x777777));
  } else if (kind === 'spreader') {
    // Hopper on two wheels with spinning discs at the back.
    box(root, 0.7, 0.35, 1.1, 0xd9dde0, 0.05, 0.75, 0);
    box(root, 0.5, 0.25, 0.8, 0xc4c9cc, 0.05, 0.47, 0);
    box(root, 0.72, 0.05, 1.12, 0x2e7dc2, 0.05, 0.94, 0);
    for (const z of [0.2, -0.2]) cyl(root, 0.14, 0.03, 0x555555, -0.35, 0.3, z, 'y', 12);
    wheels.push(wheel(root, 0.28, 0.14, 0.1, 0.62, 0x2e7dc2), wheel(root, 0.28, 0.14, 0.1, -0.62, 0x2e7dc2));
  } else if (kind === 'roller') {
    box(root, 0.3, 0.1, width, 0x2d7a3a, 0.2, 0.55, 0);
    const n = Math.max(1, Math.round(width / 1.3));
    for (let i = 0; i < n; i++) {
      const seg = width / n;
      cyl(root, 0.26, seg - 0.06, 0x6b7075, -0.15, 0.26, -width / 2 + seg * (i + 0.5), 'z', 14);
    }
  } else if (kind === 'weeder') {
    box(root, 0.18, 0.12, width, 0xd4652a, 0.1, 0.5, 0);
    const n = width * 4;
    for (let i = 0; i < n; i++) {
      const z = -width / 2 + (i + 0.5) * (width / n);
      const tine = box(root, 0.03, 0.42, 0.02, 0x333333, -0.12, 0.25, z);
      tine.rotation.z = 0.5;
    }
  } else if (kind === 'sprayer') {
    // Trailed tank with a boom; the boom folds for transport.
    box(root, 0.9, 0.08, 0.7, 0x444444, 0.1, 0.42, 0);
    add(root, new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.95, 16), mat(0xf2f2f2)), 0.1, 0.8, 0).rotation.z = Math.PI / 2;
    box(root, 0.08, 0.08, width, 0xd9a21c, -0.45, 0.62, 0);
    for (let z = -width / 2 + 0.25; z < width / 2; z += 0.5) box(root, 0.03, 0.2, 0.03, 0x666666, -0.45, 0.5, z);
    wheels.push(wheel(root, 0.3, 0.14, 0.1, 0.45, 0x333333), wheel(root, 0.3, 0.14, 0.1, -0.45, 0x333333));
  } else if (kind === 'planter') {
    box(root, 0.3, 0.12, width, 0x444444, 0.3, 0.45, 0);
    for (let i = 0; i < width; i++) {
      const z = -width / 2 + i + 0.5;
      box(root, 0.8, 0.45, 0.8, 0xc0392b, 0, 0.85, z); // seed potato hopper
      box(root, 0.82, 0.05, 0.82, 0x8e2a1f, 0, 1.1, z);
      const ridger = box(root, 0.3, 0.18, 0.3, 0x6b6b6b, -0.5, 0.12, z);
      ridger.rotation.y = Math.PI / 4;
    }
    wheels.push(wheel(root, 0.22, 0.12, 0.2, width / 2 + 0.1, 0x777777), wheel(root, 0.22, 0.12, 0.2, -width / 2 - 0.1, 0x777777));
  } else {
    const W = 1.2, L = 1.7, H = 0.5, y0 = 0.42;
    box(root, L, 0.06, W, 0x2f6e2f, -0.1, y0, 0); // floor
    box(root, L, H, 0.06, 0x3f8a3a, -0.1, y0 + H / 2, W / 2);
    box(root, L, H, 0.06, 0x3f8a3a, -0.1, y0 + H / 2, -W / 2);
    box(root, 0.06, H, W, 0x3f8a3a, L / 2 - 0.1, y0 + H / 2, 0);
    box(root, 0.06, H, W, 0x3f8a3a, -L / 2 - 0.1, y0 + H / 2, 0);
    const fill = new THREE.Mesh(new THREE.BoxGeometry(L - 0.1, 1, W - 0.1), new THREE.MeshLambertMaterial({ color: 0xe2bf5a, flatShading: true }));
    fill.position.set(-0.1, y0, 0);
    fill.visible = false;
    fill.receiveShadow = true;
    root.add(fill);
    for (const x of [-0.45, 0.25]) {
      wheels.push(wheel(root, 0.26, 0.14, x, W / 2 + 0.02, 0xd8d8d8), wheel(root, 0.26, 0.14, x, -W / 2 - 0.02, 0xd8d8d8));
    }
    for (const w of wheels) mergeLocal(w);
    mergeLocal(root, [...wheels, fill]);
    return { root, kind, width, fill, wheels };
  }
  for (const w of wheels) mergeLocal(w);
  mergeLocal(root, wheels);
  return { root, kind, width, wheels };
}

// ---------- scenery ----------

export function buildSilo(radius: number) {
  const g = new THREE.Group();
  const h = 3.2;
  add(g, new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, h, 24), mat(0xb9c1c7, 0.35, 0.7)), 0, h / 2, 0);
  add(g, new THREE.Mesh(new THREE.ConeGeometry(radius * 1.04, 0.9, 24), mat(0xaab3ba)), 0, h + 0.45, 0);
  for (let i = 1; i < 5; i++) {
    add(g, new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.01, radius * 1.01, 0.05, 24), mat(0x9aa4ab)), 0, (h / 5) * i, 0);
  }
  box(g, 0.1, h, 0.1, 0x777777, radius + 0.05, h / 2, 0); // ladder
  return g;
}

export function buildShed(w: number, d: number, wall = 0xa6463a, roof = 0x6f7a80) {
  const g = new THREE.Group();
  const h = 1.6;
  box(g, w, h, d, wall, 0, h / 2, 0);
  box(g, w * 0.5, h * 0.8, 0.05, 0x5a241c, 0, h * 0.4, d / 2 + 0.01); // door
  const roofGeo = new THREE.BufferGeometry();
  const hw = w / 2 + 0.15, hd = d / 2 + 0.15, top = h + 0.9;
  const v = [
    -hw, h, -hd, hw, h, -hd, hw, top, 0, -hw, h, -hd, hw, top, 0, -hw, top, 0,
    -hw, h, hd, -hw, top, 0, hw, top, 0, -hw, h, hd, hw, top, 0, hw, h, hd,
  ];
  roofGeo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  roofGeo.computeVertexNormals();
  const roofMat = new THREE.MeshLambertMaterial({ color: roof, side: THREE.DoubleSide, flatShading: true });
  add(g, new THREE.Mesh(roofGeo, roofMat), 0, 0, 0);
  const gable = new THREE.BufferGeometry();
  gable.setAttribute('position', new THREE.Float32BufferAttribute([
    -w / 2, h, -d / 2, -w / 2, h, d / 2, -w / 2, top - 0.1, 0,
    w / 2, h, d / 2, w / 2, h, -d / 2, w / 2, top - 0.1, 0,
  ], 3));
  gable.computeVertexNormals();
  add(g, new THREE.Mesh(gable, new THREE.MeshLambertMaterial({ color: wall, side: THREE.DoubleSide })), 0, 0, 0);
  return g;
}

export function buildFarmhouse() {
  const g = buildShed(2.6, 2.2, 0xefe6d2, 0x8a3b30);
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
