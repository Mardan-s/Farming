import { describe, expect, it } from 'vitest';
import { CARRIAGE_OUT, laneLat } from '../truck/src/sim/road';
import { Truck } from '../truck/src/sim/truck';
import { jobOffers, levelFor, settle } from '../truck/src/sim/jobs';
import { Traffic } from '../truck/src/sim/traffic';
import { World } from '../truck/src/sim/world';

const world = new World(11, 1500);
const road = world.road;

describe('road', () => {
  it('is a smooth closed loop of a sensible size', () => {
    expect(road.length).toBeGreaterThan(6000);
    expect(road.length).toBeLessThan(14000);
    let maxCurv = 0, maxGrade = 0;
    for (let i = 0; i < road.n; i++) {
      maxCurv = Math.max(maxCurv, Math.abs(road.curv[i]));
      const b = (i + 1) % road.n;
      maxGrade = Math.max(maxGrade, Math.abs(road.py[b] - road.py[i]) / road.step);
    }
    // Tightest bend at least ~180 m radius, grades under 7 %.
    expect(1 / maxCurv).toBeGreaterThan(180);
    expect(maxGrade).toBeLessThan(0.07);
  });

  it('locates points in road coordinates', () => {
    const p = { x: 0, y: 0, z: 0 };
    for (const s of [10, 1234.5, road.length * 0.7]) {
      for (const lat of [-9, 0, laneLat(1, 0), 40]) {
        road.toWorld(s, lat, p);
        const hit = road.locate(p.x, p.z)!;
        expect(hit).not.toBeNull();
        expect(Math.abs(road.delta(s, hit.s))).toBeLessThan(1.5);
        expect(hit.lat).toBeCloseTo(lat, 0);
      }
    }
  });
});

describe('world', () => {
  it('keeps the terrain just under the asphalt and depot yards', () => {
    const p = { x: 0, y: 0, z: 0 };
    for (let s = 0; s < road.length; s += 97) {
      for (const lat of [-CARRIAGE_OUT, -4, 4, CARRIAGE_OUT]) {
        road.toWorld(s, lat, p);
        const t = world.terrainHeight(p.x, p.z);
        expect(t).toBeLessThan(p.y + 0.05);
        expect(t).toBeGreaterThan(p.y - 1.2);
      }
    }
    for (const d of world.depots) {
      road.toWorld(d.bayS, d.bayLat, p);
      expect(world.depotAt(d.bayS, d.bayLat)).toBe(d);
      expect(world.groundHeight(p.x, p.z)).toBeCloseTo(road.heightAt(d.bayS), 1);
    }
  });

  it('keeps trees and buildings off the road', () => {
    for (const t of world.trees) {
      const hit = road.locate(t.x, t.z);
      if (hit) expect(Math.abs(hit.lat)).toBeGreaterThan(CARRIAGE_OUT + 4);
    }
    for (const b of world.buildings) {
      const hit = road.locate(b.x, b.z);
      if (hit) expect(Math.abs(hit.lat)).toBeGreaterThan(CARRIAGE_OUT + 6);
    }
    expect(world.fields.length).toBeGreaterThan(10);
    expect(world.buildings.length).toBeGreaterThan(100);
  });
});

describe('truck', () => {
  it('accelerates to the speed limiter on the flat and stops with the brakes', () => {
    const t = new Truck();
    t.cargoMass = 15000;
    for (let i = 0; i < 120 * 30; i++) t.update(1 / 30, { throttle: 1, brake: 0, steer: 0, handbrake: false });
    expect(t.kmh).toBeGreaterThan(85);
    expect(t.kmh).toBeLessThan(95);
    expect(t.gear).toBeGreaterThanOrEqual(11);
    let time = 0;
    while (t.speed > 0 && time < 30) { t.update(1 / 30, { throttle: 0, brake: 1, steer: 0, handbrake: false }); time += 1 / 30; }
    expect(t.speed).toBe(0);
    expect(time).toBeLessThan(10);
  });

  it('turns right with positive steering and the trailer follows', () => {
    const t = new Truck();
    t.place(0, 0, 0);
    for (let i = 0; i < 60; i++) t.update(1 / 30, { throttle: 0.5, brake: 0, steer: 1, handbrake: false });
    // Heading 0 drives towards +z; right is -x.
    expect(t.x).toBeLessThan(-0.5);
    expect(t.heading).toBeLessThan(0);
    // The trailer lags behind the tractor's heading and stays hitched at its length.
    expect(t.trailerHeading).toBeGreaterThan(t.heading);
    const k = t.tractorPoint(0.45, 0);
    expect(Math.hypot(k.x - t.tx, k.z - t.tz)).toBeCloseTo(10.4, 3);
  });

  it('reverses in R', () => {
    const t = new Truck();
    t.drive = 'R';
    for (let i = 0; i < 90; i++) t.update(1 / 30, { throttle: 1, brake: 0, steer: 0, handbrake: false });
    expect(t.speed).toBeLessThan(-0.5);
    expect(t.z).toBeLessThan(0);
  });

  it('holds still on a hill with the brake', () => {
    const t = new Truck();
    t.grade = 0.06;
    for (let i = 0; i < 60; i++) t.update(1 / 30, { throttle: 0, brake: 1, steer: 0, handbrake: false });
    expect(Math.abs(t.speed)).toBeLessThan(0.01);
  });
});

describe('jobs', () => {
  it('offers jobs to other depots and pays less for damage', () => {
    const offers = jobOffers(world.depots, 0, road.length, 42);
    expect(offers.length).toBe(4);
    for (const j of offers) {
      expect(j.to).not.toBe(0);
      expect(j.distance).toBeGreaterThan(0);
      expect(j.pay).toBeGreaterThan(500);
    }
    const clean = settle(offers[0], 0, 10, true);
    const dented = settle(offers[0], 0.3, 10, false);
    expect(dented.total).toBeLessThan(clean.total);
    expect(levelFor(0).level).toBe(1);
    expect(levelFor(5000).level).toBeGreaterThan(3);
  });
});

describe('traffic', () => {
  it('flows without cars driving through each other', () => {
    const tr = new Traffic(road, 26, 3, 500);
    for (let i = 0; i < 60 * 20; i++) tr.update(1 / 20, 500, []);
    for (const a of tr.cars) {
      expect(a.speed).toBeGreaterThan(5);
      for (const b of tr.cars) {
        if (a === b || a.dir !== b.dir || Math.abs(a.lat - b.lat) > 1.5) continue;
        expect(Math.abs(road.delta(a.s, b.s))).toBeGreaterThan((a.len + b.len) / 2 - 0.5);
      }
    }
  });

  it('slows down for the player blocking a lane', () => {
    const tr = new Traffic(road, 1, 9, 0);
    const c = tr.cars[0];
    c.s = 100; c.dir = 1; c.lane = 0; c.lat = laneLat(1, 0); c.speed = 30;
    const block = [{ s: 400, lat: laneLat(1, 0) }, { s: 400, lat: laneLat(1, 1) }];
    for (let i = 0; i < 40 * 20; i++) tr.update(1 / 20, 400, block);
    expect(road.delta(c.s, 400)).toBeGreaterThan(c.len / 2);
    expect(c.speed).toBeLessThan(1);
  });
});

describe('game', () => {
  it('holds the truck still on a slope without throttle', () => {
    const t = new Truck();
    t.grade = 0.05;
    for (let i = 0; i < 90; i++) t.update(1 / 30, { throttle: 0, brake: 0, steer: 0, handbrake: false });
    expect(Math.abs(t.speed)).toBeLessThan(0.01);
  });
});
