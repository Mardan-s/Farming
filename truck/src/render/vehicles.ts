import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { MAT, box, clearcoatOn, cyl, lamp, mergeStatic, paint } from './materials';
import { LIVERIES, cabDecal, containerSide, grilleTexture, plateTexture, trailerSide } from './textures';
import { TRUCK_MODELS, TruckLook } from '../sim/trucks';
import { DOOR_BACK, buildCab, panelTextures } from './cab';
import { normalFromCanvas } from './textures';
import type { TrailerKind } from '../sim/jobs';
import type { CarKind } from '../sim/traffic';
import { HITCH_AHEAD, TRAILER_LEN, WHEELBASE } from '../sim/truck';
import { buildConventional } from './conventional';
import { buildInterior, isInteriorDetail, isInteriorMaterial } from './interior';

/** Interior parts are in the cab's shadow already, so they never cast one. */
export const insideMat = (m: THREE.Material | THREE.Material[]) => (Array.isArray(m) ? m.some(isInteriorMaterial) : isInteriorMaterial(m));

// Procedural vehicle models. Local frame: +z forward, +x is the vehicle's LEFT side, y up,
// origin on the ground under the drive axle (tractor) or the axle group centre (trailer).

// ------------------------------------------------------------------ wheels

interface WheelGeo { tire: THREE.BufferGeometry; rim: THREE.BufferGeometry; nuts: THREE.BufferGeometry | null; pointers: THREE.BufferGeometry | null; drum: THREE.BufferGeometry | null }
const wheelCache = new Map<string, WheelGeo>();

function wheelGeometry(r: number, w: number, dish = true): WheelGeo {
  const key = `${r}-${w}-${dish}`;
  const hit = wheelCache.get(key);
  if (hit) return hit;
  const rr = r * 0.62;
  // Tyre profile from the inner bead round the shoulder and tread to the outer bead. Its UVs run
  // round the wheel (u) and across the profile (v), which the tyre texture is painted for.
  const tireProfile = [
    new THREE.Vector2(rr, -w / 2), new THREE.Vector2(r - 0.07, -w / 2), new THREE.Vector2(r - 0.02, -w / 2 + 0.03),
    new THREE.Vector2(r, -w / 2 + 0.08), new THREE.Vector2(r, w / 2 - 0.08), new THREE.Vector2(r - 0.02, w / 2 - 0.03),
    new THREE.Vector2(r - 0.07, w / 2), new THREE.Vector2(rr, w / 2),
  ];
  const tire = new THREE.LatheGeometry(tireProfile, 40);
  tire.rotateZ(-Math.PI / 2);
  const o = w / 2;
  const rimProfile = dish
    ? [new THREE.Vector2(rr, o - 0.02), new THREE.Vector2(rr * 0.92, o - 0.05), new THREE.Vector2(rr * 0.55, o - 0.11), new THREE.Vector2(0.2, o - 0.06), new THREE.Vector2(0.13, o - 0.03), new THREE.Vector2(0.11, o + 0.04), new THREE.Vector2(0.001, o + 0.05)]
    : [new THREE.Vector2(rr, o - 0.02), new THREE.Vector2(rr * 0.8, o - 0.04), new THREE.Vector2(0.001, o - 0.04)];
  const rim = new THREE.LatheGeometry(rimProfile, 40);
  rim.rotateZ(-Math.PI / 2);
  let nuts: THREE.BufferGeometry | null = null, pointers: THREE.BufferGeometry | null = null, drum: THREE.BufferGeometry | null = null;
  if (dish) {
    const ns: THREE.BufferGeometry[] = [], ps: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      const cy = Math.cos(a) * 0.165, cz = Math.sin(a) * 0.165;
      const nut = new THREE.CylinderGeometry(0.022, 0.022, 0.05, 6);
      nut.rotateZ(Math.PI / 2);
      nut.translate(o - 0.04, cy, cz);
      ns.push(nut.toNonIndexed());
      // Loose-nut indicators: little orange arrows pointing round the rim.
      const ind = new THREE.BoxGeometry(0.012, 0.06, 0.022);
      ind.translate(0, 0.04, 0);
      ind.rotateX(a + Math.PI / 2);
      ind.translate(o - 0.015, cy, cz);
      ps.push(ind.toNonIndexed());
    }
    for (const g of [...ns, ...ps]) g.deleteAttribute('uv');
    nuts = mergeNonIndexed(ns);
    pointers = mergeNonIndexed(ps);
    // Brake drum seen through the hand-holes.
    drum = new THREE.CylinderGeometry(rr * 0.82, rr * 0.82, w * 0.55, 24);
    drum.rotateZ(Math.PI / 2);
    drum.translate(-w * 0.05, 0, 0);
  }
  const out = { tire, rim, nuts, pointers, drum };
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

let tireMat: THREE.MeshStandardMaterial | null = null;
/** Rubber with tread blocks and grooves on the crown, and raised lettering on the sidewalls. */
function tireMaterial() {
  if (tireMat) return tireMat;
  const W = 2048, H = 256;
  const c = document.createElement('canvas'), hc = document.createElement('canvas');
  c.width = hc.width = W; c.height = hc.height = H;
  const g = c.getContext('2d')!, hg = hc.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#1b1b1c'; g.fillRect(0, 0, W, H);
  hg.fillStyle = '#808080'; hg.fillRect(0, 0, W, H);
  // Profile v (0 at the inner bead, 1 at the outer) maps to canvas y = (1 - v) * H.
  const y = (v: number) => (1 - v) * H;
  const t0 = y(4 / 7), t1 = y(3 / 7);
  // Tread: three circumferential grooves and zig-zag sipes between blocks.
  for (const ctx of [g, hg]) {
    ctx.fillStyle = ctx === g ? '#0d0d0e' : '#303030';
    for (const f of [0.22, 0.5, 0.78]) ctx.fillRect(0, t0 + (t1 - t0) * f - 2, W, 4);
    ctx.strokeStyle = ctx === g ? '#101011' : '#404040';
    ctx.lineWidth = 3;
    for (let x = 0; x < W; x += 26) {
      ctx.beginPath();
      ctx.moveTo(x, t0); ctx.lineTo(x + 8, t0 + (t1 - t0) * 0.35); ctx.lineTo(x, t0 + (t1 - t0) * 0.65); ctx.lineTo(x + 8, t1);
      ctx.stroke();
    }
    // Sidewall lettering, twice round each side.
    ctx.fillStyle = ctx === g ? '#3b3b3e' : '#c8c8c8';
    ctx.textBaseline = 'middle';
    for (const band of [[y(0.08), y(0.24)], [y(0.92), y(0.76)]]) {
      for (let k = 0; k < 2; k++) {
        const x0 = k * W / 2;
        ctx.font = '800 30px "Barlow Condensed", Arial, sans-serif';
        ctx.fillText('EUROGRIP  ROADMASTER', x0 + 60, (band[0] + band[1]) / 2);
        ctx.font = '700 20px "Barlow", Arial, sans-serif';
        ctx.fillText('315/70 R22.5  156/150L  M+S', x0 + 520, (band[0] + band[1]) / 2);
      }
    }
  }
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  tireMat = new THREE.MeshStandardMaterial({ map, normalMap: normalFromCanvas(hc, 3), normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.9, metalness: 0 });
  return tireMat;
}

const holedRims = new Map<THREE.Material, THREE.Material>();
let holeMap: THREE.Texture | null = null;
/** The rim's material with ten hand-holes cut through the dish. */
function holedRim(base: THREE.Material) {
  let m = holedRims.get(base);
  if (m) return m;
  if (!holeMap) {
    const W = 1024, H = 128;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    // Rim profile point 1→2 spans v 1/6..2/6, canvas y from (1-2/6)H to (1-1/6)H.
    const ya = (1 - 2 / 6) * H + 5, yb = (1 - 1 / 6) * H - 5;
    g.fillStyle = '#000';
    for (let k = 0; k < 10; k++) {
      const x = (k + 0.5) * (W / 10);
      g.beginPath();
      g.ellipse(x, (ya + yb) / 2, W / 10 * 0.3, (yb - ya) / 2, 0, 0, Math.PI * 2);
      g.fill();
    }
    holeMap = new THREE.CanvasTexture(c);
    holeMap.colorSpace = THREE.NoColorSpace;
  }
  m = (base as THREE.MeshStandardMaterial).clone();
  (m as THREE.MeshStandardMaterial).alphaMap = holeMap;
  m.alphaTest = 0.5;
  m.side = THREE.DoubleSide;
  holedRims.set(base, m);
  return m;
}

export const POINTER = new THREE.MeshStandardMaterial({ color: 0xff7a00, roughness: 0.5 });
export const ADBLUE = new THREE.MeshStandardMaterial({ color: 0x1f5fd1, roughness: 0.4 });
/** Retro-reflective conspicuity tape: glows a little at night, more when a light hits it. */
const TAPE_RED = new THREE.MeshStandardMaterial({ color: 0xc8102e, emissive: 0x500008, roughness: 0.3, metalness: 0.2 });
const TAPE_WHITE = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, emissive: 0x303030, roughness: 0.3, metalness: 0.2 });
const TAPE_YELLOW = new THREE.MeshStandardMaterial({ color: 0xf6c400, emissive: 0x403000, roughness: 0.3, metalness: 0.2 });
let checkerTex: THREE.Texture | null = null;
export function checker() {
  if (!checkerTex) {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d')!;
    g.fillStyle = '#9ea4aa'; g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#d6dbe0';
    for (let y = 0; y < 128; y += 16) for (let x = (y / 16) % 2 ? 8 : 0; x < 128; x += 16) { g.save(); g.translate(x + 4, y + 4); g.rotate(Math.PI / 4); g.fillRect(-1.5, -5, 3, 10); g.restore(); }
    checkerTex = new THREE.CanvasTexture(c);
    checkerTex.colorSpace = THREE.SRGBColorSpace;
    checkerTex.wrapS = checkerTex.wrapT = THREE.RepeatWrapping;
    checkerTex.repeat.set(4, 2);
  }
  return checkerTex;
}
export const CHECKER = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.85, roughness: 0.35 });
/** Brushed aluminium: fine streaks in colour and roughness. Texture is made on first use. */
const BRUSHED = new THREE.MeshStandardMaterial({ color: 0xb4b9be, metalness: 1, roughness: 0.42 });
export function brushed() {
  if (BRUSHED.map) return BRUSHED;
  const c = document.createElement('canvas'); c.width = 8; c.height = 256;
  const g = c.getContext('2d')!;
  for (let y = 0; y < 256; y++) { const v = 150 + Math.floor(Math.random() * 70); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(0, y, 8, 1); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1, 3);
  BRUSHED.map = t;
  BRUSHED.roughnessMap = t;
  BRUSHED.needsUpdate = true;
  return BRUSHED;
}

/** D-section tank profile (flat inboard face at x = -w/2), extruded along z. */
export function tankGeometry(w: number, h: number, len: number) {
  const sh = new THREE.Shape();
  const r = h * 0.42, ri = 0.05;
  sh.moveTo(-w / 2, -h / 2 + ri);
  sh.lineTo(-w / 2, h / 2 - ri);
  sh.quadraticCurveTo(-w / 2, h / 2, -w / 2 + ri, h / 2);
  sh.lineTo(w / 2 - r, h / 2);
  sh.absarc(w / 2 - r, h / 2 - r, r, Math.PI / 2, 0, true);
  sh.lineTo(w / 2, -h / 2 + r);
  sh.absarc(w / 2 - r, -h / 2 + r, r, 0, -Math.PI / 2, true);
  sh.lineTo(-w / 2 + ri, -h / 2);
  sh.quadraticCurveTo(-w / 2, -h / 2, -w / 2, -h / 2 + ri);
  const g = new THREE.ExtrudeGeometry(sh, { depth: len, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.02, bevelSegments: 2, curveSegments: 10 });
  g.translate(0, 0, -len / 2);
  return g;
}

/** A wheel whose outer face points to the given side (+1 left, -1 right). Returns [steer group, spin group]. */
export function wheel(r: number, w: number, side: number, rimMat: THREE.Material = MAT.rim, dish = true, detail = true) {
  const g = wheelGeometry(r, w, dish);
  const steer = new THREE.Group();
  const spin = new THREE.Group();
  const holder = new THREE.Group();
  if (side < 0) holder.rotation.y = Math.PI;
  const tire = new THREE.Mesh(g.tire, tireMaterial());
  const rim = new THREE.Mesh(g.rim, dish && detail ? holedRim(rimMat) : rimMat);
  tire.castShadow = true;
  holder.add(tire, rim);
  // Small parts stay out of the shadow pass: their shadows are lost inside the tyre's anyway.
  const small = (m: THREE.Mesh) => { m.userData.noShadow = true; holder.add(m); };
  if (g.nuts) small(new THREE.Mesh(g.nuts, rimMat));
  if (detail && g.pointers) small(new THREE.Mesh(g.pointers, POINTER));
  if (detail && g.drum) small(new THREE.Mesh(g.drum, MAT.frame));
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

export const ARCH = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.6, side: THREE.DoubleSide });
/** Black glass surrounds: solid panels seen from outside, hidden from the driver's seat. */
const BORDER = new THREE.MeshStandardMaterial({ color: 0x0d0e10, roughness: 0.4, metalness: 0.2 });
/** Clear polycarbonate headlight cover. */
export const LENS = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0, roughness: 0.02, transparent: true, opacity: 0.18, depthWrite: false });
export const HORN = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, metalness: 1, roughness: 0.08, side: THREE.DoubleSide });

export interface Tractor {
  root: THREE.Group;
  cab: THREE.Group;
  steer: THREE.Group[];
  spin: THREE.Group[];
  steeringWheel: THREE.Group;
  exhaustTip: THREE.Object3D;
  glass: THREE.Mesh[];
  dashScreen: THREE.Mesh | null;
  gpsScreen: THREE.Mesh | null;
  lights: LightMats;
  headlightAnchor: THREE.Object3D;
  paintMat: THREE.Material;
  model: number;
  wipers: THREE.Group[];
  /** Exterior-only meshes (window surrounds) to hide in the cab view. */
  exterior: THREE.Object3D[];
  /** Small interior parts, only shown in the cab view. */
  cabDetail: THREE.Object3D[];
  /** Where the rig puts things (cab-local): cab suspension pivot, driver's eye, headlamps, main mirror. */
  fit: { pivot: THREE.Vector3; eye: THREE.Vector3; head: THREE.Vector3; mirror: THREE.Vector3; mirrorSize: [number, number] };
}

/** Cab paint: the panel texture (shut-lines, frit, lettering) under a flaky metallic clear coat. */
export function shellPaint(color: number, panel: { map: THREE.Texture; height: HTMLCanvasElement }, lod: boolean) {
  const normalMap = lod ? null : normalFromCanvas(panel.height, 2.5);
  const m = clearcoatOn()
    ? new THREE.MeshPhysicalMaterial({ color, map: panel.map, normalMap, normalScale: new THREE.Vector2(0.35, 0.35), metalness: 0.55, roughness: 0.33, clearcoat: 1, clearcoatRoughness: 0.04 })
    : new THREE.MeshStandardMaterial({ color, map: panel.map, normalMap, normalScale: new THREE.Vector2(0.35, 0.35), metalness: 0.45, roughness: 0.28 });
  return m;
}

export function buildTractor(look: TruckLook, opts: { interior: boolean; lod?: boolean; plate?: string } = { interior: true }): Tractor {
  if (TRUCK_MODELS[look.model].style === 'conventional') return buildConventional(look, opts);
  const root = new THREE.Group();
  const chassis = new THREE.Group();
  const cab = new THREE.Group();
  root.add(chassis);
  root.add(cab);
  const lights = makeLightMats(!!opts.lod);
  const accent = paint(look.accent, 0.4, 0.3);
  const lod = !!opts.lod;
  const M = look.model;
  if (!CHECKER.map) { CHECKER.map = checker(); CHECKER.needsUpdate = true; }
  const trim = look.chrome ? MAT.chrome : MAT.plasticGrey;

  // --- chassis
  for (const x of [-0.45, 0.45]) box(0.12, 0.3, 7.1, MAT.frame, x, 0.95, 1.6, chassis);
  for (const z of [-1.2, 0.9, 2.6, 4.4]) box(0.9, 0.12, 0.12, MAT.frame, 0, 0.9, z, chassis);
  const fifth = cyl(0.46, 0.46, 0.12, MAT.steel, 24);
  fifth.position.set(0, 1.18, HITCH_AHEAD);
  chassis.add(fifth);
  box(1.1, 0.08, 0.5, MAT.steel, 0, 1.1, -0.2, chassis);
  // Fuel tank (left), with polished straps.
  const tank = new THREE.Mesh(tankGeometry(0.62, 0.66, 1.7), look.chrome ? MAT.chrome : brushed());
  tank.position.set(0.92, 0.84, 1.95);
  chassis.add(tank);
  for (const dz of [-0.6, 0.6]) {
    const strap = new THREE.Mesh(tankGeometry(0.64, 0.68, 0.05), MAT.frame);
    strap.position.set(0.92, 0.84, 1.95 + dz);
    chassis.add(strap);
  }
  const cap = cyl(0.07, 0.07, 0.06, MAT.chrome, 12); cap.position.set(0.98, 1.19, 2.35); chassis.add(cap);
  if (!lod) {
    // Filler neck guard and the gauge sender on top.
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.012, 6, 16), MAT.steel); ring.rotation.x = Math.PI / 2; ring.position.set(0.98, 1.2, 2.35); chassis.add(ring);
    box(0.12, 0.03, 0.12, MAT.plastic, 0.9, 1.19, 1.5, chassis);
  }
  // Side fairing on the right (the fuel tank fills the left), in the accent colour.
  box(0.05, M === 0 ? 0.45 : 0.62, M === 0 ? 1.6 : 2.3, accent, -1.22, 0.74, 1.95, chassis);
  box(0.5, 0.45, 0.6, MAT.plastic, -0.95, 0.75, 2.6, chassis);
  if (!lod) {
    // AdBlue tank with its blue filler cap, behind the diesel tank.
    const ad = new THREE.Mesh(new RoundedBoxGeometry(0.42, 0.5, 0.42, 2, 0.08), MAT.plasticGrey);
    ad.position.set(0.93, 0.84, 0.86);
    chassis.add(ad);
    const adCap = cyl(0.06, 0.06, 0.05, ADBLUE, 12); adCap.position.set(0.93, 1.12, 0.9); chassis.add(adCap);
    // Air tanks, drive shaft, air suspension bellows, shock absorbers and the rear axle housing.
    for (const x of [-0.24, 0.24]) { const tk = cyl(0.13, 0.13, 1.0, MAT.alu, 16); tk.rotation.x = Math.PI / 2; tk.position.set(x, 0.74, 1.4); chassis.add(tk); }
    const shaft = cyl(0.05, 0.05, 2.6, MAT.steel, 10); shaft.rotation.x = Math.PI / 2 - 0.05; shaft.position.set(0, 0.6, 1.55); chassis.add(shaft);
    for (const x of [-0.55, 0.55]) for (const z of [-0.38, 0.38]) { const bag = cyl(0.13, 0.13, 0.3, MAT.rubber, 14); bag.position.set(x, 0.86, z); chassis.add(bag); }
    for (const x of [-0.62, 0.62]) { const sh = cyl(0.03, 0.03, 0.5, MAT.steel, 8); sh.rotation.x = 0.4; sh.position.set(x, 0.75, 0.15); chassis.add(sh); }
    box(1.55, 0.17, 0.17, MAT.frame, 0, 0.52, 0, chassis);
    const diff = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 10), MAT.frame); diff.position.set(0, 0.52, 0); chassis.add(diff);
    // Front axle beam and under-run protection below the bumper.
    box(1.6, 0.12, 0.15, MAT.frame, 0, 0.5, WHEELBASE, chassis);
    box(2.2, 0.14, 0.12, MAT.frame, 0, 0.6, 5.12, chassis);
    // Checker-plate catwalk behind the cab with grab handles.
    box(1.25, 0.03, 0.6, CHECKER, 0, 1.32, 2.45, chassis);
    for (const x of [-0.55, 0.55]) { const hnd = cyl(0.015, 0.015, 0.5, MAT.chrome, 6); hnd.position.set(x, 1.6, 2.83); chassis.add(hnd); }
    box(0.5, 0.35, 0.5, MAT.plastic, -0.95, 0.75, 0.95, chassis);
  }
  // Rear mudguards and flaps with a reflective strip.
  for (const x of [-1, 1]) {
    box(0.78, 0.05, 1.25, MAT.plastic, x * 0.95, 1.18, 0, chassis);
    box(0.7, 0.62, 0.02, MAT.rubber, x * 0.95, 0.55, -0.72, chassis);
    box(0.6, 0.06, 0.025, MAT.reflector, x * 0.95, 0.32, -0.73, chassis);
  }
  // Rear light bar.
  box(2.3, 0.16, 0.1, MAT.plastic, 0, 0.78, -1.45, chassis);
  for (const x of [-1, 1]) {
    box(0.26, 0.1, 0.02, lights.tail, x * 0.88, 0.79, -1.51, chassis);
    box(0.1, 0.1, 0.02, x > 0 ? lights.indL : lights.indR, x * 1.07, 0.79, -1.51, chassis);
    box(0.08, 0.1, 0.02, lights.reverse, x * 0.66, 0.79, -1.51, chassis);
  }
  // Exhaust stacks behind the cab: one, or twin polished stacks on the V8.
  const stacks = M === 2 ? [-1.05, 1.05] : [-1.05];
  const exhaustTip = new THREE.Object3D();
  for (const x of stacks) {
    const stack = cyl(0.09, 0.09, 3.2, MAT.chrome, 18);
    stack.position.set(x, 2.85, 2.72);
    chassis.add(stack);
    const shield = cyl(0.12, 0.12, 1.1, MAT.alu, 18);
    shield.position.set(x, 2.0, 2.72);
    chassis.add(shield);
    const lip = cyl(0.1, 0.09, 0.12, MAT.chrome, 18);
    lip.position.set(x, 4.46, 2.72);
    chassis.add(lip);
  }
  exhaustTip.position.set(-1.05, 4.5, 2.72);
  root.add(exhaustTip);
  if (!lod) {
    for (const [x, col] of [[0.18, 0xc0281f], [-0.18, 0xe8b511]] as const) {
      const pts: THREE.Vector3[] = [];
      for (let t = 0; t <= 1; t += 0.01) pts.push(new THREE.Vector3(x + Math.cos(t * 40) * 0.09, 2.2 - t * 0.9, 2.6 - t * 1.4 + Math.sin(t * 40) * 0.09));
      chassis.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 160, 0.018, 5), new THREE.MeshStandardMaterial({ color: col, roughness: 0.4 })));
    }
  }

  // --- wheels
  const rimMat = look.chrome ? MAT.chrome : MAT.rim;
  const steer: THREE.Group[] = [], spin: THREE.Group[] = [];
  for (const side of [1, -1]) {
    const f = wheel(0.52, 0.36, side, rimMat, true, !lod);
    f.steer.position.set(side * 1.03, 0.52, WHEELBASE);
    root.add(f.steer);
    steer.push(f.steer); spin.push(f.spin);
    for (const [x, dish] of [[1.12, true], [0.8, false]] as const) {
      const r = wheel(0.52, 0.3, side, dish ? rimMat : MAT.rimDark, dish, !lod);
      r.steer.position.set(side * x, 0.52, 0);
      root.add(r.steer);
      spin.push(r.spin);
    }
    // Wheel-house liner inside the arch cut-out, and a black plastic flare round its edge.
    const arch = new THREE.Mesh(new THREE.CylinderGeometry(0.69, 0.69, 0.5, 24, 1, true, -0.15, Math.PI + 0.3), ARCH);
    arch.rotation.z = Math.PI / 2;
    arch.position.set(side * 0.98, 0.52, WHEELBASE);
    cab.add(arch);
    const flare = new THREE.Mesh(new THREE.TorusGeometry(0.71, 0.06, 8, 28, Math.PI * 0.86), MAT.plastic);
    flare.rotation.set(0, side * Math.PI / 2, Math.PI * 0.07);
    flare.scale.set(1, 1, 0.6);
    flare.position.set(side * 1.25, 0.52, WHEELBASE);
    cab.add(flare);
  }

  // --- cab: a sculpted, lofted shell (see cab.ts) with real window openings
  // The shell starts low (0.95 m) so the body wraps round the front wheel arches; y0 is the
  // old floor line that the fittings below are placed from.
  const W = 2.5, y0 = 1.25, H = [2.6, 2.85, 3.0][M], zBack = 2.9;
  const built = buildCab({ y0: 0.95, H: H + 0.3, zBack, model: M }, lod);
  const shape = built.shape;
  const panel = panelTextures(shape, TRUCK_MODELS[M].name);
  const shellMat = shellPaint(look.color, panel, lod);
  // Plain paint (no panel texture) for small body-coloured parts.
  const bodyPlain = paint(look.color, 0.45, 0.26);
  const shell = new THREE.Mesh(built.shell, shellMat);
  cab.add(shell);
  const zf = (y: number, x = 0) => shape.frontZ(x, y);
  const front = (w: number, h: number, mat: THREE.Material, x: number, y: number, out: number, depth = 0.02) => {
    const m = box(w, h, depth, mat, x, y, zf(y, x) + out, cab);
    m.rotation.x = shape.frontTilt(y);
    return m;
  };
  const glassMat = opts.interior ? MAT.glassCab : MAT.glass;
  const ws = new THREE.Mesh(built.windscreen, glassMat);
  cab.add(ws);
  const glass: THREE.Mesh[] = [ws];
  for (const g of built.sides) { const sw = new THREE.Mesh(g, glassMat); cab.add(sw); glass.push(sw); }
  const wsY0 = shape.yAt(shape.win.t0), wsY1 = shape.yAt(shape.win.t1);
  // Grille: honeycomb backing set into the nose, with model-specific brightwork.
  const grille = new THREE.MeshStandardMaterial({ map: grilleTexture(), roughness: 0.5, metalness: 0.4 });
  const gY = y0 + 0.62, gH = 0.74;
  front(1.66, gH, grille, 0, gY, 0.004);
  if (M === 0) for (let k = 0; k < 4; k++) front(1.58, 0.05, MAT.chrome, 0, gY - 0.27 + k * 0.18, 0.03, 0.03);
  else if (M === 1) { for (let k = 0; k < 9; k++) front(0.045, gH - 0.08, MAT.chrome, -0.72 + k * 0.18, gY, 0.03, 0.03); front(1.72, 0.06, MAT.chrome, 0, gY + gH / 2, 0.03, 0.035); }
  else {
    for (const dy of [-gH / 2, gH / 2]) front(1.78, 0.07, MAT.chrome, 0, gY + dy, 0.035, 0.045);
    for (const dx of [-0.87, 0.87]) front(0.07, gH + 0.07, MAT.chrome, dx, gY, 0.035, 0.045);
    for (let k = 0; k < 5; k++) front(1.68, 0.035, MAT.chrome, 0, gY - 0.26 + k * 0.13, 0.03, 0.03);
  }
  // Bumper: moulded lower section with a step, fog-light pods and a chin spoiler.
  const bumper = new THREE.Mesh(new RoundedBoxGeometry(2.5, 0.5, 0.46, lod ? 1 : 3, 0.08), MAT.plasticGrey);
  bumper.position.set(0, 1.04, 5.06);
  cab.add(bumper);
  box(2.3, 0.05, 0.05, trim, 0, 1.25, 5.3, cab);
  box(0.74, 0.05, 0.26, MAT.alu, 0, 0.86, 5.22, cab);
  box(2.32, 0.1, 0.34, MAT.plastic, 0, 0.78, 5.12, cab);
  // Sun visor (body colour) with marker lights tucked under it.
  const roofY = y0 + H;
  const visorY = wsY1 + 0.1;
  const visor = new THREE.Mesh(new RoundedBoxGeometry(2.36, 0.07, 0.5, lod ? 1 : 2, 0.03), bodyPlain);
  visor.position.set(0, visorY, zf(visorY) + 0.16);
  visor.rotation.x = 0.08;
  cab.add(visor);
  for (const x of [-0.9, -0.3, 0.3, 0.9]) box(0.1, 0.03, 0.06, lights.marker, x, visorY - 0.05, zf(visorY) + 0.38, cab);
  // Kerb-view mirror over the passenger corner of the windscreen.
  const kArm = cyl(0.018, 0.018, 0.45, MAT.plastic, 8);
  kArm.rotation.x = Math.PI / 2;
  kArm.position.set(-0.85, visorY + 0.02, zf(visorY) + 0.35);
  cab.add(kArm);
  box(0.36, 0.2, 0.08, look.chrome ? MAT.chrome : MAT.plastic, -0.85, visorY - 0.1, zf(visorY) + 0.58, cab);
  box(0.33, 0.17, 0.01, MAT.mirror, -0.85, visorY - 0.1, zf(visorY) + 0.535, cab);
  // Air horns, a roof hatch and a CB aerial on the roof.
  for (const x of [-0.3, 0.3]) {
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.7, 14, 1, true), HORN);
    horn.rotation.x = -Math.PI / 2;
    horn.position.set(x, roofY + 0.07, 3.7);
    cab.add(horn);
  }
  box(0.7, 0.05, 0.7, MAT.plasticGrey, 0, roofY + 0.05, 3.4, cab);
  const aerial = cyl(0.008, 0.012, 1.1, MAT.plastic, 6);
  aerial.position.set(-1.0, roofY + 0.55, 3.1);
  cab.add(aerial);
  // Roof light bar.
  if (look.lightbar) {
    box(2.1, 0.12, 0.18, MAT.plastic, 0, roofY + 0.1, zf(roofY - 0.05) - 0.2, cab);
    for (let k = 0; k < 6; k++) {
      const l = cyl(0.075, 0.075, 0.07, lights.roof, 14);
      l.rotation.x = Math.PI / 2;
      l.position.set(-0.85 + k * 0.34, roofY + 0.1, zf(roofY - 0.05) - 0.09);
      cab.add(l);
    }
  }
  // Windscreen wipers: two arms that sweep when it rains (animated by the rig).
  const wipers: THREE.Group[] = [];
  if (!lod) {
    for (const px of [0.42, -0.62]) {
      const pivot = new THREE.Group();
      const py = wsY0 + 0.05;
      pivot.position.set(px, py, zf(py, px) + 0.03);
      pivot.rotation.x = shape.frontTilt(py);
      const arm = box(0.025, 0.95, 0.02, MAT.plastic, 0, 0.47, 0, pivot);
      void arm;
      box(0.026, 0.9, 0.02, MAT.rubber, 0.018, 0.5, 0.01, pivot);
      cab.add(pivot);
      pivot.rotation.z = Math.PI / 2 - 0.08;
      wipers.push(pivot);
    }
  }
  // Decal and detailing down each side.
  const decal = new THREE.MeshStandardMaterial({ map: cabDecal(TRUCK_MODELS[M].name, look.accent), transparent: true, alphaTest: 0.05, roughness: 0.35, metalness: 0.2, polygonOffset: true, polygonOffsetFactor: -2 });
  for (const side of [1, -1]) {
    const sx = side * (W / 2 + 0.004);
    const dec = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.78), decal);
    dec.position.set(sx, y0 + 0.62, (zBack + DOOR_BACK) / 2 + 0.05);
    dec.rotation.y = side * Math.PI / 2;
    cab.add(dec);
    // Door handle and the chrome trim under the window line.
    box(0.025, 0.05, 0.22, MAT.chrome, side * (W / 2 + 0.01), shape.yAt(0.41), DOOR_BACK + 0.2, cab);
    box(0.015, 0.03, 1.15, trim, side * (W / 2 + 0.008), wsY0 - 0.04, (DOOR_BACK + 5.0) / 2, cab);
    // Aero corner deflector from the windscreen pillar round to the door.
    const dy = y0 + 1.15 + (H - 1.25) / 2;
    const defl = box(0.04, H - 1.25, 0.3, look.model === 0 ? MAT.plastic : accent, side * (W / 2 + 0.03), dy, zf(dy, side * 1.2) - 0.18, cab);
    defl.rotation.x = shape.frontTilt(dy);
    defl.rotation.y = side * 0.3;
    // Rear side extender panels.
    box(0.04, H - 0.5, 0.34, bodyPlain, side * 1.24, y0 + H / 2, 2.78, cab);
    // Entry steps, recessed into the cab corner ahead of the wheel.
    box(0.08, 0.75, 0.42, MAT.plastic, side * 1.2, 0.85, 4.82, cab);
    for (const y of [0.58, 0.95]) box(0.3, 0.04, 0.4, CHECKER, side * 1.12, y, 4.82, cab);
    // Mirrors: main and wide-angle, on a two-piece arm.
    const winY = (wsY0 + wsY1) / 2 + 0.02;
    const mBody = look.chrome ? MAT.chrome : bodyPlain;
    const arm = cyl(0.025, 0.025, 0.46, MAT.plastic, 8);
    arm.rotation.z = Math.PI / 2;
    arm.position.set(side * 1.44, winY + 0.32, 5.0);
    cab.add(arm);
    const arm2 = cyl(0.022, 0.022, 0.9, MAT.plastic, 8);
    arm2.position.set(side * 1.62, winY - 0.1, 5.0);
    cab.add(arm2);
    const mh = new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.62, 0.12, lod ? 1 : 2, 0.04), mBody);
    mh.position.set(side * 1.66, winY + 0.05, 4.95);
    cab.add(mh);
    box(0.18, 0.58, 0.01, MAT.mirror, side * 1.66, winY + 0.05, 4.886, cab);
    const mh2 = new THREE.Mesh(new RoundedBoxGeometry(0.17, 0.3, 0.12, lod ? 1 : 2, 0.03), mBody);
    mh2.position.set(side * 1.62, winY - 0.45, 4.98);
    cab.add(mh2);
    box(0.15, 0.25, 0.01, MAT.mirror, side * 1.62, winY - 0.45, 4.915, cab);
    // Headlight cluster: a recessed housing, clear lens, chrome reflector bowls with
    // projectors, an LED running-light strip and the indicator.
    const hy = y0 + 0.33, hx = side * 0.87;
    front(0.6, 0.3, MAT.plastic, hx, hy, 0.0, 0.06);
    for (const dx of [-0.13, 0.11]) {
      const bowl = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), MAT.chrome);
      bowl.rotation.x = Math.PI / 2 + shape.frontTilt(hy);
      bowl.position.set(hx + side * dx, hy - 0.01, zf(hy, hx) + 0.06);
      bowl.scale.set(1, 0.5, 1);
      cab.add(bowl);
      const proj = cyl(0.05, 0.05, 0.03, lights.head, 16);
      proj.rotation.x = Math.PI / 2 + shape.frontTilt(hy);
      proj.position.set(hx + side * dx, hy - 0.01, zf(hy, hx) + 0.075);
      cab.add(proj);
    }
    front(0.52, 0.025, lights.drl, hx, hy + 0.115, 0.06);
    front(0.025, 0.2, lights.drl, side * 1.16, hy + 0.005, 0.05);
    front(0.08, 0.16, side > 0 ? lights.indL : lights.indR, side * 1.09, hy - 0.03, 0.06);
    const lens = front(0.6, 0.3, LENS, hx, hy, 0.1, 0.01);
    void lens;
    const fog = cyl(0.07, 0.07, 0.04, lights.head, 16);
    fog.rotation.x = Math.PI / 2;
    fog.position.set(side * 0.95, 1.05, 5.3);
    cab.add(fog);
  }
  if (opts.plate) {
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.115), new THREE.MeshStandardMaterial({ map: plateTexture(opts.plate), roughness: 0.4 }));
    plate.position.set(0, 1.0, 5.295);
    cab.add(plate);
  }

  // --- interior (only seen from the driver's seat): see interior.ts
  let steeringWheel = new THREE.Group();
  let dashScreen: THREE.Mesh | null = null;
  let gpsScreen: THREE.Mesh | null = null;
  let eye = new THREE.Vector3(0.62, 2.98, 3.98);
  if (opts.interior) {
    const inner = buildInterior(shape, built.shell, { floor: 1.36 });
    cab.add(inner.group);
    ({ steeringWheel, dashScreen, gpsScreen, eye } = inner);
  }
  const headlightAnchor = new THREE.Object3D();
  headlightAnchor.position.set(0, 1.55, 5.35);
  cab.add(headlightAnchor);

  const keep: THREE.Object3D[] = [steeringWheel, headlightAnchor, ...wipers];
  if (dashScreen) keep.push(dashScreen);
  if (gpsScreen) keep.push(gpsScreen);
  for (const g of glass) keep.push(g);
  mergeStatic(cab, keep);
  mergeStatic(chassis);
  const exterior: THREE.Object3D[] = [];
  cab.traverse((o) => { if (o instanceof THREE.Mesh && o.material === BORDER) exterior.push(o); });
  const cabDetail: THREE.Object3D[] = [];
  cab.traverse((o) => { if (o instanceof THREE.Mesh && isInteriorDetail(o.material)) cabDetail.push(o); });
  // The cab interior sits in the shell's shadow already, so it never casts one.
  root.traverse((o) => { if (o instanceof THREE.Mesh) { o.castShadow = !o.userData.noShadow && !insideMat(o.material); o.receiveShadow = true; } });
  for (const g of glass) g.castShadow = false;
  return { root, cab, steer, spin, steeringWheel, exhaustTip, glass, dashScreen, gpsScreen, lights, headlightAnchor, paintMat: shellMat, model: look.model, exterior, wipers, cabDetail,
    fit: {
      pivot: new THREE.Vector3(0, 1.25, 3.9),
      eye,
      head: new THREE.Vector3(0.86, 1.55, 5.35),
      mirror: new THREE.Vector3(1.66, (wsY0 + wsY1) / 2 + 0.07, 4.95),
      mirrorSize: [0.18, 0.58],
    },
  };
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
      const w = wheel(0.53, 0.38, side, MAT.rim, true, !opts.lod);
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

  // Conspicuity tape: red and white round the rear, yellow dashes along the sides.
  if (!opts.lod) {
    const tapeTop = kind === 'container' ? deckY + 2.5 : kind === 'tanker' ? 1.5 : topY - 0.08;
    const tapeW = kind === 'tanker' ? 2.2 : 2.48;
    for (let x = -tapeW / 2 + 0.12, k = 0; x < tapeW / 2; x += 0.25, k++) {
      box(0.22, 0.05, 0.01, k % 2 ? TAPE_WHITE : TAPE_RED, x, deckY - 0.12, rear - 0.075, root);
      if (kind !== 'tanker') box(0.22, 0.05, 0.01, k % 2 ? TAPE_WHITE : TAPE_RED, x, tapeTop, rear - 0.075, root);
    }
    if (kind !== 'tanker') for (const x of [-1, 1]) for (let y = deckY + 0.1, k = 0; y < tapeTop; y += 0.25, k++) box(0.05, 0.2, 0.01, k % 2 ? TAPE_WHITE : TAPE_RED, x * (tapeW / 2 - 0.03), y, rear - 0.075, root);
    for (const side of [1, -1]) for (let z = rear + 0.6; z < front - 0.6; z += 0.75) box(0.01, 0.05, 0.4, TAPE_YELLOW, side * (kind === 'tanker' ? 1.22 : 1.29), deckY - 0.12, z, root);
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
  root.traverse((o) => { if (o instanceof THREE.Mesh) { o.castShadow = !o.userData.noShadow && (!opts.lod || o.geometry.attributes.position.count > 100); o.receiveShadow = true; } });
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

/** A plausible look for an AI truck. */
export function aiTruckLook(i: number): TruckLook {
  // Mostly long-noses, with a few European cab-overs.
  const model = [3, 4, 0, 3, 1, 4, 3, 2][i % 8];
  const conv = TRUCK_MODELS[model].style === 'conventional';
  return { model, color: truckPaintFor(i), accent: [0xf2f2f2, 0x111214, 0xffb020][i % 3], chrome: i % 2 === 0 || model === 4, lightbar: !conv && i % 3 === 2 };
}

export { CONTAINER_COLORS };
