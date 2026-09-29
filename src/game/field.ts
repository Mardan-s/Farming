import { CROPS, CROP_DEFS, MINUTES_PER_DAY, type CropId } from './config';
import type { Axis } from './coverage';
import { centroid, polygonArea, type Pt } from './geometry';

export enum CellState { Grass = 0, Plowed = 1, Seeded = 2, Stubble = 3 }

export const READY_STAGE = 4;

export interface FieldSave {
  id: number;
  poly: Pt[];
  cells: number[]; // flat x,y pairs
  axis: Axis;
  state: number[];
  crop: number[];
  planted: number[];
}

export class Field {
  readonly id: number;
  readonly poly: Pt[];
  readonly cells: Pt[];
  readonly axis: Axis;
  readonly state: Uint8Array;
  readonly crop: Int8Array; // index into CROPS, -1 for none
  readonly planted: Float64Array; // game minute of seeding
  readonly center: Pt;

  constructor(id: number, poly: Pt[], cells: Pt[], axis?: Axis) {
    this.id = id;
    this.poly = poly;
    this.cells = cells;
    const xs = cells.map(c => c.x);
    const ys = cells.map(c => c.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    this.axis = axis ?? (w >= h ? 'h' : 'v');
    this.state = new Uint8Array(cells.length);
    this.crop = new Int8Array(cells.length).fill(-1);
    this.planted = new Float64Array(cells.length);
    this.center = centroid(poly);
  }

  get area() { return polygonArea(this.poly); }

  stage(i: number, clock: number): number {
    if (this.state[i] !== CellState.Seeded) return -1;
    const def = CROP_DEFS[CROPS[this.crop[i]]];
    const t = (clock - this.planted[i]) / (def.growDays * MINUTES_PER_DAY);
    return t >= 1 ? READY_STAGE : Math.max(0, Math.floor(t * 4));
  }

  isReady(i: number, clock: number) { return this.stage(i, clock) === READY_STAGE; }

  cropAt(i: number): CropId | null {
    return this.crop[i] >= 0 ? CROPS[this.crop[i]] : null;
  }

  /** Summary used by the UI. */
  summary(clock: number) {
    let grass = 0, plowed = 0, growing = 0, ready = 0, stubble = 0, progress = 0;
    const cropCounts: Record<CropId, number> = { wheat: 0, corn: 0, soy: 0 };
    const readyCounts: Record<CropId, number> = { wheat: 0, corn: 0, soy: 0 };
    for (let i = 0; i < this.cells.length; i++) {
      switch (this.state[i]) {
        case CellState.Grass: grass++; break;
        case CellState.Plowed: plowed++; break;
        case CellState.Stubble: stubble++; break;
        case CellState.Seeded: {
          const crop = CROPS[this.crop[i]];
          cropCounts[crop]++;
          const def = CROP_DEFS[crop];
          const t = (clock - this.planted[i]) / (def.growDays * MINUTES_PER_DAY);
          if (t >= 1) { ready++; readyCounts[crop]++; } else { growing++; progress += t; }
        }
      }
    }
    return {
      total: this.cells.length, grass, plowed, growing, ready, stubble,
      growthPct: growing ? Math.round((progress / growing) * 100) : 0,
      cropCounts, readyCounts,
    };
  }

  save(): FieldSave {
    return {
      id: this.id,
      poly: this.poly,
      cells: this.cells.flatMap(c => [c.x, c.y]),
      axis: this.axis,
      state: Array.from(this.state),
      crop: Array.from(this.crop),
      planted: Array.from(this.planted),
    };
  }

  static load(s: FieldSave): Field {
    const cells: Pt[] = [];
    for (let i = 0; i < s.cells.length; i += 2) cells.push({ x: s.cells[i], y: s.cells[i + 1] });
    const f = new Field(s.id, s.poly, cells, s.axis);
    f.state.set(s.state);
    f.crop.set(s.crop);
    f.planted.set(s.planted);
    return f;
  }
}
