import * as THREE from 'three';
import { CROPS, CROP_DEFS, MAP_H, MAP_W } from '../game/config';
import { CellState, Weeds, type Field } from '../game/field';

const CAP = MAP_W * MAP_H;
const STAGE_HEIGHT = [0.14, 0.42, 0.78, 1];

/** Tapered ridges running along x across one cell; y spans 0..1 and is scaled per instance. */
function ridges(centers: number[], bottom: number, top: number) {
  const pos: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (const z of centers) {
    const b = bottom / 2, t = top / 2;
    quad([-0.5, 1, z - t], [-0.5, 1, z + t], [0.5, 1, z + t], [0.5, 1, z - t]); // top
    quad([-0.5, 0, z + b], [0.5, 0, z + b], [0.5, 1, z + t], [-0.5, 1, z + t]); // sloped sides
    quad([0.5, 0, z - b], [-0.5, 0, z - b], [-0.5, 1, z - t], [0.5, 1, z - t]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // Darker near the ground so rows read as depth.
  const colors: number[] = [];
  for (let i = 1; i < pos.length; i += 3) {
    const shade = 0.55 + 0.45 * pos[i];
    colors.push(shade, shade, shade);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.computeVertexNormals();
  return g;
}

/** A clump of spiky weeds with purple thistle heads. */
function weedClump() {
  const parts: THREE.BufferGeometry[] = [];
  const spots = [[-0.28, -0.2], [0.22, 0.25], [0.05, -0.3], [-0.15, 0.3], [0.3, -0.05]];
  for (const [x, z] of spots) {
    const cone = new THREE.ConeGeometry(0.1, 1, 5).toNonIndexed();
    cone.translate(x, 0.5, z);
    parts.push(cone);
    const head = new THREE.IcosahedronGeometry(0.07, 0).toNonIndexed();
    head.translate(x, 1.02, z);
    parts.push(head);
  }
  const pos: number[] = [];
  const col: number[] = [];
  parts.forEach((g, k) => {
    const p = g.getAttribute('position');
    const c = k % 2 === 0 ? [0.33, 0.45, 0.2] : [0.62, 0.35, 0.7];
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      col.push(...c);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

class Pool {
  readonly mesh: THREE.InstancedMesh;
  private slotOf = new Int32Array(CAP).fill(-1);
  private keyOf = new Int32Array(CAP).fill(-1);
  private tmp = new THREE.Matrix4();
  private tmpC = new THREE.Color();
  count = 0;

  constructor(geo: THREE.BufferGeometry) {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.mesh = new THREE.InstancedMesh(geo, mat, CAP);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.setColorAt(0, new THREE.Color());
  }

  set(key: number, m: THREE.Matrix4, c: THREE.Color) {
    let s = this.slotOf[key];
    if (s < 0) {
      s = this.count++;
      this.slotOf[key] = s;
      this.keyOf[s] = key;
    }
    this.mesh.setMatrixAt(s, m);
    this.mesh.setColorAt(s, c);
    this.touch();
  }

  remove(key: number) {
    const s = this.slotOf[key];
    if (s < 0) return;
    const last = --this.count;
    if (s !== last) {
      const lastKey = this.keyOf[last];
      this.mesh.getMatrixAt(last, this.tmp);
      this.mesh.getColorAt(last, this.tmpC);
      this.mesh.setMatrixAt(s, this.tmp);
      this.mesh.setColorAt(s, this.tmpC);
      this.keyOf[s] = lastKey;
      this.slotOf[lastKey] = s;
    }
    this.slotOf[key] = -1;
    this.keyOf[last] = -1;
    this.touch();
  }

  private touch() {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

/** Growing crops drawn as instanced 3D rows. */
export class Crops {
  readonly group = new THREE.Group();
  private grain = new Pool(ridges([-0.4, -0.2, 0, 0.2, 0.4], 0.22, 0.15));
  private rows = new Pool(ridges([-1 / 3, 0, 1 / 3], 0.28, 0.1));
  private weeds = new Pool(weedClump());
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private qV = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  private c = new THREE.Color();

  constructor() {
    this.group.add(this.grain.mesh, this.rows.mesh, this.weeds.mesh);
  }

  clear(x: number, y: number) {
    const key = y * MAP_W + x;
    this.grain.remove(key);
    this.rows.remove(key);
    this.weeds.remove(key);
  }

  /** stage: -1 not growing, 0 seeded (flat), 1..3 growing, 4 ripe. */
  update(field: Field, i: number, stage: number) {
    const cell = field.cells[i];
    const key = cell.y * MAP_W + cell.x;
    const hash = ((cell.x * 73856093) ^ (cell.y * 19349663)) >>> 0;
    if (field.state[i] === CellState.Seeded && field.weeds[i] === Weeds.Present) {
      const def = CROP_DEFS[CROPS[field.crop[i]]];
      const h = Math.max(0.28, def.look.height * 0.5) * (0.8 + (hash % 7) / 20);
      this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (hash % 628) / 100);
      this.m.compose(new THREE.Vector3(cell.x + 0.5, 0, cell.y + 0.5), this.q, new THREE.Vector3(1, h, 1));
      this.weeds.set(key, this.m, this.c.setHex(0xffffff));
    } else {
      this.weeds.remove(key);
    }
    if (field.state[i] !== CellState.Seeded || stage < 1) {
      this.grain.remove(key);
      this.rows.remove(key);
      return;
    }
    const def = CROP_DEFS[CROPS[field.crop[i]]];
    const pool = def.look.style === 'grain' ? this.grain : this.rows;
    (pool === this.grain ? this.rows : this.grain).remove(key);
    const jitter = 0.9 + ((hash % 1000) / 1000) * 0.2;
    const h = Math.max(0.04, def.look.height * STAGE_HEIGHT[stage - 1] * jitter);
    this.q.identity();
    if (field.axis === 'v') this.q.copy(this.qV);
    this.m.compose(new THREE.Vector3(cell.x + 0.5, 0, cell.y + 0.5), this.q, new THREE.Vector3(1, h, 1));
    this.c.setHex(def.look.stages[stage - 1]);
    const shade = 0.94 + (((hash >> 10) % 100) / 100) * 0.12;
    this.c.multiplyScalar(shade);
    pool.set(key, this.m, this.c);
  }
}
