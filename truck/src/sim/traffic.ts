import { laneLat, Road } from './road';
import { clamp, mulberry32 } from '../util';

// AI traffic on the motorway, simulated in road coordinates. Cars follow the Intelligent Driver
// Model, overtake slower traffic, keep right afterwards, and treat the player's rig as an
// obstacle. Traffic is kept dense around the player by recycling cars that fall far behind.

export type CarKind = 'sedan' | 'hatch' | 'wagon' | 'suv' | 'van' | 'truck';
export const CAR_DIMS: Record<CarKind, { len: number; wid: number }> = {
  sedan: { len: 4.75, wid: 1.85 },
  hatch: { len: 4.1, wid: 1.8 },
  wagon: { len: 4.85, wid: 1.85 },
  suv: { len: 4.7, wid: 1.95 },
  van: { len: 5.4, wid: 2.0 },
  truck: { len: 18.0, wid: 2.55 },
};

export interface Car {
  id: number;
  kind: CarKind;
  color: number;
  s: number;
  dir: 1 | -1;
  lane: 0 | 1;
  lat: number;
  latVel: number;
  speed: number;
  desired: number;
  len: number;
  wid: number;
  /** Seconds left standing still after a crash. */
  crashed: number;
  braking: boolean;
  /** Seconds before this driver will honk again. */
  honkCd: number;
  indicator: -1 | 0 | 1;
  keepRightTimer: number;
  /** Bumped every time the car is recycled so the renderer can repaint it. */
  gen: number;
}

/** A point of the player's rig in road coordinates. */
export interface Obstacle { s: number; lat: number }

const PAINT = [0xf2f2f2, 0x15171a, 0x8a9199, 0x1d3f8c, 0xa31621, 0x3b4a3f, 0xc9c2b5, 0x0f5c78, 0x5a2a6e, 0xd0d4d8, 0x2b2d31, 0x7c1e1e, 0xe2a21b];
const KINDS: CarKind[] = ['sedan', 'sedan', 'sedan', 'hatch', 'hatch', 'wagon', 'wagon', 'suv', 'suv', 'van', 'truck', 'truck'];

export class Traffic {
  readonly cars: Car[] = [];
  /** Cars that honked this frame (read and cleared by the game). */
  honks: Car[] = [];
  private rnd: () => number;
  private nextId = 1;

  constructor(private road: Road, count: number, seed = 5, around = 0) {
    this.rnd = mulberry32(seed);
    for (let i = 0; i < count; i++) {
      const c = this.make();
      this.cars.push(c);
      this.respawn(c, around, true);
    }
  }

  private make(): Car {
    return {
      id: this.nextId++, kind: 'sedan', color: 0, s: 0, dir: 1, lane: 0, lat: 0, latVel: 0, speed: 0, desired: 30, honkCd: 0,
      len: 4.7, wid: 1.8, crashed: 0, braking: false, indicator: 0, keepRightTimer: 0, gen: 0,
    };
  }

  private respawn(c: Car, around: number, initial: boolean) {
    const r = this.rnd;
    c.kind = KINDS[Math.floor(r() * KINDS.length)];
    c.color = c.kind === 'truck' ? Math.floor(r() * 6) : PAINT[Math.floor(r() * PAINT.length)];
    c.len = CAR_DIMS[c.kind].len;
    c.wid = CAR_DIMS[c.kind].wid;
    c.dir = r() < 0.5 ? 1 : -1;
    c.lane = c.kind === 'truck' || r() < 0.55 ? 0 : 1;
    c.desired = c.kind === 'truck' ? 22 + r() * 2 : c.kind === 'van' ? 30 + r() * 3 : 31 + r() * 9;
    c.crashed = 0;
    c.indicator = 0;
    c.gen++;
    for (let attempt = 0; attempt < 12; attempt++) {
      const off = initial ? (r() * 2 - 1) * 950 : (r() < 0.5 ? -1 : 1) * (720 + r() * 230);
      // Never pop in right next to the player.
      if (Math.abs(off) < 120) continue;
      const s = around + off;
      if (this.cars.some((o) => o !== c && o.dir === c.dir && o.lane === c.lane && Math.abs(this.road.delta(o.s, s)) < 45)) continue;
      c.s = ((s % this.road.length) + this.road.length) % this.road.length;
      break;
    }
    c.lat = laneLat(c.dir, c.lane);
    c.latVel = 0;
    c.speed = c.desired * (0.85 + r() * 0.1);
  }

  /** Free gap ahead of `c` in the lane band around `lat`, considering cars and the player. */
  private gapAhead(c: Car, lat: number, player: Obstacle[], back = 0): { gap: number; speed: number; player: boolean } {
    let best = 250, bestV = c.desired, isPlayer = false;
    for (const o of this.cars) {
      if (o === c || o.dir !== c.dir || Math.abs(o.lat - lat) > 2.4) continue;
      const d = this.road.delta(c.s, o.s) * c.dir;
      if (d < -back || d > 250) continue;
      const gap = d - (c.len + o.len) / 2;
      if (gap < best) { best = gap; bestV = o.speed; }
    }
    for (const p of player) {
      if (Math.abs(p.lat - lat) > 2.6) continue;
      const d = this.road.delta(c.s, p.s) * c.dir;
      if (d < -back || d > 250) continue;
      const gap = d - c.len / 2 - 0.6;
      if (gap < best) { best = gap; bestV = 0; isPlayer = true; }
    }
    return { gap: best, speed: bestV, player: isPlayer };
  }

  update(dt: number, playerS: number, player: Obstacle[]) {
    for (const c of this.cars) {
      if (Math.abs(this.road.delta(playerS, c.s)) > 1000) { this.respawn(c, playerS, false); continue; }
      if (c.crashed > 0) {
        c.crashed -= dt;
        c.speed = Math.max(0, c.speed - 9 * dt);
        c.braking = true;
        c.s += c.speed * c.dir * dt;
        continue;
      }
      const lead = this.gapAhead(c, c.lat, player);
      // Intelligent Driver Model.
      const v = c.speed, v0 = c.desired, T = c.kind === 'truck' ? 1.8 : 1.3, s0 = 3.5, aMax = c.kind === 'truck' ? 0.7 : 1.6, b = 2.4;
      const dv = v - lead.speed;
      const sStar = s0 + v * T + (v * dv) / (2 * Math.sqrt(aMax * b));
      const gap = Math.max(0.1, lead.gap);
      let acc = aMax * (1 - (v / v0) ** 4 - (Math.max(0, sStar) / gap) ** 2);
      acc = clamp(acc, -9, aMax);
      c.speed = Math.max(0, v + acc * dt);
      c.braking = acc < -1;
      // Drivers forced to brake hard for the player let them know about it.
      c.honkCd -= dt;
      if (lead.player && acc < -3 && c.honkCd <= 0 && lead.gap < 45) { c.honkCd = 12; this.honks.push(c); }
      c.s += c.speed * c.dir * dt;
      c.s = ((c.s % this.road.length) + this.road.length) % this.road.length;

      // Lane changes: overtake when stuck behind slower traffic, drift back right when clear.
      const target = laneLat(c.dir, c.lane);
      if (Math.abs(c.lat - target) < 0.05) {
        c.indicator = 0;
        c.keepRightTimer -= dt;
        const other = (1 - c.lane) as 0 | 1;
        const oLat = laneLat(c.dir, other);
        const wantPass = c.lane === 0 && lead.gap < 55 && lead.speed < c.desired - 2.5 && c.kind !== 'truck';
        const wantRight = c.lane === 1 && c.keepRightTimer <= 0;
        if (wantPass || wantRight) {
          const ahead = this.gapAhead(c, oLat, player, 0);
          const behind = this.behindGap(c, oLat, player);
          const needAhead = wantRight ? 70 : 25;
          if (ahead.gap > needAhead && behind > 18 + c.speed * 0.9 && (!wantRight || ahead.speed > c.speed - 1)) {
            c.lane = other;
            c.indicator = other === 1 ? -1 : 1;
            c.keepRightTimer = 6 + this.rnd() * 6;
          }
        }
      }
      const want = laneLat(c.dir, c.lane) - c.lat;
      c.latVel = clamp(want * 1.6, -1.4, 1.4);
      c.lat += c.latVel * dt;
    }
  }

  private behindGap(c: Car, lat: number, player: Obstacle[]) {
    let best = 250;
    for (const o of this.cars) {
      if (o === c || o.dir !== c.dir || Math.abs(o.lat - lat) > 2.4) continue;
      const d = -this.road.delta(c.s, o.s) * c.dir;
      if (d < 0 || d > 250) continue;
      best = Math.min(best, d - (c.len + o.len) / 2);
    }
    for (const p of player) {
      if (Math.abs(p.lat - lat) > 2.6) continue;
      const d = -this.road.delta(c.s, p.s) * c.dir;
      if (d < -3 || d > 250) continue;
      best = Math.min(best, d - c.len / 2);
    }
    return best;
  }
}
