import * as THREE from 'three';
import { COMBINE_LEN, COMBINE_WID, HEADER_OFFSET, TOOL_LEN, type ToolKind } from '../game/config';

// Low-poly models built from primitives. Every model faces +x; 1 unit = 1 grid cell.

const mats = new Map<string, THREE.MeshLambertMaterial>();
export function mat(color: number, emissive = 0) {
  const key = `${color}-${emissive}`;
  let m = mats.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color, emissive, flatShading: true });
    mats.set(key, m);
  }
  return m;
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

/** A tire with a colored hub; returned group spins around z to roll. */
function wheel(parent: THREE.Object3D, r: number, width: number, x: number, z: number, hub: number) {
  const g = new THREE.Group();
  g.position.set(x, r, z);
  parent.add(g);
  cyl(g, r, width, 0x1d1d1d, 0, 0, 0, 'z', 16);
  cyl(g, r * 0.55, width * 1.04, hub, 0, 0, 0, 'z', 10);
  // Tread blocks make rolling visible.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const t = box(g, r * 0.25, r * 0.12, width * 1.06, 0x2c2c2c, Math.cos(a) * r * 0.93, Math.sin(a) * r * 0.93, 0);
    t.rotation.z = a;
  }
  g.userData.radius = r;
  return g;
}

const GLASS = 0x9fd3ea;
const LIGHT_OFF = 0xfff4c2;

function headlights(parent: THREE.Object3D, x: number, y: number, zs: number[]) {
  const m = new THREE.MeshLambertMaterial({ color: LIGHT_OFF, emissive: 0xffe9a0, emissiveIntensity: 0 });
  for (const z of zs) box(parent, 0.04, 0.07, 0.1, m, x, y, z).castShadow = false;
  return m;
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
    wheel(body, 0.34, 0.2, -0.38, 0.4, 0xe0b000), wheel(body, 0.34, 0.2, -0.38, -0.4, 0xe0b000),
    wheel(body, 0.2, 0.14, 0.5, 0.33, 0xe0b000), wheel(body, 0.2, 0.14, 0.5, -0.33, 0xe0b000),
  ];
  box(body, 1.25, 0.2, 0.42, 0x333333, 0.05, 0.3, 0); // chassis
  box(body, 0.78, 0.36, 0.44, color, 0.36, 0.52, 0); // hood
  box(body, 0.72, 0.05, 0.4, color, 0.37, 0.72, 0).scale.set(1, 1, 0.9);
  box(body, 0.06, 0.26, 0.38, 0x2a2a2a, 0.76, 0.5, 0); // grille
  for (const z of [0.4, -0.4]) box(body, 0.52, 0.06, 0.26, color, -0.38, 0.72, z); // fenders
  box(body, 0.56, 0.12, 0.6, color, -0.34, 0.47, 0); // cab base
  const glass = new THREE.MeshLambertMaterial({ color: GLASS, transparent: true, opacity: 0.75 });
  box(body, 0.54, 0.46, 0.58, glass, -0.34, 0.76, 0);
  for (const [x, z] of [[-0.6, 0.28], [-0.6, -0.28], [-0.08, 0.28], [-0.08, -0.28]]) box(body, 0.04, 0.48, 0.04, 0x222222, x, 0.76, z);
  box(body, 0.66, 0.06, 0.68, 0xf2f2f2, -0.34, 1.02, 0); // roof
  cyl(body, 0.03, 0.4, 0x333333, 0.58, 0.9, 0.14, 'y', 6); // exhaust
  const lights = headlights(body, 0.79, 0.55, [0.15, -0.15]);
  return { root, body, wheels, lights };
}

function buildHeader(width: number) {
  const g = new THREE.Group();
  box(g, 0.55, 0.22, width, 0xd9a21c, 0, 0.3, 0); // trough
  box(g, 0.08, 0.05, width, 0x9aa0a5, 0.3, 0.2, 0); // cutter bar
  for (const z of [width / 2, -width / 2]) box(g, 0.6, 0.35, 0.05, 0xc28d17, 0.02, 0.35, z); // side plates
  const reel = new THREE.Group();
  reel.position.set(0.18, 0.62, 0);
  g.add(reel);
  cyl(reel, 0.04, width - 0.1, 0x7a5a10, 0, 0, 0, 'z', 6);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const bat = box(reel, 0.03, 0.03, width - 0.14, 0xe0b34a, Math.cos(a) * 0.2, Math.sin(a) * 0.2, 0);
    bat.castShadow = false;
  }
  return { g, reel };
}

export function buildCombine(headerWidth: number): VehicleModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const L = COMBINE_LEN, W = COMBINE_WID;
  const wheels = [
    wheel(body, 0.46, 0.28, 0.45, W / 2 - 0.06, 0x333333), wheel(body, 0.46, 0.28, 0.45, -W / 2 + 0.06, 0x333333),
    wheel(body, 0.28, 0.2, -0.8, W / 2 - 0.12, 0x333333), wheel(body, 0.28, 0.2, -0.8, -W / 2 + 0.12, 0x333333),
  ];
  box(body, L * 0.86, 0.75, W * 0.72, 0xe3a822, -0.1, 0.85, 0); // body
  box(body, L * 0.5, 0.3, W * 0.66, 0xc98f16, -0.35, 1.38, 0); // grain tank
  box(body, L * 0.46, 0.04, W * 0.6, 0x6b5a2c, -0.35, 1.54, 0);
  box(body, 0.2, 0.5, W * 0.72, 0x3a3a3a, -1.1, 0.85, 0); // rear
  const glass = new THREE.MeshLambertMaterial({ color: GLASS, transparent: true, opacity: 0.75 });
  box(body, 0.5, 0.48, 0.62, glass, 0.62, 1.47, 0); // cab
  box(body, 0.56, 0.06, 0.7, 0xf5f5f5, 0.62, 1.74, 0);
  box(body, 0.5, 0.3, 0.5, 0xe3a822, 0.8, 0.75, 0); // feeder
  const lights = headlights(body, 0.88, 1.6, [0.22, -0.22]);

  // Unloading pipe: pivots at the left rear of the tank and swings out when unloading.
  const pipe = new THREE.Group();
  pipe.position.set(-0.55, 1.5, -W * 0.3);
  body.add(pipe);
  const tube = cyl(pipe, 0.07, 1.9, 0xb8841a, 0.95, 0, 0, 'x', 8);
  tube.castShadow = true;
  box(pipe, 0.14, 0.2, 0.14, 0x8a6210, 1.9, -0.08, 0);
  pipe.rotation.y = Math.PI * 0.94; // folded back along the body

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
  const glass = new THREE.MeshLambertMaterial({ color: GLASS, transparent: true, opacity: 0.75 });
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
    return { root, kind, width, fill, wheels };
  }
  return { root, kind, width, wheels };
}

// ---------- scenery ----------

export function buildSilo(radius: number) {
  const g = new THREE.Group();
  const h = 3.2;
  add(g, new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, h, 24), mat(0xd3d9de)), 0, h / 2, 0);
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
  box(g, 0.5, 0.5, 0.05, GLASS, -0.7, 1.0, 1.11);
  box(g, 0.5, 0.5, 0.05, GLASS, 0.7, 1.0, 1.11);
  box(g, 0.3, 0.9, 0.3, 0x7a4a3a, 0.8, 2.3, -0.4); // chimney
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

/** Instanced low-poly trees. */
export function buildTrees(points: { x: number; z: number; s: number; v: number }[]) {
  const group = new THREE.Group();
  const trunkGeo = new THREE.CylinderGeometry(0.1, 0.14, 0.8, 6);
  const crownGeo = new THREE.IcosahedronGeometry(0.75, 0);
  const pineGeo = new THREE.ConeGeometry(0.6, 1.8, 7);
  const trunks = new THREE.InstancedMesh(trunkGeo, mat(0x6b4a2f), points.length);
  const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshLambertMaterial({ flatShading: true }), points.length);
  const pines = new THREE.InstancedMesh(pineGeo, new THREE.MeshLambertMaterial({ flatShading: true }), points.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const c = new THREE.Color();
  let nc = 0, np = 0;
  points.forEach((p, i) => {
    m.compose(new THREE.Vector3(p.x, 0.4 * p.s, p.z), q, new THREE.Vector3(p.s, p.s, p.s));
    trunks.setMatrixAt(i, m);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.v * 7);
    if (p.v < 0.3) {
      m.compose(new THREE.Vector3(p.x, 1.4 * p.s, p.z), q, new THREE.Vector3(p.s, p.s, p.s));
      pines.setMatrixAt(np, m);
      pines.setColorAt(np++, c.setHex(0x2f6b3a).multiplyScalar(0.85 + p.v));
    } else {
      m.compose(new THREE.Vector3(p.x, 1.25 * p.s, p.z), q, new THREE.Vector3(p.s, p.s * 0.9, p.s));
      crowns.setMatrixAt(nc, m);
      crowns.setColorAt(nc++, c.setHex([0x3f8f3f, 0x4f9c45, 0x36803a][Math.floor(p.v * 10) % 3]));
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
