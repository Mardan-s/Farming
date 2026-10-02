import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ANIMAL_DEFS, buildingDepth, feedPoint, penYard, type AnimalKind, type Pen } from '../game/animals';
import { box, buildShed, mergeLocal } from './models';
import { blob } from './scenery';

// Animals and their pens. Each animal type is one merged, vertex-colored geometry drawn with an
// InstancedMesh per pen; every animal wanders, grazes or pecks, crowds the trough when hungry and
// lies down at night.

// ---------- animal geometry ----------

/** Paints a geometry one color (as a vertex color attribute) so it can be merged with others. */
function tint(geo: THREE.BufferGeometry, color: number) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  const c = new THREE.Color(color);
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}
const at = (geo: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
  geo.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1)));

function cowGeo() {
  const W = 0xf4f1ea, B = 0x1d1d1d, P = 0xe8a0a0, H = 0x2a2a2a;
  const parts = [
    tint(at(new RoundedBoxGeometry(0.72, 0.36, 0.34, 2, 0.1), 0, 0.5, 0), W),
    tint(at(new THREE.SphereGeometry(0.12, 8, 6).scale(1.3, 0.8, 0.35), 0.08, 0.6, 0.16), B),
    tint(at(new THREE.SphereGeometry(0.1, 8, 6).scale(1.2, 0.9, 0.35), -0.2, 0.48, -0.16), B),
    tint(at(new THREE.SphereGeometry(0.09, 8, 6).scale(1, 0.4, 1), -0.12, 0.69, 0), B),
    tint(at(new THREE.SphereGeometry(0.07, 8, 6), -0.2, 0.3, 0), P), // udder
    tint(at(new RoundedBoxGeometry(0.16, 0.16, 0.2, 2, 0.04), 0.42, 0.66, 0, 0, 0, -0.4), W), // neck
    tint(at(new RoundedBoxGeometry(0.2, 0.16, 0.16, 2, 0.05), 0.54, 0.62, 0, 0, 0, -0.3), W), // head
    tint(at(new RoundedBoxGeometry(0.08, 0.1, 0.13, 1, 0.03), 0.65, 0.57, 0, 0, 0, -0.3), P), // muzzle
    tint(at(new THREE.ConeGeometry(0.02, 0.07, 5), 0.5, 0.74, 0.07, 0.4, 0, 0), 0xe8dcc0),
    tint(at(new THREE.ConeGeometry(0.02, 0.07, 5), 0.5, 0.74, -0.07, -0.4, 0, 0), 0xe8dcc0),
    tint(at(new THREE.BoxGeometry(0.03, 0.06, 0.1), 0.48, 0.69, 0.11, 0.6, 0, 0), W),
    tint(at(new THREE.BoxGeometry(0.03, 0.06, 0.1), 0.48, 0.69, -0.11, -0.6, 0, 0), W),
    tint(at(new THREE.BoxGeometry(0.02, 0.3, 0.02), -0.37, 0.5, 0, 0, 0, -0.15), W), // tail
    tint(at(new THREE.SphereGeometry(0.03, 6, 4), -0.39, 0.35, 0), B),
  ];
  for (const [x, z] of [[0.25, 0.11], [0.25, -0.11], [-0.25, 0.11], [-0.25, -0.11]]) {
    parts.push(tint(at(new THREE.BoxGeometry(0.08, 0.28, 0.08), x, 0.2, z), W));
    parts.push(tint(at(new THREE.BoxGeometry(0.085, 0.06, 0.085), x, 0.03, z), H));
  }
  return mergeGeometries(parts)!;
}

function pigGeo() {
  const P = 0xf2b3a8, D = 0xd98b80;
  const parts = [
    tint(at(new THREE.CapsuleGeometry(0.15, 0.32, 4, 10).rotateZ(Math.PI / 2), 0, 0.27, 0), P),
    tint(at(new THREE.SphereGeometry(0.13, 10, 8), 0.27, 0.3, 0), P),
    tint(at(new THREE.CylinderGeometry(0.06, 0.065, 0.06, 10).rotateZ(Math.PI / 2), 0.4, 0.28, 0), D),
    tint(at(new THREE.SphereGeometry(0.012, 4, 3), 0.43, 0.29, 0.025), 0x5a2a28),
    tint(at(new THREE.SphereGeometry(0.012, 4, 3), 0.43, 0.29, -0.025), 0x5a2a28),
    tint(at(new THREE.ConeGeometry(0.05, 0.08, 3), 0.28, 0.42, 0.07, 0.3, 0, -0.3), D),
    tint(at(new THREE.ConeGeometry(0.05, 0.08, 3), 0.28, 0.42, -0.07, -0.3, 0, -0.3), D),
    tint(at(new THREE.TorusGeometry(0.03, 0.01, 4, 10, Math.PI * 1.6), -0.33, 0.33, 0, 0, Math.PI / 2, 0), D),
  ];
  for (const [x, z] of [[0.15, 0.08], [0.15, -0.08], [-0.15, 0.08], [-0.15, -0.08]]) parts.push(tint(at(new THREE.BoxGeometry(0.06, 0.14, 0.06), x, 0.07, z), D));
  return mergeGeometries(parts)!;
}

function sheepGeo() {
  const W = 0xf1ece0, F = 0x2c2a28;
  const parts: THREE.BufferGeometry[] = [];
  for (const [x, y, z, r] of [[0, 0.42, 0, 0.2], [0.15, 0.44, 0.04, 0.16], [-0.15, 0.42, -0.03, 0.17], [0.02, 0.5, -0.08, 0.15], [-0.05, 0.5, 0.09, 0.15], [0.1, 0.36, -0.1, 0.14]]) {
    parts.push(tint(at(new THREE.IcosahedronGeometry(r, 1), x, y, z), W));
  }
  parts.push(tint(at(new RoundedBoxGeometry(0.15, 0.14, 0.12, 2, 0.04), 0.32, 0.5, 0, 0, 0, -0.3), F));
  parts.push(tint(at(new THREE.BoxGeometry(0.03, 0.04, 0.09), 0.3, 0.55, 0.09, 0.5, 0, 0), F));
  parts.push(tint(at(new THREE.BoxGeometry(0.03, 0.04, 0.09), 0.3, 0.55, -0.09, -0.5, 0, 0), F));
  for (const [x, z] of [[0.13, 0.08], [0.13, -0.08], [-0.13, 0.08], [-0.13, -0.08]]) parts.push(tint(at(new THREE.BoxGeometry(0.04, 0.26, 0.04), x, 0.13, z), F));
  return mergeGeometries(parts)!;
}

function chickenGeo() {
  const W = 0xf6f2e8, R = 0xd63a2a, Y = 0xf0b030;
  const parts = [
    tint(at(new THREE.SphereGeometry(0.09, 10, 8).scale(1.25, 1, 0.95), 0, 0.15, 0), W),
    tint(at(new THREE.ConeGeometry(0.06, 0.12, 6), -0.11, 0.2, 0, 0, 0, 0.9), W), // tail
    tint(at(new THREE.SphereGeometry(0.055, 8, 6), 0.09, 0.25, 0), W),
    tint(at(new THREE.BoxGeometry(0.06, 0.04, 0.012), 0.09, 0.3, 0), R), // comb
    tint(at(new THREE.BoxGeometry(0.02, 0.03, 0.01), 0.13, 0.22, 0), R), // wattle
    tint(at(new THREE.ConeGeometry(0.015, 0.04, 4), 0.15, 0.25, 0, 0, 0, -Math.PI / 2), Y),
    tint(at(new THREE.BoxGeometry(0.012, 0.08, 0.012), 0.01, 0.04, 0.03), Y),
    tint(at(new THREE.BoxGeometry(0.012, 0.08, 0.012), 0.01, 0.04, -0.03), Y),
  ];
  return mergeGeometries(parts)!;
}

const GEO: Partial<Record<AnimalKind, THREE.BufferGeometry>> = {};
function animalGeo(kind: AnimalKind) {
  GEO[kind] ??= kind === 'cow' ? cowGeo() : kind === 'pig' ? pigGeo() : kind === 'sheep' ? sheepGeo() : chickenGeo();
  return GEO[kind]!;
}

/** Coat variations per animal type (multiplied with the vertex colors). */
const COATS: Record<AnimalKind, number[]> = {
  cow: [0xffffff, 0xffffff, 0xb07850, 0x8a5a3a, 0xffffff],
  pig: [0xffffff, 0xf4e4dc, 0xe8cfc4],
  sheep: [0xffffff, 0xf0e6d0, 0xe8dcc0, 0x6a625a],
  chicken: [0xffffff, 0xffffff, 0xc87a3a, 0x9a5a2a, 0x3a3230],
};
const SPEED: Record<AnimalKind, number> = { cow: 0.32, pig: 0.38, sheep: 0.34, chicken: 0.55 };
const MAX_SHOWN: Record<AnimalKind, number> = { cow: 16, pig: 20, sheep: 20, chicken: 44 };

interface Critter { x: number; z: number; h: number; tx: number; tz: number; mode: 'walk' | 'graze' | 'idle'; t: number; phase: number }

// ---------- pens ----------

/** Fences, building, trough and herd for one pen. */
export class PenView {
  readonly group = new THREE.Group();
  readonly herd: THREE.InstancedMesh;
  private feed: THREE.Mesh;
  private critters: Critter[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();

  constructor(readonly pen: Pen) {
    const d = ANIMAL_DEFS[pen.kind];
    const { x, y } = pen;
    const W = d.w, H = d.h;
    const depth = buildingDepth(pen.kind);
    const statics = new THREE.Group();
    // Fence with posts and two rails; a gate gap in the middle of the front.
    const wood = 0x8a6a48;
    const gate = { a: x + W / 2 - 0.9, b: x + W / 2 + 0.9 };
    const rail = (x0: number, z0: number, x1: number, z1: number) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      for (const hy of [0.32, 0.58]) {
        const r = box(statics, len, 0.05, 0.04, wood, (x0 + x1) / 2, hy, (z0 + z1) / 2);
        r.rotation.y = -Math.atan2(z1 - z0, x1 - x0);
      }
      for (let t = 0; t <= len + 0.01; t += 1.2) box(statics, 0.08, 0.72, 0.08, 0x6b4f34, x0 + (x1 - x0) * (t / len), 0.36, z0 + (z1 - z0) * (t / len));
    };
    rail(x + 0.1, y + 0.1, x + W - 0.1, y + 0.1);
    rail(x + 0.1, y + 0.1, x + 0.1, y + H - 0.1);
    rail(x + W - 0.1, y + 0.1, x + W - 0.1, y + H - 0.1);
    rail(x + 0.1, y + H - 0.1, gate.a, y + H - 0.1);
    rail(gate.b, y + H - 0.1, x + W - 0.1, y + H - 0.1);
    // Gate: a white five-bar gate standing open against the fence.
    for (let i = 0; i < 4; i++) box(statics, 0.04, 0.04, 1.6, 0xeeeae0, gate.a, 0.2 + i * 0.15, y + H - 0.1 - 0.85);
    // Building along the back.
    let building: THREE.Object3D;
    if (pen.kind === 'cow') {
      building = buildShed(W - 1.2, depth, 0xa6463a, 0x5d656b);
      building.scale.y = 1.35;
    } else if (pen.kind === 'pig') {
      building = buildShed(W - 1.4, depth, 0xc9b9a6, 0x8a3b30);
      building.scale.y = 0.75;
    } else if (pen.kind === 'chicken') {
      building = buildShed(3.2, depth, 0xb8463a, 0x6f7a80);
      building.scale.set(1, 0.8, 1);
      // Ramp up to the pop hole and nest boxes on the side.
      const ramp = box(statics, 0.3, 0.03, 0.9, 0x9a7b5a, x + W / 2, 0.22, y + depth + 0.55);
      ramp.rotation.x = -0.45;
      box(statics, 0.6, 0.4, 0.5, 0x8e3a30, x + W / 2 + 2.0, 0.45, y + depth * 0.5);
    } else {
      // Open-fronted shelter: posts and a sloping roof.
      const sh = new THREE.Group();
      const sw = W - 2, sd = depth;
      for (const px of [-sw / 2, 0, sw / 2]) {
        box(sh, 0.1, 1.5, 0.1, 0x6b4f34, px, 0.75, sd / 2 - 0.1);
        box(sh, 0.1, 1.9, 0.1, 0x6b4f34, px, 0.95, -sd / 2 + 0.1);
      }
      box(sh, sw, 1.3, 0.08, 0x8a6a48, 0, 0.85, -sd / 2 + 0.05);
      const roof = box(sh, sw + 0.4, 0.07, sd + 0.4, 0x6f7a80, 0, 1.75, 0);
      roof.rotation.x = 0.14;
      building = sh;
      for (let i = 0; i < 2; i++) box(statics, 0.9, 0.5, 0.55, 0xd8b560, x + 1.4 + i * 1.0, 0.25, y + depth - 0.4); // hay bales
    }
    building.position.set(x + W / 2, 0, y + depth / 2 + 0.15);
    statics.add(building);
    // Trough by the gate, inside the fence.
    const f = feedPoint(pen);
    const tw = Math.min(2.4, W - 3);
    box(statics, tw, 0.28, 0.5, 0x7a7f84, f.x + 1.6, 0.14, y + H - 0.55);
    box(statics, tw - 0.1, 0.04, 0.4, 0x3a3f44, f.x + 1.6, 0.27, y + H - 0.55);
    this.feed = new THREE.Mesh(new THREE.BoxGeometry(tw - 0.14, 1, 0.38), new THREE.MeshLambertMaterial({ color: 0xd9b45a, flatShading: true }));
    this.feed.position.set(f.x + 1.6, 0.25, y + H - 0.55);
    // Pig mud wallow, water trough for the rest.
    if (pen.kind === 'pig') {
      const mud = new THREE.Mesh(new THREE.CircleGeometry(1.2, 18).rotateX(-Math.PI / 2).scale(1.4, 1, 1),
        new THREE.MeshLambertMaterial({ color: 0x4a3420, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      mud.position.set(x + W * 0.3, 0.03, y + H * 0.62);
      this.group.add(mud);
    } else {
      box(statics, 0.9, 0.3, 0.4, 0x5d656b, x + 1.2, 0.15, y + H - 0.6);
      box(statics, 0.8, 0.02, 0.3, 0x4f86b5, x + 1.2, 0.29, y + H - 0.6);
    }
    mergeLocal(statics);
    this.group.add(statics, this.feed);
    const shadow = blob(W - 0.6, depth + 0.8, 0.6);
    shadow.position.set(x + W / 2, 0.035, y + depth / 2 + 0.2);
    this.group.add(shadow);
    // The herd.
    this.herd = new THREE.InstancedMesh(animalGeo(pen.kind), new THREE.MeshLambertMaterial({ vertexColors: true }), MAX_SHOWN[pen.kind]);
    this.herd.castShadow = true;
    this.herd.frustumCulled = false;
    const coats = COATS[pen.kind];
    const c = new THREE.Color();
    const yard = penYard(pen);
    for (let i = 0; i < MAX_SHOWN[pen.kind]; i++) {
      this.herd.setColorAt(i, c.setHex(coats[i % coats.length]));
      const px = yard.x0 + Math.random() * (yard.x1 - yard.x0), pz = yard.y0 + Math.random() * (yard.y1 - yard.y0);
      this.critters.push({ x: px, z: pz, h: Math.random() * 6, tx: px, tz: pz, mode: 'idle', t: Math.random() * 3, phase: Math.random() * 10 });
    }
    this.group.add(this.herd);
  }

  /** Moves the herd: wander and graze by day, bunch at the trough when hungry, lie down at night. */
  update(dt: number, time: number, night: number) {
    const pen = this.pen;
    const d = ANIMAL_DEFS[pen.kind];
    const fill = Math.min(1, pen.food / d.trough);
    this.feed.visible = fill > 0.01;
    this.feed.scale.y = Math.max(0.01, fill * 0.18);
    this.feed.position.y = 0.25 + this.feed.scale.y / 2;
    const n = Math.min(pen.animals, MAX_SHOWN[pen.kind]);
    this.herd.count = n;
    const yard = penYard(pen);
    const hungry = pen.food <= 0;
    const trough = { x: feedPoint(pen).x + 1.6, z: pen.y + d.h - 1.3 };
    const sleepy = night > 0.6;
    const speed = SPEED[pen.kind];
    for (let i = 0; i < n; i++) {
      const a = this.critters[i];
      a.t -= dt;
      if (a.t <= 0) {
        // Pick something new to do.
        const r = Math.random();
        if (sleepy) {
          a.mode = 'idle';
          a.t = 4 + Math.random() * 6;
        } else if (hungry && r < 0.7) {
          a.tx = trough.x + (Math.random() - 0.5) * 2.4;
          a.tz = trough.z - Math.random() * 1.2;
          a.mode = 'walk';
          a.t = 6;
        } else if (r < 0.45) {
          a.tx = yard.x0 + Math.random() * (yard.x1 - yard.x0);
          a.tz = yard.y0 + Math.random() * (yard.y1 - yard.y0);
          a.mode = 'walk';
          a.t = 8;
        } else {
          a.mode = r < 0.85 ? 'graze' : 'idle';
          a.t = 2 + Math.random() * 5;
        }
      }
      let bob = 0, pitch = 0, lie = 0;
      if (a.mode === 'walk') {
        const dx = a.tx - a.x, dz = a.tz - a.z;
        const dd = Math.hypot(dx, dz);
        if (dd < 0.08) { a.mode = 'graze'; a.t = 1 + Math.random() * 3; } else {
          const want = Math.atan2(dz, dx);
          let dh = want - a.h;
          dh = Math.atan2(Math.sin(dh), Math.cos(dh));
          a.h += dh * Math.min(1, dt * 4);
          const step = Math.min(dd, speed * dt);
          a.x += Math.cos(a.h) * step;
          a.z += Math.sin(a.h) * step;
          bob = Math.abs(Math.sin(time * (pen.kind === 'chicken' ? 18 : 9) + a.phase)) * (pen.kind === 'chicken' ? 0.03 : 0.02);
        }
      } else if (a.mode === 'graze') {
        // Heads down: cows and sheep crop the grass, pigs root, chickens peck.
        pitch = pen.kind === 'chicken' ? -0.5 * Math.max(0, Math.sin(time * 9 + a.phase)) ** 3 : -0.12 - 0.04 * Math.sin(time * 1.5 + a.phase);
      }
      if (sleepy) lie = 1;
      this.v.set(a.x, bob - lie * (pen.kind === 'chicken' ? 0.05 : 0.14), a.z);
      this.q.setFromEuler(this.e.set(0, -a.h, pitch, 'YXZ'));
      this.s.set(1, 1 - lie * 0.25, 1);
      this.m.compose(this.v, this.q, this.s);
      this.herd.setMatrixAt(i, this.m);
    }
    this.herd.instanceMatrix.needsUpdate = true;
  }
}

