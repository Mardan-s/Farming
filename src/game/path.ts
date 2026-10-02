import {
  ELEVATOR, MAP_H, MAP_W, PARCEL_COLS, PARCEL_H, PARCEL_ORIGIN, PARCEL_ROWS, PARCEL_W, PUMP, ROAD, SILO_POS, SILO_RADIUS,
  YARD, YARD_GATE,
} from './config';
import type { Pt } from './geometry';
import { inRect, type World } from './world';

// Travel cost per cell. Machines stick to the road and the farmyard, cross open grass when they
// must, and only drive over crops on the field they're heading for.
const COST_ROAD = 1; // center lane
const COST_ROAD_EDGE = 1.4;
const COST_YARD = 1.1;
const COST_GRASS = 3;
const COST_FIELD = 9;
const COST_DEST_FIELD = 2;
const BLOCKED = 255;

/** Static obstacles: buildings, the farmyard fence (except its gate), and the woods around the map. */
function buildStatic(): Uint8Array {
  const base = new Uint8Array(MAP_W * MAP_H);
  const px0 = PARCEL_ORIGIN.x, px1 = PARCEL_ORIGIN.x + PARCEL_COLS * PARCEL_W;
  const py0 = PARCEL_ORIGIN.y, py1 = PARCEL_ORIGIN.y + PARCEL_ROWS * PARCEL_H;
  const set = (x: number, y: number, c: number) => { if (x >= 0 && y >= 0 && x < MAP_W && y < MAP_H) base[y * MAP_W + x] = c; };
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      let c = COST_GRASS;
      if (inRect(x, y, ROAD)) c = y === ROAD.y + Math.floor(ROAD.h / 2) ? COST_ROAD : COST_ROAD_EDGE;
      else if (inRect(x, y, YARD)) c = COST_YARD;
      else if (inRect(x, y, ELEVATOR)) c = BLOCKED;
      else if (x < px0 || x >= px1 || y < py0 || y >= py1) c = BLOCKED; // trees
      base[y * MAP_W + x] = c;
    }
  }
  // Fence: top and left sides of the yard, and the right side apart from the gate.
  for (let x = YARD.x; x < YARD.x + YARD.w; x++) set(x, YARD.y, BLOCKED);
  for (let y = YARD.y; y < YARD.y + YARD.h; y++) {
    set(YARD.x, y, BLOCKED);
    if (y < YARD_GATE.y0 || y >= YARD_GATE.y1) set(YARD.x + YARD.w, y, BLOCKED);
  }
  // Silo, shed and pump.
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (Math.hypot(x + 0.5 - SILO_POS.x, y + 0.5 - SILO_POS.y) < SILO_RADIUS + 0.2) set(x, y, BLOCKED);
    }
  }
  const shedX = YARD.x + YARD.w - 2.8, shedY = YARD.y + 2.2;
  for (let y = Math.floor(shedY - 1.5); y < shedY + 1.5; y++) for (let x = Math.floor(shedX - 2.3); x < shedX + 2.3; x++) set(x, y, BLOCKED);
  set(Math.floor(PUMP.x), Math.floor(PUMP.y), BLOCKED);
  return base;
}

let staticCost: Uint8Array | null = null;

function costAt(world: World, k: number, destField: number) {
  const c = staticCost![k];
  if (c === BLOCKED || world.penAt[k] >= 0) return BLOCKED;
  const f = world.fieldAt[k];
  if (f >= 0) return f === destField ? COST_DEST_FIELD : COST_FIELD;
  return c;
}

/** True where a machine can't go: buildings, the yard fence, the woods and the map edge. */
export function blockedAt(x: number, y: number, world?: World) {
  staticCost ??= buildStatic();
  const cx = Math.floor(x), cy = Math.floor(y);
  if (cx < 0 || cy < 0 || cx >= MAP_W || cy >= MAP_H) return true;
  const k = cy * MAP_W + cx;
  return staticCost[k] === BLOCKED || (!!world && world.penAt[k] >= 0);
}

export function isRoad(x: number, y: number) {
  return inRect(Math.floor(x), Math.floor(y), ROAD);
}

/** Nearest open cell, for starts and goals that sit on an obstacle. */
function openCell(world: World, x: number, y: number, dest: number): number {
  const cx = Math.max(0, Math.min(MAP_W - 1, Math.floor(x)));
  const cy = Math.max(0, Math.min(MAP_H - 1, Math.floor(y)));
  for (let r = 0; r < 6; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
        if (costAt(world, ny * MAP_W + nx, dest) !== BLOCKED) return ny * MAP_W + nx;
      }
    }
  }
  return cy * MAP_W + cx;
}

/** Straight segment check: no obstacles and nothing pricier than `limit` under a machine-wide strip. */
function clear(world: World, a: Pt, b: Pt, dest: number, limit: number) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.ceil(len / 0.3);
  // Sample the center line and both sides of a machine-wide strip.
  const nx = len ? -(b.y - a.y) / len * 0.45 : 0, ny = len ? (b.x - a.x) / len * 0.45 : 0;
  for (let i = 0; i <= n; i++) {
    const t = n ? i / n : 0;
    const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
    for (const s of [0, 1, -1]) {
      const sx = Math.floor(x + nx * s), sy = Math.floor(y + ny * s);
      if (sx < 0 || sy < 0 || sx >= MAP_W || sy >= MAP_H) return false;
      const c = costAt(world, sy * MAP_W + sx, dest);
      if (c === BLOCKED || c > limit) return false;
    }
  }
  return true;
}

/** Tiny binary min-heap keyed by f-score. */
class Heap {
  private k: number[] = [];
  private f: number[] = [];
  get size() { return this.k.length; }
  push(key: number, f: number) {
    const k = this.k, fs = this.f;
    let i = k.length;
    k.push(key); fs.push(f);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (fs[p] <= f) break;
      k[i] = k[p]; fs[i] = fs[p];
      i = p;
    }
    k[i] = key; fs[i] = f;
  }
  pop(): number {
    const k = this.k, fs = this.f;
    const top = k[0];
    const lk = k.pop()!, lf = fs.pop()!;
    if (k.length) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i, mf = lf;
        if (l < k.length && fs[l] < mf) { m = l; mf = fs[l]; }
        if (r < k.length && fs[r] < mf) { m = r; mf = fs[r]; }
        if (m === i) break;
        k[i] = k[m]; fs[i] = fs[m];
        i = m;
      }
      k[i] = lk; fs[i] = lf;
    }
    return top;
  }
}

const G = new Float32Array(MAP_W * MAP_H);
const FROM = new Int32Array(MAP_W * MAP_H);
const STAMP = new Uint32Array(MAP_W * MAP_H);
let stamp = 0;
const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

/**
 * Route from a to b as a list of waypoints (b last). Follows roads and the yard gate,
 * keeps off buildings and other fields, then pulls the corners tight.
 */
export function findPath(world: World, a: Pt, b: Pt): Pt[] {
  staticCost ??= buildStatic();
  const dest = world.fieldIdAt(Math.floor(b.x), Math.floor(b.y));
  const start = openCell(world, a.x, a.y, dest);
  const goal = openCell(world, b.x, b.y, dest);
  if (start === goal) return [b];
  stamp++;
  const heap = new Heap();
  const gx = goal % MAP_W, gy = Math.floor(goal / MAP_W);
  const h = (k: number) => Math.hypot(k % MAP_W - gx, Math.floor(k / MAP_W) - gy) * COST_ROAD;
  G[start] = 0; FROM[start] = -1; STAMP[start] = stamp;
  heap.push(start, h(start));
  let found = false;
  while (heap.size) {
    const k = heap.pop();
    if (k === goal) { found = true; break; }
    const x = k % MAP_W, y = Math.floor(k / MAP_W);
    const g = G[k];
    for (const [dx, dy, len] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
      const nk = ny * MAP_W + nx;
      const c = costAt(world, nk, dest);
      if (c === BLOCKED) continue;
      // No squeezing diagonally between two obstacles.
      if (dx && dy && (costAt(world, y * MAP_W + nx, dest) === BLOCKED || costAt(world, ny * MAP_W + x, dest) === BLOCKED)) continue;
      const ng = g + c * len;
      if (STAMP[nk] === stamp && G[nk] <= ng) continue;
      STAMP[nk] = stamp; G[nk] = ng; FROM[nk] = k;
      heap.push(nk, ng + h(nk));
    }
  }
  if (!found) return [b];
  const cells: Pt[] = [];
  for (let k = goal; k !== -1; k = FROM[k]) cells.push({ x: (k % MAP_W) + 0.5, y: Math.floor(k / MAP_W) + 0.5 });
  cells.reverse();
  cells[cells.length - 1] = { x: b.x, y: b.y };
  // String-pull within each stretch of same-cost ground (a road run, a grass run...), so
  // shortcuts never leave the road for the grass beside it.
  const cost = cells.map(p => costAt(world, Math.floor(p.y) * MAP_W + Math.floor(p.x), dest));
  const out: Pt[] = [];
  let cur: Pt = { x: a.x, y: a.y };
  let i = 0;
  while (i < cells.length) {
    let end = i;
    while (end + 1 < cells.length && cost[end + 1] === cost[i]) end++;
    let j = Math.min(cells.length - 1, end + 1, i + 40);
    while (j > i && !clear(world, cur, cells[j], dest, Math.max(cost[i], cost[j]))) j--;
    out.push(cells[j]);
    cur = cells[j];
    i = j + 1;
  }
  return out;
}
