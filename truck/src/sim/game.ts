import { BARRIER_HALF, CARRIAGE_OUT, RAIL_LAT } from './road';
import { Job, jobOffers, levelFor, settle, Delivery } from './jobs';
import { Traffic, Car } from './traffic';
import { Truck, TruckInput, FUEL_CAP, HITCH_AHEAD, TRAILER_LEN } from './truck';
import { Depot, World } from './world';
import { Box2, yardColliders } from './yard';
import { angleDiff, clamp, mulberry32 } from '../util';
import { TRUCK_MODELS, TruckLook, UPGRADES, UpgradeId, torqueScale } from './trucks';

// Game rules on top of the simulation: jobs and pay, fuel, collisions with traffic, barriers and
// yard objects, time of day, weather and the save game.

export type HeadMode = 'auto' | 'on' | 'high' | 'off';
export type Weather = 'clear' | 'cloudy' | 'rain';

export interface Save {
  money: number;
  xp: number;
  deliveries: number;
  km: number;
  depot: number;
  color: number;
  model?: number;
  owned?: number[];
  upgrades?: UpgradeId[];
  accent?: number;
  fuel: number;
  damage: number;
}

export interface GameEvents {
  toast(text: string, kind?: 'good' | 'bad' | 'info'): void;
  crash(strength: number, x: number, y: number, z: number): void;
  scrape(x: number, z: number, speed: number): void;
  delivered(d: Delivery, job: Job): void;
  arrived(depot: Depot): void;
  coupled(job: Job): void;
  trailerReady(job: Job): void;
  speedCam(kmh: number, limit: number, fine: number): void;
}

const SAVE_KEY = 'eurohaul-save-v1';

/** Separating-axis test for two oriented boxes. Returns the push for `a` (x, z) or null. */
export function obbOverlap(a: Box2, b: Box2): { x: number; z: number; depth: number } | null {
  const axes = [a.heading, a.heading + Math.PI / 2, b.heading, b.heading + Math.PI / 2];
  let best = Infinity, bx = 0, bz = 0;
  const dx = a.x - b.x, dz = a.z - b.z;
  for (const h of axes) {
    const ax = Math.sin(h), az = Math.cos(h);
    const ra = a.hl * Math.abs(Math.sin(a.heading) * ax + Math.cos(a.heading) * az) + a.hw * Math.abs(Math.cos(a.heading) * ax - Math.sin(a.heading) * az);
    const rb = b.hl * Math.abs(Math.sin(b.heading) * ax + Math.cos(b.heading) * az) + b.hw * Math.abs(Math.cos(b.heading) * ax - Math.sin(b.heading) * az);
    const dist = dx * ax + dz * az;
    const o = ra + rb - Math.abs(dist);
    if (o <= 0) return null;
    if (o < best) { best = o; const sg = dist < 0 ? -1 : 1; bx = ax * sg; bz = az * sg; }
  }
  return { x: bx * best, z: bz * best, depth: best };
}

export class Game {
  readonly world: World;
  readonly truck = new Truck();
  traffic: Traffic;
  readonly colliders: Box2[];
  money = 2500;
  xp = 0;
  deliveries = 0;
  km = 0;
  color = 0xb3141b;
  accent = 0xf2f2f2;
  model = 0;
  owned: number[] = [0];
  upgrades = new Set<UpgradeId>();
  job: Job | null = null;
  jobTime = 0;
  offers: Job[] = [];
  depotId = 0;
  /** Depot the truck is currently standing in. */
  atDepot: Depot | null = null;
  hours = 16.2;
  timeScale = 20;
  fixedHour: number | null = null;
  fixedWeather: Weather | null = null;
  weather: Weather = 'clear';
  cloud = 0.3;
  rain = 0;
  wet = 0;
  private weatherTimer = 240;
  headMode: HeadMode = 'auto';
  indL = false;
  indR = false;
  hazard = false;
  horn = false;
  roofLights = false;
  private indTurned = false;
  private carCooldown = new Map<number, number>();
  private wallCooldown = 0;
  private rnd = mulberry32(Date.now() & 0xffff);
  time = 0;
  /** Road coordinates of the truck's drive axle. */
  roadS = 0;
  roadLat = 0;

  constructor(world: World, trafficCount: number, private ev: GameEvents) {
    this.world = world;
    this.colliders = yardColliders(world);
    this.load();
    this.truck.torqueScale = torqueScale(this.model, this.upgrades);
    this.placeAtDepot(this.depotId);
    this.traffic = new Traffic(world.road, trafficCount, 5, world.depots[this.depotId].s);
    this.offers = this.makeOffers();
  }

  // ---------------------------------------------------------------- save game

  private load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as Partial<Save>;
      this.money = s.money ?? this.money;
      this.xp = s.xp ?? 0;
      this.deliveries = s.deliveries ?? 0;
      this.km = s.km ?? 0;
      this.depotId = clamp(s.depot ?? 0, 0, this.world.depots.length - 1);
      this.color = s.color ?? this.color;
      this.model = s.model ?? 0;
      this.owned = s.owned ?? [0];
      this.upgrades = new Set(s.upgrades ?? []);
      this.accent = s.accent ?? this.accent;
      this.truck.fuel = s.fuel ?? this.truck.fuel;
      this.truck.damage = s.damage ?? 0;
    } catch { /* corrupt or unavailable storage: start fresh */ }
  }

  save() {
    const s: Save = { money: this.money, xp: this.xp, deliveries: this.deliveries, km: this.km, depot: this.depotId, color: this.color, fuel: this.truck.fuel, damage: this.truck.damage, model: this.model, owned: this.owned, upgrades: [...this.upgrades], accent: this.accent };
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
  }

  get level() { return levelFor(this.xp); }

  // ---------------------------------------------------------------- garage

  get look(): TruckLook {
    return { model: this.model, color: this.color, accent: this.accent, chrome: this.upgrades.has('chrome') || this.model === 2, lightbar: this.upgrades.has('lightbar') || this.model === 2 };
  }

  /** Buys (if needed) and switches to a truck model. Returns false when it can't be afforded. */
  chooseTruck(id: number) {
    const m = TRUCK_MODELS[id];
    if (!this.owned.includes(id)) {
      if (this.money < m.price) return false;
      this.money -= m.price;
      this.owned.push(id);
      this.ev.toast(`Bought the ${m.name}!`, 'good');
    }
    this.model = id;
    this.truck.torqueScale = torqueScale(this.model, this.upgrades);
    this.save();
    return true;
  }

  buyUpgrade(id: UpgradeId) {
    const u = UPGRADES.find((x) => x.id === id)!;
    if (this.upgrades.has(id)) return false;
    if (id === 'engine2' && !this.upgrades.has('engine1')) { this.ev.toast('Fit the stage 1 tune first', 'bad'); return false; }
    if (this.money < u.price) { this.ev.toast('Not enough money yet', 'bad'); return false; }
    this.money -= u.price;
    this.upgrades.add(id);
    this.truck.torqueScale = torqueScale(this.model, this.upgrades);
    this.ev.toast(`${u.name} fitted`, 'good');
    this.save();
    return true;
  }

  placeAtDepot(id: number) {
    const d = this.world.depots[id];
    const p = this.world.road.toWorld(d.s - 10, CARRIAGE_OUT + 18, { x: 0, y: 0, z: 0 });
    const t = this.world.road.sample(d.s - 10, { x: 0, y: 0, z: 0, tx: 0, tz: 1 });
    this.truck.place(p.x, p.z, Math.atan2(t.tx, t.tz));
    this.truck.hasTrailer = false;
    this.truck.cargoMass = 0;
    this.atDepot = d;
    this.depotId = id;
  }

  makeOffers() {
    return jobOffers(this.world.depots, this.depotId, this.world.road.length, this.depotId * 1000 + this.deliveries * 7 + 3);
  }

  // ---------------------------------------------------------------- jobs

  /** The loaded trailer waiting in the yard for you to back under it. */
  pickup: { x: number; z: number; heading: number } | null = null;

  accept(job: Job) {
    this.job = job;
    this.jobTime = 0;
    this.truck.hasTrailer = false;
    this.truck.cargoMass = 0;
    const d = this.atDepot ?? this.world.depots[this.depotId];
    const s = d.bayS - 5.2;
    const p = this.world.road.toWorld(s, d.bayLat, { x: 0, y: 0, z: 0 });
    const tg = this.world.road.sample(s, { x: 0, y: 0, z: 0, tx: 0, tz: 1 });
    this.pickup = { x: p.x, z: p.z, heading: Math.atan2(tg.tx, tg.tz) };
    this.ev.trailerReady(job);
    this.ev.toast('Reverse under the trailer in the glowing bay to couple', 'info');
  }

  /** Where the trailer's kingpin is, and how far the fifth wheel is from it. */
  couplingGap() {
    if (!this.pickup) return null;
    const p = this.pickup;
    const kx = p.x + Math.sin(p.heading) * TRAILER_LEN, kz = p.z + Math.cos(p.heading) * TRAILER_LEN;
    const f = this.truck.tractorPoint(HITCH_AHEAD, 0);
    return { dist: Math.hypot(kx - f.x, kz - f.z), angle: Math.abs(angleDiff(this.truck.heading, p.heading)) };
  }

  canCouple() {
    const g = this.couplingGap();
    return !!g && g.dist < 1.2 && g.angle < 0.35 && Math.abs(this.truck.speed) < 1.5;
  }

  couple() {
    if (!this.pickup || !this.job) return;
    const t = this.truck, p = this.pickup;
    t.hasTrailer = true;
    t.cargoMass = this.job.mass;
    t.trailerHeading = p.heading;
    t.alignTrailer();
    this.pickup = null;
    this.ev.coupled(this.job);
  }

  /** Lets the yard crew line the truck up and couple it, for a fee. */
  crewCouple() {
    if (!this.pickup) return;
    const fee = 150;
    if (this.money < fee) { this.ev.toast('Not enough money for the yard crew', 'bad'); return; }
    this.money -= fee;
    const p = this.pickup;
    const kx = p.x + Math.sin(p.heading) * TRAILER_LEN, kz = p.z + Math.cos(p.heading) * TRAILER_LEN;
    this.truck.place(kx - Math.sin(p.heading) * HITCH_AHEAD, kz - Math.cos(p.heading) * HITCH_AHEAD, p.heading);
    this.couple();
    this.ev.toast(`Yard crew coupled the trailer · −€${fee}`, 'info');
  }

  cancelJob() {
    if (!this.job) return;
    const fee = Math.round(this.job.pay * 0.25);
    this.money -= fee;
    this.ev.toast(`Job cancelled · −€${fee}`, 'bad');
    this.job = null;
    this.pickup = null;
    this.truck.hasTrailer = false;
    this.truck.cargoMass = 0;
    this.save();
  }

  /** Is the trailer parked neatly in the destination bay? */
  parkedInBay(): boolean {
    if (!this.job || !this.truck.hasTrailer) return false;
    const d = this.world.depots[this.job.to];
    const c = this.truck.trailerPoint(5.2, 0);
    const hit = this.world.road.locate(c.x, c.z);
    if (!hit) return false;
    const t = this.world.road.sample(hit.s, { x: 0, y: 0, z: 0, tx: 0, tz: 1 });
    const align = Math.abs(Math.sin(angleDiff(Math.atan2(t.tx, t.tz), this.truck.trailerHeading)));
    return Math.abs(this.world.road.delta(hit.s, d.bayS)) < 3 && Math.abs(hit.lat - d.bayLat) < 1.3 && align < 0.2;
  }

  canDeliver() { return !!this.job && this.truck.hasTrailer && this.atDepot?.id === this.job.to && Math.abs(this.truck.speed) < 0.5; }

  deliver() {
    if (!this.job || !this.canDeliver()) return null;
    const job = this.job;
    const res = settle(job, this.truck.damage, this.jobTime, this.parkedInBay());
    this.money += res.total;
    this.xp += res.xp;
    this.deliveries++;
    this.job = null;
    this.truck.hasTrailer = false;
    this.truck.cargoMass = 0;
    this.depotId = job.to;
    this.offers = this.makeOffers();
    this.save();
    this.ev.delivered(res, job);
    return res;
  }

  canRefuel() { return !!this.atDepot?.fuel && Math.abs(this.truck.speed) < 0.5 && this.truck.fuel < FUEL_CAP - 1; }

  refuel() {
    if (!this.canRefuel()) return;
    const litres = FUEL_CAP - this.truck.fuel;
    const cost = Math.round(litres * 1.45);
    if (this.money < cost) { this.ev.toast('Not enough money to refuel', 'bad'); return; }
    this.money -= cost;
    this.truck.fuel = FUEL_CAP;
    this.ev.toast(`Refuelled ${Math.round(litres)} L · −€${cost}`, 'info');
    this.save();
  }

  canRepair() { return !!this.atDepot && Math.abs(this.truck.speed) < 0.5 && this.truck.damage > 0.005; }

  repairCost() { return Math.round(this.truck.damage * 6000); }

  repair() {
    if (!this.canRepair()) return;
    const cost = this.repairCost();
    if (this.money < cost) { this.ev.toast('Not enough money to repair', 'bad'); return; }
    this.money -= cost;
    this.truck.damage = 0;
    this.ev.toast(`Truck repaired · −€${cost}`, 'info');
    this.save();
  }

  // ---------------------------------------------------------------- per frame

  get speedLimit() { return this.atDepot ? 30 : this.world.zoneAt(this.roadS) ? 80 : 90; }

  lightsOn(night: number) {
    if (this.headMode === 'off') return false;
    if (this.headMode === 'auto') return night > 0.25 || this.rain > 0.3;
    return true;
  }

  update(dt: number, input: TruckInput) {
    this.time += dt;
    if (this.job) this.jobTime += dt;
    this.updateClockAndWeather(dt);
    const t = this.truck;
    const wasGear = t.gear;
    t.update(dt, input);
    if (t.gear !== wasGear && t.load > 0.5) this.onShift?.();
    this.km += Math.abs(t.speed) * dt / 1000;
    // Cancel the indicator once a turn has been made and the wheel straightened.
    if ((this.indL || this.indR) && !this.hazard) {
      if (Math.abs(input.steer) > 0.35) this.indTurned = true;
      else if (this.indTurned && Math.abs(input.steer) < 0.08) { this.indL = this.indR = false; this.indTurned = false; }
    }
    const hit = this.world.road.locate(t.x, t.z);
    const prevS = this.roadS;
    if (hit) { this.roadS = hit.s; this.roadLat = hit.lat; }
    // Speed cameras photograph anyone more than 4 km/h over the limit as they pass.
    if (hit && hit.lat > 0 && Math.abs(this.world.road.delta(prevS, this.roadS)) < 30) {
      for (const cs of this.world.speedCameras) {
        if (this.world.road.delta(prevS, cs) > 0 && this.world.road.delta(this.roadS, cs) <= 0) {
          const limit = this.speedLimit, kmh = Math.round(t.kmh);
          if (kmh > limit + 4) {
            const fine = 40 + (kmh - limit) * 12;
            this.money -= fine;
            this.ev.speedCam(kmh, limit, fine);
          }
        }
      }
    }
    const dep = hit ? this.world.depotAt(hit.s, hit.lat) : null;
    if (dep && dep !== this.atDepot) {
      this.depotId = dep.id;
      if (!this.job) this.offers = this.makeOffers();
      this.ev.arrived(dep);
    }
    this.atDepot = dep;
    t.offroad = false;
    this.wallCooldown -= dt;
    this.constrain(dt);
    // Backing in squarely couples automatically, like pressing the coupling button.
    const gap = this.couplingGap();
    if (gap && gap.dist < 0.7 && gap.angle < 0.25 && Math.abs(t.speed) < 4.5) {
      // The jaws lock on contact and the bump stops the truck.
      t.speed = 0;
      this.couple();
    }
    this.collideStatic();
    const obstacles = this.rigObstacles();
    this.traffic.update(dt, this.roadS, obstacles);
    this.collideTraffic(dt);
    if (Math.floor(this.time / 15) !== Math.floor((this.time - dt) / 15)) this.save();
  }

  onShift: (() => void) | null = null;

  private updateClockAndWeather(dt: number) {
    if (this.fixedHour != null) this.hours += (this.fixedHour - this.hours) * Math.min(1, dt * 2);
    else this.hours = (this.hours + (dt * this.timeScale) / 3600) % 24;
    this.weatherTimer -= dt;
    if (this.fixedWeather) this.weather = this.fixedWeather;
    else if (this.weatherTimer <= 0) {
      this.weatherTimer = 300 + this.rnd() * 300;
      const r = this.rnd();
      this.weather = r < 0.5 ? 'clear' : r < 0.78 ? 'cloudy' : 'rain';
    }
    const [tc, tr] = this.weather === 'clear' ? [0.3, 0] : this.weather === 'cloudy' ? [0.7, 0] : [0.93, 0.85];
    const k = this.fixedWeather ? 1.5 : 0.05;
    this.cloud += (tc - this.cloud) * Math.min(1, dt * k);
    this.rain += (tr - this.rain) * Math.min(1, dt * k * (tr > this.rain ? 0.7 : 1.4));
    this.wet = clamp(this.wet + (this.rain > 0.25 ? dt * 0.05 : -dt * 0.012), 0, 1);
  }

  /** The rig's footprint in road coordinates, for the AI to avoid. */
  rigObstacles() {
    const t = this.truck;
    const pts = [t.tractorPoint(5.3, 0), t.tractorPoint(2, 0), t.tractorPoint(-1.2, 0)];
    if (t.hasTrailer) pts.push(t.trailerPoint(10, 0), t.trailerPoint(5, 0), t.trailerPoint(-1.6, 0));
    const out: { s: number; lat: number }[] = [];
    for (const p of pts) {
      const h = this.world.road.locate(p.x, p.z);
      if (h && Math.abs(h.lat) < CARRIAGE_OUT + 1) out.push({ s: h.s, lat: h.lat });
    }
    return out;
  }

  rigBoxes(): Box2[] {
    const t = this.truck;
    const c = t.tractorPoint(2.0, 0);
    const out: Box2[] = [{ x: c.x, z: c.z, heading: t.heading, hl: 3.35, hw: 1.27 }];
    if (t.hasTrailer) { const k = t.trailerPoint(5.2, 0); out.push({ x: k.x, z: k.z, heading: t.trailerHeading, hl: 6.85, hw: 1.3 }); }
    return out;
  }

  /** Keeps the rig between the median barrier, the guard rails and the yard fences. */
  private constrain(dt: number) {
    const t = this.truck;
    const road = this.world.road;
    const checks: { along: number; side: number; trailer: boolean }[] = [];
    for (const side of [-1.25, 1.25]) {
      checks.push({ along: 5.3, side, trailer: false }, { along: -1.3, side, trailer: false });
      if (t.hasTrailer) checks.push({ along: 12.0, side, trailer: true }, { along: 5, side, trailer: true }, { along: -1.6, side, trailer: true });
    }
    const tp = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };
    for (const c of checks) {
      const p = c.trailer ? t.trailerPoint(c.along, c.side) : t.tractorPoint(c.along, c.side);
      const h = road.locate(p.x, p.z);
      if (!h) continue;
      road.sample(h.s, tp);
      const rx = -tp.tz, rz = tp.tx; // road right normal
      let pushLat = 0, pushS = 0;
      const dep = this.world.depots.find((d) => Math.abs(road.delta(d.s, h.s)) < d.sHalf + 6);
      const inGap = this.world.railGap(h.s);
      const maxLat = inGap && dep ? CARRIAGE_OUT + dep.depth - 0.25 : RAIL_LAT - 0.18;
      if (h.lat > maxLat) pushLat = maxLat - h.lat;
      if (h.lat < BARRIER_HALF + 0.05 && h.lat > -BARRIER_HALF - 1) pushLat = BARRIER_HALF + 0.05 - h.lat;
      if (dep && h.lat > RAIL_LAT - 0.1) {
        const ds = road.delta(dep.s, h.s);
        const lim = dep.sHalf - 0.3;
        if (Math.abs(ds) > lim && Math.abs(ds) < dep.sHalf + 4) pushS = (Math.abs(ds) - lim) * -Math.sign(ds);
      }
      if (!pushLat && !pushS) continue;
      const px = rx * pushLat + tp.tx * pushS, pz = rz * pushLat + tp.tz * pushS;
      const len = Math.hypot(px, pz);
      const nx = px / len, nz = pz / len;
      if (c.trailer && c.along < 9) {
        t.tx += px; t.tz += pz;
        const k = t.tractorPoint(0.45, 0);
        const th = Math.atan2(k.x - t.tx, k.z - t.tz);
        t.trailerHeading = th;
        t.alignTrailer();
      } else { t.x += px; t.z += pz; if (c.trailer) t.alignTrailer(); }
      const head = c.trailer ? t.trailerHeading : t.heading;
      const into = Math.abs(t.speed * (Math.sin(head) * nx + Math.cos(head) * nz));
      if (into > 2.2 && this.wallCooldown <= 0) {
        this.wallCooldown = 0.8;
        const dmg = t.impact(into, clamp(1 - into * 0.06, 0.45, 0.9));
        this.ev.crash(into / 10, p.x, h.y + 0.8, p.z);
        if (dmg > 0.004) this.ev.toast(`Hit the barrier · damage ${Math.round(t.damage * 100)}%`, 'bad');
      } else {
        t.speed *= 1 - Math.min(0.5, dt * 0.9);
        if (Math.abs(t.speed) > 4) this.ev.scrape(p.x, p.z, Math.abs(t.speed));
      }
    }
  }

  private collideStatic() {
    const boxes = this.rigBoxes();
    const t = this.truck;
    const list = this.colliders.slice();
    // The waiting trailer blocks you everywhere except under its front, where the tractor slides in.
    if (this.pickup) {
      const p = this.pickup;
      list.push({ x: p.x + Math.sin(p.heading) * 2.6, z: p.z + Math.cos(p.heading) * 2.6, heading: p.heading, hl: 4.3, hw: 1.3 });
    }
    for (const c of list) {
      if (Math.abs(c.x - t.x) > 40 || Math.abs(c.z - t.z) > 40) continue;
      boxes.forEach((b, i) => {
        const o = obbOverlap(b, c);
        if (!o) return;
        if (i === 0) { t.x += o.x; t.z += o.z; } else { t.tx += o.x; t.tz += o.z; const k = t.tractorPoint(0.45, 0); t.trailerHeading = Math.atan2(k.x - t.tx, k.z - t.tz); t.alignTrailer(); }
        if (Math.abs(t.speed) > 2 && this.wallCooldown <= 0) {
          this.wallCooldown = 0.8;
          t.impact(Math.abs(t.speed), 0.2);
          this.ev.crash(Math.abs(t.speed) / 10, b.x, this.world.groundHeight(b.x, b.z) + 1, b.z);
        } else t.speed *= 0.5;
      });
    }
  }

  carBoxes(c: Car): Box2[] {
    const road = this.world.road;
    const tp = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };
    const p = { x: 0, y: 0, z: 0 };
    const heading = (s: number) => { road.sample(s, tp); return Math.atan2(tp.tx, tp.tz) + (c.dir < 0 ? Math.PI : 0); };
    if (c.kind === 'truck') {
      const s1 = c.s + c.dir * 5.3, s2 = c.s - c.dir * 2.6;
      road.toWorld(s1, c.lat, p);
      const a: Box2 = { x: p.x, z: p.z, heading: heading(s1), hl: 3.3, hw: 1.25 };
      road.toWorld(s2, c.lat, p);
      return [a, { x: p.x, z: p.z, heading: heading(s2), hl: 6.8, hw: 1.28 }];
    }
    road.toWorld(c.s, c.lat, p);
    return [{ x: p.x, z: p.z, heading: heading(c.s), hl: c.len / 2, hw: c.wid / 2 }];
  }

  private collideTraffic(dt: number) {
    const t = this.truck;
    const rig = this.rigBoxes();
    const road = this.world.road;
    for (const [id, v] of this.carCooldown) { if (v - dt <= 0) this.carCooldown.delete(id); else this.carCooldown.set(id, v - dt); }
    for (const c of this.traffic.cars) {
      if (Math.abs(road.delta(c.s, this.roadS)) > 40) continue;
      for (const cb of this.carBoxes(c)) {
        for (let i = 0; i < rig.length; i++) {
          const o = obbOverlap(rig[i], cb);
          if (!o) continue;
          // Push both apart: the heavy rig moves a little, the car a lot.
          const share = c.kind === 'truck' ? 0.5 : 0.25;
          if (i === 0) { t.x += o.x * share; t.z += o.z * share; } else { t.tx += o.x * share; t.tz += o.z * share; t.alignTrailer(); }
          const tp = road.sample(c.s, { x: 0, y: 0, z: 0, tx: 0, tz: 1 });
          const along = -(o.x * tp.tx + o.z * tp.tz) * (1 - share);
          c.s += along;
          const n = { x: o.x / o.depth, z: o.z / o.depth };
          const tvx = Math.sin(t.heading) * t.speed, tvz = Math.cos(t.heading) * t.speed;
          const cvx = tp.tx * c.speed * c.dir, cvz = tp.tz * c.speed * c.dir;
          const rel = Math.abs((tvx - cvx) * n.x + (tvz - cvz) * n.z);
          if (!this.carCooldown.has(c.id)) {
            this.carCooldown.set(c.id, 1.2);
            c.crashed = 6;
            // A car shunted from behind gets carried along at the truck's speed.
            const shove = (tvx * tp.tx + tvz * tp.tz) * c.dir;
            c.speed = Math.max(c.speed * 0.4, shove * 0.8);
            if (rel > 1.2) {
              t.impact(rel, clamp(1 - rel * (c.kind === 'truck' ? 0.07 : 0.03), 0.4, 0.95));
              const fine = Math.round(Math.min(1500, 80 + rel * 60));
              this.money -= fine;
              this.ev.crash(rel / 12, (rig[i].x + cb.x) / 2, this.world.groundHeight(cb.x, cb.z) + 1, (rig[i].z + cb.z) / 2);
              this.ev.toast(`Collision · fine −€${fine}`, 'bad');
            }
          }
        }
      }
    }
  }

  /** Is the job's destination ahead, and how far along the road? */
  routeDistance() {
    if (!this.job) return 0;
    const d = this.world.depots[this.job.to];
    if (this.atDepot === d) return 0;
    const ahead = this.world.road.ahead(this.roadS, d.s);
    // Just past the depot's centre still counts as being there.
    return ahead > this.world.road.length - d.sHalf ? 0 : ahead;
  }
}

export { FUEL_CAP };
