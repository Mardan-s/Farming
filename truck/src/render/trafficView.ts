import * as THREE from 'three';
import type { Car, CarKind, Traffic } from '../sim/traffic';
import type { Road } from '../sim/road';
import type { TrailerKind } from '../sim/jobs';
import { mergeStatic, paint } from './materials';
import { LightMats, LightState, aiTruckLook, applyLights, buildCar, buildTractor, buildTrailer } from './vehicles';

// Draws the AI traffic. Models are pooled per vehicle kind and repainted when a car respawns.

interface Model { kind: CarKind; root: THREE.Group; spin: THREE.Group[]; lights: LightMats[]; paintMesh: THREE.Mesh[]; trailer?: THREE.Group; trailerSpin?: THREE.Group[] }

const TRUCK_TRAILERS: TrailerKind[] = ['curtain', 'reefer', 'container', 'tanker', 'curtain', 'container'];

export class TrafficView {
  private pools = new Map<CarKind, Model[]>();
  private active = new Map<number, { model: Model; gen: number; spin: number }>();
  private blink = 0;
  private p = { x: 0, y: 0, z: 0 };
  private t = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };

  constructor(private scene: THREE.Scene, private traffic: Traffic, private road: Road) {}

  private make(kind: CarKind, seed: number): Model {
    if (kind === 'truck') {
      const tr = buildTractor(aiTruckLook(seed), { interior: false, lod: true });
      const tl = buildTrailer(TRUCK_TRAILERS[seed % TRUCK_TRAILERS.length], seed + 1, { lod: true });
      const root = new THREE.Group();
      root.add(tr.root);
      mergeStatic(tr.root);
      mergeStatic(tl.root);
      this.scene.add(root, tl.root);
      return { kind, root, spin: [], lights: [tr.lights, tl.lights], paintMesh: [], trailer: tl.root, trailerSpin: [] };
    }
    const c = buildCar(kind, 0xffffff);
    mergeStatic(c.root);
    const paintMesh: THREE.Mesh[] = [];
    c.root.traverse((o) => { if (o instanceof THREE.Mesh && o.material === c.paintMat) paintMesh.push(o); });
    this.scene.add(c.root);
    return { kind, root: c.root, spin: [], lights: [c.lights], paintMesh };
  }

  private acquire(car: Car): Model {
    const pool = this.pools.get(car.kind) ?? [];
    this.pools.set(car.kind, pool);
    const m = pool.pop() ?? this.make(car.kind, car.id + car.gen);
    m.root.visible = true;
    if (m.trailer) m.trailer.visible = true;
    for (const pm of m.paintMesh) pm.material = paint(car.color, 0.5, 0.25);
    return m;
  }

  private release(m: Model) {
    m.root.visible = false;
    if (m.trailer) m.trailer.visible = false;
    this.pools.get(m.kind)!.push(m);
  }

  update(dt: number, night: number) {
    this.blink = (this.blink + dt) % 0.8;
    const on = this.blink < 0.4;
    for (const car of this.traffic.cars) {
      let a = this.active.get(car.id);
      if (a && (a.gen !== car.gen || a.model.kind !== car.kind)) { this.release(a.model); a = undefined; }
      if (!a) { a = { model: this.acquire(car), gen: car.gen, spin: 0 }; this.active.set(car.id, a); }
      a.spin += (car.speed / (car.kind === 'truck' ? 0.52 : 0.32)) * dt;
      const m = a.model;
      const yaw = -car.dir * Math.atan2(car.latVel, Math.max(3, car.speed));
      const ls: LightState = {
        head: night > 0.25, high: false, brake: car.braking ? 1 : 0, tail: night > 0.25,
        indL: car.indicator < 0 && on, indR: car.indicator > 0 && on, reverse: false, roof: false,
      };
      for (const l of m.lights) applyLights(l, ls, night);
      if (car.kind === 'truck' && m.trailer) {
        // Tractor drive axle ahead of the rig centre, trailer axles behind; both follow the lane.
        const sd = car.s + car.dir * 3.0, st = car.s - car.dir * 6.95;
        this.road.toWorld(sd, car.lat, this.p);
        this.road.sample(sd, this.t);
        const h = Math.atan2(this.t.tx, this.t.tz) + (car.dir < 0 ? Math.PI : 0) + yaw;
        m.root.position.set(this.p.x, this.p.y, this.p.z);
        m.root.rotation.set(0, h, 0);
        const kx = this.p.x + Math.sin(h) * 0.45, kz = this.p.z + Math.cos(h) * 0.45;
        this.road.toWorld(st, car.lat, this.p);
        m.trailer.position.set(this.p.x, this.p.y, this.p.z);
        m.trailer.rotation.set(0, Math.atan2(kx - this.p.x, kz - this.p.z), 0);
        for (const s of m.trailerSpin ?? []) s.rotation.x = a.spin;
      } else {
        this.road.toWorld(car.s, car.lat, this.p);
        this.road.sample(car.s, this.t);
        m.root.position.set(this.p.x, this.p.y, this.p.z);
        m.root.rotation.set(0, Math.atan2(this.t.tx, this.t.tz) + (car.dir < 0 ? Math.PI : 0) + yaw, 0);
      }
      for (const s of m.spin) s.rotation.x = a.spin;
    }
  }
}
