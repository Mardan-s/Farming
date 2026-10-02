import {
  ELEVATOR, MAP_H, MAP_W, PARCEL_COLS, PARCEL_H, PARCEL_ORIGIN, PARCEL_ROWS, PARCEL_W, ROAD, YARD, type Rect,
} from './config';
import { ANIMAL_DEFS, feedPoint, type AnimalKind, type Pen } from './animals';
import { Field } from './field';
import { isSimplePolygon, rasterize, type Pt } from './geometry';

export function inRect(x: number, y: number, r: Rect) {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

export function parcelRect(i: number): Rect {
  const col = i % PARCEL_COLS;
  const row = Math.floor(i / PARCEL_COLS);
  return { x: PARCEL_ORIGIN.x + col * PARCEL_W, y: PARCEL_ORIGIN.y + row * PARCEL_H, w: PARCEL_W, h: PARCEL_H };
}

export const PARCEL_COUNT = PARCEL_COLS * PARCEL_ROWS;

/** Static map layout plus the dynamic field index. */
export class World {
  readonly parcelOf = new Int8Array(MAP_W * MAP_H).fill(-1);
  readonly blocked = new Uint8Array(MAP_W * MAP_H);
  readonly fieldAt = new Int16Array(MAP_W * MAP_H).fill(-1);
  readonly fieldCellIdx = new Int32Array(MAP_W * MAP_H).fill(-1);
  readonly fields = new Map<number, Field>();
  /** Pen id on each cell, or -1. */
  readonly penAt = new Int16Array(MAP_W * MAP_H).fill(-1);

  constructor() {
    for (let i = 0; i < PARCEL_COUNT; i++) {
      const r = parcelRect(i);
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) this.parcelOf[y * MAP_W + x] = i;
    }
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        if (inRect(x, y, YARD) || inRect(x, y, ROAD) || inRect(x, y, ELEVATOR)) this.blocked[y * MAP_W + x] = 1;
      }
    }
  }

  inBounds(x: number, y: number) { return x >= 0 && y >= 0 && x < MAP_W && y < MAP_H; }

  parcelAt(x: number, y: number) { return this.inBounds(x, y) ? this.parcelOf[y * MAP_W + x] : -1; }

  fieldIdAt(x: number, y: number) { return this.inBounds(x, y) ? this.fieldAt[y * MAP_W + x] : -1; }

  addField(f: Field) {
    this.fields.set(f.id, f);
    f.cells.forEach((c, i) => {
      this.fieldAt[c.y * MAP_W + c.x] = f.id;
      this.fieldCellIdx[c.y * MAP_W + c.x] = i;
    });
  }

  removeField(id: number) {
    const f = this.fields.get(id);
    if (!f) return;
    for (const c of f.cells) {
      this.fieldAt[c.y * MAP_W + c.x] = -1;
      this.fieldCellIdx[c.y * MAP_W + c.x] = -1;
    }
    this.fields.delete(id);
  }

  penIdAt(x: number, y: number) { return this.inBounds(x, y) ? this.penAt[y * MAP_W + x] : -1; }

  addPen(p: Pen) {
    const d = ANIMAL_DEFS[p.kind];
    for (let y = p.y; y < p.y + d.h; y++) for (let x = p.x; x < p.x + d.w; x++) this.penAt[y * MAP_W + x] = p.id;
  }

  removePen(p: Pen) {
    const d = ANIMAL_DEFS[p.kind];
    for (let y = p.y; y < p.y + d.h; y++) for (let x = p.x; x < p.x + d.w; x++) this.penAt[y * MAP_W + x] = -1;
  }

  /** Can a pen of this kind go with its top-left corner at (x, y)? */
  validatePen(kind: AnimalKind, x: number, y: number, owned: Set<number>): { ok: boolean; reason?: string } {
    const d = ANIMAL_DEFS[kind];
    for (let cy = y; cy < y + d.h; cy++) {
      for (let cx = x; cx < x + d.w; cx++) {
        if (!this.inBounds(cx, cy)) return { ok: false, reason: 'Outside the map' };
        const k = cy * MAP_W + cx;
        if (this.blocked[k]) return { ok: false, reason: 'Overlaps the farmyard or road' };
        if (!owned.has(this.parcelOf[k])) return { ok: false, reason: 'You don\u2019t own all of this land' };
        if (this.fieldAt[k] >= 0) return { ok: false, reason: 'Overlaps a field' };
        if (this.penAt[k] >= 0) return { ok: false, reason: 'Overlaps another pen' };
      }
    }
    const f = feedPoint({ kind, x, y } as Pen);
    const fx = Math.floor(f.x), fy = Math.floor(f.y);
    if (!this.inBounds(fx, fy)) return { ok: false, reason: 'Leave room in front for the feed wagon' };
    const k = fy * MAP_W + fx;
    if (this.fieldAt[k] >= 0 || this.penAt[k] >= 0) return { ok: false, reason: 'Leave room in front for the feed wagon' };
    return { ok: true };
  }

  /** Checks a candidate outline against ownership, obstacles and other fields. */
  validateOutline(poly: Pt[], owned: Set<number>): { ok: boolean; reason?: string; cells: Pt[] } {
    if (poly.length < 4) return { ok: false, reason: `Add ${4 - poly.length} more corner${poly.length === 3 ? '' : 's'}`, cells: [] };
    if (!isSimplePolygon(poly)) return { ok: false, reason: 'Edges cross each other', cells: [] };
    const cells = rasterize(poly);
    if (cells.length < 12) return { ok: false, reason: 'Field is too small', cells };
    for (const c of cells) {
      if (!this.inBounds(c.x, c.y)) return { ok: false, reason: 'Outside the map', cells };
      const k = c.y * MAP_W + c.x;
      if (this.blocked[k]) return { ok: false, reason: 'Overlaps the farmyard or road', cells };
      if (!owned.has(this.parcelOf[k])) return { ok: false, reason: 'You don’t own all of this land', cells };
      if (this.fieldAt[k] >= 0) return { ok: false, reason: 'Overlaps another field', cells };
      if (this.penAt[k] >= 0) return { ok: false, reason: 'Overlaps an animal pen', cells };
    }
    return { ok: true, cells };
  }
}
