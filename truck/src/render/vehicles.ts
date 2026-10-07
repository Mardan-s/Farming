import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { MAT, box, cyl, lamp, mergeStatic, paint } from './materials';
import { LIVERIES, containerSide, plateTexture, trailerSide } from './textures';
import type { TrailerKind } from '../sim/jobs';
import type { CarKind } from '../sim/traffic';
import { HITCH_AHEAD, TRAILER_LEN, WHEELBASE } from '../sim/truck';

// Procedural vehicle models. Local frame: +z forward, +x is the vehicle's LEFT side, y up,
// origin on the ground under the drive axle (tractor) or the axle group centre (trailer).

// ------------------------------------------------------------------ wheels

const wheelCache = new Map<string, { tire: THREE.BufferGeometry; rim: THREE.BufferGeometry }>();

function wheelGeometry(r: number, w: number, dish = true) {
  const key = `${r}-${w}-${dish}`;
  const hit = wheelCache.get(key);
  if (hit) return hit;
  const rr = r * 0.62;
  const tireProfile = [
    new THREE.Vector2(rr, -w / 2), new THREE.Vector2(r - 0.07, -w / 2), new THREE.Vector2(r - 0.02, -w / 2 + 0.03),
    new THREE.Vector2(r, -w / 2 + 0.08), new THREE.Vector2(r, w / 2 - 0.08), new THREE.Vector2(r - 0.02, w / 2 - 0.03),
    new THREE.Vector2(r - 0.07, w / 2), new THREE.Vector2(rr, w / 2),
  ];
  const tire = new THREE.LatheGeometry(tireProfile, 30);
  tire.rotateZ(-Math.PI / 2);
  const o = w / 2;
  const rimProfile = dish
    ? [new THREE.Vector2(rr, o - 0.02), new THREE.Vector2(rr * 0.92, o - 0.05), new THREE.Vector2(rr * 0.55, o - 0.11), new THREE.Vector2(0.2, o - 0.06), new THREE.Vector2(0.13, o - 0.03), new THREE.Vector2(0.11, o + 0.04), new THREE.Vector2(0.001, o + 0.05)]
    : [new THREE.Vector2(rr, o - 0.02), new THREE.Vector2(rr * 0.8, o - 0.04), new THREE.Vector2(0.001, o - 0.04)];
  const rimG = new THREE.LatheGeometry(rimProfile, 30);
  rimG.rotateZ(-Math.PI / 2);
  const parts: THREE.BufferGeometry[] = [rimG.toNonIndexed()];
  if (dish) {
    // Wheel nuts and hand-holes.
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      const nut = new THREE.CylinderGeometry(0.022, 0.022, 0.05, 6);
      nut.rotateZ(Math.PI / 2);
      nut.translate(o - 0.04, Math.cos(a) * 0.165, Math.sin(a) * 0.165);
      parts.push(nut.toNonIndexed());
    }
  }
  for (const p of parts) { p.deleteAttribute('uv'); }
  const rim = parts.length > 1 ? mergeNonIndexed(parts) : parts[0];
  const out = { tire, rim };
  wheelCache.set(key, out);
  return out;
}

function mergeNonIndexed(parts: THREE.BufferGeometry[]) {
  let count = 0;
  for (const p of parts) count += p.attributes.position.count;
  const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3);
  let off = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array as Float32Array, off * 3);
    nor.set(p.attributes.normal.array as Float32Array, off * 3);
    off += p.attributes.position.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return g;
}

/** A wheel whose outer face points to the given side (+1 left, -1 right). Returns [steer group, spin group]. */
function wheel(r: number, w: number, side: number, rimMat: THREE.Material = MAT.rim, dish = true) {
  const g = wheelGeometry(r, w, dish);
  const steer = new THREE.Group();
  const spin = new THREE.Group();
  const holder = new THREE.Group();
  if (side < 0) holder.rotation.y = Math.PI;
  const tire = new THREE.Mesh(g.tire, MAT.rubber);
  const rim = new THREE.Mesh(g.rim, rimMat);
  tire.castShadow = true;
  holder.add(tire, rim);
  spin.add(holder);
  steer.add(spin);
  return { steer, spin };
}

// ------------------------------------------------------------------ lights

export interface LightMats {
  head: THREE.MeshStandardMaterial;
  drl: THREE.MeshStandardMaterial;
  tail: THREE.MeshStandardMaterial;
  indL: THREE.MeshStandardMaterial;
  indR: THREE.MeshStandardMaterial;
  reverse: THREE.MeshStandardMaterial;
  roof: THREE.MeshStandardMaterial;
  marker: THREE.MeshStandardMaterial;
}

/**
 * Per-vehicle lamp materials. Traffic shares one material between lamps that switch together
 * (head, running and reverse lights; tail and side markers) to save draw calls.
 */
export function makeLightMats(shared = false): LightMats {
  if (shared) {
    const head = lamp(0xfff4e0, 0xd8dde2), tail = lamp(0xff1a0a, 0x4a0704);
    return { head, drl: head, tail, indL: lamp(0xff8a00, 0x5a3000), indR: lamp(0xff8a00, 0x5a3000), reverse: head, roof: head, marker: tail };
  }
  return {
    head: lamp(0xfff4e0, 0xd8dde2),
    drl: lamp(0xe6f0ff, 0x8a9096),
    tail: lamp(0xff1a0a, 0x4a0704),
    indL: lamp(0xff8a00, 0x5a3000),
    indR: lamp(0xff8a00, 0x5a3000),
    reverse: lamp(0xffffff, 0x9a9a9a),
    roof: lamp(0xffd08a, 0x7a6a50),
    marker: lamp(0xff8a00, 0x6a3a00),
  };
}

export interface LightState { head: boolean; high: boolean; brake: number; tail: boolean; indL: boolean; indR: boolean; reverse: boolean; roof: boolean }

export function applyLights(m: LightMats, s: LightState, night: number) {
  m.tail.emissiveIntensity = (s.tail ? 1.6 : 0) + s.brake * 5;
  m.indL.emissiveIntensity = s.indL ? 6 : 0;
  m.indR.emissiveIntensity = s.indR ? 6 : 0;
  if (m.drl === m.head) {
    m.head.emissiveIntensity = s.head ? 6 : 1.5;
    return;
  }
  m.head.emissiveIntensity = s.head ? 6 : 0;
  m.drl.emissiveIntensity = 3 + night * 2;
  m.reverse.emissiveIntensity = s.reverse ? 4 : 0;
  m.roof.emissiveIntensity = s.roof ? 7 : 0;
  m.marker.emissiveIntensity = s.tail ? 3.5 : 0;
}

// ------------------------------------------------------------------ tractor

const ARCH = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.6, side: THREE.DoubleSide });
const HORN = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, metalness: 1, roughness: 0.08, side: THREE.DoubleSide });

export interface Tractor {
  root: THREE.Group;
  cab: THREE.Group;
  steer: THREE.Group[];
  spin: THREE.Group[];
  steeringWheel: THREE.Group;
  exhaustTip: THREE.Object3D;
  glass: THREE.Mesh[];
  dashScreen: THREE.Mesh | null;
  lights: LightMats;
  headlightAnchor: THREE.Object3D;
  paintMat: THREE.Material;
}

/** Pushes the top of the front face back to give the cab a raked windscreen. */
function rakeCab(g: THREE.BufferGeometry, h: number, d: number, rake: number) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) + h / 2, z = p.getZ(i);
    if (z > 0) p.setZ(i, z - (y / h) * rake * (z / (d / 2)));
  }
  g.computeVertexNormals();
}

export function buildTractor(color: number, opts: { interior: boolean; lod?: boolean; plate?: string } = { interior: true }): Tractor {
  const root = new THREE.Group();
  const chassis = new THREE.Group();
  const cab = new THREE.Group();
  root.add(chassis);
  root.add(cab);
  const lights = makeLightMats(!!opts.lod);
  const body = paint(color, 0.45, 0.28);
  const lod = !!opts.lod;

  // --- chassis
  for (const x of [-0.45, 0.45]) box(0.12, 0.3, 7.1, MAT.frame, x, 0.95, 1.6, chassis);
  for (const z of [-1.2, 0.9, 2.6, 4.4]) box(0.9, 0.12, 0.12, MAT.frame, 0, 0.9, z, chassis);
  // Fifth wheel coupling.
  const fifth = cyl(0.46, 0.46, 0.12, MAT.steel, 24);
  fifth.position.set(0, 1.18, HITCH_AHEAD);
  chassis.add(fifth);
  box(1.1, 0.08, 0.5, MAT.steel, 0, 1.1, -0.2, chassis);
  // Fuel tank (left) and battery box + side skirt (right).
  const tank = cyl(0.33, 0.33, 1.6, MAT.alu, 24);
  tank.rotation.x = Math.PI / 2;
  tank.position.set(0.93, 0.84, 1.95);
  chassis.add(tank);
  for (const dz of [-0.55, 0.55]) { const strap = cyl(0.34, 0.34, 0.05, MAT.frame, 24); strap.rotation.x = Math.PI / 2; strap.position.set(0.93, 0.84, 1.95 + dz); chassis.add(strap); }
  const cap = cyl(0.07, 0.07, 0.06, MAT.chrome, 12); cap.position.set(0.93, 1.18, 2.3); chassis.add(cap);
  box(0.06, 0.55, 2.1, body, -1.2, 0.8, 1.75, chassis);
  box(0.5, 0.45, 0.6, MAT.plastic, -0.95, 0.75, 2.6, chassis);
  // Rear mudguards and flaps.
  for (const x of [-1, 1]) {
    box(0.78, 0.05, 1.25, MAT.plastic, x * 0.95, 1.18, 0, chassis);
    box(0.7, 0.62, 0.02, MAT.rubber, x * 0.95, 0.55, -0.72, chassis);
  }
  // Rear light bar.
  box(2.3, 0.16, 0.1, MAT.plastic, 0, 0.78, -1.45, chassis);
  for (const x of [-1, 1]) {
    box(0.26, 0.1, 0.02, lights.tail, x * 0.88, 0.79, -1.51, chassis);
    box(0.1, 0.1, 0.02, x > 0 ? lights.indL : lights.indR, x * 1.07, 0.79, -1.51, chassis);
    box(0.08, 0.1, 0.02, lights.reverse, x * 0.66, 0.79, -1.51, chassis);
  }
  // Exhaust stack behind the cab.
  const stack = cyl(0.085, 0.085, 3.0, MAT.chrome, 16);
  stack.position.set(-1.05, 2.75, 2.72);
  chassis.add(stack);
  const shield = cyl(0.11, 0.11, 1.0, MAT.alu, 16);
  shield.position.set(-1.05, 2.0, 2.72);
  chassis.add(shield);
  const exhaustTip = new THREE.Object3D();
  exhaustTip.position.set(-1.05, 4.28, 2.72);
  root.add(exhaustTip);
  // Coiled air lines behind the cab.
  if (!lod) {
    for (const [x, col] of [[0.18, 0xc0281f], [-0.18, 0xe8b511]] as const) {
      const pts: THREE.Vector3[] = [];
      for (let t = 0; t <= 1; t += 0.01) pts.push(new THREE.Vector3(x + Math.cos(t * 40) * 0.09, 2.2 - t * 0.9, 2.6 - t * 1.4 + Math.sin(t * 40) * 0.09));
      const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 160, 0.018, 5), new THREE.MeshStandardMaterial({ color: col, roughness: 0.4 }));
      chassis.add(tube);
    }
  }

  // --- wheels
  const steer: THREE.Group[] = [], spin: THREE.Group[] = [];
  for (const side of [1, -1]) {
    const f = wheel(0.52, 0.36, side);
    f.steer.position.set(side * 1.03, 0.52, WHEELBASE);
    root.add(f.steer);
    steer.push(f.steer); spin.push(f.spin);
    for (const [x, dish] of [[1.12, true], [0.8, false]] as const) {
      const r = wheel(0.52, 0.3, side, dish ? MAT.rim : MAT.rimDark, dish);
      r.steer.position.set(side * x, 0.52, 0);
      root.add(r.steer);
      spin.push(r.spin);
    }
    // Front wheel arch.
    const arch = new THREE.Mesh(new THREE.CylinderGeometry(0.64, 0.64, 0.46, 20, 1, true, -Math.PI / 2 - 0.1, Math.PI + 0.2), ARCH);
    arch.rotation.z = Math.PI / 2;
    arch.position.set(side * 1.03, 0.52, WHEELBASE);
    cab.add(arch);
  }

  // --- cab (cab-over, high roof sleeper)
  const W = 2.5, H = 2.75, D = 2.3, y0 = 1.25, zBack = 2.9;
  const cabGeo = new RoundedBoxGeometry(W, H, D, lod ? 2 : 5, 0.14);
  rakeCab(cabGeo, H, D, 0.2);
  const shell = new THREE.Mesh(cabGeo, body);
  shell.position.set(0, y0 + H / 2, zBack + D / 2);
  shell.castShadow = true;
  cab.add(shell);
  const zf = (y: number) => zBack + D - ((y - y0) / H) * 0.2; // front face z at height y
  // Windscreen with a slight rake.
  const ws = new THREE.Mesh(new THREE.PlaneGeometry(2.22, 1.12), MAT.glass);
  ws.position.set(0, 2.92, zf(2.92) + 0.012);
  ws.rotation.x = -Math.atan(0.2 / H);
  cab.add(ws);
  const glass: THREE.Mesh[] = [ws];
  // Side windows.
  for (const side of [1, -1]) {
    const sw = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.88), MAT.glass);
    sw.position.set(side * (W / 2 + 0.006), 2.86, 4.62);
    sw.rotation.y = side * Math.PI / 2;
    cab.add(sw);
    glass.push(sw);
    // Rear side extender panels and door handle.
    box(0.04, 2.2, 0.32, body, side * 1.24, 2.75, 2.78, cab);
    box(0.02, 0.04, 0.22, MAT.chrome, side * 1.258, 2.2, 4.05, cab);
    // Entry steps.
    for (const [y, z] of [[0.62, 4.45], [1.0, 4.5]]) box(0.32, 0.04, 0.5, MAT.alu, side * 1.08, y, z, cab);
    // Mirror arm, housing and glass, plus the wide-angle mirror below.
    const arm = cyl(0.025, 0.025, 0.42, MAT.plastic, 8);
    arm.rotation.z = Math.PI / 2;
    arm.position.set(side * 1.42, 3.12, 5.0);
    cab.add(arm);
    box(0.17, 0.58, 0.24, body, side * 1.64, 2.86, 5.0, cab);
    box(0.15, 0.52, 0.01, MAT.mirror, side * 1.64, 2.86, 4.875, cab);
    box(0.17, 0.3, 0.22, MAT.plastic, side * 1.6, 2.38, 5.02, cab);
    box(0.15, 0.25, 0.01, MAT.mirror, side * 1.6, 2.38, 4.905, cab);
    // Headlights.
    box(0.52, 0.26, 0.1, MAT.plastic, side * 0.9, 1.56, zf(1.56) - 0.02, cab);
    box(0.4, 0.15, 0.02, lights.head, side * 0.86, 1.55, zf(1.55) + 0.035, cab);
    box(0.46, 0.03, 0.02, lights.drl, side * 0.9, 1.67, zf(1.67) + 0.035, cab);
    box(0.1, 0.15, 0.02, side > 0 ? lights.indL : lights.indR, side * 1.12, 1.55, zf(1.55) + 0.03, cab);
    // Fog lights in the bumper.
    const fog = cyl(0.07, 0.07, 0.04, lights.head, 16);
    fog.rotation.x = Math.PI / 2;
    fog.position.set(side * 0.95, 1.05, 5.27);
    cab.add(fog);
  }
  // Grille, emblem, bumper, sun visor.
  box(1.76, 0.78, 0.03, MAT.plastic, 0, 1.86, zf(1.86) + 0.01, cab);
  for (let k = 0; k < 4; k++) box(1.66, 0.045, 0.04, MAT.chrome, 0, 1.6 + k * 0.17, zf(1.6 + k * 0.17) + 0.03, cab);
  const emblem = cyl(0.12, 0.12, 0.03, MAT.chrome, 24);
  emblem.rotation.x = Math.PI / 2;
  emblem.position.set(0, 2.32, zf(2.32) + 0.03);
  cab.add(emblem);
  box(2.48, 0.44, 0.42, MAT.plasticGrey, 0, 1.07, 5.03, cab);
  box(2.3, 0.12, 0.3, MAT.plastic, 0, 0.82, 5.08, cab);
  const visor = box(2.36, 0.05, 0.42, MAT.plastic, 0, 3.56, zf(3.56) + 0.12, cab);
  visor.rotation.x = 0.12;
  // Roof: light bar and air horns.
  box(1.7, 0.1, 0.16, MAT.plastic, 0, 4.06, zf(4.0) - 0.15, cab);
  for (let k = 0; k < 4; k++) {
    const l = cyl(0.065, 0.065, 0.06, lights.roof, 14);
    l.rotation.x = Math.PI / 2;
    l.position.set(-0.6 + k * 0.4, 4.06, zf(4.0) - 0.05);
    cab.add(l);
  }
  for (const x of [-0.3, 0.3]) {
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.7, 14, 1, true), HORN);
    horn.rotation.x = -Math.PI / 2;
    horn.position.set(x, 4.05, 3.7);
    cab.add(horn);
  }
  if (opts.plate) {
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.115), new THREE.MeshStandardMaterial({ map: plateTexture(opts.plate), roughness: 0.4 }));
    plate.position.set(0, 1.0, 5.25);
    cab.add(plate);
  }

  // --- interior (only seen from the driver's seat)
  const steeringWheel = new THREE.Group();
  let dashScreen: THREE.Mesh | null = null;
  if (opts.interior) {
    const inner = new THREE.Group();
    cab.add(inner);
    const IW = 1.17, top = 3.86, floor = 1.36, back = 2.99, front = 5.12;
    box(IW * 2, 0.04, front - back, MAT.interior, 0, floor, (front + back) / 2, inner);
    box(IW * 2, 0.04, front - back, MAT.interiorLight, 0, top, (front + back) / 2, inner);
    box(IW * 2, top - floor, 0.04, MAT.interior, 0, (top + floor) / 2, back, inner);
    // Bunk behind the seats.
    box(IW * 2, 0.25, 0.75, MAT.interior, 0, 1.8, back + 0.4, inner);
    for (const side of [1, -1]) {
      const x = side * IW;
      box(0.04, 2.3 - floor, front - back, MAT.interior, x, (2.3 + floor) / 2, (front + back) / 2, inner);
      box(0.04, top - 3.3, front - back, MAT.interiorLight, x, (top + 3.3) / 2, (front + back) / 2, inner);
      box(0.04, 3.3 - 2.3, 4.15 - back, MAT.interior, x, 2.8, (4.15 + back) / 2, inner);
      box(0.04, 3.3 - 2.3, 0.12, MAT.dash, x, 2.8, 5.08, inner);
      // A-pillars.
      box(0.1, 1.2, 0.1, MAT.dash, side * 1.12, 2.9, zf(2.9) - 0.06, inner);
      // Seats.
      const sx = side * 0.62;
      box(0.55, 0.14, 0.55, MAT.interior, sx, 1.95, 4.15, inner);
      const back2 = box(0.55, 0.8, 0.12, MAT.interior, sx, 2.4, 3.85, inner);
      back2.rotation.x = -0.15;
    }
    box(IW * 2, 0.5, 0.04, MAT.interiorLight, 0, 3.6, zf(3.6) - 0.05, inner);
    // Dashboard: a wide sloped panel and a hooded cluster in front of the driver.
    const dash = box(IW * 2, 0.14, 0.6, MAT.dash, 0, 2.4, 4.85, inner);
    dash.rotation.x = 0.16;
    box(IW * 2, 1.0, 0.08, MAT.dash, 0, 1.92, 5.12, inner);
    const cowl = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.62, 16, 1, true, -Math.PI / 2, Math.PI), MAT.dash);
    cowl.rotation.z = Math.PI / 2;
    cowl.scale.set(0.7, 1, 0.3);
    cowl.position.set(0.62, 2.52, 4.95);
    inner.add(cowl);
    box(0.62, 0.5, 0.45, MAT.dash, 0.02, 2.15, 4.72, inner);
    dashScreen = new THREE.Mesh(new THREE.PlaneGeometry(0.64, 0.25), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
    dashScreen.position.set(0.62, 2.56, 4.84);
    // Face the driver (yaw half a turn), then tilt the top away so it looks up at them.
    dashScreen.rotation.order = 'YXZ';
    dashScreen.rotation.set(-0.3, Math.PI, 0);
    inner.add(dashScreen);
    // Steering wheel: rim, spokes and hub, tilted towards the driver.
    steeringWheel.position.set(0.62, 2.6, 4.6);
    steeringWheel.rotation.x = -0.8;
    const wheelInner = new THREE.Group();
    steeringWheel.add(wheelInner);
    const rimW = new THREE.Mesh(new THREE.TorusGeometry(0.235, 0.024, 10, 40), MAT.dash);
    wheelInner.add(rimW);
    for (const a of [Math.PI / 2 + 0.05, -Math.PI / 2 - 0.05, -Math.PI / 2 + Math.PI]) {
      const sp = box(0.2, 0.035, 0.02, MAT.dash, Math.cos(a) * 0.12, Math.sin(a) * 0.12, 0, wheelInner);
      sp.rotation.z = a;
    }
    const hub = cyl(0.07, 0.08, 0.06, MAT.dash, 20);
    hub.rotation.x = Math.PI / 2;
    wheelInner.add(hub);
    const col = cyl(0.04, 0.05, 0.5, MAT.dash, 10);
    col.rotation.x = Math.PI / 2 - 0.8;
    col.position.set(0.62, 2.4, 4.78);
    inner.add(col);
    cab.add(steeringWheel);
  }
  const headlightAnchor = new THREE.Object3D();
  headlightAnchor.position.set(0, 1.55, 5.35);
  cab.add(headlightAnchor);

  const keep: THREE.Object3D[] = [steeringWheel, headlightAnchor];
  if (dashScreen) keep.push(dashScreen);
  for (const g of glass) keep.push(g);
  mergeStatic(cab, keep);
  mergeStatic(chassis);
  root.traverse((o) => { if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; } });
  for (const g of glass) g.castShadow = false;
  return { root, cab, steer, spin, steeringWheel, exhaustTip, glass, dashScreen, lights, headlightAnchor, paintMat: body };
}

// ------------------------------------------------------------------ trailers

export interface Trailer {
  root: THREE.Group;
  spin: THREE.Group[];
  lights: LightMats;
  kind: TrailerKind;
}

const CONTAINER_COLORS = ['#b23a2e', '#1f5f99', '#2f7a4f', '#c97a1c', '#6b6f75', '#8a2f5f'];
const CONTAINER_LABELS = ['MAERA', 'CORSAN', 'HAPAG', 'NORDIC', 'EVERWAVE', 'CMA·LINE'];

export function buildTrailer(kind: TrailerKind, livery: number, opts: { lod?: boolean } = {}): Trailer {
  const root = new THREE.Group();
  const lights = makeLightMats(!!opts.lod);
  const front = TRAILER_LEN + 1.6, rear = -1.6;
  const len = front - rear, mid = (front + rear) / 2;
  const L = LIVERIES[livery % LIVERIES.length];
  const deckY = 1.28, topY = 4.0;

  // --- chassis common to all
  for (const x of [-0.5, 0.5]) box(0.14, kind === 'container' ? 0.3 : 0.42, len - 0.4, MAT.frame, x, 1.02, mid, root);
  const spin: THREE.Group[] = [];
  for (const z of [-1.31, 0, 1.31]) {
    for (const side of [1, -1]) {
      const w = wheel(0.53, 0.38, side, MAT.rim);
      w.steer.position.set(side * 0.98, 0.53, z);
      root.add(w.steer);
      spin.push(w.spin);
    }
    box(1.7, 0.12, 0.12, MAT.frame, 0, 0.53, z, root);
  }
  for (const side of [1, -1]) {
    box(0.44, 0.05, 4.1, MAT.plastic, side * 0.98, 1.14, 0, root);
    box(0.5, 0.55, 0.02, MAT.rubber, side * 0.98, 0.6, -2.2, root);
    // Landing legs.
    box(0.12, 0.95, 0.12, MAT.frame, side * 0.82, 0.62, 8.6, root);
    box(0.3, 0.05, 0.3, MAT.frame, side * 0.82, 0.12, 8.6, root);
    // Side under-run guard.
    for (const y of [0.62, 0.9]) box(0.04, 0.09, 5.8, MAT.alu, side * 1.22, y, 5.1, root);
  }
  // Rear under-run bar and lights.
  box(2.35, 0.14, 0.14, MAT.steel, 0, 0.56, rear + 0.08, root);
  for (const side of [1, -1]) {
    box(0.6, 0.18, 0.08, MAT.plastic, side * 0.88, 0.95, rear - 0.02, root);
    box(0.24, 0.12, 0.02, lights.tail, side * 0.98, 0.96, rear - 0.07, root);
    box(0.1, 0.12, 0.02, side > 0 ? lights.indL : lights.indR, side * 0.76, 0.96, rear - 0.07, root);
    box(0.08, 0.12, 0.02, lights.reverse, side * 0.64, 0.96, rear - 0.07, root);
  }

  const bodyTop = kind === 'container' ? deckY + 2.59 : topY;
  if (kind === 'curtain' || kind === 'reefer') {
    const sideTex = trailerSide(livery, kind);
    const sideMat = new THREE.MeshStandardMaterial({ map: sideTex, roughness: kind === 'reefer' ? 0.35 : 0.7, metalness: 0 });
    const H = topY - deckY - 0.1;
    for (const side of [1, -1]) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(len - 0.1, H), sideMat);
      p.position.set(side * 1.275, deckY + 0.05 + H / 2, mid);
      p.rotation.y = side * Math.PI / 2;
      root.add(p);
      box(0.06, 0.2, len, MAT.alu, side * 1.25, deckY, mid, root);
      box(0.06, 0.12, len, MAT.alu, side * 1.25, topY, mid, root);
      // Amber side markers along the bottom rail.
      for (let z = rear + 1; z < front - 0.5; z += 1.9) box(0.03, 0.06, 0.1, lights.marker, side * 1.285, deckY - 0.04, z, root);
    }
    const endMat = kind === 'reefer' ? MAT.white : paint(new THREE.Color(L.bg).getHex(), 0.1, 0.5);
    box(2.5, H, 0.06, endMat, 0, deckY + 0.05 + H / 2, front - 0.03, root);
    // Rear doors with locking bars.
    box(2.5, H, 0.06, kind === 'reefer' ? MAT.white : MAT.alu, 0, deckY + 0.05 + H / 2, rear + 0.03, root);
    for (const x of [-0.85, -0.35, 0.35, 0.85]) {
      const bar = cyl(0.025, 0.025, H - 0.1, MAT.chrome, 8);
      bar.position.set(x, deckY + 0.05 + H / 2, rear - 0.04);
      root.add(bar);
    }
    box(2.5, 0.04, len, MAT.roof, 0, topY + 0.02, mid, root);
    for (const [x, z] of [[1, front], [-1, front], [1, rear], [-1, rear]]) box(0.1, H + 0.2, 0.1, MAT.alu, x * 1.22, deckY + H / 2, z - Math.sign(z - mid) * 0.05, root);
    if (kind === 'reefer') {
      box(2.0, 1.7, 0.5, MAT.plasticGrey, 0, 2.95, front + 0.25, root);
      box(1.6, 1.1, 0.02, MAT.plastic, 0, 3.0, front + 0.51, root);
      box(1.7, 0.18, 0.02, paint(new THREE.Color(L.bg).getHex(), 0.1, 0.4), 0, 3.66, front + 0.51, root);
      for (const side of [1, -1]) box(0.03, 0.7, 6.5, MAT.white, side * 1.2, 0.85, 4.6, root);
    }
  } else if (kind === 'container') {
    const col = CONTAINER_COLORS[livery % CONTAINER_COLORS.length];
    const label = CONTAINER_LABELS[livery % CONTAINER_LABELS.length];
    const sideMat = new THREE.MeshStandardMaterial({ map: containerSide(col, label), roughness: 0.55, metalness: 0.3 });
    const endMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(col).multiplyScalar(0.9), roughness: 0.6, metalness: 0.3 });
    const cl = 12.19, cw = 2.44, ch = 2.59, cz = front - 0.3 - cl / 2;
    const cont = new THREE.Group();
    root.add(cont);
    for (const side of [1, -1]) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(cl, ch), sideMat);
      p.position.set(side * cw / 2, deckY + ch / 2, cz);
      p.rotation.y = side * Math.PI / 2;
      cont.add(p);
    }
    box(cw, ch, 0.05, endMat, 0, deckY + ch / 2, cz + cl / 2, cont);
    box(cw, ch, 0.05, endMat, 0, deckY + ch / 2, cz - cl / 2, cont);
    for (const x of [-0.75, -0.25, 0.25, 0.75]) { const bar = cyl(0.022, 0.022, ch - 0.1, MAT.steel, 8); bar.position.set(x, deckY + ch / 2, cz - cl / 2 - 0.04); cont.add(bar); }
    box(cw, 0.05, cl, endMat, 0, deckY + ch, cz, cont);
    box(cw - 0.1, 0.1, cl, MAT.frame, 0, deckY - 0.02, cz, cont);
    for (const side of [1, -1]) for (let z = rear + 1; z < front - 0.5; z += 2.6) box(0.03, 0.06, 0.1, lights.marker, side * 1.15, 1.0, z, root);
  } else {
    // Stainless tanker.
    const tankMat = new THREE.MeshStandardMaterial({ color: 0xe6e9ec, metalness: 1, roughness: 0.14 });
    const tl = len - 0.6;
    const t = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, tl, 40, 1, true), tankMat);
    t.rotation.x = Math.PI / 2;
    t.scale.set(1.2, 1, 1.0);
    t.position.set(0, 2.45, mid);
    root.add(t);
    for (const s of [1, -1]) {
      const cap = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), tankMat);
      cap.rotation.x = s * Math.PI / 2;
      cap.scale.set(1.2, 0.35, 1.0);
      cap.position.set(0, 2.45, mid + s * tl / 2);
      root.add(cap);
    }
    for (let z = rear + 1.5; z < front - 1; z += 2.4) { const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.03, 6, 40), MAT.alu); ring.scale.set(1.2, 1, 1); ring.position.set(0, 2.45, z); root.add(ring); }
    box(0.6, 0.06, tl - 1, MAT.alu, 0, 3.47, mid, root);
    for (let z = rear + 1; z < front - 1; z += 1.5) box(0.04, 0.25, 0.04, MAT.alu, 0.32, 3.6, z, root);
    box(0.04, 0.04, tl - 1, MAT.alu, 0.32, 3.72, mid, root);
    for (let k = 0; k < 5; k++) box(0.5, 0.03, 0.03, MAT.alu, 0, 1.6 + k * 0.4, rear - 0.12, root);
    box(2.2, 0.5, 1.2, MAT.alu, 0, 1.15, 4.2, root);
    for (const side of [1, -1]) for (let z = rear + 1; z < front - 0.5; z += 2.2) box(0.03, 0.06, 0.1, lights.marker, side * 1.2, 1.2, z, root);
  }
  void bodyTop;
  mergeStatic(root, spin.map((w) => w.parent!));
  root.traverse((o) => { if (o instanceof THREE.Mesh) { o.castShadow = !opts.lod || o.geometry.attributes.position.count > 100; o.receiveShadow = true; } });
  return { root, spin, lights, kind };
}

// ------------------------------------------------------------------ cars

export interface CarModel {
  root: THREE.Group;
  spin: THREE.Group[];
  lights: LightMats;
  paintMat: THREE.Material;
}

const carTemplates = new Map<string, THREE.Group>();

function carShape(kind: Exclude<CarKind, 'truck'>) {
  // [length, body height, width, cabin length, cabin height, cabin offset, ride height]
  switch (kind) {
    case 'hatch': return { l: 4.1, bh: 0.62, w: 1.78, cl: 2.35, ch: 0.62, co: -0.35, ride: 0.18, tr: 0.3 };
    case 'wagon': return { l: 4.85, bh: 0.62, w: 1.84, cl: 3.1, ch: 0.58, co: -0.55, ride: 0.18, tr: 0.32 };
    case 'suv': return { l: 4.7, bh: 0.8, w: 1.93, cl: 2.85, ch: 0.68, co: -0.4, ride: 0.26, tr: 0.36 };
    case 'van': return { l: 5.4, bh: 1.05, w: 2.0, cl: 4.2, ch: 1.15, co: -0.55, ride: 0.22, tr: 0.34 };
    default: return { l: 4.75, bh: 0.6, w: 1.84, cl: 2.55, ch: 0.56, co: -0.25, ride: 0.18, tr: 0.32 };
  }
}

export function buildCar(kind: Exclude<CarKind, 'truck'>, color: number): CarModel {
  const lights = makeLightMats(true);
  const paintMat = paint(color, 0.5, 0.25);
  const s = carShape(kind);
  const root = new THREE.Group();
  const bodyY = s.ride + s.tr * 0.6 + s.bh / 2;
  const bodyG = new RoundedBoxGeometry(s.w, s.bh, s.l, 3, Math.min(0.2, s.bh * 0.35));
  const body = new THREE.Mesh(bodyG, paintMat);
  body.position.y = bodyY;
  root.add(body);
  // Cabin: glass greenhouse tapered towards the top, with a painted roof.
  const cabG = new RoundedBoxGeometry(s.w * 0.92, s.ch, s.cl, 2, 0.12);
  const p = cabG.attributes.position;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > 0) { p.setX(i, p.getX(i) * 0.88); p.setZ(i, p.getZ(i) * (kind === 'van' ? 0.95 : 0.78)); }
  }
  cabG.computeVertexNormals();
  const cab = new THREE.Mesh(cabG, MAT.glass);
  const cabY = bodyY + s.bh / 2 + s.ch / 2 - 0.04;
  cab.position.set(0, cabY, s.co);
  root.add(cab);
  const roof = new THREE.Mesh(new RoundedBoxGeometry(s.w * 0.8, 0.08, s.cl * (kind === 'van' ? 0.93 : 0.74), 2, 0.035), paintMat);
  roof.position.set(0, cabY + s.ch / 2 - 0.02, s.co);
  root.add(roof);
  if (kind === 'van') {
    // Panel van: solid painted cargo box behind the cab.
    const cargo = new THREE.Mesh(new RoundedBoxGeometry(s.w * 0.98, s.ch, s.cl * 0.62, 2, 0.08), paintMat);
    cargo.position.set(0, cabY, s.co - s.cl * 0.19);
    root.add(cargo);
  }
  // Bumpers, lights, mirrors, plates.
  for (const z of [s.l / 2 - 0.05, -s.l / 2 + 0.05]) box(s.w * 0.96, 0.18, 0.1, MAT.plasticGrey, 0, s.ride + s.tr * 0.55, z, root);
  for (const side of [1, -1]) {
    box(0.42, 0.12, 0.04, lights.head, side * (s.w / 2 - 0.3), bodyY + s.bh * 0.15, s.l / 2 - 0.01, root);
    box(0.38, 0.12, 0.04, lights.tail, side * (s.w / 2 - 0.26), bodyY + s.bh * 0.2, -s.l / 2 + 0.01, root);
    box(0.1, 0.08, 0.04, side > 0 ? lights.indL : lights.indR, side * (s.w / 2 - 0.06), bodyY + s.bh * 0.15, s.l / 2 - 0.03, root);
    box(0.1, 0.08, 0.04, side > 0 ? lights.indL : lights.indR, side * (s.w / 2 - 0.06), bodyY + s.bh * 0.2, -s.l / 2 + 0.03, root);
    box(0.08, 0.1, 0.18, paintMat, side * (s.w / 2 + 0.05), cabY - s.ch * 0.25, s.co + s.cl * 0.32, root);
  }
  box(s.w * 0.6, 0.15, 0.03, MAT.plastic, 0, bodyY - s.bh * 0.1, s.l / 2 + 0.005, root);
  const spin: THREE.Group[] = [];
  for (const z of [s.l / 2 - 0.85, -s.l / 2 + 0.85]) {
    for (const side of [1, -1]) {
      const w = wheel(s.tr, 0.22, side, MAT.rim, false);
      w.steer.position.set(side * (s.w / 2 - 0.13), s.tr, z);
      root.add(w.steer);
      spin.push(w.spin);
    }
  }
  mergeStatic(root, spin.map((w) => w.parent!));
  root.traverse((o) => { if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = false; } });
  return { root, spin, lights, paintMat };
}

/** Cached car template so traffic doesn't rebuild geometry every respawn. */
export function carTemplate(kind: Exclude<CarKind, 'truck'>) {
  let t = carTemplates.get(kind);
  if (!t) { t = buildCar(kind, 0xffffff).root; carTemplates.set(kind, t); }
  return t;
}

export function truckPaintFor(i: number) {
  return [0xb3141b, 0xf2f2f2, 0x0d2f6b, 0x111214, 0xe07a10, 0x2c6e3f][i % 6];
}

export { CONTAINER_COLORS };
