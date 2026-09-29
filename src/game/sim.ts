import {
  AUTO_UNLOAD_THRESHOLD, COMBINE_SPEED, COMBINE_WORK_FACTOR, COMBINE_TANK, CROPS, CROP_DEFS, FIXED_TOOL_WIDTH,
  GAME_MIN_PER_SEC, HEADER_OFFSET, HEADER_WIDTH, HITCH_OFFSET, LIME_HARVESTS, MINUTES_PER_DAY, OFFLINE_CAP_MIN,
  OFFLINE_RATE, OP_DEFS, PLOW_WIDTH, ROOT_SPEED, ROOT_TANK, SEEDER_WIDTH, SELL_UNLOAD, SHOP_ITEMS, SILO_CAP, SILO_UNLOAD,
  SPEEDS, START_MONEY, START_PARCEL, TOOL_LEN, TOOL_SLOTS, TRACTOR_SPEED, UNLOAD_RATE, UPGRADES, VEHICLE_SLOTS,
  WAGON_CAP, WEATHER_DEFS, WORK_SPEED_FACTOR, emptyCropRecord, parcelPrice, slotPos,
  type CropId, type Op, type ToolKind, type UpgradeId, type VehicleKind, type Weather,
} from './config';
import { planPasses, type Axis } from './coverage';
import { CellState, Field, READY_STAGE, Weeds, type FieldSave } from './field';
import { angleLerp, dist, type Pt } from './geometry';
import { GOALS, newStats, type Stats } from './goals';
import { World, parcelRect } from './world';
import { MAP_W } from './config';

export type { Op };
export type Dest = 'silo' | 'sell';

export interface Cargo { crop: CropId | null; amount: number }

export interface Waypoint { x: number; y: number; work?: { axis: Axis; start: number; width: number } }

export type Step =
  | { t: 'goto'; x: number; y: number }
  | { t: 'park' }
  | { t: 'attach'; toolId: number; timer?: number }
  | { t: 'detach'; timer?: number }
  | { t: 'waitTool'; toolId: number }
  | { t: 'work'; op: Op; fieldId: number; crop?: CropId; level?: number; path?: Waypoint[]; idx?: number; rounds?: number; abort?: boolean }
  | { t: 'follow'; combineId: number }
  | { t: 'unload'; dest: Dest; earned?: number };

export interface Vehicle {
  id: number;
  kind: VehicleKind;
  name: string;
  x: number;
  y: number;
  heading: number;
  slot: number;
  toolId: number | null;
  tank: Cargo;
  steps: Step[];
  autoUnload: boolean;
  // Runtime-only flags, rebuilt every frame.
  status: string;
  moving: boolean;
  working: Op | null;
  unloadingTo: number | null;
  waiting: boolean;
}

export interface Tool {
  id: number;
  kind: ToolKind;
  slot: number;
  x: number;
  y: number;
  heading: number;
  attachedTo: number | null;
  reservedBy: number | null;
  load: Cargo;
}

type Handler = (...args: any[]) => void;

export class Emitter {
  private handlers = new Map<string, Handler[]>();
  on(event: string, fn: Handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
  }
  emit(event: string, ...args: any[]) {
    for (const fn of this.handlers.get(event) ?? []) fn(...args);
  }
}

export const TOOL_NAMES: Record<ToolKind, string> = {
  plow: 'plow', seeder: 'seeder', wagon: 'grain wagon', spreader: 'spreader', roller: 'roller', weeder: 'weeder',
  sprayer: 'sprayer', planter: 'root planter',
};
export const VEHICLE_NAMES: Record<VehicleKind, string> = { tractor: 'Tractor', combine: 'Combine', rootHarvester: 'Root harvester' };

export function isHarvester(v: Vehicle) { return v.kind === 'combine' || v.kind === 'rootHarvester'; }

/** The implement a tractor needs for a job. */
export function toolForOp(op: Op, crop?: CropId): ToolKind | undefined {
  if (op === 'seed') return crop && CROP_DEFS[crop].root ? 'planter' : 'seeder';
  return OP_DEFS[op].tool;
}

function gauss() {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface OfflineReport { minutes: number; days: number }

export class Game {
  readonly world = new World();
  readonly events = new Emitter();
  money = START_MONEY;
  clock = 6 * 60;
  speedIdx = 0;
  owned = new Set<number>([START_PARCEL]);
  vehicles: Vehicle[] = [];
  tools: Tool[] = [];
  silo: Record<CropId, number> = emptyCropRecord(() => 0);
  prices: Record<CropId, number> = Object.fromEntries(CROPS.map(c => [c, CROP_DEFS[c].basePrice])) as Record<CropId, number>;
  priceHistory: Record<CropId, number[]> = emptyCropRecord<number[]>(() => []);
  upgrades: Record<UpgradeId, number> = { plow: 0, seeder: 0, header: 0, wagon: 0, engine: 0 };
  stats: Stats = newStats();
  goalIdx = 0;
  deliverTo: Dest = 'sell';
  muted = false;
  weather: Weather = 'sun';
  weatherNext: Weather = 'cloudy';
  weatherChangeAt = 6 * 60 + 5 * 60;
  private nextId = 1;
  private nextFieldId = 1;
  private tick = 0;

  constructor() {
    for (const c of CROPS) this.priceHistory[c].push(this.prices[c]);
    this.addVehicle('tractor');
    this.addVehicle('combine');
    this.addTool('plow');
    this.addTool('seeder');
    this.addTool('wagon');
  }

  // ---------- queries ----------

  get day() { return Math.floor(this.clock / MINUTES_PER_DAY) + 1; }
  get timeOfDay() { return this.clock % MINUTES_PER_DAY; }
  get speed() { return SPEEDS[this.speedIdx]; }

  vehicle(id: number) { return this.vehicles.find(v => v.id === id); }
  tool(id: number | null) { return id == null ? undefined : this.tools.find(t => t.id === id); }
  toolOf(v: Vehicle) { return this.tool(v.toolId); }

  cargoOf(v: Vehicle): { cargo: Cargo; cap: number } | null {
    if (v.kind === 'combine') return { cargo: v.tank, cap: COMBINE_TANK[this.upgrades.header] };
    if (v.kind === 'rootHarvester') return { cargo: v.tank, cap: ROOT_TANK };
    const t = this.toolOf(v);
    if (t?.kind === 'wagon') return { cargo: t.load, cap: WAGON_CAP[this.upgrades.wagon] };
    return null;
  }

  speedOf(v: Vehicle) {
    if (v.kind === 'tractor') return TRACTOR_SPEED[this.upgrades.engine];
    return v.kind === 'rootHarvester' ? ROOT_SPEED : COMBINE_SPEED;
  }

  toolWidth(kind: ToolKind | 'header' | 'rootHeader') {
    if (kind === 'plow') return PLOW_WIDTH[this.upgrades.plow];
    if (kind === 'seeder') return SEEDER_WIDTH[this.upgrades.seeder];
    if (kind === 'header') return HEADER_WIDTH[this.upgrades.header];
    return FIXED_TOOL_WIDTH[kind] ?? 1;
  }

  /** Width of whatever does the work for this vehicle right now. */
  workWidth(v: Vehicle) {
    if (v.kind === 'combine') return this.toolWidth('header');
    if (v.kind === 'rootHarvester') return this.toolWidth('rootHeader');
    const t = this.toolOf(v);
    return t ? this.toolWidth(t.kind) : 1;
  }

  /** Signed distance from vehicle center to its work point along the heading. */
  workOffset(v: Vehicle) {
    if (isHarvester(v)) return HEADER_OFFSET;
    const t = this.toolOf(v);
    return -(HITCH_OFFSET + (t ? TOOL_LEN[t.kind] / 2 : 0));
  }

  isIdle(v: Vehicle) { return v.steps.length === 0 || (v.steps.length === 1 && v.steps[0].t === 'park'); }

  eligibleCount(field: Field, op: Op, crop?: CropId, level?: number) {
    let n = 0;
    for (let i = 0; i < field.cells.length; i++) if (this.eligible(field, i, op, crop, level)) n++;
    return n;
  }

  /** `level` caps a fertilizer job at one pass: cells below that many passes. */
  private eligible(field: Field, i: number, op: Op, crop?: CropId, level = 2) {
    const s = field.state[i];
    const seeded = s === CellState.Seeded;
    switch (op) {
      case 'plow': return s === CellState.Grass || s === CellState.Stubble;
      case 'seed': return s === CellState.Plowed;
      case 'harvest': return seeded && field.isReady(i, this.clock) && (!crop || field.cropAt(i) === crop);
      case 'fertilize': return field.fert[i] < Math.min(2, level) && (s === CellState.Plowed || (seeded && field.stage(i, this.clock) < READY_STAGE));
      case 'lime': return field.lime[i] === 0;
      case 'roll': return seeded && !field.rolled[i] && field.stage(i, this.clock) <= 1;
      case 'weed': return seeded && field.weeds[i] !== Weeds.Protected && field.stage(i, this.clock) <= 2;
      case 'spray': return seeded && field.weeds[i] !== Weeds.Protected && field.stage(i, this.clock) < READY_STAGE;
    }
  }

  // ---------- entity creation ----------

  private addVehicle(kind: VehicleKind) {
    const slot = this.vehicles.length;
    const pos = slotPos(VEHICLE_SLOTS, slot);
    const count = this.vehicles.filter(v => v.kind === kind).length + 1;
    const v: Vehicle = {
      id: this.nextId++, kind, name: `${VEHICLE_NAMES[kind]} ${count}`,
      x: pos.x, y: pos.y, heading: -Math.PI / 2, slot, toolId: null, tank: { crop: null, amount: 0 }, steps: [],
      autoUnload: true, status: 'Idle', moving: false, working: null, unloadingTo: null, waiting: false,
    };
    this.vehicles.push(v);
    return v;
  }

  private addTool(kind: ToolKind) {
    const slot = this.tools.length;
    const pos = slotPos(TOOL_SLOTS, slot);
    const t: Tool = { id: this.nextId++, kind, slot, x: pos.x, y: pos.y, heading: 0, attachedTo: null, reservedBy: null, load: { crop: null, amount: 0 } };
    this.tools.push(t);
    return t;
  }

  // ---------- simulation ----------

  update(dtReal: number) {
    const dt = Math.min(dtReal, 0.1);
    const prevDay = this.day;
    this.clock += dt * GAME_MIN_PER_SEC * this.speed;
    if (this.day !== prevDay) this.newDay();
    if (this.clock >= this.weatherChangeAt) this.advanceWeather();

    for (const v of this.vehicles) { v.moving = false; v.working = null; v.unloadingTo = null; v.waiting = false; }
    for (const v of this.vehicles) this.updateVehicle(v, dt);
    this.updateTools();

    this.tick += dt;
    if (this.tick >= 1) {
      this.tick = 0;
      this.dispatchUnloaders();
      this.growWeeds();
      this.checkGoals();
    }
  }

  private pickWeather(from: Weather): Weather {
    let r = Math.random();
    for (const [w, p] of WEATHER_DEFS[from].next) {
      if ((r -= p) <= 0) return w;
    }
    return 'sun';
  }

  private advanceWeather() {
    // Catch up if a lot of time passed (e.g. while offline).
    while (this.clock >= this.weatherChangeAt) {
      this.weather = this.weatherNext;
      this.weatherNext = this.pickWeather(this.weather);
      this.weatherChangeAt += (3 + Math.random() * 6) * 60;
    }
    this.events.emit('weather', this.weather);
  }

  /** Weeds creep into growing crops that haven't been weeded or sprayed. */
  private growWeeds() {
    for (const f of this.world.fields.values()) {
      for (let i = 0; i < f.cells.length; i++) {
        if (f.state[i] !== CellState.Seeded || f.weeds[i] !== Weeds.None || !f.weedProne(i)) continue;
        if (f.stage(i, this.clock) < 2) continue;
        f.weeds[i] = Weeds.Present;
        this.events.emit('cell', f.id, i);
      }
    }
  }

  private newDay() {
    for (const c of CROPS) {
      const base = CROP_DEFS[c].basePrice;
      let p = this.prices[c];
      p = p * (1 + gauss() * 0.07) + (base - p) * 0.12;
      p = Math.min(base * 1.6, Math.max(base * 0.55, p));
      this.prices[c] = Math.round(p);
    }
    if (Math.random() < 0.12) {
      const c = CROPS[Math.floor(Math.random() * CROPS.length)];
      this.prices[c] = Math.round(Math.min(CROP_DEFS[c].basePrice * 1.8, this.prices[c] * 1.3));
      this.events.emit('toast', `📈 ${CROP_DEFS[c].name} demand spike! $${this.prices[c]} / 1000 L`, 'good');
    }
    for (const c of CROPS) {
      this.priceHistory[c].push(this.prices[c]);
      if (this.priceHistory[c].length > 14) this.priceHistory[c].shift();
    }
    this.events.emit('day', this.day);
  }

  private updateVehicle(v: Vehicle, dt: number) {
    const step = v.steps[0];
    if (!step) {
      v.status = 'Idle — tap a field to give a job';
      return;
    }
    switch (step.t) {
      case 'goto':
        v.status = 'Driving';
        if (this.moveTo(v, step.x, step.y, this.speedOf(v), dt)) v.steps.shift();
        break;
      case 'park': {
        v.status = 'Returning to the farmyard';
        const p = slotPos(VEHICLE_SLOTS, v.slot);
        if (this.moveTo(v, p.x, p.y, this.speedOf(v), dt)) v.steps.shift();
        break;
      }
      case 'attach': {
        const tool = this.tool(step.toolId);
        v.status = `Hitching ${tool ? TOOL_NAMES[tool.kind] : 'tool'}`;
        step.timer = (step.timer ?? 0) + dt;
        v.heading = angleLerp(v.heading, 0, Math.min(1, dt * 10));
        if (step.timer < 0.4) break;
        v.heading = 0;
        if (tool && tool.attachedTo == null) {
          tool.attachedTo = v.id;
          tool.reservedBy = null;
          tool.heading = 0;
          tool.x = v.x - HITCH_OFFSET - TOOL_LEN[tool.kind] / 2;
          tool.y = v.y;
          v.toolId = tool.id;
        }
        v.steps.shift();
        break;
      }
      case 'detach': {
        const tool = this.toolOf(v);
        v.status = 'Unhitching';
        step.timer = (step.timer ?? 0) + dt;
        v.heading = angleLerp(v.heading, 0, Math.min(1, dt * 10));
        if (step.timer < 0.4) break;
        if (tool) {
          const home = slotPos(TOOL_SLOTS, tool.slot);
          tool.attachedTo = null;
          tool.x = home.x;
          tool.y = home.y;
          tool.heading = 0;
        }
        v.toolId = null;
        v.steps.shift();
        break;
      }
      case 'waitTool': {
        const tool = this.tool(step.toolId);
        const holder = tool?.attachedTo != null ? this.vehicle(tool.attachedTo) : undefined;
        if (!tool || !holder) { v.steps.shift(); break; }
        v.status = `Waiting for ${holder.name} to drop off the ${TOOL_NAMES[tool.kind]}`;
        break;
      }
      case 'work': this.stepWork(v, step, dt); break;
      case 'follow': this.stepFollow(v, step, dt); break;
      case 'unload': this.stepUnload(v, step, dt); break;
    }
  }

  private moveTo(v: Vehicle, tx: number, ty: number, speed: number, dt: number): boolean {
    const dx = tx - v.x;
    const dy = ty - v.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-3) return true;
    const stepLen = speed * dt;
    v.moving = true;
    v.heading = angleLerp(v.heading, Math.atan2(dy, dx), Math.min(1, dt * 7));
    if (d <= stepLen) {
      v.x = tx;
      v.y = ty;
      return true;
    }
    v.x += (dx / d) * stepLen;
    v.y += (dy / d) * stepLen;
    return false;
  }

  private stepWork(v: Vehicle, s: Extract<Step, { t: 'work' }>, dt: number) {
    const field = this.world.fields.get(s.fieldId);
    if (!field || s.abort) {
      v.steps = v.steps.filter(st => st.t === 'park');
      if (v.steps.length === 0) v.steps.push({ t: 'park' });
      return;
    }
    if (!s.path || (s.idx ?? 0) >= s.path.length) {
      const rounds = s.rounds ?? 0;
      const path = rounds < 3 ? this.buildPath(v, s, field) : [];
      s.rounds = rounds + 1;
      if (path.length === 0) {
        v.steps.shift();
        this.events.emit('toast', `✅ ${v.name} finished ${OP_DEFS[s.op].verb.toLowerCase()} Field ${field.id}`, 'good');
        return;
      }
      s.path = path;
      s.idx = 0;
    }
    const wp = s.path[s.idx!];
    if (s.op === 'harvest' && wp.work) {
      const cargo = this.cargoOf(v)!;
      const per = CROP_DEFS[s.crop!].yieldPerCell * wp.work.width * 1.3;
      if (cargo.cap - cargo.cargo.amount < per) {
        v.waiting = true;
        v.status = v.autoUnload ? 'Tank full — waiting for a wagon' : 'Tank full — send a tractor with a wagon';
        return;
      }
    }
    const factor = isHarvester(v) ? COMBINE_WORK_FACTOR : WORK_SPEED_FACTOR;
    const speed = this.speedOf(v) * (wp.work ? factor : 1);
    const px = v.x;
    const py = v.y;
    const arrived = this.moveTo(v, wp.x, wp.y, speed, dt);
    if (wp.work) {
      this.applyWork(v, s, field, px, py, wp.work);
      v.working = s.op;
    }
    const remaining = this.eligibleCount(field, s.op, s.crop, s.level);
    const pct = Math.round((1 - remaining / field.cells.length) * 100);
    v.status = `${OP_DEFS[s.op].verb} Field ${field.id}${s.crop ? ` (${CROP_DEFS[s.crop].name})` : ''} · ${pct}%`;
    if (arrived) s.idx!++;
  }

  private buildPath(v: Vehicle, s: Extract<Step, { t: 'work' }>, field: Field): Waypoint[] {
    const cells: Pt[] = [];
    for (let i = 0; i < field.cells.length; i++) if (this.eligible(field, i, s.op, s.crop, s.level)) cells.push(field.cells[i]);
    const width = this.workWidth(v);
    const passes = planPasses(cells, field.axis, width, { x: v.x, y: v.y });
    const off = this.workOffset(v);
    const path: Waypoint[] = [];
    for (const p of passes) {
      const len = dist(p.from, p.to) || 1;
      const dx = (p.to.x - p.from.x) / len;
      const dy = (p.to.y - p.from.y) / len;
      const sx = p.from.x - dx * off, sy = p.from.y - dy * off;
      const ex = p.to.x - dx * off, ey = p.to.y - dy * off;
      path.push({ x: sx - dx * 1.5, y: sy - dy * 1.5 });
      path.push({ x: sx, y: sy });
      path.push({ x: ex, y: ey, work: { axis: p.axis, start: p.bandStart, width: p.width } });
      path.push({ x: ex + dx * 1.2, y: ey + dy * 1.2 });
    }
    return path;
  }

  private applyWork(v: Vehicle, s: Extract<Step, { t: 'work' }>, field: Field, px: number, py: number, band: NonNullable<Waypoint['work']>) {
    const mx = v.x - px, my = v.y - py;
    const len = Math.hypot(mx, my);
    if (len < 1e-6) return;
    const off = this.workOffset(v);
    const dx = mx / len, dy = my / len;
    const a0 = band.axis === 'h' ? px + dx * off : py + dy * off;
    const a1 = band.axis === 'h' ? v.x + dx * off : v.y + dy * off;
    const lo = Math.floor(Math.min(a0, a1));
    const hi = Math.floor(Math.max(a0, a1));
    for (let a = lo; a <= hi; a++) {
      for (let c = band.start; c < band.start + band.width; c++) {
        const x = band.axis === 'h' ? a : c;
        const y = band.axis === 'h' ? c : a;
        if (this.world.fieldIdAt(x, y) !== field.id) continue;
        const i = this.world.fieldCellIdx[y * MAP_W + x];
        if (!this.eligible(field, i, s.op, s.crop, s.level)) continue;
        if (!this.applyCell(v, s, field, i)) return;
      }
    }
  }

  /** Returns false when work must stop (out of money / tank full). */
  private applyCell(v: Vehicle, s: Extract<Step, { t: 'work' }>, field: Field, i: number): boolean {
    const cost = s.op === 'seed' ? CROP_DEFS[s.crop!].seedCostPerCell : OP_DEFS[s.op].costPerCell ?? 0;
    if (cost > 0 && this.money < cost) {
      s.abort = true;
      this.events.emit('toast', `💸 Out of money for ${s.op === 'seed' ? 'seeds' : OP_DEFS[s.op].name.toLowerCase()} — sell some grain first`, 'bad');
      return false;
    }
    switch (s.op) {
      case 'plow':
        field.state[i] = CellState.Plowed;
        field.crop[i] = -1;
        field.resetSeason(i);
        this.stats.plowed++;
        break;
      case 'seed':
        field.state[i] = CellState.Seeded;
        field.crop[i] = CROPS.indexOf(s.crop!);
        field.planted[i] = this.clock;
        field.rolled[i] = 0;
        field.weeds[i] = Weeds.None;
        this.stats.seeded++;
        break;
      case 'fertilize': field.fert[i]++; this.stats.fertilized++; break;
      case 'lime': field.lime[i] = LIME_HARVESTS; this.stats.limed++; break;
      case 'roll': field.rolled[i] = 1; break;
      case 'weed':
      case 'spray':
        field.weeds[i] = Weeds.Protected;
        this.stats.weeded++;
        break;
      case 'harvest': {
        const cargo = this.cargoOf(v)!;
        const y = CROP_DEFS[s.crop!].yieldPerCell * field.yieldFactor(i);
        if (cargo.cargo.amount + y > cargo.cap) return false;
        cargo.cargo.crop = s.crop!;
        cargo.cargo.amount += y;
        field.state[i] = CellState.Stubble;
        field.lime[i] = Math.max(0, field.lime[i] - 1);
        field.resetSeason(i);
        this.stats.harvested++;
        if (!this.stats.cropsHarvested.includes(s.crop!)) this.stats.cropsHarvested.push(s.crop!);
        break;
      }
    }
    this.money -= cost;
    this.events.emit('cell', field.id, i);
    return true;
  }

  /** Where a tractor should sit to receive grain from a combine's pipe. */
  unloadSpot(c: Vehicle): Pt {
    const dx = Math.cos(c.heading), dy = Math.sin(c.heading);
    const lx = dy, ly = -dx; // left side of the combine
    const back = HITCH_OFFSET + TOOL_LEN.wagon / 2 - 0.3;
    return { x: c.x + lx * 2.6 + dx * back, y: c.y + ly * 2.6 + dy * back };
  }

  private stepFollow(v: Vehicle, s: Extract<Step, { t: 'follow' }>, dt: number) {
    const c = this.vehicle(s.combineId);
    const wagon = this.toolOf(v);
    if (!c || !wagon || wagon.kind !== 'wagon') { v.steps.shift(); return; }
    const cap = WAGON_CAP[this.upgrades.wagon];
    const load = wagon.load;
    const combineWorking = c.steps[0]?.t === 'work';
    const mismatch = load.amount > 0 && c.tank.amount > 0 && c.tank.crop !== load.crop;
    if (load.amount >= cap - 1 || (!combineWorking && c.tank.amount <= 0.5) || mismatch) {
      v.steps.shift();
      return;
    }
    const target = this.unloadSpot(c);
    const d = dist(v, target);
    if (d > 0.8) {
      v.status = `Driving to ${c.name}`;
      this.moveTo(v, target.x, target.y, this.speedOf(v) * 1.3, dt);
      return;
    }
    const k = Math.min(1, dt * 6);
    v.x += (target.x - v.x) * k;
    v.y += (target.y - v.y) * k;
    v.heading = angleLerp(v.heading, c.heading, Math.min(1, dt * 5));
    v.moving = c.moving;
    const amt = Math.min(UNLOAD_RATE * dt, c.tank.amount, cap - load.amount);
    if (amt > 0) {
      if (load.amount <= 0) load.crop = c.tank.crop;
      load.amount += amt;
      c.tank.amount -= amt;
      if (c.tank.amount <= 0.01) { c.tank.amount = 0; c.tank.crop = null; }
      c.unloadingTo = v.id;
      v.status = `Receiving grain · ${Math.round((load.amount / cap) * 100)}%`;
    } else {
      v.status = `Following ${c.name}`;
    }
  }

  private stepUnload(v: Vehicle, s: Extract<Step, { t: 'unload' }>, dt: number) {
    const info = this.cargoOf(v);
    const finish = () => {
      if (s.earned && s.earned > 0) {
        const p = s.dest === 'sell' ? SELL_UNLOAD : SILO_UNLOAD;
        this.events.emit('money', p.x, p.y, s.earned);
      }
      v.steps.shift();
    };
    if (!info || info.cargo.amount <= 0 || !info.cargo.crop) { finish(); return; }
    const crop = info.cargo.crop;
    let amt = Math.min(UNLOAD_RATE * 1.5 * dt, info.cargo.amount);
    if (s.dest === 'silo') {
      const space = SILO_CAP - this.silo[crop];
      if (space <= 0) {
        this.events.emit('toast', '🏚️ Silo is full — sell grain from the Market', 'bad');
        finish();
        return;
      }
      amt = Math.min(amt, space);
      this.silo[crop] += amt;
      v.status = 'Unloading into the silo';
    } else {
      const earned = (amt / 1000) * this.prices[crop];
      this.money += earned;
      s.earned = (s.earned ?? 0) + earned;
      this.stats.soldLiters += amt;
      this.stats.earned += earned;
      v.status = `Selling ${CROP_DEFS[crop].name}`;
    }
    info.cargo.amount -= amt;
    if (info.cargo.amount <= 0.01) { info.cargo.amount = 0; info.cargo.crop = null; finish(); }
  }

  private updateTools() {
    for (const t of this.tools) {
      if (t.attachedTo == null) continue;
      const v = this.vehicle(t.attachedTo);
      if (!v) { t.attachedTo = null; continue; }
      const hx = v.x - Math.cos(v.heading) * HITCH_OFFSET;
      const hy = v.y - Math.sin(v.heading) * HITCH_OFFSET;
      let nx = hx - t.x, ny = hy - t.y;
      const n = Math.hypot(nx, ny);
      if (n < 1e-4) { nx = Math.cos(v.heading); ny = Math.sin(v.heading); } else { nx /= n; ny /= n; }
      const half = TOOL_LEN[t.kind] / 2;
      t.x = hx - nx * half;
      t.y = hy - ny * half;
      t.heading = Math.atan2(ny, nx);
    }
  }

  private dispatchUnloaders() {
    for (const c of this.vehicles) {
      if (!isHarvester(c) || !c.autoUnload || c.tank.amount <= 0) continue;
      const cap = this.cargoOf(c)!.cap;
      const working = c.steps[0]?.t === 'work';
      if (working && c.tank.amount < cap * AUTO_UNLOAD_THRESHOLD) continue;
      const assigned = this.vehicles.some(t => t.steps.some(st => st.t === 'follow' && st.combineId === c.id));
      if (assigned) continue;
      const candidates = this.vehicles
        .filter(t => t.kind === 'tractor' && this.isIdle(t))
        .filter(t => this.toolOf(t)?.kind === 'wagon' || this.tools.some(w => w.kind === 'wagon' && w.attachedTo == null && w.reservedBy == null))
        .sort((a, b) => {
          const aw = this.toolOf(a)?.kind === 'wagon' ? 0 : 100;
          const bw = this.toolOf(b)?.kind === 'wagon' ? 0 : 100;
          return aw + dist(a, c) - (bw + dist(b, c));
        });
      if (candidates[0]) {
        const err = this.orderUnloadCombine(candidates[0].id, c.id);
        if (!err) this.events.emit('toast', `🚜 ${candidates[0].name} is coming to unload ${c.name}`, 'info');
      }
    }
  }

  private checkGoals() {
    this.stats.fields = this.world.fields.size;
    this.stats.parcels = this.owned.size;
    const g = GOALS[this.goalIdx];
    if (!g) return;
    const [cur, target] = g.progress(this.stats);
    if (cur >= target) {
      this.money += g.reward;
      this.goalIdx++;
      this.events.emit('goal', g);
    }
  }

  // ---------- orders ----------

  cancel(v: Vehicle) {
    v.steps = [];
    for (const t of this.tools) if (t.reservedBy === v.id) t.reservedBy = null;
  }

  private attachPoint(t: Tool): Pt {
    const home = slotPos(TOOL_SLOTS, t.slot);
    return { x: home.x + HITCH_OFFSET + TOOL_LEN[t.kind] / 2, y: home.y };
  }

  /** Steps that leave the tractor hitched to a tool of this kind, or an error. */
  private ensureTool(v: Vehicle, kind: ToolKind, reserve: boolean): Step[] | string {
    const cur = this.toolOf(v);
    if (cur?.kind === kind) return [];
    const free = this.tools
      .filter(t => t.kind === kind && t.attachedTo == null && (t.reservedBy == null || t.reservedBy === v.id))
      .sort((a, b) => (a.load.amount > 0 ? 1000 : 0) + dist(a, v) - ((b.load.amount > 0 ? 1000 : 0) + dist(b, v)));
    const target = free[0];
    if (!target) {
      // Borrow it from a tractor that is just parked.
      const lend = this.tools.find(t => {
        const h = t.kind === kind && t.attachedTo != null && t.attachedTo !== v.id ? this.vehicle(t.attachedTo) : undefined;
        return h && this.isIdle(h) && (t.reservedBy == null || t.reservedBy === v.id) && t.load.amount <= 0;
      });
      if (lend) {
        const steps: Step[] = [];
        if (cur) {
          const p = this.attachPoint(cur);
          steps.push({ t: 'goto', x: p.x, y: p.y }, { t: 'detach' });
        }
        const p = this.attachPoint(lend);
        steps.push({ t: 'waitTool', toolId: lend.id }, { t: 'goto', x: p.x, y: p.y }, { t: 'attach', toolId: lend.id });
        if (reserve) {
          const holder = this.vehicle(lend.attachedTo!)!;
          this.cancel(holder);
          holder.steps = [{ t: 'goto', x: p.x, y: p.y }, { t: 'detach' }, { t: 'park' }];
          lend.reservedBy = v.id;
        }
        return steps;
      }
      const busy = this.tools.find(t => t.kind === kind && t.attachedTo != null);
      const holder = busy && this.vehicle(busy.attachedTo!);
      return holder
        ? `The ${TOOL_NAMES[kind]} is hitched to ${holder.name}. Buy another one in the Shop.`
        : `You don't own a ${TOOL_NAMES[kind]} yet.`;
    }
    const steps: Step[] = [];
    if (cur) {
      const p = this.attachPoint(cur);
      steps.push({ t: 'goto', x: p.x, y: p.y }, { t: 'detach' });
    }
    const p = this.attachPoint(target);
    steps.push({ t: 'goto', x: p.x, y: p.y }, { t: 'attach', toolId: target.id });
    if (reserve) target.reservedBy = v.id;
    return steps;
  }

  private deliverSteps(dest: Dest): Step[] {
    const p = dest === 'sell' ? SELL_UNLOAD : SILO_UNLOAD;
    return [{ t: 'goto', x: p.x, y: p.y }, { t: 'unload', dest }];
  }

  /** Validates a field job for a vehicle without changing anything. */
  checkFieldOp(v: Vehicle, field: Field, op: Op, crop?: CropId): { ok: boolean; reason?: string; crop?: CropId; cells: number } {
    if (op === 'harvest') {
      if (!isHarvester(v)) return { ok: false, reason: 'Needs a combine or root harvester', cells: 0 };
      const roots = v.kind === 'rootHarvester';
      const sum = field.summary(this.clock);
      const mine = CROPS.filter(c => !!CROP_DEFS[c].root === roots);
      const otherReady = CROPS.some(c => !mine.includes(c) && sum.readyCounts[c] > 0);
      let c: CropId | undefined;
      if (v.tank.amount > 0 && v.tank.crop) {
        c = v.tank.crop;
        if (sum.readyCounts[c] === 0) {
          return { ok: false, reason: sum.ready ? `Tank holds ${CROP_DEFS[c].name} — unload it first` : 'Nothing is ready yet', cells: 0 };
        }
      } else {
        c = mine.slice().sort((a, b) => sum.readyCounts[b] - sum.readyCounts[a])[0];
        if (sum.readyCounts[c] === 0) {
          if (otherReady) return { ok: false, reason: roots ? 'This crop needs a combine' : 'Root crops need a root harvester', cells: 0 };
          return { ok: false, reason: sum.growing ? `Still growing (${sum.growthPct}%)` : 'Nothing to harvest', cells: 0 };
        }
      }
      return { ok: true, crop: c, cells: sum.readyCounts[c] };
    }
    if (v.kind !== 'tractor') return { ok: false, reason: 'Needs a tractor', cells: 0 };
    const n = this.eligibleCount(field, op);
    if (n === 0) {
      const reasons: Record<Op, string> = {
        plow: 'Nothing to plow', seed: 'Plow the field first', harvest: '',
        fertilize: 'Plow or seed first (max 2 passes)', lime: 'Soil doesn\u2019t need lime yet',
        roll: 'Roll right after seeding', weed: 'Only young crops can be weeded', spray: 'No growing crop to spray',
      };
      return { ok: false, reason: reasons[op], cells: 0 };
    }
    const cost = op === 'seed' ? (crop ? CROP_DEFS[crop].seedCostPerCell : 0) : OP_DEFS[op].costPerCell ?? 0;
    if (cost > 0 && this.money < cost * Math.min(n, 20)) {
      return { ok: false, reason: `Not enough money (${op === 'seed' ? 'seeds' : 'supplies'})`, cells: n };
    }
    const kind = toolForOp(op, crop);
    if (kind && (op !== 'seed' || crop)) {
      const tools = this.ensureTool(v, kind, false);
      if (typeof tools === 'string') return { ok: false, reason: tools, cells: n };
    }
    return { ok: true, crop, cells: n };
  }

  orderFieldOp(vid: number, fieldId: number, op: Op, crop?: CropId): string | null {
    const v = this.vehicle(vid);
    const field = this.world.fields.get(fieldId);
    if (!v || !field) return 'Not available';
    if (op === 'seed' && !crop) return 'Pick a crop';
    const check = this.checkFieldOp(v, field, op, crop);
    if (!check.ok) return check.reason ?? 'Not possible';
    this.cancel(v);
    const pre: Step[] = [];
    const kind = v.kind === 'tractor' ? toolForOp(op, crop) : undefined;
    if (kind) {
      const tools = this.ensureTool(v, kind, true);
      if (typeof tools === 'string') return tools;
      pre.push(...tools);
    }
    let level: number | undefined;
    if (op === 'fertilize') {
      let min = 2;
      for (let i = 0; i < field.cells.length; i++) if (this.eligible(field, i, op)) min = Math.min(min, field.fert[i]);
      level = min + 1;
    }
    v.steps = [...pre, { t: 'work', op, fieldId, crop: check.crop, level }, { t: 'park' }];
    return null;
  }

  orderUnloadCombine(tid: number, cid: number): string | null {
    const t = this.vehicle(tid);
    const c = this.vehicle(cid);
    if (!t || !c || t.kind !== 'tractor' || !isHarvester(c)) return 'Not available';
    const cur = this.toolOf(t);
    const pre: Step[] = [];
    if (cur?.kind === 'wagon' && cur.load.amount > 0 && c.tank.crop && cur.load.crop !== c.tank.crop) {
      pre.push(...this.deliverSteps(this.deliverTo));
    }
    const tools = this.ensureTool(t, 'wagon', false);
    if (typeof tools === 'string') return tools;
    this.cancel(t);
    const hitch = this.ensureTool(t, 'wagon', true) as Step[];
    t.steps = [...pre, ...hitch, { t: 'follow', combineId: c.id }, ...this.deliverSteps(this.deliverTo), { t: 'park' }];
    return null;
  }

  orderDeliver(vid: number): string | null {
    const v = this.vehicle(vid);
    if (!v) return 'Not available';
    const info = this.cargoOf(v);
    if (!info || info.cargo.amount <= 0) return 'Nothing to unload';
    this.cancel(v);
    v.steps = [...this.deliverSteps(this.deliverTo), { t: 'park' }];
    return null;
  }

  orderPark(vid: number) {
    const v = this.vehicle(vid);
    if (!v) return;
    this.cancel(v);
    v.steps = [{ t: 'park' }];
  }

  orderDetach(vid: number): string | null {
    const v = this.vehicle(vid);
    const cur = v && this.toolOf(v);
    if (!v || !cur) return 'No tool attached';
    this.cancel(v);
    const p = this.attachPoint(cur);
    v.steps = [{ t: 'goto', x: p.x, y: p.y }, { t: 'detach' }, { t: 'park' }];
    return null;
  }

  // ---------- fields ----------

  createField(poly: Pt[]): string | null {
    const res = this.world.validateOutline(poly, this.owned);
    if (!res.ok) return res.reason ?? 'Invalid field';
    const f = new Field(this.nextFieldId++, poly, res.cells);
    this.world.addField(f);
    this.stats.fields = this.world.fields.size;
    this.events.emit('fields');
    return null;
  }

  deleteField(id: number) {
    for (const v of this.vehicles) {
      if (v.steps.some(s => s.t === 'work' && s.fieldId === id)) this.orderPark(v.id);
    }
    this.world.removeField(id);
    this.events.emit('fields');
  }

  // ---------- economy ----------

  buyParcel(i: number): string | null {
    if (this.owned.has(i)) return 'Already owned';
    const price = parcelPrice(i);
    if (this.money < price) return 'Not enough money';
    this.money -= price;
    this.owned.add(i);
    this.stats.parcels = this.owned.size;
    this.events.emit('parcels');
    const r = parcelRect(i);
    this.events.emit('money', r.x + r.w / 2, r.y + r.h / 2, -price);
    return null;
  }

  buyItem(kind: VehicleKind | ToolKind): string | null {
    const item = SHOP_ITEMS.find(s => s.id === kind);
    if (!item) return 'Unknown item';
    if (this.money < item.cost) return 'Not enough money';
    this.money -= item.cost;
    if (kind === 'tractor' || kind === 'combine' || kind === 'rootHarvester') {
      this.addVehicle(kind);
      this.stats.vehiclesBought++;
    } else {
      this.addTool(kind);
    }
    this.events.emit('fleet');
    return null;
  }

  buyUpgrade(id: UpgradeId): string | null {
    const lvl = this.upgrades[id];
    const next = UPGRADES[id].levels[lvl + 1];
    if (!next) return 'Fully upgraded';
    if (this.money < next.cost) return 'Not enough money';
    this.money -= next.cost;
    this.upgrades[id]++;
    this.stats.upgrades++;
    this.events.emit('fleet');
    return null;
  }

  sellSilo(crop: CropId): number {
    const amt = this.silo[crop];
    if (amt <= 0) return 0;
    const earned = (amt / 1000) * this.prices[crop];
    this.money += earned;
    this.silo[crop] = 0;
    this.stats.soldLiters += amt;
    this.stats.earned += earned;
    this.events.emit('money', SILO_UNLOAD.x, SILO_UNLOAD.y - 2, earned);
    return earned;
  }

  // ---------- persistence ----------

  save() {
    const cleanSteps = (steps: Step[]): Step[] => steps.map(s => {
      if (s.t === 'work') return { t: 'work', op: s.op, fieldId: s.fieldId, crop: s.crop, level: s.level };
      if (s.t === 'attach') return { t: 'attach', toolId: s.toolId };
      if (s.t === 'detach') return { t: 'detach' };
      if (s.t === 'waitTool') return s;
      return s;
    });
    return {
      v: 1,
      savedAt: Date.now(),
      money: this.money,
      clock: this.clock,
      speedIdx: this.speedIdx,
      owned: [...this.owned],
      fields: [...this.world.fields.values()].map(f => f.save()),
      vehicles: this.vehicles.map(v => ({
        id: v.id, kind: v.kind, name: v.name, x: v.x, y: v.y, heading: v.heading, slot: v.slot,
        toolId: v.toolId, tank: v.tank, steps: cleanSteps(v.steps), autoUnload: v.autoUnload,
      })),
      tools: this.tools,
      silo: this.silo,
      prices: this.prices,
      priceHistory: this.priceHistory,
      upgrades: this.upgrades,
      stats: this.stats,
      goalIdx: this.goalIdx,
      deliverTo: this.deliverTo,
      muted: this.muted,
      weather: this.weather,
      weatherNext: this.weatherNext,
      weatherChangeAt: this.weatherChangeAt,
      nextId: this.nextId,
      nextFieldId: this.nextFieldId,
    };
  }

  static load(data: ReturnType<Game['save']>): { game: Game; offline: OfflineReport } {
    const g = new Game();
    g.money = data.money;
    g.clock = data.clock;
    g.speedIdx = data.speedIdx ?? 0;
    g.owned = new Set(data.owned);
    for (const fs of data.fields as FieldSave[]) g.world.addField(Field.load(fs));
    g.vehicles = data.vehicles.map(v => ({ ...v, status: 'Idle', moving: false, working: null, unloadingTo: null, waiting: false }));
    g.tools = data.tools;
    // Older saves know fewer crops; keep defaults for the new ones.
    g.silo = { ...g.silo, ...data.silo };
    g.prices = { ...g.prices, ...data.prices };
    g.priceHistory = { ...g.priceHistory, ...data.priceHistory };
    for (const c of CROPS) if (g.priceHistory[c].length === 0) g.priceHistory[c].push(g.prices[c]);
    g.upgrades = { ...g.upgrades, ...data.upgrades };
    g.stats = { ...newStats(), ...data.stats };
    g.goalIdx = data.goalIdx;
    g.deliverTo = data.deliverTo;
    g.muted = data.muted;
    if (data.weather) {
      g.weather = data.weather;
      g.weatherNext = data.weatherNext;
      g.weatherChangeAt = data.weatherChangeAt;
    } else {
      g.weatherChangeAt = data.clock + 5 * 60;
    }
    g.nextId = data.nextId;
    g.nextFieldId = data.nextFieldId;

    // Hybrid time: the farm keeps growing while closed, at a slower rate.
    const elapsedSec = Math.max(0, (Date.now() - data.savedAt) / 1000);
    const minutes = Math.min(elapsedSec * GAME_MIN_PER_SEC * OFFLINE_RATE, OFFLINE_CAP_MIN);
    const startDay = g.day;
    g.clock += minutes;
    const days = g.day - startDay;
    for (let d = 0; d < days; d++) g.newDay();
    return { game: g, offline: { minutes, days } };
  }
}
