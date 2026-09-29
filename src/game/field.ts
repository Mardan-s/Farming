import {
  CROPS, CROP_DEFS, FERT_BONUS, LIME_HARVESTS, LIME_PENALTY, MINUTES_PER_DAY, ROLL_BONUS, STORM_YIELD, WEED_PENALTY, emptyCropRecord,
  type CropId,
} from './config';
import type { Axis } from './coverage';
import { centroid, polygonArea, type Pt } from './geometry';

export enum CellState { Grass = 0, Plowed = 1, Seeded = 2, Stubble = 3 }

export const READY_STAGE = 4;

/** Weed state per cell: none yet, weeds growing, or protected (weeded/sprayed this season). */
export enum Weeds { None = 0, Present = 1, Protected = 2 }

export interface FieldSave {
  id: number;
  poly: Pt[];
  cells: number[]; // flat x,y pairs
  axis: Axis;
  state: number[];
  crop: number[];
  planted: number[];
  fert?: number[];
  rolled?: number[];
  weeds?: number[];
  lime?: number[];
  damaged?: number[];
}

export class Field {
  readonly id: number;
  readonly poly: Pt[];
  readonly cells: Pt[];
  readonly axis: Axis;
  readonly state: Uint8Array;
  readonly crop: Int8Array; // index into CROPS, -1 for none
  readonly planted: Float64Array; // game minute of seeding
  readonly fert: Uint8Array; // fertilizer passes this season (0-2)
  readonly rolled: Uint8Array;
  readonly weeds: Uint8Array;
  readonly lime: Uint8Array; // harvests left before the soil needs lime
  readonly damaged: Uint8Array; // flattened by a storm
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
    this.fert = new Uint8Array(cells.length);
    this.rolled = new Uint8Array(cells.length);
    this.weeds = new Uint8Array(cells.length);
    this.lime = new Uint8Array(cells.length).fill(LIME_HARVESTS - 1);
    this.damaged = new Uint8Array(cells.length);
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

  /** About two thirds of cells are prone to weeds, fixed per cell so it doesn't flicker. */
  weedProne(i: number) {
    const c = this.cells[i];
    return (((c.x * 92821) ^ (c.y * 68917) ^ (this.id * 131)) >>> 0) % 100 < 65;
  }

  /** Harvest multiplier from soil care: fertilizer, lime, rolling and weeds. */
  yieldFactor(i: number) {
    let f = 1 + this.fert[i] * FERT_BONUS;
    if (this.lime[i] === 0) f -= LIME_PENALTY;
    if (this.rolled[i]) f += ROLL_BONUS;
    if (this.weeds[i] === Weeds.Present) f -= WEED_PENALTY;
    if (this.damaged[i]) f *= STORM_YIELD;
    return Math.max(0.3, f);
  }

  /** Resets per-season soil care; lime lasts across seasons. */
  resetSeason(i: number) {
    this.fert[i] = 0;
    this.rolled[i] = 0;
    this.weeds[i] = Weeds.None;
    this.damaged[i] = 0;
  }

  cropAt(i: number): CropId | null {
    return this.crop[i] >= 0 ? CROPS[this.crop[i]] : null;
  }

  /** Summary used by the UI. `clock` is the growth clock, which pauses in winter. */
  summary(clock: number) {
    let grass = 0, plowed = 0, growing = 0, ready = 0, stubble = 0, progress = 0;
    let fert = 0, needLime = 0, weedy = 0, rolled = 0, yieldSum = 0, damaged = 0;
    for (let i = 0; i < this.cells.length; i++) {
      fert += this.fert[i];
      if (this.lime[i] === 0) needLime++;
      if (this.weeds[i] === Weeds.Present) weedy++;
      if (this.rolled[i]) rolled++;
      if (this.damaged[i]) damaged++;
      yieldSum += this.yieldFactor(i);
    }
    const cropCounts = emptyCropRecord(() => 0);
    const readyCounts = emptyCropRecord(() => 0);
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
      fertAvg: fert / this.cells.length, needLime, weedy, rolled, damaged,
      yieldPct: Math.round((yieldSum / this.cells.length) * 100),
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
      fert: Array.from(this.fert),
      rolled: Array.from(this.rolled),
      weeds: Array.from(this.weeds),
      lime: Array.from(this.lime),
      damaged: Array.from(this.damaged),
    };
  }

  static load(s: FieldSave): Field {
    const cells: Pt[] = [];
    for (let i = 0; i < s.cells.length; i += 2) cells.push({ x: s.cells[i], y: s.cells[i + 1] });
    const f = new Field(s.id, s.poly, cells, s.axis);
    f.state.set(s.state);
    f.crop.set(s.crop);
    f.planted.set(s.planted);
    if (s.fert) f.fert.set(s.fert);
    if (s.rolled) f.rolled.set(s.rolled);
    if (s.weeds) f.weeds.set(s.weeds);
    if (s.lime) f.lime.set(s.lime);
    if (s.damaged) f.damaged.set(s.damaged);
    return f;
  }
}
