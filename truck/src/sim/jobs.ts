import type { Depot } from './world';
import { mulberry32 } from '../util';

export type TrailerKind = 'curtain' | 'reefer' | 'container' | 'tanker';

export interface Cargo { name: string; trailer: TrailerKind; massMin: number; massMax: number; rate: number; fragile?: boolean }

export const CARGOS: Cargo[] = [
  { name: 'Machine parts', trailer: 'curtain', massMin: 9000, massMax: 16000, rate: 1.0 },
  { name: 'Furniture', trailer: 'curtain', massMin: 6000, massMax: 11000, rate: 0.95, fragile: true },
  { name: 'Steel coils', trailer: 'curtain', massMin: 18000, massMax: 24000, rate: 1.15 },
  { name: 'Fresh produce', trailer: 'reefer', massMin: 10000, massMax: 17000, rate: 1.2, fragile: true },
  { name: 'Frozen fish', trailer: 'reefer', massMin: 12000, massMax: 19000, rate: 1.25 },
  { name: 'Electronics', trailer: 'container', massMin: 7000, massMax: 13000, rate: 1.35, fragile: true },
  { name: 'Car tyres', trailer: 'container', massMin: 8000, massMax: 12000, rate: 1.0 },
  { name: 'Fuel oil', trailer: 'tanker', massMin: 20000, massMax: 25000, rate: 1.3 },
  { name: 'Milk', trailer: 'tanker', massMin: 15000, massMax: 22000, rate: 1.1 },
];

export interface Job {
  id: number;
  cargo: Cargo;
  mass: number;
  from: number;
  to: number;
  /** Route length in metres. */
  distance: number;
  pay: number;
  /** Seconds of real time allowed before the late penalty. */
  deadline: number;
  /** Livery index for the trailer. */
  livery: number;
}

/** Offers on a depot's board; the loop only runs one way, so distance is always forward. */
export function jobOffers(depots: Depot[], at: number, roadLength: number, seed: number, count = 4): Job[] {
  const rnd = mulberry32(seed);
  const here = depots[at];
  const out: Job[] = [];
  for (let k = 0; k < count; k++) {
    let to = Math.floor(rnd() * depots.length);
    if (to === at) to = (to + 1 + Math.floor(rnd() * (depots.length - 1))) % depots.length;
    const cargo = CARGOS[Math.floor(rnd() * CARGOS.length)];
    const mass = Math.round((cargo.massMin + rnd() * (cargo.massMax - cargo.massMin)) / 100) * 100;
    const there = depots[to];
    const distance = ((there.s - here.s) % roadLength + roadLength) % roadLength;
    const pay = Math.round((600 + distance * 0.42 * cargo.rate + mass * 0.012) / 10) * 10;
    out.push({ id: seed * 10 + k, cargo, mass, from: at, to, distance, pay, deadline: 90 + distance / 13, livery: Math.floor(rnd() * 6) });
  }
  return out;
}

export interface Delivery { base: number; damage: number; late: number; parking: number; total: number; xp: number }

export function settle(job: Job, damage: number, elapsed: number, parked: boolean): Delivery {
  const base = job.pay;
  const dmgPenalty = Math.round(base * Math.min(1, damage * (job.cargo.fragile ? 1.6 : 1)));
  const late = elapsed > job.deadline ? Math.round(Math.min(base * 0.5, (elapsed - job.deadline) * 4)) : 0;
  const parking = parked ? Math.round(base * 0.1) : 0;
  const total = Math.max(0, base - dmgPenalty - late + parking);
  const xp = Math.round(job.distance / 20 + (parked ? 60 : 0) + (damage < 0.02 ? 80 : 0));
  return { base, damage: -dmgPenalty, late: -late, parking, total, xp };
}

export function levelFor(xp: number) {
  let lvl = 1, need = 400, acc = 0;
  while (xp >= acc + need) { acc += need; lvl++; need = Math.round(need * 1.25); }
  return { level: lvl, into: xp - acc, need };
}
