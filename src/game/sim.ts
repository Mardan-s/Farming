import {
  AUTO_UNLOAD_THRESHOLD, COMBINE_SPEED, COMBINE_WORK_FACTOR, COMBINE_TANK, CROPS, CROP_DEFS, FIXED_TOOL_WIDTH,
  GAME_MIN_PER_SEC, minutesPerSec, HEADER_OFFSET, HEADER_WIDTH, HITCH_OFFSET, LIME_HARVESTS, MINUTES_PER_DAY, OFFLINE_CAP_MIN,
  OFFLINE_RATE, OP_DEFS, PLOW_WIDTH, ROOT_SPEED, ROOT_TANK, SEEDER_WIDTH, SELL_UNLOAD, SHOP_ITEMS, SILO_CAP, SILO_UNLOAD,
  SPEEDS, START_MONEY, START_PARCEL, TOOL_LEN, TOOL_SLOTS, TRACTOR_SPEED, UNLOAD_RATE, UPGRADES, VEHICLE_SLOTS,
  WAGON_CAP, WEATHER_DEFS, WEATHER_HOURS, WORK_SPEED_FACTOR, emptyCropRecord, parcelPrice, slotPos,
  FUEL_CAP, FUEL_PRICE, FUEL_USE, LOAN_DAILY_RATE, LOAN_MAX, LOAN_STEP, OVERRIPE_DAYS, PUMP, REFUEL_RATE,
  REPAIR_COST_PER_PCT, SEASONS, SEASON_DAYS, SEASON_NAMES, STORM_CHANCE, WAGE_PER_SEC, WEAR_PER_SEC, WET_LIMIT, WET_RATE,
  type CropId, type Op, type Season, type ToolKind, type UpgradeId, type VehicleKind, type Weather,
} from './config';
import { planPasses, type Axis } from './coverage';
import { blockedAt, findPath, isRoad } from './path';
import { CellState, Field, READY_STAGE, Weeds, type FieldSave } from './field';
import { angleLerp, dist, type Pt } from './geometry';
import { GOALS, newStats, type Stats } from './goals';
import { World, parcelRect } from './world';
import { MAP_W } from './config';

export type { Op };
export type Dest = 'silo' | 'sell';

export interface Cargo { crop: CropId | null; amount: number }

export interface Need { op: Op; priority: number; why: string }

export interface Waypoint { x: number; y: number; work?: { axis: Axis; start: number; width: number } }

export type Step =
  | { t: 'goto'; x: number; y: number }
  | { t: 'park' }
  | { t: 'attach'; toolId: number; timer?: number }
  | { t: 'detach'; timer?: number }
  | { t: 'waitTool'; toolId: number }
  | { t: 'work'; op: Op; fieldId: number; crop?: CropId; level?: number; path?: Waypoint[]; idx?: number; rounds?: number; abort?: boolean }
  | { t: 'follow'; combineId: number }
  | { t: 'unload'; dest: Dest; earned?: number }
  | { t: 'refuel' }
  | { t: 'handover'; fieldId: number; op: Op; crop?: CropId; heading: number };

export type Expense = 'fuel' | 'wages' | 'repairs' | 'interest' | 'supplies';
export type Ledger = Record<Expense | 'sales', number>;
const emptyLedger = (): Ledger => ({ sales: 0, fuel: 0, wages: 0, repairs: 0, interest: 0, supplies: 0 });

/** What the driven machine can do where it stands; the driving HUD shows buttons from this. */
export interface DriveContext {
  op: Op | null;
  opLabel: string;
  lowered: boolean;
  unload: Dest | null;
  refuel: boolean;
  hitch: 'unhitch' | 'hitch' | null;
  hitchName: string;
}

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
  fuel: number;
  condition: number; // 0-100 %
  // Runtime-only flags, rebuilt every frame.
  status: string;
  moving: boolean;
  working: Op | null;
  unloadingTo: number | null;
  waiting: boolean;
  /** Signed ground speed while you drive it. */
  speed: number;
  /** Planned road route to the current destination (runtime only). */
  route?: Pt[];
  routeTo?: Pt;
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

/** "Spring or Autumn" */
export function plantWindow(crop: CropId) {
  return CROP_DEFS[crop].seasons.map(x => SEASON_NAMES[x]).join(' or ');
}

function gauss() {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface OfflineReport { minutes: number; days: number }

export function seasonAt(clock: number): Season {
  return SEASONS[Math.floor(Math.floor(clock / MINUTES_PER_DAY) / SEASON_DAYS) % SEASONS.length];
}

/** Game minutes of crop growth between two clock times: everything except winter. */
export function growthBetween(from: number, to: number) {
  let g = 0;
  let c = from;
  while (c < to) {
    const dayEnd = (Math.floor(c / MINUTES_PER_DAY) + 1) * MINUTES_PER_DAY;
    const end = Math.min(to, dayEnd);
    if (seasonAt(c) !== 'winter') g += end - c;
    c = end;
  }
  return g;
}

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
  /** Crops the player wants a message about when their price is high. */
  priceAlerts: CropId[] = [];
  muted = false;
  weather: Weather = 'sun';
  weatherNext: Weather = 'cloudy';
  weatherChangeAt = 6 * 60 + 5 * 60;
  /** Growth clock in game minutes: runs with the clock but stops in winter. */
  growth = 6 * 60;
  /** How wet the crops are, 0..1. Above WET_LIMIT combines can't harvest. */
  wetness = 0;
  loan = 0;
  ledger = { today: emptyLedger(), yesterday: emptyLedger() };
  // Driving.
  drivenId: number | null = null;
  input = { steer: 0, throttle: 0 };
  implDown = false;
  driveCrop: CropId = 'wheat';
  driveSpread: 'fertilize' | 'lime' = 'fertilize';
  private driveTouched = new Set<number>();
  private lastWork: Pt | null = null;
  private stormHit = new Set<number>();
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
  get season(): Season { return seasonAt(this.clock); }
  get seasonDay() { return (Math.floor(this.clock / MINUTES_PER_DAY) % SEASON_DAYS) + 1; }
  get seasonName() { return SEASON_NAMES[this.season]; }
  get tooWet() { return this.wetness > WET_LIMIT; }
  get driven() { return this.drivenId == null ? undefined : this.vehicle(this.drivenId); }
  isDriven(v: Vehicle) { return this.drivenId === v.id; }
  canPlant(crop: CropId) { return CROP_DEFS[crop].seasons.includes(this.season); }

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
    const base = v.kind === 'tractor' ? TRACTOR_SPEED[this.upgrades.engine] : v.kind === 'rootHarvester' ? ROOT_SPEED : COMBINE_SPEED;
    return base * this.healthFactor(v);
  }

  /** Empty tanks limp along; worn machines run slower. */
  healthFactor(v: Vehicle) {
    let k = 1;
    if (v.fuel <= 0) k *= 0.35;
    if (v.condition <= 0) k *= 0.5;
    else if (v.condition < 30) k *= 0.75;
    return k;
  }

  repairCost(v: Vehicle) { return Math.ceil((100 - v.condition) * REPAIR_COST_PER_PCT[v.kind]); }

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

  isIdle(v: Vehicle) {
    return !this.isDriven(v) && (v.steps.length === 0 || (v.steps.length === 1 && v.steps[0].t === 'park'));
  }

  /** A harvester that is cutting right now, by AI or by you. */
  isHarvesting(c: Vehicle) { return this.isDriven(c) ? this.implDown : c.steps[0]?.t === 'work'; }

  /** Whether a hitched tool is unfolded and working. */
  toolWorking(t: Tool) {
    const v = t.attachedTo != null ? this.vehicle(t.attachedTo) : undefined;
    if (!v) return false;
    return this.isDriven(v) ? this.implDown : v.steps[0]?.t === 'work';
  }

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
      case 'harvest': return seeded && field.isReady(i, this.growth) && (!crop || field.cropAt(i) === crop);
      case 'fertilize': return field.fert[i] < Math.min(2, level) && (s === CellState.Plowed || (seeded && field.stage(i, this.growth) < READY_STAGE));
      case 'lime': return field.lime[i] === 0;
      case 'roll': return seeded && !field.rolled[i] && field.stage(i, this.growth) <= 1;
      case 'weed': return seeded && field.weeds[i] !== Weeds.Protected && field.stage(i, this.growth) <= 2;
      case 'spray': return seeded && field.weeds[i] !== Weeds.Protected && field.stage(i, this.growth) < READY_STAGE;
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
      autoUnload: true, fuel: FUEL_CAP[kind], condition: 100,
      status: 'Idle', moving: false, working: null, unloadingTo: null, waiting: false, speed: 0,
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
    const prevSeason = this.season;
    const mins = dt * minutesPerSec(this.clock) * this.speed;
    this.growth += growthBetween(this.clock, this.clock + mins);
    this.clock += mins;
    if (this.day !== prevDay) this.newDay();
    if (this.season !== prevSeason) this.events.emit('season', this.season);
    if (this.clock >= this.weatherChangeAt) this.advanceWeather();
    this.wetness = Math.min(1, Math.max(0, this.wetness + WET_RATE[this.weather] * mins * (this.weather === 'sun' && !this.isDaytime ? 0.4 : 1)));

    for (const v of this.vehicles) { v.moving = false; v.working = null; v.unloadingTo = null; v.waiting = false; }
    for (const v of this.vehicles) {
      if (this.isDriven(v)) this.updateDriven(v, dt);
      else this.updateVehicle(v, dt);
      this.runningCosts(v, dt);
    }
    this.updateTools();

    this.tick += dt;
    if (this.tick >= 1) {
      this.tick = 0;
      this.dispatchUnloaders();
      this.growWeeds();
      this.stormDamage();
      this.checkGoals();
    }
  }

  get isDaytime() { const h = this.timeOfDay / 60; return h >= 6 && h < 20; }

  /** Fuel burn, machine wear and hired-worker wages for one frame. */
  private runningCosts(v: Vehicle, dt: number) {
    const driven = this.isDriven(v);
    const busy = driven || v.steps.length > 0;
    if (!busy) return;
    const use = v.working ? FUEL_USE.work : v.moving ? FUEL_USE.drive : FUEL_USE.idle;
    if (v.fuel > 0) v.fuel = Math.max(0, v.fuel - use * dt);
    const wear = v.working ? WEAR_PER_SEC.work : v.moving ? WEAR_PER_SEC.drive : 0;
    const before = v.condition;
    v.condition = Math.max(0, v.condition - wear * dt);
    if (before >= 30 && v.condition < 30) this.events.emit('toast', `🔧 ${v.name} is worn out and slowing down — repair it`, 'bad');
    const forYou = v.steps.some(st => st.t === 'handover');
    if (!driven && !v.waiting && !forYou) this.spend('wages', WAGE_PER_SEC * dt);
  }

  spend(kind: Expense, amount: number) {
    this.money -= amount;
    this.ledger.today[kind] += amount;
  }

  private earn(amount: number) {
    this.money += amount;
    this.ledger.today.sales += amount;
  }

  /** Storms flatten ripe crops, and crops left ripe too long go down fastest. */
  private stormDamage() {
    if (this.weather !== 'storm') { this.stormHit.clear(); return; }
    for (const f of this.world.fields.values()) {
      let hit = 0;
      for (let i = 0; i < f.cells.length; i++) {
        if (f.damaged[i] || !f.isReady(i, this.growth)) continue;
        const def = CROP_DEFS[f.cropAt(i)!];
        const over = this.growth - f.planted[i] > (def.growDays + OVERRIPE_DAYS) * MINUTES_PER_DAY;
        if (Math.random() >= (over ? STORM_CHANCE.overripe : STORM_CHANCE.ripe)) continue;
        f.damaged[i] = 1;
        hit++;
        this.events.emit('cell', f.id, i);
      }
      if (hit && !this.stormHit.has(f.id)) {
        this.stormHit.add(f.id);
        this.events.emit('toast', `⛈️ The storm is flattening ripe crops on Field ${f.id}`, 'bad');
      }
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
      const [lo, hi] = WEATHER_HOURS[this.weather];
      this.weatherChangeAt += (lo + Math.random() * (hi - lo)) * 60;
    }
    this.events.emit('weather', this.weather);
    if (this.weatherNext === 'storm') {
      const ripe = [...this.world.fields.values()].filter(f => f.summary(this.growth).ready > 0);
      if (ripe.length) this.events.emit('toast', `⛈️ Storm on the way — harvest Field ${ripe.map(f => f.id).join(', ')} before it hits`, 'bad');
    }
  }

  /** Weeds creep into growing crops that haven't been weeded or sprayed. */
  private growWeeds() {
    for (const f of this.world.fields.values()) {
      for (let i = 0; i < f.cells.length; i++) {
        if (f.state[i] !== CellState.Seeded || f.weeds[i] !== Weeds.None || !f.weedProne(i)) continue;
        if (f.stage(i, this.growth) < 2) continue;
        f.weeds[i] = Weeds.Present;
        this.events.emit('cell', f.id, i);
      }
    }
  }

  private newDay() {
    this.ledger.yesterday = this.ledger.today;
    this.ledger.today = emptyLedger();
    if (this.loan > 0) this.spend('interest', this.loan * LOAN_DAILY_RATE);
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
      const prev = this.priceHistory[c][this.priceHistory[c].length - 1] ?? this.prices[c];
      this.priceHistory[c].push(this.prices[c]);
      if (this.priceHistory[c].length > 14) this.priceHistory[c].shift();
      const high = this.highPrice(c);
      if (this.priceAlerts.includes(c) && this.prices[c] >= high && prev < high) {
        this.events.emit('toast', `📈 ${CROP_DEFS[c].name} is selling high today: $${this.prices[c]} per 1,000 L`, 'good');
      }
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
        if (this.driveTo(v, step.x, step.y, this.speedOf(v), dt)) v.steps.shift();
        break;
      case 'park': {
        v.status = 'Returning to the farmyard';
        const p = slotPos(VEHICLE_SLOTS, v.slot);
        if (this.driveTo(v, p.x, p.y, this.speedOf(v), dt)) v.steps.shift();
        break;
      }
      case 'attach': {
        const tool = this.tool(step.toolId);
        v.status = `Hitching ${tool ? TOOL_NAMES[tool.kind] : 'tool'}`;
        step.timer = (step.timer ?? 0) + dt;
        const want = tool?.heading ?? 0;
        v.heading = angleLerp(v.heading, want, Math.min(1, dt * 10));
        if (step.timer < 0.4) break;
        v.heading = want;
        if (tool && tool.attachedTo == null) {
          tool.attachedTo = v.id;
          tool.reservedBy = null;
          tool.x = v.x - Math.cos(want) * (HITCH_OFFSET + TOOL_LEN[tool.kind] / 2);
          tool.y = v.y - Math.sin(want) * (HITCH_OFFSET + TOOL_LEN[tool.kind] / 2);
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
      case 'refuel': this.stepRefuel(v, dt); break;
      case 'handover': this.stepHandover(v, step, dt); break;
    }
  }

  private stepRefuel(v: Vehicle, dt: number) {
    const cap = FUEL_CAP[v.kind];
    const amt = Math.min(REFUEL_RATE * dt, cap - v.fuel);
    v.fuel += amt;
    this.spend('fuel', amt * FUEL_PRICE);
    v.status = `Refueling · ${Math.round((v.fuel / cap) * 100)}%`;
    if (v.fuel >= cap - 0.01) {
      v.fuel = cap;
      v.steps.shift();
    }
  }

  /** Lines the machine up with the first row, then puts you in the seat with the tool lowered. */
  private stepHandover(v: Vehicle, s: Extract<Step, { t: 'handover' }>, dt: number) {
    const field = this.world.fields.get(s.fieldId);
    if (!field) { v.steps.shift(); return; }
    if (this.drivenId != null) { v.status = `Waiting for you at Field ${field.id}`; v.waiting = true; return; }
    v.heading = angleLerp(v.heading, s.heading, Math.min(1, dt * 6));
    v.status = `Ready for you at Field ${field.id}`;
    if (Math.abs(Math.atan2(Math.sin(s.heading - v.heading), Math.cos(s.heading - v.heading))) > 0.05) return;
    v.heading = s.heading;
    const tool = this.toolOf(v);
    if (tool) {
      // Straighten the implement behind the tractor.
      const d = HITCH_OFFSET + TOOL_LEN[tool.kind] / 2;
      tool.heading = v.heading;
      tool.x = v.x - Math.cos(v.heading) * d;
      tool.y = v.y - Math.sin(v.heading) * d;
    }
    this.startDriving(v.id);
    if (s.op === 'seed' && s.crop) this.driveCrop = s.crop;
    if (s.op === 'fertilize' || s.op === 'lime') this.driveSpread = s.op;
    const err = this.toggleImplement();
    this.events.emit('handover', v.id, s.fieldId, s.op, err);
  }

  /** Steps to top up at the pump first when the tank is getting low. */
  private fuelSteps(v: Vehicle, below = 0.3): Step[] {
    return v.fuel < FUEL_CAP[v.kind] * below ? [{ t: 'goto', x: PUMP.x + 1.2, y: PUMP.y }, { t: 'refuel' }] : [];
  }

  /** Travels along a planned route (roads first, around buildings and other fields). */
  private driveTo(v: Vehicle, tx: number, ty: number, speed: number, dt: number, retarget = 0.5): boolean {
    if (Math.hypot(tx - v.x, ty - v.y) < 1.5) {
      v.route = undefined;
      return this.moveTo(v, tx, ty, speed, dt);
    }
    if (!v.route || !v.routeTo || Math.hypot(v.routeTo.x - tx, v.routeTo.y - ty) > retarget) {
      v.route = findPath(this.world, v, { x: tx, y: ty });
      v.routeTo = { x: tx, y: ty };
    }
    const wp = v.route[0] ?? { x: tx, y: ty };
    const road = isRoad(v.x, v.y) ? 1.25 : 1;
    if (this.moveTo(v, wp.x, wp.y, speed * road, dt)) {
      v.route.shift();
      if (v.route.length === 0) { v.route = undefined; return Math.hypot(tx - v.x, ty - v.y) < 0.05; }
    }
    return false;
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
    if (v.fuel < FUEL_CAP[v.kind] * 0.06) {
      // Nip back to the pump, then restart the current pass from its beginning.
      s.idx = Math.floor(s.idx! / 4) * 4;
      v.steps.unshift(...this.fuelSteps(v, 1));
      this.events.emit('toast', `⛽ ${v.name} is low on fuel and heading to the pump`, 'info');
      return;
    }
    const wp = s.path[s.idx!];
    if (s.op === 'harvest' && wp.work && this.tooWet) {
      v.waiting = true;
      v.status = 'Crop too wet to harvest — waiting for it to dry';
      return;
    }
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
    const arrived = wp.work ? this.moveTo(v, wp.x, wp.y, speed, dt) : this.driveTo(v, wp.x, wp.y, speed, dt);
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
        field.planted[i] = this.growth;
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
    if (cost > 0) this.spend('supplies', cost);
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
    const combineWorking = this.isHarvesting(c);
    const mismatch = load.amount > 0 && c.tank.amount > 0 && c.tank.crop !== load.crop;
    if (load.amount >= cap - 1 || (!combineWorking && c.tank.amount <= 0.5) || mismatch) {
      v.steps.shift();
      return;
    }
    const target = this.unloadSpot(c);
    const d = dist(v, target);
    if (d > 0.8) {
      v.status = `Driving to ${c.name}`;
      this.driveTo(v, target.x, target.y, this.speedOf(v) * 1.3, dt, 3);
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
      this.earn(earned);
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
      const working = this.isHarvesting(c);
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
    if (this.isDriven(v)) this.stopDriving();
    v.steps = [];
    for (const t of this.tools) if (t.reservedBy === v.id) t.reservedBy = null;
  }

  /** Where a tractor stops to hitch a tool, wherever the tool was left. */
  private attachPoint(t: Tool): Pt {
    const d = HITCH_OFFSET + TOOL_LEN[t.kind] / 2;
    return { x: t.x + Math.cos(t.heading) * d, y: t.y + Math.sin(t.heading) * d };
  }

  /** Where a tractor stops to drop a tool back in its farmyard slot. */
  private homePoint(t: Tool): Pt {
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
          const p = this.homePoint(cur);
          steps.push({ t: 'goto', x: p.x, y: p.y }, { t: 'detach' });
        }
        // The lending tractor drops it at home, so hitch it there.
        const p = this.homePoint(lend);
        steps.push({ t: 'waitTool', toolId: lend.id }, { t: 'goto', x: p.x, y: p.y }, { t: 'attach', toolId: lend.id });
        if (reserve) {
          const holder = this.vehicle(lend.attachedTo!)!;
          this.cancel(holder);
          const h = this.homePoint(lend);
          holder.steps = [{ t: 'goto', x: h.x, y: h.y }, { t: 'detach' }, { t: 'park' }];
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
      const p = this.homePoint(cur);
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
      const sum = field.summary(this.growth);
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
    if (op === 'seed' && crop && !this.canPlant(crop)) {
      return { ok: false, reason: `${CROP_DEFS[crop].name} is planted in ${plantWindow(crop)}`, cells: n };
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
    v.steps = [...this.fuelSteps(v), ...pre, { t: 'work', op, fieldId, crop: check.crop, level }, { t: 'park' }];
    return null;
  }

  /** Like a hired job, but the worker only brings the machine and tool to the field (free), then you drive. */
  orderDriveJob(vid: number, fieldId: number, op: Op, crop?: CropId): string | null {
    const v = this.vehicle(vid);
    const field = this.world.fields.get(fieldId);
    if (!v || !field) return 'Not available';
    if (op === 'seed' && !crop) return 'Pick a crop';
    const check = this.checkFieldOp(v, field, op, crop);
    if (!check.ok) return check.reason ?? 'Not possible';
    if (op === 'harvest' && this.tooWet) return 'The crop is too wet to harvest right now';
    this.cancel(v);
    const kind = v.kind === 'tractor' ? toolForOp(op, crop) : undefined;
    const pre: Step[] = [];
    if (kind) {
      const tools = this.ensureTool(v, kind, true);
      if (typeof tools === 'string') return tools;
      pre.push(...tools);
    }
    // Plan the job as if a worker were doing it, to find the start of the first row.
    const plan = this.buildPath(v, { t: 'work', op, fieldId, crop: check.crop, level: op === 'fertilize' ? 2 : undefined }, field);
    const a = plan[0] ?? field.center, b = plan[1] ?? field.center;
    const heading = Math.atan2(b.y - a.y, b.x - a.x);
    // Stop a machine-length back so the tool starts at the edge.
    const back = v.kind === 'tractor' ? 1.2 : 0.5;
    const dx = Math.cos(heading), dy = Math.sin(heading);
    const reach = isHarvester(v) ? 1.3 : 0.85;
    const start = { x: a.x - dx * back, y: a.y - dy * back };
    // Never hand over parked in a fence or hedge: roll forward until the spot and the bumper are clear.
    for (let i = 0; i < 20 && (blockedAt(start.x, start.y) || blockedAt(start.x + dx * reach, start.y + dy * reach)); i++) {
      start.x += dx * 0.25;
      start.y += dy * 0.25;
    }
    v.steps = [...this.fuelSteps(v), ...pre, { t: 'goto', x: start.x, y: start.y }, { t: 'handover', fieldId, op, crop: check.crop, heading }];
    return null;
  }

  /** What a field needs right now, most important first. Only jobs that are possible now. */
  fieldNeeds(f: Field): Need[] {
    const s = f.summary(this.growth);
    const pct = (n: number) => Math.round((n / s.total) * 100);
    const needs: Need[] = [];
    const can = (op: Op) => this.eligibleCount(f, op) > 0;
    if (s.ready) {
      const storm = this.weather === 'storm' || this.weatherNext === 'storm' ? ' — storm coming!' : '';
      const wet = this.tooWet ? ' — too wet to cut right now' : '';
      needs.push({ op: 'harvest', priority: 100, why: `${pct(s.ready)}% is ripe and ready${wet || storm}` });
    }
    if (can('seed')) {
      const any = CROPS.some(c => this.canPlant(c));
      needs.push(any ? { op: 'seed', priority: 90, why: `Plowed — ${this.seasonName.toLowerCase()} planting` }
        : { op: 'seed', priority: 30, why: 'Plowed — nothing can be planted in winter' });
    }
    if (s.weedy && (can('weed') || can('spray'))) {
      const op = can('weed') && this.tools.some(t => t.kind === 'weeder') ? 'weed' : 'spray';
      needs.push({ op, priority: 85, why: `Weeds on ${pct(s.weedy)}% — costing 25% of that harvest` });
    }
    if (can('plow')) needs.push({ op: 'plow', priority: 80, why: s.grass ? 'Grass — plow it before planting' : 'Stubble — plow for the next crop' });
    if (can('lime')) needs.push({ op: 'lime', priority: s.growing ? 50 : 75, why: `Soil is sour on ${pct(s.needLime)}% — losing 15%` });
    if (can('fertilize')) needs.push({ op: 'fertilize', priority: 60, why: `Fertilizer ${s.fertAvg.toFixed(1)} of 2 passes — +15% each` });
    if (can('roll')) needs.push({ op: 'roll', priority: 55, why: 'Just planted — roll it for +5%' });
    if (!s.weedy && s.growing) {
      const op = can('weed') && this.tools.some(t => t.kind === 'weeder') ? 'weed' : can('spray') ? 'spray' : null;
      if (op) needs.push({ op, priority: 40, why: 'Stop weeds before they spread' });
    }
    return needs.sort((a, b) => b.priority - a.priority);
  }

  /** Picks the best free machine for a job, or explains what's missing. */
  bestVehicleFor(f: Field, op: Op, crop?: CropId): { vehicle?: Vehicle; reason?: string; buy?: VehicleKind | ToolKind } {
    const wantsRoot = op === 'harvest'
      ? CROPS.some(c => CROP_DEFS[c].root && f.summary(this.growth).readyCounts[c] > 0)
        && !CROPS.some(c => !CROP_DEFS[c].root && f.summary(this.growth).readyCounts[c] > 0)
      : false;
    const kind: VehicleKind = op === 'harvest' ? (wantsRoot ? 'rootHarvester' : 'combine') : 'tractor';
    const fleet = this.vehicles.filter(v => v.kind === kind);
    if (fleet.length === 0) return { reason: `You need a ${VEHICLE_NAMES[kind].toLowerCase()}`, buy: kind };
    const tool = kind === 'tractor' ? toolForOp(op, crop) : undefined;
    if (tool && !this.tools.some(t => t.kind === tool)) return { reason: `You need a ${TOOL_NAMES[tool]}`, buy: tool };
    let best: Vehicle | undefined;
    let bestScore = Infinity;
    let lastReason = '';
    for (const v of fleet) {
      const check = this.checkFieldOp(v, f, op, crop);
      if (!check.ok) { lastReason = check.reason ?? ''; continue; }
      if (!this.isIdle(v)) { lastReason = `All ${VEHICLE_NAMES[kind].toLowerCase()}s are busy`; continue; }
      const score = dist(v, f.center) - (tool && this.toolOf(v)?.kind === tool ? 30 : 0);
      if (score < bestScore) { best = v; bestScore = score; }
    }
    return best ? { vehicle: best } : { reason: lastReason || 'No machine can do this now' };
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
    t.steps = [...this.fuelSteps(t, 0.12), ...pre, ...hitch, { t: 'follow', combineId: c.id }, ...this.deliverSteps(this.deliverTo), { t: 'park' }];
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

  orderRefuel(vid: number): string | null {
    const v = this.vehicle(vid);
    if (!v) return 'Not available';
    if (v.fuel >= FUEL_CAP[v.kind] - 1) return 'The tank is already full';
    this.cancel(v);
    v.steps = [...this.fuelSteps(v, 2), { t: 'park' }];
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
    const p = this.homePoint(cur);
    v.steps = [{ t: 'goto', x: p.x, y: p.y }, { t: 'detach' }, { t: 'park' }];
    return null;
  }

  /** Rough seconds, wages and fuel for a hired worker to do a job. */
  estimateJob(v: Vehicle, field: Field, op: Op, crop?: CropId) {
    const cells = this.eligibleCount(field, op, crop);
    let width = this.workWidth(v);
    if (v.kind === 'tractor') {
      const kind = toolForOp(op, crop);
      if (kind) width = this.toolWidth(kind);
    }
    const factor = isHarvester(v) ? COMBINE_WORK_FACTOR : WORK_SPEED_FACTOR;
    const speed = this.speedOf(v) * factor;
    const secs = (cells / Math.max(1, width)) / speed * 1.3 + dist(v, field.center) / this.speedOf(v) * 2;
    return { secs, wage: secs * WAGE_PER_SEC, fuel: secs * FUEL_USE.work * FUEL_PRICE };
  }

  repair(vid: number): string | null {
    const v = this.vehicle(vid);
    if (!v) return 'Not available';
    const cost = this.repairCost(v);
    if (cost <= 0) return 'Already in top shape';
    if (this.money < cost) return 'Not enough money';
    this.spend('repairs', cost);
    v.condition = 100;
    return null;
  }

  borrow(): string | null {
    if (this.loan + LOAN_STEP > LOAN_MAX) return 'The bank won\u2019t lend more';
    this.loan += LOAN_STEP;
    this.money += LOAN_STEP;
    return null;
  }

  repay(): string | null {
    if (this.loan <= 0) return 'No loan to repay';
    const amt = Math.min(LOAN_STEP, this.loan);
    if (this.money < amt) return 'Not enough money';
    this.loan -= amt;
    this.money -= amt;
    return null;
  }

  // ---------- driving ----------

  startDriving(vid: number): string | null {
    const v = this.vehicle(vid);
    if (!v) return 'Not available';
    if (this.drivenId != null) this.stopDriving();
    this.cancel(v);
    this.drivenId = v.id;
    v.speed = 0;
    this.implDown = false;
    this.input = { steer: 0, throttle: 0 };
    this.lastWork = null;
    this.events.emit('drive', v.id);
    return null;
  }

  stopDriving() {
    const v = this.driven;
    this.drivenId = null;
    this.implDown = false;
    this.input = { steer: 0, throttle: 0 };
    if (v) { v.speed = 0; v.steps = v.steps.filter(st => st.t !== 'unload' && st.t !== 'refuel'); }
    this.events.emit('drive', null);
  }

  setDriveInput(steer: number, throttle: number) {
    this.input.steer = Math.max(-1, Math.min(1, steer));
    this.input.throttle = Math.max(-1, Math.min(1, throttle));
  }

  /** The job the driven machine does when its implement is lowered. */
  driveOp(v: Vehicle): Op | null {
    if (isHarvester(v)) return 'harvest';
    const t = this.toolOf(v);
    switch (t?.kind) {
      case 'plow': return 'plow';
      case 'seeder': case 'planter': return 'seed';
      case 'spreader': return this.driveSpread;
      case 'roller': return 'roll';
      case 'weeder': return 'weed';
      case 'sprayer': return 'spray';
      default: return null;
    }
  }

  /** The seed crop the driven seeder will plant, matched to seeder vs root planter. */
  private driveSeedCrop(v: Vehicle): CropId {
    const root = this.toolOf(v)?.kind === 'planter';
    if (!!CROP_DEFS[this.driveCrop].root === root) return this.driveCrop;
    return CROPS.find(c => !!CROP_DEFS[c].root === root && this.canPlant(c)) ?? CROPS.find(c => !!CROP_DEFS[c].root === root)!;
  }

  /** Lowers or raises the implement; returns a reason when it can't be lowered. */
  toggleImplement(): string | null {
    const v = this.driven;
    if (!v) return 'Not driving';
    if (this.implDown) { this.implDown = false; this.driveTouched.clear(); return null; }
    const op = this.driveOp(v);
    if (!op) return isHarvester(v) ? null : this.toolOf(v) ? 'The wagon has nothing to lower' : 'Hitch a tool first';
    if (op === 'seed') {
      const crop = this.driveSeedCrop(v);
      if (!this.canPlant(crop)) return `${CROP_DEFS[crop].name} is planted in ${plantWindow(crop)}`;
      this.driveCrop = crop;
    }
    if (op === 'harvest' && this.tooWet) return 'The crop is too wet to harvest — wait for the sun';
    this.implDown = true;
    this.driveTouched.clear();
    this.lastWork = null;
    return null;
  }

  driveContext(): DriveContext | null {
    const v = this.driven;
    if (!v) return null;
    const op = this.driveOp(v);
    const cargo = this.cargoOf(v);
    const near = (p: Pt, r: number) => dist(v, p) < r;
    let unload: Dest | null = null;
    if (cargo && cargo.cargo.amount > 0) unload = near(SELL_UNLOAD, 5) ? 'sell' : near(SILO_UNLOAD, 4) ? 'silo' : null;
    const tool = this.toolOf(v);
    const nearTool = v.kind === 'tractor' && !tool ? this.hitchableTool(v) : undefined;
    let opLabel = op ? OP_DEFS[op].name : '';
    if (op === 'seed') opLabel = `Plant ${CROP_DEFS[this.driveSeedCrop(v)].name.toLowerCase()}`;
    return {
      op, opLabel, lowered: this.implDown,
      unload,
      refuel: near(PUMP, 3.2) && v.fuel < FUEL_CAP[v.kind] - 1,
      hitch: tool && v.kind === 'tractor' ? 'unhitch' : nearTool ? 'hitch' : null,
      hitchName: tool ? TOOL_NAMES[tool.kind] : nearTool ? TOOL_NAMES[nearTool.kind] : '',
    };
  }

  private hitchableTool(v: Vehicle): Tool | undefined {
    const hx = v.x - Math.cos(v.heading) * HITCH_OFFSET;
    const hy = v.y - Math.sin(v.heading) * HITCH_OFFSET;
    let best: Tool | undefined, bestD = 1.8;
    for (const t of this.tools) {
      if (t.attachedTo != null || (t.reservedBy != null && t.reservedBy !== v.id)) continue;
      const half = TOOL_LEN[t.kind] / 2;
      const d = Math.hypot(t.x + Math.cos(t.heading) * half - hx, t.y + Math.sin(t.heading) * half - hy);
      if (d < bestD) { best = t; bestD = d; }
    }
    return best;
  }

  /** Hitch the tool behind you, or drop the one you're pulling right where it is. */
  driverHitch(): string | null {
    const v = this.driven;
    if (!v || v.kind !== 'tractor') return 'Only tractors pull tools';
    const cur = this.toolOf(v);
    if (cur) {
      cur.attachedTo = null;
      v.toolId = null;
      this.implDown = false;
      return null;
    }
    const t = this.hitchableTool(v);
    if (!t) return 'Back up to a tool to hitch it';
    t.attachedTo = v.id;
    t.reservedBy = null;
    v.toolId = t.id;
    return null;
  }

  driverUnload(): string | null {
    const v = this.driven;
    const dest = this.driveContext()?.unload;
    if (!v || !dest) return 'Drive to the sell point or the silo';
    this.implDown = false;
    v.speed = 0;
    v.steps = [{ t: 'unload', dest }];
    return null;
  }

  driverRefuel(): string | null {
    const v = this.driven;
    if (!v || !this.driveContext()?.refuel) return 'Drive to the fuel pump';
    v.speed = 0;
    v.steps = [{ t: 'refuel' }];
    return null;
  }

  private updateDriven(v: Vehicle, dt: number) {
    const step = v.steps[0];
    if (step?.t === 'unload') { this.stepUnload(v, step, dt); return; }
    if (step?.t === 'refuel') { this.stepRefuel(v, dt); return; }
    v.steps = [];
    const op = this.implDown ? this.driveOp(v) : null;
    const factor = isHarvester(v) ? COMBINE_WORK_FACTOR : WORK_SPEED_FACTOR;
    const maxF = this.speedOf(v) * (op ? factor * 1.25 : 1.3);
    const maxR = 1.6 * this.healthFactor(v);
    const th = this.input.throttle;
    const target = th >= 0 ? th * maxF : th * maxR;
    const braking = Math.sign(target) !== Math.sign(v.speed) && Math.abs(v.speed) > 0.05;
    const rate = (braking ? 7 : 2.6) * dt;
    v.speed += Math.max(-rate, Math.min(rate, target - v.speed));
    if (th === 0 && Math.abs(v.speed) < 0.05) v.speed = 0;
    const wheelbase = isHarvester(v) ? 1.9 : 1.35;
    v.heading += (v.speed * Math.tan(this.input.steer * 0.6) / wheelbase) * dt;
    v.heading = Math.atan2(Math.sin(v.heading), Math.cos(v.heading));
    const nx = v.x + Math.cos(v.heading) * v.speed * dt, ny = v.y + Math.sin(v.heading) * v.speed * dt;
    // Bump into buildings, fences and trees: check the bumper on the side we're moving toward.
    const reach = (isHarvester(v) ? 1.3 : 0.85) * Math.sign(v.speed);
    const fx = nx + Math.cos(v.heading) * reach, fy = ny + Math.sin(v.heading) * reach;
    const px = -Math.sin(v.heading) * 0.4, py = Math.cos(v.heading) * 0.4;
    const hit = (x: number, y: number) => blockedAt(x + px, y + py) || blockedAt(x - px, y - py) || blockedAt(x, y);
    // A machine already touching an obstacle may always move away from it.
    const stuck = hit(v.x + Math.cos(v.heading) * reach, v.y + Math.sin(v.heading) * reach);
    if (!stuck && hit(fx, fy)) {
      if (Math.abs(v.speed) > 1.5) this.events.emit('bump', v.id);
      v.speed = 0;
    } else {
      v.x = nx;
      v.y = ny;
    }
    v.moving = Math.abs(v.speed) > 0.05;
    v.status = op ? `${OP_DEFS[op].verb} · you're driving` : "You're driving";
    this.driverGrain(v, dt);
    if (op) this.driveWork(v, op);
    else this.lastWork = null;
  }

  /** A wagon you drive alongside a harvester takes its grain. */
  private driverGrain(v: Vehicle, dt: number) {
    const wagon = this.toolOf(v);
    if (wagon?.kind !== 'wagon') return;
    const cap = WAGON_CAP[this.upgrades.wagon];
    for (const c of this.vehicles) {
      if (!isHarvester(c) || c.tank.amount <= 0 || dist(this.unloadSpot(c), v) > 1.6) continue;
      if (wagon.load.amount > 0 && wagon.load.crop !== c.tank.crop) continue;
      const amt = Math.min(UNLOAD_RATE * dt, c.tank.amount, cap - wagon.load.amount);
      if (amt <= 0) return;
      wagon.load.crop = c.tank.crop;
      wagon.load.amount += amt;
      c.tank.amount -= amt;
      if (c.tank.amount <= 0.01) { c.tank.amount = 0; c.tank.crop = null; }
      c.unloadingTo = v.id;
      v.status = `Taking grain from ${c.name} · ${Math.round((wagon.load.amount / cap) * 100)}%`;
      return;
    }
  }

  /** Works every field cell under the implement between last frame and this one. */
  private driveWork(v: Vehicle, op: Op) {
    const tool = this.toolOf(v);
    let px: number, py: number, h: number;
    if (isHarvester(v) || !tool) {
      px = v.x + Math.cos(v.heading) * HEADER_OFFSET; py = v.y + Math.sin(v.heading) * HEADER_OFFSET; h = v.heading;
    } else {
      px = tool.x; py = tool.y; h = tool.heading;
    }
    const prev = this.lastWork;
    this.lastWork = { x: px, y: py };
    if (!prev || v.speed <= 0.05) return;
    v.working = op;
    if (op === 'harvest' && this.tooWet) {
      v.status = 'Too wet to harvest — raise the header and wait';
      return;
    }
    const width = this.workWidth(v);
    const nx = -Math.sin(h), ny = Math.cos(h);
    const len = Math.hypot(px - prev.x, py - prev.y);
    const steps = Math.max(1, Math.ceil(len / 0.4));
    const seen = new Set<number>();
    const crop = op === 'seed' ? this.driveSeedCrop(v) : undefined;
    for (let k = 1; k <= steps; k++) {
      const cx = prev.x + (px - prev.x) * (k / steps);
      const cy = prev.y + (py - prev.y) * (k / steps);
      for (let o = -width / 2 + 0.25; o < width / 2; o += 0.5) {
        const x = Math.floor(cx + nx * o), y = Math.floor(cy + ny * o);
        const key = y * MAP_W + x;
        if (seen.has(key)) continue;
        seen.add(key);
        const fid = this.world.fieldIdAt(x, y);
        const field = fid > 0 ? this.world.fields.get(fid) : undefined;
        if (!field) continue;
        const i = this.world.fieldCellIdx[key];
        if (!this.driveCell(v, op, field, i, key, crop)) return;
      }
    }
  }

  /** Returns false when the machine must stop (tank full, no money). */
  private driveCell(v: Vehicle, op: Op, field: Field, i: number, key: number, crop?: CropId): boolean {
    if (op === 'fertilize' && this.driveTouched.has(key)) return true;
    let c = crop;
    if (op === 'harvest') {
      const here = field.cropAt(i);
      if (!here || !!CROP_DEFS[here].root !== (v.kind === 'rootHarvester')) return true;
      if (v.tank.amount > 0 && v.tank.crop !== here) return true;
      c = here;
    }
    if (!this.eligible(field, i, op, c)) return true;
    if (op === 'harvest') {
      const cargo = this.cargoOf(v)!;
      if (cargo.cap - cargo.cargo.amount < CROP_DEFS[c!].yieldPerCell * 1.6) {
        this.implDown = false;
        this.events.emit('toast', `${v.name}'s tank is full — unload into a wagon or at the sell point`, 'bad');
        return false;
      }
    }
    const step: Extract<Step, { t: 'work' }> = { t: 'work', op, fieldId: field.id, crop: c };
    if (!this.applyCell(v, step, field, i)) { this.implDown = false; return false; }
    if (op === 'fertilize') this.driveTouched.add(key);
    this.stats.drivenCells++;
    return true;
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

  /** The price that counts as "high" for a crop: 15% over its usual price. */
  highPrice(c: CropId) { return Math.round(CROP_DEFS[c].basePrice * 1.15); }

  togglePriceAlert(c: CropId) {
    const on = !this.priceAlerts.includes(c);
    this.priceAlerts = on ? [...this.priceAlerts, c] : this.priceAlerts.filter(x => x !== c);
    return on;
  }

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
    this.earn(earned);
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
        toolId: v.toolId, tank: v.tank, steps: this.isDriven(v) ? [] : cleanSteps(v.steps), autoUnload: v.autoUnload,
        fuel: v.fuel, condition: v.condition,
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
      growth: this.growth,
      wetness: this.wetness,
      loan: this.loan,
      ledger: this.ledger,
      driveCrop: this.driveCrop,
      driveSpread: this.driveSpread,
      priceAlerts: this.priceAlerts,
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
    g.vehicles = data.vehicles.map(v => ({
      ...v, fuel: v.fuel ?? FUEL_CAP[v.kind], condition: v.condition ?? 100,
      status: 'Idle', moving: false, working: null, unloadingTo: null, waiting: false, speed: 0,
    }));
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
    // Before seasons, crops grew on the plain clock. Start those farms at the beginning of spring.
    g.growth = data.growth ?? data.clock;
    if (data.growth == null) {
      const cycle = SEASONS.length * SEASON_DAYS;
      const day = Math.floor(g.clock / MINUTES_PER_DAY);
      const spring = Math.floor(day / cycle) * cycle * MINUTES_PER_DAY + (g.clock % MINUTES_PER_DAY);
      g.weatherChangeAt += spring - g.clock;
      g.clock = spring;
    }
    g.wetness = data.wetness ?? 0;
    g.loan = data.loan ?? 0;
    if (data.ledger) g.ledger = data.ledger;
    if (data.driveCrop) g.driveCrop = data.driveCrop;
    if (data.driveSpread) g.driveSpread = data.driveSpread;
    if (data.priceAlerts) g.priceAlerts = data.priceAlerts.filter(c => CROPS.includes(c));
    g.nextId = data.nextId;
    g.nextFieldId = data.nextFieldId;
    // Rain passes quickly now; don't keep an old save stuck in a long wet spell.
    if (g.weather === 'rain' || g.weather === 'storm') g.weatherChangeAt = Math.min(g.weatherChangeAt, g.clock + 2 * 60);
    if (g.weatherNext === 'rain' || g.weatherNext === 'storm') g.weatherNext = 'sun';

    // Hybrid time: the farm keeps growing while closed, at a slower rate.
    const elapsedSec = Math.max(0, (Date.now() - data.savedAt) / 1000);
    const minutes = Math.min(elapsedSec * GAME_MIN_PER_SEC * OFFLINE_RATE, OFFLINE_CAP_MIN);
    const startDay = g.day;
    g.growth += growthBetween(g.clock, g.clock + minutes);
    g.clock += minutes;
    const days = g.day - startDay;
    for (let d = 0; d < days; d++) g.newDay();
    return { game: g, offline: { minutes, days } };
  }
}
