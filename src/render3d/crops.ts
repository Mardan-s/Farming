import * as THREE from 'three';
import { CROPS, CROP_DEFS, MAP_H, MAP_W } from '../game/config';
import { CellState, Weeds, type Field } from '../game/field';

// Crops, weeds and meadow grass drawn as individual plants built from leaf
// triangles, instanced per 16x16 map chunk so off-screen chunks are culled.

type PlantType = 'grain' | 'corn' | 'sunflower' | 'bush' | 'canola' | 'weed' | 'grass';

const CHUNK = 16;
const CHUNK_COLS = Math.ceil(MAP_W / CHUNK);
const STAGE_H = [0.2, 0.48, 0.85, 1];
const STAGE_W = [0.45, 0.75, 1, 1];

/** Plants per cell as rows x plants along each row (before quality scaling). */
const LAYOUT: Record<PlantType, { rows: number; along: number; width: number }> = {
  grain: { rows: 3, along: 3, width: 0.8 },
  canola: { rows: 3, along: 3, width: 0.8 },
  corn: { rows: 2, along: 3, width: 1.05 },
  sunflower: { rows: 2, along: 2, width: 1.0 },
  bush: { rows: 2, along: 2, width: 1.05 },
  weed: { rows: 1, along: 2, width: 0.7 },
  grass: { rows: 1, along: 2, width: 0.9 },
};

function hash(x: number, y: number, k = 0) {
  let h = (x * 374761393 + y * 668265263 + k * 2147483647) >>> 0;
  h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
  return (h ^ (h >>> 16)) / 4294967296;
}

// ---------- geometry ----------

class Builder {
  pos: number[] = [];
  col: number[] = [];
  head: number[] = [];
  private rnd: () => number;
  constructor(seed: number) {
    let s = seed;
    this.rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  }
  r(a = 0, b = 1) { return a + this.rnd() * (b - a); }
  tri(a: number[], b: number[], c: number[], head = 0) {
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      const shade = 0.5 + 0.5 * Math.min(1, p[1] / 0.9);
      this.col.push(shade, shade, shade);
      this.head.push(head);
    }
  }
  quad(a: number[], b: number[], c: number[], d: number[], head = 0) { this.tri(a, b, c, head); this.tri(a, c, d, head); }
  /** A tapering leaf blade from (x,z) at height y0, leaning outwards. */
  blade(x: number, z: number, y0: number, len: number, w: number, lean: number, ang: number, head = 0) {
    const dx = Math.cos(ang), dz = Math.sin(ang);
    const px = -dz * w / 2, pz = dx * w / 2;
    const mid = [x + dx * lean * 0.5, y0 + len * 0.6, z + dz * lean * 0.5];
    const tip = [x + dx * lean, y0 + len, z + dz * lean];
    this.tri([x - px, y0, z - pz], [x + px, y0, z + pz], mid, head);
    this.tri([x - px * 0.6 + mid[0] - x, mid[1], z - pz * 0.6 + mid[2] - z], [x + px * 0.6 + mid[0] - x, mid[1], z + pz * 0.6 + mid[2] - z], tip, head);
    this.tri([x - px, y0, z - pz], mid, [x - px * 0.6 + mid[0] - x, mid[1], z - pz * 0.6 + mid[2] - z], head);
  }
  /** A flat leaf (diamond) at a point, pointing along ang and tilted up by tilt. */
  leaf(x: number, y: number, z: number, len: number, w: number, ang: number, tilt: number, head = 0) {
    const dx = Math.cos(ang) * Math.cos(tilt), dy = Math.sin(tilt), dz = Math.sin(ang) * Math.cos(tilt);
    const px = -Math.sin(ang) * w / 2, pz = Math.cos(ang) * w / 2;
    const base = [x, y, z];
    const tip = [x + dx * len, y + dy * len, z + dz * len];
    const m1 = [x + dx * len * 0.45 + px, y + dy * len * 0.45 + 0.02, z + dz * len * 0.45 + pz];
    const m2 = [x + dx * len * 0.45 - px, y + dy * len * 0.45 + 0.02, z + dz * len * 0.45 - pz];
    this.quad(base, m1, tip, m2, head);
  }
  /** Two crossed thin quads: a stem. */
  stem(x: number, z: number, y0: number, y1: number, w: number, head = 0) {
    this.quad([x - w, y0, z], [x + w, y0, z], [x + w, y1, z], [x - w, y1, z], head);
    this.quad([x, y0, z - w], [x, y0, z + w], [x, y1, z + w], [x, y1, z - w], head);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('head', new THREE.Float32BufferAttribute(this.head, 1));
    // Foliage lit mostly from above so thin leaves don't turn black from behind.
    const n = new Float32Array(this.pos.length);
    for (let i = 0; i < n.length; i += 3) { n[i] = 0; n[i + 1] = 1; n[i + 2] = 0; }
    g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    return g;
  }
}

function plantGeometry(type: PlantType): THREE.BufferGeometry {
  const b = new Builder(7 + type.length * 31);
  const TAU = Math.PI * 2;
  switch (type) {
    case 'grain':
      for (let i = 0; i < 5; i++) b.blade(b.r(-0.12, 0.12), b.r(-0.12, 0.12), 0, b.r(0.4, 0.65), 0.06, b.r(0.15, 0.3), b.r(0, TAU));
      for (let i = 0; i < 7; i++) {
        const x = b.r(-0.16, 0.16), z = b.r(-0.16, 0.16), top = b.r(0.82, 1), lean = b.r(0, 0.08), ang = b.r(0, TAU);
        const tx = x + Math.cos(ang) * lean, tz = z + Math.sin(ang) * lean;
        b.tri([x - 0.012, 0, z], [x + 0.012, 0, z], [tx, top - 0.18, tz]); // stalk
        b.leaf(tx, top - 0.2, tz, 0.22, 0.06, ang, 1.25, 1); // ear
      }
      break;
    case 'canola':
      for (let i = 0; i < 5; i++) b.leaf(0, b.r(0.05, 0.3), 0, b.r(0.28, 0.4), 0.2, b.r(0, TAU), b.r(0.1, 0.5));
      for (let i = 0; i < 5; i++) {
        const x = b.r(-0.15, 0.15), z = b.r(-0.15, 0.15), top = b.r(0.82, 1);
        b.tri([x - 0.015, 0, z], [x + 0.015, 0, z], [x, top, z]);
        for (let k = 0; k < 3; k++) b.leaf(x, top - k * 0.05, z, 0.12, 0.12, b.r(0, TAU), b.r(0, 0.6), 1); // flower clusters
      }
      break;
    case 'corn': {
      b.stem(0, 0, 0, 0.92, 0.035);
      for (let i = 0; i < 7; i++) {
        const y = 0.18 + i * 0.1, ang = i * 2.4;
        b.blade(0, 0, y, b.r(0.28, 0.4), 0.09, b.r(0.3, 0.45), ang);
      }
      for (let i = 0; i < 4; i++) b.blade(0, 0, 0.9, 0.18, 0.03, 0.08, i * 1.6, 1); // tassel
      b.stem(0.05, 0, 0.45, 0.62, 0.04, 1); // cob
      break;
    }
    case 'sunflower': {
      b.stem(0, 0, 0, 0.9, 0.03);
      for (let i = 0; i < 6; i++) b.leaf(0, 0.2 + i * 0.1, 0, b.r(0.22, 0.3), 0.2, i * 2.2, b.r(-0.1, 0.3));
      // Flower head: a disc facing sideways.
      const cx = 0.06, cy = 0.95, r = 0.16, seg = 10;
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * TAU, a1 = ((i + 1) / seg) * TAU;
        b.tri([cx, cy, 0], [cx, cy + Math.sin(a0) * r, Math.cos(a0) * r], [cx, cy + Math.sin(a1) * r, Math.cos(a1) * r], 1);
      }
      break;
    }
    case 'bush':
      for (let i = 0; i < 12; i++) {
        const ang = b.r(0, TAU), y = b.r(0.1, 0.55);
        b.leaf(b.r(-0.05, 0.05), y, b.r(-0.05, 0.05), b.r(0.32, 0.5), 0.3, ang, b.r(0.1, 0.8));
      }
      for (let i = 0; i < 5; i++) b.leaf(b.r(-0.15, 0.15), b.r(0.85, 1), b.r(-0.15, 0.15), 0.07, 0.07, b.r(0, TAU), 0.3, 1); // flowers
      break;
    case 'weed':
      for (let i = 0; i < 7; i++) b.blade(b.r(-0.1, 0.1), b.r(-0.1, 0.1), 0, b.r(0.5, 0.8), 0.09, b.r(0.15, 0.35), b.r(0, TAU));
      for (let i = 0; i < 3; i++) {
        const x = b.r(-0.12, 0.12), z = b.r(-0.12, 0.12), top = b.r(0.85, 1);
        b.stem(x, z, 0, top, 0.015);
        b.stem(x, z, top - 0.08, top + 0.04, 0.05, 1);
      }
      break;
    case 'grass':
      for (let i = 0; i < 10; i++) b.blade(b.r(-0.18, 0.18), b.r(-0.18, 0.18), 0, b.r(0.55, 1), 0.06, b.r(0.1, 0.3), b.r(0, TAU));
      break;
  }
  return b.build();
}

// ---------- material ----------

const uniforms = { uTime: { value: 0 } };

function plantMaterial(safe: boolean) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  if (safe) return m;
  m.onBeforeCompile = shader => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float head;
        attribute vec3 headColor;
        uniform float uTime;`)
      .replace('#include <color_vertex>', `
        vColor = color;
        #ifdef USE_INSTANCING_COLOR
          vColor *= mix(instanceColor, headColor, head);
        #endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec4 wp = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float h = transformed.y * transformed.y;
          float gust = sin(uTime * 1.3 + wp.x * 0.21 + wp.z * 0.17) * 0.5 + 0.5;
          float sway = sin(uTime * 2.3 + wp.x * 0.9 + wp.z * 0.7) * (0.03 + gust * 0.07);
          transformed.x += sway * h;
          transformed.z += sway * 0.5 * h;
        }`);
    // Keep leaves lit from both sides.
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>',
      THREE.ShaderChunk.normal_fragment_begin.replace(/normal\s*\*=\s*faceDirection;/g, ''));
  };
  return m;
}

// ---------- instanced pools ----------

/** One chunk's plants of one type; each cell owns a block of `k` instances. */
class ChunkPool {
  readonly mesh: THREE.InstancedMesh;
  private headColor: THREE.InstancedBufferAttribute;
  private blockOf = new Map<number, number>();
  private keyOf: number[] = [];
  private m = new THREE.Matrix4();
  private c = new THREE.Color();

  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, readonly k: number, cx: number, cy: number) {
    const cap = CHUNK * CHUNK * k;
    const g = geo.clone();
    this.headColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    g.setAttribute('headColor', this.headColor);
    this.mesh = new THREE.InstancedMesh(g, mat, cap);
    this.mesh.count = 0;
    this.mesh.receiveShadow = true;
    this.mesh.setColorAt(0, new THREE.Color());
    // Cull by chunk: a bounding sphere around the chunk's area.
    const half = CHUNK / 2;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx * CHUNK + half, 0.8, cy * CHUNK + half), half * 1.5 + 1.5);
  }

  set(key: number, matrices: THREE.Matrix4[], stem: number, head: number) {
    let block = this.blockOf.get(key);
    if (block == null) {
      block = this.keyOf.length;
      this.keyOf.push(key);
      this.blockOf.set(key, block);
    }
    for (let j = 0; j < this.k; j++) {
      const idx = block * this.k + j;
      this.mesh.setMatrixAt(idx, matrices[j]);
      this.mesh.setColorAt(idx, this.c.setHex(stem));
      this.c.setHex(head);
      this.headColor.setXYZ(idx, this.c.r, this.c.g, this.c.b);
    }
    this.touch();
  }

  remove(key: number) {
    const block = this.blockOf.get(key);
    if (block == null) return;
    const last = this.keyOf.length - 1;
    if (block !== last) {
      const lastKey = this.keyOf[last];
      for (let j = 0; j < this.k; j++) {
        const from = last * this.k + j, to = block * this.k + j;
        this.mesh.getMatrixAt(from, this.m);
        this.mesh.setMatrixAt(to, this.m);
        this.mesh.getColorAt(from, this.c);
        this.mesh.setColorAt(to, this.c);
        this.headColor.setXYZ(to, this.headColor.getX(from), this.headColor.getY(from), this.headColor.getZ(from));
      }
      this.keyOf[block] = lastKey;
      this.blockOf.set(lastKey, block);
    }
    this.keyOf.pop();
    this.blockOf.delete(key);
    this.touch();
  }

  private touch() {
    this.mesh.count = this.keyOf.length * this.k;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.headColor.needsUpdate = true;
  }
}

export class Crops {
  readonly group = new THREE.Group();
  private material: THREE.MeshLambertMaterial;
  private geos = new Map<PlantType, THREE.BufferGeometry>();
  private pools = new Map<string, ChunkPool>();
  private cropType = new Map<number, PlantType>(); // cell key -> type currently shown
  private weedOn = new Set<number>();
  private grassOn = new Set<number>();
  private tmp: THREE.Matrix4[] = [];
  private q = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);

  constructor(private density: number, private grassDensity: number, safe = false) {
    this.material = plantMaterial(safe);
  }

  tick(time: number) { uniforms.uTime.value = time; }

  private perCell(type: PlantType) {
    const l = LAYOUT[type];
    const along = Math.max(1, Math.round(l.along * (type === 'grass' ? 1 : this.density)));
    return { rows: l.rows, along, k: l.rows * along, width: l.width };
  }

  private pool(type: PlantType, x: number, y: number) {
    const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK);
    const id = `${type}:${cy * CHUNK_COLS + cx}`;
    let p = this.pools.get(id);
    if (!p) {
      let geo = this.geos.get(type);
      if (!geo) { geo = plantGeometry(type); this.geos.set(type, geo); }
      p = new ChunkPool(geo, this.material, this.perCell(type).k, cx, cy);
      this.pools.set(id, p);
      this.group.add(p.mesh);
    }
    return p;
  }

  /** Instance transforms laid out in rows across the cell. */
  private layout(type: PlantType, x: number, y: number, axis: 'h' | 'v', height: number, width: number) {
    const { rows, along, k } = this.perCell(type);
    while (this.tmp.length < k) this.tmp.push(new THREE.Matrix4());
    let n = 0;
    for (let r = 0; r < rows; r++) {
      for (let a = 0; a < along; a++) {
        const jr = (hash(x, y, n * 3 + 1) - 0.5) * 0.12, ja = (hash(x, y, n * 3 + 2) - 0.5) * 0.25;
        const across = (r + 0.5) / rows + (type === 'grass' || type === 'weed' ? (hash(x, y, n + 9) - 0.5) * 0.8 : jr);
        const alongP = (a + 0.5) / along + ja;
        const px = axis === 'h' ? x + alongP : x + across;
        const pz = axis === 'h' ? y + across : y + alongP;
        const s = 0.85 + hash(x, y, n * 5 + 7) * 0.3;
        this.q.setFromAxisAngle(this.up, hash(x, y, n * 7 + 3) * Math.PI * 2);
        this.tmp[n].compose(new THREE.Vector3(px, 0, pz), this.q, new THREE.Vector3(width * s, height * s, width * s));
        n++;
      }
    }
    return this.tmp;
  }

  clear(x: number, y: number) {
    const key = y * MAP_W + x;
    const t = this.cropType.get(key);
    if (t) { this.pool(t, x, y).remove(key); this.cropType.delete(key); }
    if (this.weedOn.delete(key)) this.pool('weed', x, y).remove(key);
  }

  /** stage: -1 not growing, 0 seeded (flat), 1..3 growing, 4 ripe. */
  update(field: Field, i: number, stage: number) {
    const { x, y } = field.cells[i];
    const key = y * MAP_W + x;
    const seeded = field.state[i] === CellState.Seeded;
    this.setGrass(x, y, false);

    if (seeded && field.weeds[i] === Weeds.Present) {
      const def = CROP_DEFS[CROPS[field.crop[i]]];
      const h = Math.max(0.3, def.look.height * 0.55);
      this.pool('weed', x, y).set(key, this.layout('weed', x, y, field.axis, h, LAYOUT.weed.width), 0x55803a, 0xa35bb5);
      this.weedOn.add(key);
    } else if (this.weedOn.delete(key)) {
      this.pool('weed', x, y).remove(key);
    }

    const prev = this.cropType.get(key);
    if (!seeded || stage < 1) {
      if (prev) { this.pool(prev, x, y).remove(key); this.cropType.delete(key); }
      return;
    }
    const def = CROP_DEFS[CROPS[field.crop[i]]];
    const type = def.look.plant as PlantType;
    if (prev && prev !== type) this.pool(prev, x, y).remove(key);
    const s = stage - 1;
    const stem = def.look.stages[s];
    const head = (def.look.heads ?? def.look.stages)[s];
    // Storm-flattened crops lie low and spread out.
    const flat = field.damaged[i] ? 0.35 : 1;
    const mats = this.layout(type, x, y, field.axis, def.look.height * STAGE_H[s] * flat, LAYOUT[type].width * STAGE_W[s] * (field.damaged[i] ? 1.35 : 1));
    this.pool(type, x, y).set(key, mats, stem, head);
    this.cropType.set(key, type);
  }

  /** Meadow grass tufts on open land; `allowed` says whether a cell may have grass. */
  syncGrass(allowed: (x: number, y: number) => boolean) {
    if (this.grassDensity <= 0) return;
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        this.setGrass(x, y, allowed(x, y) && hash(x, y, 99) < this.grassDensity);
      }
    }
  }

  private setGrass(x: number, y: number, on: boolean) {
    const key = y * MAP_W + x;
    if (on === this.grassOn.has(key)) return;
    const pool = this.pool('grass', x, y);
    if (on) {
      const h = 0.22 + hash(x, y, 5) * 0.18;
      const tint = hash(x, y, 6) < 0.5 ? 0x5f9a3e : 0x6fa84a;
      pool.set(key, this.layout('grass', x, y, 'h', h, 0.9), tint, tint);
      this.grassOn.add(key);
    } else {
      pool.remove(key);
      this.grassOn.delete(key);
    }
  }
}
