import type { TrailerKind } from './jobs';
import { CARRIAGE_OUT } from './road';
import type { Depot, World } from './world';

// What stands in each depot yard: parked trailers, the fuel station and floodlight masts.
// Shared by the renderer (to draw them) and the game (to collide with them).

export type YardProp =
  | { kind: 'trailer'; s: number; lat: number; trailer: TrailerKind; livery: number }
  | { kind: 'island'; s: number; lat: number }
  | { kind: 'canopy'; s: number; lat: number }
  | { kind: 'mast'; s: number; lat: number };

/** Parking bays along the back row, as offsets from the depot's s. Index 1 is the delivery bay. */
export function bayOffsets(d: Depot) {
  return [d.bayS - d.s - 21, d.bayS - d.s, d.bayS - d.s + 21];
}

export function yardProps(d: Depot): YardProp[] {
  const kinds: TrailerKind[] = ['curtain', 'reefer', 'container', 'tanker'];
  const props: YardProp[] = [];
  const bays = bayOffsets(d);
  props.push({ kind: 'trailer', s: d.s + bays[0], lat: d.bayLat, trailer: kinds[d.id % 4], livery: d.id + 1 });
  props.push({ kind: 'trailer', s: d.s + bays[2], lat: d.bayLat, trailer: kinds[(d.id + 2) % 4], livery: d.id + 3 });
  if (d.fuel) {
    const s = d.s - d.sHalf + 15, lat = CARRIAGE_OUT + 13;
    props.push({ kind: 'canopy', s, lat });
    props.push({ kind: 'island', s, lat: lat - 4.6 });
    props.push({ kind: 'island', s, lat: lat + 4.6 });
  }
  props.push({ kind: 'mast', s: d.s - d.sHalf + 3, lat: CARRIAGE_OUT + d.depth - 3 });
  props.push({ kind: 'mast', s: d.s + d.sHalf - 3, lat: CARRIAGE_OUT + d.depth - 3 });
  return props;
}

/** Oriented boxes in world space: centre, half extents along heading (hl) and across (hw). */
export interface Box2 { x: number; z: number; heading: number; hl: number; hw: number }

export function yardColliders(world: World): Box2[] {
  const out: Box2[] = [];
  const p = { x: 0, y: 0, z: 0 };
  const t = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };
  for (const d of world.depots) {
    for (const pr of yardProps(d)) {
      if (pr.kind === 'canopy') continue;
      world.road.toWorld(pr.s, pr.lat, p);
      world.road.sample(pr.s, t);
      const heading = Math.atan2(t.tx, t.tz);
      if (pr.kind === 'trailer') out.push({ x: p.x, z: p.z, heading, hl: 7.0, hw: 1.3 });
      else if (pr.kind === 'island') out.push({ x: p.x, z: p.z, heading, hl: 3.2, hw: 0.7 });
      else out.push({ x: p.x, z: p.z, heading, hl: 0.5, hw: 0.5 });
    }
  }
  return out;
}
