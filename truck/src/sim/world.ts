import { CARRIAGE_OUT, RAIL_LAT, Road } from './road';
import { clamp, fbm, lerp, mulberry32, noise2, ridged, smoothstep, wrap } from '../util';

// Everything about the map that isn't the road itself: terrain heights, the depots where cargo
// is picked up and delivered, towns, farm fields, lakes, forests and wind turbines. All of it is
// generated from a seed, so every player gets the same countryside.

export const TERRAIN_HALF = 2000;
export const TERRAIN_RES = 320;
export const TERRAIN_CELL = (TERRAIN_HALF * 2) / TERRAIN_RES;

export interface Depot {
  id: number;
  name: string;
  company: string;
  /** Hex colour of the company's branding. */
  color: number;
  s: number;
  /** Half length of the yard along the road. */
  sHalf: number;
  /** How far the yard reaches back from the asphalt edge. */
  depth: number;
  fuel: boolean;
  bayS: number;
  bayLat: number;
}

export type FieldKind = 'wheat' | 'rapeseed' | 'green' | 'plowed' | 'stubble' | 'sunflower';
export interface Field { i0: number; j0: number; i1: number; j1: number; kind: FieldKind; angle: number }
export interface Lake { x: number; z: number; r: number; level: number }
export type BuildingKind = 'house' | 'block' | 'barn' | 'church' | 'warehouse' | 'office';
export interface Building { x: number; z: number; y: number; w: number; d: number; h: number; rot: number; kind: BuildingKind; color: number; roof: number; seed: number }
export interface Tree { x: number; y: number; z: number; s: number; rot: number; kind: 0 | 1 | 2 }
export interface Turbine { x: number; y: number; z: number; rot: number; phase: number }

const DEPOT_DEFS: Omit<Depot, 'id' | 's' | 'bayS' | 'bayLat'>[] = [
  { name: 'Valmont', company: 'Alpina Logistik', color: 0x1f6fd1, sHalf: 46, depth: 48, fuel: true },
  { name: 'Nordhaven', company: 'Nordhaven Port', color: 0xd9342b, sHalf: 50, depth: 52, fuel: false },
  { name: 'Rivabella', company: 'Fresco Foods', color: 0x2e9e4f, sHalf: 44, depth: 46, fuel: true },
  { name: 'Brennwald', company: 'Brennwald Stahl', color: 0xe08a12, sHalf: 46, depth: 48, fuel: false },
  { name: 'Lac Doré', company: 'Doré Chimie', color: 0x7b3fc4, sHalf: 44, depth: 46, fuel: true },
];
const DEPOT_AT = [0.03, 0.22, 0.43, 0.62, 0.81];

export class World {
  readonly road: Road;
  readonly depots: Depot[] = [];
  readonly heights: Float32Array;
  readonly fields: Field[] = [];
  readonly lakes: Lake[] = [];
  readonly buildings: Building[] = [];
  readonly trees: Tree[] = [];
  readonly turbines: Turbine[] = [];
  /** 4 m occupancy grid used while placing things (fields, water, buildings, yards). */
  private occ: Uint8Array;
  private readonly occRes = 1000;

  constructor(readonly seed = 11, treeBudget = 6000) {
    this.road = new Road(seed);
    const L = this.road.length;
    DEPOT_DEFS.forEach((d, id) => {
      const s = DEPOT_AT[id] * L;
      this.depots.push({ ...d, id, s, bayS: s + 6, bayLat: CARRIAGE_OUT + d.depth - 10 });
    });
    this.occ = new Uint8Array(this.occRes * this.occRes);
    this.heights = new Float32Array((TERRAIN_RES + 1) * (TERRAIN_RES + 1));
    const rnd = mulberry32(seed * 7 + 3);
    this.placeLakes(rnd);
    this.buildTerrain();
    this.reserveYards();
    this.placeFields(rnd);
    this.placeTowns(rnd);
    this.placeTurbines(rnd);
    this.placeTrees(rnd, treeBudget);
  }

  // ---------------------------------------------------------------- terrain

  /** Raw countryside height before the road and lakes are cut in. */
  private baseHeight(x: number, z: number) {
    let h = 16 + 36 * fbm(x / 1100, z / 1100, 4, this.seed) + 9 * fbm(x / 260, z / 260, 3, this.seed + 5);
    const r = Math.max(Math.abs(x), Math.abs(z)) / TERRAIN_HALF;
    h += smoothstep(0.72, 1.0, r) * (90 + 180 * ridged(x / 520, z / 520, 4, this.seed + 9));
    return h;
  }

  /** Distance from the paved surface (asphalt or a depot yard), and the road height there. */
  private pavedDistance(x: number, z: number): { e: number; y: number } | null {
    const hit = this.road.locate(x, z);
    if (!hit) return null;
    let e = Math.max(0, Math.abs(hit.lat) - CARRIAGE_OUT);
    for (const d of this.depots) {
      const ds = Math.max(0, Math.abs(this.road.delta(d.s, hit.s)) - d.sHalf);
      if (ds > 120) continue;
      const dl = hit.lat < CARRIAGE_OUT ? (hit.lat < 0 ? 999 : 0) : Math.max(0, hit.lat - CARRIAGE_OUT - d.depth);
      e = Math.min(e, Math.hypot(ds, dl));
    }
    return { e, y: hit.y };
  }

  private buildTerrain() {
    const R = TERRAIN_RES;
    for (let j = 0; j <= R; j++) {
      for (let i = 0; i <= R; i++) {
        const x = -TERRAIN_HALF + i * TERRAIN_CELL, z = -TERRAIN_HALF + j * TERRAIN_CELL;
        let h = this.baseHeight(x, z);
        for (const lk of this.lakes) {
          const d = Math.hypot(x - lk.x, z - lk.z);
          if (d > lk.r * 1.7) continue;
          const a = Math.atan2(z - lk.z, x - lk.x);
          const re = lk.r * (1 + 0.22 * noise2(Math.cos(a) * 2 + lk.x, Math.sin(a) * 2, 3));
          if (d < re) h = lk.level - 0.4 - 5 * (1 - (d / re) ** 2);
          else h = lerp(Math.max(h, lk.level + 0.35), h, smoothstep(re * 1.08, re * 1.6, d));
        }
        const p = this.pavedDistance(x, z);
        if (p) h = lerp(p.y - 0.45, h, smoothstep(12, 62, p.e));
        this.heights[j * (R + 1) + i] = h;
      }
    }
  }

  /** Terrain mesh height, matching the triangle split used by the renderer exactly. */
  terrainHeight(x: number, z: number) {
    const R = TERRAIN_RES;
    const gx = clamp((x + TERRAIN_HALF) / TERRAIN_CELL, 0, R - 1e-4);
    const gz = clamp((z + TERRAIN_HALF) / TERRAIN_CELL, 0, R - 1e-4);
    const i = Math.floor(gx), j = Math.floor(gz);
    const fx = gx - i, fz = gz - j;
    const H = this.heights, w = R + 1;
    const h00 = H[j * w + i], h10 = H[j * w + i + 1], h01 = H[(j + 1) * w + i], h11 = H[(j + 1) * w + i + 1];
    if (fx > fz) return h00 + (h10 - h00) * fx + (h11 - h10) * fz;
    return h00 + (h11 - h01) * fx + (h01 - h00) * fz;
  }

  /** Is this road-space point inside a depot yard? */
  depotAt(s: number, lat: number): Depot | null {
    if (lat < CARRIAGE_OUT - 0.5) return null;
    for (const d of this.depots) {
      if (Math.abs(this.road.delta(d.s, s)) <= d.sHalf && lat <= CARRIAGE_OUT + d.depth) return d;
    }
    return null;
  }

  /** Height of whatever you'd be driving on: asphalt, a yard, or the grass. */
  groundHeight(x: number, z: number) {
    const hit = this.road.locate(x, z);
    if (hit && (Math.abs(hit.lat) <= CARRIAGE_OUT + 0.4 || this.depotAt(hit.s, hit.lat))) return hit.y;
    return this.terrainHeight(x, z);
  }

  // ---------------------------------------------------------------- placement helpers

  private occIndex(x: number, z: number) {
    const i = Math.floor((x + TERRAIN_HALF) / 4), j = Math.floor((z + TERRAIN_HALF) / 4);
    if (i < 0 || j < 0 || i >= this.occRes || j >= this.occRes) return -1;
    return j * this.occRes + i;
  }
  private occupied(x: number, z: number) {
    const k = this.occIndex(x, z);
    return k < 0 || this.occ[k] !== 0;
  }
  private mark(x0: number, z0: number, x1: number, z1: number, v = 1) {
    for (let z = z0; z <= z1; z += 4) for (let x = x0; x <= x1; x += 4) {
      const k = this.occIndex(x, z);
      if (k >= 0) this.occ[k] = v;
    }
  }
  private markCircle(x: number, z: number, r: number) {
    for (let dz = -r; dz <= r; dz += 4) for (let dx = -r; dx <= r; dx += 4) {
      if (dx * dx + dz * dz <= r * r) this.mark(x + dx, z + dz, x + dx, z + dz);
    }
  }
  /** Distance from the asphalt edge, Infinity if far away. */
  private roadGap(x: number, z: number) {
    const hit = this.road.locate(x, z);
    return hit ? Math.abs(hit.lat) - CARRIAGE_OUT : Infinity;
  }

  private placeLakes(rnd: () => number) {
    let tries = 0;
    while (this.lakes.length < 3 && tries++ < 400) {
      const x = (rnd() * 2 - 1) * TERRAIN_HALF * 0.7, z = (rnd() * 2 - 1) * TERRAIN_HALF * 0.7;
      const r = 70 + rnd() * 90;
      const hit = this.road.locate(x, z);
      if (hit && hit.dist < r + 140) continue;
      if (this.lakes.some((l) => Math.hypot(l.x - x, l.z - z) < l.r + r + 200)) continue;
      const level = this.baseHeight(x, z) + 0.5;
      this.lakes.push({ x, z, r, level });
      this.markCircle(x, z, r * 1.25);
    }
  }

  private placeFields(rnd: () => number) {
    const kinds: FieldKind[] = ['wheat', 'wheat', 'rapeseed', 'green', 'green', 'plowed', 'stubble', 'sunflower'];
    let tries = 0;
    while (this.fields.length < 46 && tries++ < 3000) {
      const wI = 7 + Math.floor(rnd() * 14), wJ = 7 + Math.floor(rnd() * 14);
      const i0 = 20 + Math.floor(rnd() * (TERRAIN_RES - 40 - wI)), j0 = 20 + Math.floor(rnd() * (TERRAIN_RES - 40 - wJ));
      const i1 = i0 + wI, j1 = j0 + wJ;
      const x0 = -TERRAIN_HALF + i0 * TERRAIN_CELL, z0 = -TERRAIN_HALF + j0 * TERRAIN_CELL;
      const x1 = -TERRAIN_HALF + i1 * TERRAIN_CELL, z1 = -TERRAIN_HALF + j1 * TERRAIN_CELL;
      let ok = true, lo = Infinity, hi = -Infinity;
      for (let j = j0; j <= j1 && ok; j++) for (let i = i0; i <= i1; i++) {
        const x = -TERRAIN_HALF + i * TERRAIN_CELL, z = -TERRAIN_HALF + j * TERRAIN_CELL;
        if (this.occupied(x, z) || this.roadGap(x, z) < 26) { ok = false; break; }
        const h = this.heights[j * (TERRAIN_RES + 1) + i];
        lo = Math.min(lo, h); hi = Math.max(hi, h);
      }
      if (!ok || hi - lo > 24) continue;
      this.fields.push({ i0, j0, i1, j1, kind: kinds[Math.floor(rnd() * kinds.length)], angle: rnd() < 0.5 ? 0 : Math.PI / 2 });
      this.mark(x0 - 6, z0 - 6, x1 + 6, z1 + 6, 2);
    }
  }

  private addBuilding(b: Building, pad = 4) {
    const r = Math.hypot(b.w, b.d) / 2 + pad;
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      if (this.occupied(b.x + Math.cos(ang) * r * 0.8, b.z + Math.sin(ang) * r * 0.8)) return false;
    }
    if (this.occupied(b.x, b.z) || this.roadGap(b.x, b.z) < r + 6) return false;
    // Sit the building on the lowest corner so it never floats.
    const c = Math.cos(b.rot), s = Math.sin(b.rot);
    let y = Infinity;
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const px = b.x + (u * b.w * c + v * b.d * s) / 2, pz = b.z + (-u * b.w * s + v * b.d * c) / 2;
      y = Math.min(y, this.terrainHeight(px, pz));
    }
    b.y = y - 0.2;
    this.buildings.push(b);
    this.markCircle(b.x, b.z, r);
    return true;
  }

  /** Yards (and the warehouse behind each) are reserved first so nothing grows inside them. */
  private reserveYards() {
    const p = { x: 0, y: 0, z: 0 };
    for (const d of this.depots) {
      for (let s = -d.sHalf - 8; s <= d.sHalf + 8; s += 3) {
        for (let lat = CARRIAGE_OUT - 2; lat <= CARRIAGE_OUT + d.depth + 40; lat += 3) {
          this.road.toWorld(d.s + s, lat, p);
          this.mark(p.x, p.z, p.x, p.z, 3);
        }
      }
    }
  }

  private placeTowns(rnd: () => number) {
    const road = this.road;
    const p = { x: 0, y: 0, z: 0 };
    const roofs = [0x8e3b2a, 0xa5482f, 0x6d2f25, 0x4a4f57, 0x3b3f45, 0x7a3a2c];
    const walls = [0xefe6d6, 0xe8d8b8, 0xd9c7a3, 0xf2efe8, 0xcfd6d9, 0xe5c9a8, 0xd8b98f, 0xbfc7b5];
    for (const d of this.depots) {
      const t = road.sample(d.s, { x: 0, y: 0, z: 0, tx: 0, tz: 1 });
      const rot = Math.atan2(t.tx, t.tz);
      // The depot warehouse sits right behind the yard fence.
      road.toWorld(d.s, CARRIAGE_OUT + d.depth + 20, p);
      this.forceBuilding({ x: p.x, z: p.z, y: 0, w: 30, d: d.sHalf * 1.7, h: 13, rot, kind: 'warehouse', color: d.color, roof: 0x9aa3ad, seed: d.id });
      // Town: houses spread along the far side of the depot and across the motorway.
      let placed = 0, tries = 0;
      while (placed < 70 && tries++ < 900) {
        const side = rnd() < 0.62 ? 1 : -1;
        const along = (rnd() * 2 - 1) * 330;
        const lat = side * (CARRIAGE_OUT + 34 + rnd() * 250) + (side > 0 ? d.depth : 0);
        road.toWorld(d.s + along, lat, p);
        const dist = Math.abs(lat) + Math.abs(along) * 0.6;
        const big = rnd() < 0.18 && dist < 200;
        const kind: BuildingKind = big ? 'block' : rnd() < 0.08 ? 'barn' : rnd() < 0.05 ? 'office' : 'house';
        const w = kind === 'block' ? 16 + rnd() * 14 : kind === 'barn' ? 14 + rnd() * 8 : kind === 'office' ? 18 : 8 + rnd() * 5;
        const dd = kind === 'block' ? 12 + rnd() * 6 : kind === 'barn' ? 22 + rnd() * 10 : kind === 'office' ? 14 : 8 + rnd() * 4;
        const h = kind === 'block' ? 12 + Math.floor(rnd() * 4) * 3 : kind === 'barn' ? 7 : kind === 'office' ? 15 + rnd() * 10 : 5.5 + rnd() * 2.5;
        const ok = this.addBuilding({
          x: p.x, z: p.z, y: 0, w, d: dd, h, rot: rot + (rnd() < 0.85 ? 0 : Math.PI / 2) + (rnd() - 0.5) * 0.3, kind,
          color: walls[Math.floor(rnd() * walls.length)], roof: roofs[Math.floor(rnd() * roofs.length)], seed: Math.floor(rnd() * 1e6),
        });
        if (ok) placed++;
      }
      // A church spire marks every town.
      for (let k = 0; k < 40; k++) {
        road.toWorld(d.s + (rnd() * 2 - 1) * 200, -(CARRIAGE_OUT + 80 + rnd() * 140), p);
        if (this.addBuilding({ x: p.x, z: p.z, y: 0, w: 9, d: 22, h: 11, rot: rot + rnd() * 0.4, kind: 'church', color: 0xece4d4, roof: 0x5a3b30, seed: k }, 10)) break;
      }
    }
    // Lone farms in the countryside.
    let tries = 0, farms = 0;
    while (farms < 26 && tries++ < 1500) {
      const x = (rnd() * 2 - 1) * TERRAIN_HALF * 0.85, z = (rnd() * 2 - 1) * TERRAIN_HALF * 0.85;
      if (this.roadGap(x, z) < 50) continue;
      const rot = rnd() * Math.PI;
      const ok = this.addBuilding({ x, z, y: 0, w: 10, d: 9, h: 6.5, rot, kind: 'house', color: walls[Math.floor(rnd() * walls.length)], roof: roofs[Math.floor(rnd() * roofs.length)], seed: tries });
      if (!ok) continue;
      farms++;
      const c = Math.cos(rot), s = Math.sin(rot);
      this.addBuilding({ x: x + c * 22, z: z - s * 22, y: 0, w: 14, d: 26, h: 8, rot, kind: 'barn', color: 0x8c4a32, roof: 0x4a4f57, seed: tries }, 2);
    }
  }

  private forceBuilding(b: Building) {
    b.y = this.terrainHeight(b.x, b.z) - 0.3;
    this.buildings.push(b);
  }

  private placeTurbines(rnd: () => number) {
    let tries = 0;
    while (this.turbines.length < 12 && tries++ < 3000) {
      const x = (rnd() * 2 - 1) * TERRAIN_HALF * 0.8, z = (rnd() * 2 - 1) * TERRAIN_HALF * 0.8;
      if (this.roadGap(x, z) < 160 || this.occupied(x, z)) continue;
      const y = this.terrainHeight(x, z);
      if (y < 30) continue;
      if (this.turbines.some((t) => Math.hypot(t.x - x, t.z - z) < 230)) continue;
      this.turbines.push({ x, y, z, rot: 0.6 + (rnd() - 0.5) * 0.2, phase: rnd() * 6.28 });
      this.markCircle(x, z, 14);
    }
  }

  private placeTrees(rnd: () => number, budget: number) {
    const add = (x: number, z: number, kind: 0 | 1 | 2, scale: number) => {
      if (this.trees.length >= budget) return;
      if (this.occupied(x, z)) return;
      const gap = this.roadGap(x, z);
      if (gap < 9) return;
      const r = Math.max(Math.abs(x), Math.abs(z)) / TERRAIN_HALF;
      if (r > 0.97) return;
      this.trees.push({ x, y: this.terrainHeight(x, z), z, s: scale, rot: rnd() * Math.PI * 2, kind });
    };
    // Hedgerows and tree lines along field edges.
    for (const f of this.fields) {
      if (rnd() < 0.35) continue;
      const x0 = -TERRAIN_HALF + f.i0 * TERRAIN_CELL - 9, z0 = -TERRAIN_HALF + f.j0 * TERRAIN_CELL - 9;
      const x1 = -TERRAIN_HALF + f.i1 * TERRAIN_CELL + 9, z1 = -TERRAIN_HALF + f.j1 * TERRAIN_CELL + 9;
      const side = Math.floor(rnd() * 4);
      for (let t = 0; t <= 1; t += 0.03 + rnd() * 0.03) {
        const [x, z] = side === 0 ? [lerp(x0, x1, t), z0] : side === 1 ? [x1, lerp(z0, z1, t)] : side === 2 ? [lerp(x0, x1, t), z1] : [x0, lerp(z0, z1, t)];
        add(x + (rnd() - 0.5) * 3, z + (rnd() - 0.5) * 3, rnd() < 0.8 ? 1 : 2, 0.8 + rnd() * 0.5);
      }
    }
    // Forests where the noise says so, scattered trees elsewhere.
    let guard = 0;
    while (this.trees.length < budget && guard++ < budget * 30) {
      const x = (rnd() * 2 - 1) * TERRAIN_HALF, z = (rnd() * 2 - 1) * TERRAIN_HALF;
      const forest = fbm(x / 520, z / 520, 3, this.seed + 21);
      const h = this.terrainHeight(x, z);
      const conifer = h > 55 || forest > 0.32;
      if (forest > 0.12 || rnd() < 0.025) add(x, z, conifer ? 0 : rnd() < 0.7 ? 1 : 2, 0.75 + rnd() * 0.6);
    }
  }

  /** Where the yard of a depot is, in world space, for the minimap and UI. */
  depotCenter(d: Depot) {
    const p = { x: 0, y: 0, z: 0 };
    return this.road.toWorld(d.s, CARRIAGE_OUT + d.depth / 2, p);
  }

  /** Guard rails run along both outer edges, with gaps at depot entrances. */
  railGap(s: number) {
    for (const d of this.depots) if (Math.abs(this.road.delta(d.s, s)) < d.sHalf - 1) return true;
    return false;
  }

  /** Which s along the loop is closest to a fraction, used for spawning. */
  sAt(frac: number) { return wrap(frac, 1) * this.road.length; }
}

export { RAIL_LAT };
