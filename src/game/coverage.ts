import type { Pt } from './geometry';

export type Axis = 'h' | 'v';

/** One straight work pass, expressed in work-point (tool center) coordinates. */
export interface Pass {
  from: Pt;
  to: Pt;
  axis: Axis;
  bandStart: number;
  width: number;
}

/**
 * Plans back-and-forth passes that cover every given cell with a tool of the
 * given width (in cells). Axis 'h' means passes run along x.
 */
export function planPasses(cells: Pt[], axis: Axis, width: number, start: Pt): Pass[] {
  if (cells.length === 0) return [];
  // Work in (along, across) space so both axes share one implementation.
  const toAC = (p: Pt) => (axis === 'h' ? { a: p.x, c: p.y } : { a: p.y, c: p.x });
  const fromAC = (a: number, c: number): Pt => (axis === 'h' ? { x: a, y: c } : { x: c, y: a });

  let minC = Infinity, maxC = -Infinity;
  for (const cell of cells) {
    const { c } = toAC(cell);
    minC = Math.min(minC, c);
    maxC = Math.max(maxC, c);
  }
  const bands: { start: number; lo: number; hi: number }[] = [];
  const bandCount = Math.floor((maxC - minC) / width) + 1;
  const lo = new Array(bandCount).fill(Infinity);
  const hi = new Array(bandCount).fill(-Infinity);
  for (const cell of cells) {
    const { a, c } = toAC(cell);
    const b = Math.floor((c - minC) / width);
    lo[b] = Math.min(lo[b], a);
    hi[b] = Math.max(hi[b], a);
  }
  for (let b = 0; b < bandCount; b++) {
    if (lo[b] <= hi[b]) bands.push({ start: minC + b * width, lo: lo[b], hi: hi[b] + 1 });
  }

  const s = toAC(start);
  const first = bands[0];
  const last = bands[bands.length - 1];
  if (Math.abs(s.c - (last.start + width / 2)) < Math.abs(s.c - (first.start + width / 2))) bands.reverse();

  const b0 = bands[0];
  let forward = Math.abs(s.a - b0.lo) <= Math.abs(s.a - b0.hi);
  const passes: Pass[] = [];
  for (const band of bands) {
    const c = band.start + width / 2;
    const from = forward ? band.lo : band.hi;
    const to = forward ? band.hi : band.lo;
    passes.push({ from: fromAC(from, c), to: fromAC(to, c), axis, bandStart: band.start, width });
    forward = !forward;
  }
  return passes;
}
