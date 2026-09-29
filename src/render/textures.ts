import Phaser from 'phaser';
import { CROPS, type CropId } from '../game/config';
import type { Axis } from '../game/coverage';

// Textures are drawn at 2x (64px per cell) and displayed at 0.5 scale.
export const RES = 64;
const TILE_COLS = 8;

export const T_GRASS = 0; // 0..3 variants
export const T_PLOWED_H = 4;
export const T_PLOWED_V = 5;
const T_CROP_BASE = 6; // 3 crops x 2 axes x 6 stages = 36
export const T_GRAVEL = 42;
export const T_ROAD = 43;
export const T_MEADOW = 44; // unworked grass inside a field
export const T_ROAD_EDGE = 45;
const TILE_COUNT = 46;

/** stage: 0 seeded, 1-3 growing, 4 ready, 5 stubble */
export function cropTile(crop: number, axis: Axis, stage: number) {
  return T_CROP_BASE + (crop * 2 + (axis === 'v' ? 1 : 0)) * 6 + stage;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const SOIL = '#7b5436';
const SOIL_DARK = '#5e3f27';
const SOIL_LIGHT = '#8e6644';

const CROP_GREEN: Record<CropId, [string, string]> = {
  wheat: ['#8fc24e', '#6fa33a'],
  corn: ['#3f9a3a', '#2c7a2b'],
  soy: ['#5fae3e', '#468f2f'],
};

function grass(ctx: CanvasRenderingContext2D, ox: number, oy: number, seed: number, base: string, blades: string[]) {
  ctx.fillStyle = base;
  ctx.fillRect(ox, oy, RES, RES);
  const r = rng(seed);
  for (let i = 0; i < 70; i++) {
    ctx.fillStyle = blades[Math.floor(r() * blades.length)];
    const x = ox + r() * RES, y = oy + r() * RES;
    ctx.fillRect(x, y, 2, 3 + r() * 3);
  }
}

function soil(ctx: CanvasRenderingContext2D, ox: number, oy: number, axis: Axis, seed: number, base = SOIL) {
  ctx.fillStyle = base;
  ctx.fillRect(ox, oy, RES, RES);
  const r = rng(seed);
  // Furrows every 8px, seamless across tiles.
  for (let k = 0; k < RES; k += 8) {
    ctx.fillStyle = SOIL_DARK;
    if (axis === 'h') ctx.fillRect(ox, oy + k + 5, RES, 2); else ctx.fillRect(ox + k + 5, oy, 2, RES);
    ctx.fillStyle = SOIL_LIGHT;
    if (axis === 'h') ctx.fillRect(ox, oy + k + 1, RES, 1); else ctx.fillRect(ox + k + 1, oy, 1, RES);
  }
  for (let i = 0; i < 25; i++) {
    ctx.fillStyle = r() < 0.5 ? SOIL_DARK : SOIL_LIGHT;
    ctx.fillRect(ox + r() * RES, oy + r() * RES, 2, 2);
  }
}

/** Calls fn for each plant position along 4 crop rows per tile. */
function rows(axis: Axis, spacing: number, fn: (x: number, y: number, i: number) => void) {
  let i = 0;
  for (let row = 8; row < RES; row += 16) {
    for (let a = spacing / 2; a < RES; a += spacing) {
      if (axis === 'h') fn(a, row, i++); else fn(row, a, i++);
    }
  }
}

function drawCrop(ctx: CanvasRenderingContext2D, ox: number, oy: number, crop: CropId, axis: Axis, stage: number) {
  const r = rng(crop.length * 97 + stage * 13 + (axis === 'h' ? 1 : 2));
  const [g1, g2] = CROP_GREEN[crop];
  if (stage === 5) {
    // Stubble: pale straw with cut rows, clearly lighter than plowed soil.
    ctx.fillStyle = crop === 'corn' ? '#c9b07a' : crop === 'soy' ? '#c7ad7c' : '#d6c28e';
    ctx.fillRect(ox, oy, RES, RES);
    for (let i = 0; i < 50; i++) {
      ctx.fillStyle = ['#b89c66', '#e6d6a6', '#a98d5c'][Math.floor(r() * 3)];
      ctx.fillRect(ox + r() * RES, oy + r() * RES, 3, 2);
    }
    rows(axis, 5, (x, y) => {
      ctx.fillStyle = crop === 'corn' ? '#8f7442' : '#efe2b4';
      const jx = (r() - 0.5) * 2, jy = (r() - 0.5) * 2;
      if (crop === 'corn') ctx.fillRect(ox + x + jx - 1.5, oy + y + jy - 1.5, 3, 3);
      else if (axis === 'h') ctx.fillRect(ox + x + jx, oy + y + jy - 2, 2, 4);
      else ctx.fillRect(ox + x + jx - 2, oy + y + jy, 4, 2);
    });
    return;
  }
  if (stage < 3) soil(ctx, ox, oy, axis, 11 + stage);
  if (stage === 0) {
    rows(axis, 8, (x, y) => { ctx.fillStyle = '#c7a57a'; ctx.fillRect(ox + x - 1, oy + y - 1, 2, 2); });
    return;
  }
  if (stage === 1) {
    rows(axis, 8, (x, y) => {
      ctx.fillStyle = g1;
      ctx.fillRect(ox + x - 1, oy + y - 2, 3, 4);
    });
    return;
  }
  if (stage === 2) {
    rows(axis, 8, (x, y) => {
      ctx.fillStyle = g2;
      ctx.beginPath(); ctx.arc(ox + x, oy + y, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = g1;
      ctx.beginPath(); ctx.arc(ox + x - 1, oy + y - 1, 2.5, 0, Math.PI * 2); ctx.fill();
    });
    return;
  }
  if (stage === 3) {
    ctx.fillStyle = g2;
    ctx.fillRect(ox, oy, RES, RES);
    rows(axis, 7, (x, y) => {
      ctx.fillStyle = g1;
      ctx.beginPath(); ctx.arc(ox + x + (r() - 0.5) * 2, oy + y + (r() - 0.5) * 2, crop === 'corn' ? 7 : 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath(); ctx.arc(ox + x - 2, oy + y - 2, 2, 0, Math.PI * 2); ctx.fill();
    });
    return;
  }
  // Ready to harvest.
  if (crop === 'wheat') {
    ctx.fillStyle = '#c99a35';
    ctx.fillRect(ox, oy, RES, RES);
    for (let i = 0; i < 260; i++) {
      ctx.fillStyle = ['#e8c35a', '#d9ae42', '#f2d879', '#b98a2c'][Math.floor(r() * 4)];
      ctx.fillRect(ox + r() * RES, oy + r() * RES, 2, 4);
    }
  } else if (crop === 'corn') {
    ctx.fillStyle = '#b8963e';
    ctx.fillRect(ox, oy, RES, RES);
    rows(axis, 8, (x, y) => {
      ctx.strokeStyle = r() < 0.5 ? '#e3c872' : '#d2b25a';
      ctx.lineWidth = 2.5;
      for (let l = 0; l < 4; l++) {
        const ang = r() * Math.PI * 2;
        ctx.beginPath(); ctx.moveTo(ox + x, oy + y); ctx.lineTo(ox + x + Math.cos(ang) * 7, oy + y + Math.sin(ang) * 7); ctx.stroke();
      }
      ctx.fillStyle = '#f4e3a0';
      ctx.beginPath(); ctx.arc(ox + x, oy + y, 2.4, 0, Math.PI * 2); ctx.fill();
    });
  } else {
    ctx.fillStyle = '#a07c3c';
    ctx.fillRect(ox, oy, RES, RES);
    rows(axis, 7, (x, y) => {
      ctx.fillStyle = ['#cfa458', '#b98f45', '#dcb76a'][Math.floor(r() * 3)];
      ctx.beginPath(); ctx.arc(ox + x + (r() - 0.5) * 2, oy + y + (r() - 0.5) * 2, 5.5, 0, Math.PI * 2); ctx.fill();
    });
  }
}

function makeCanvas(scene: Phaser.Scene, key: string, w: number, h: number) {
  if (scene.textures.exists(key)) scene.textures.remove(key);
  const tex = scene.textures.createCanvas(key, Math.ceil(w), Math.ceil(h))!;
  return { tex, ctx: tex.getContext() };
}

function shadowed(ctx: CanvasRenderingContext2D, fn: () => void) {
  ctx.save();
  fn();
  ctx.restore();
}

export function buildTileset(scene: Phaser.Scene) {
  const rowsCount = Math.ceil(TILE_COUNT / TILE_COLS);
  const { tex, ctx } = makeCanvas(scene, 'tiles', TILE_COLS * RES, rowsCount * RES);
  const at = (i: number) => [(i % TILE_COLS) * RES, Math.floor(i / TILE_COLS) * RES] as const;
  for (let v = 0; v < 4; v++) {
    const [x, y] = at(T_GRASS + v);
    grass(ctx, x, y, 100 + v, '#6cab4c', ['#5e9a41', '#7cbb58', '#66a346', '#82c05f']);
  }
  { const [x, y] = at(T_MEADOW); grass(ctx, x, y, 999, '#79b552', ['#6aa446', '#8bc562', '#9ccd6f', '#71ad4b']); }
  { const [x, y] = at(T_PLOWED_H); soil(ctx, x, y, 'h', 1); }
  { const [x, y] = at(T_PLOWED_V); soil(ctx, x, y, 'v', 2); }
  CROPS.forEach((crop, ci) => {
    (['h', 'v'] as Axis[]).forEach(axis => {
      for (let s = 0; s < 6; s++) {
        const [x, y] = at(cropTile(ci, axis, s));
        drawCrop(ctx, x, y, crop, axis, s);
      }
    });
  });
  {
    const [x, y] = at(T_GRAVEL);
    ctx.fillStyle = '#b3a58c'; ctx.fillRect(x, y, RES, RES);
    const r = rng(7);
    for (let i = 0; i < 120; i++) {
      ctx.fillStyle = ['#a0927a', '#c4b79e', '#948670', '#d0c4ab'][Math.floor(r() * 4)];
      ctx.fillRect(x + r() * RES, y + r() * RES, 3, 3);
    }
  }
  for (const idx of [T_ROAD, T_ROAD_EDGE]) {
    const [x, y] = at(idx);
    ctx.fillStyle = '#5b5f63'; ctx.fillRect(x, y, RES, RES);
    const r = rng(idx);
    for (let i = 0; i < 80; i++) {
      ctx.fillStyle = r() < 0.5 ? '#54585c' : '#666a6e';
      ctx.fillRect(x + r() * RES, y + r() * RES, 2, 2);
    }
    if (idx === T_ROAD_EDGE) { ctx.fillStyle = '#e9e4d4'; ctx.fillRect(x, y + 4, RES, 3); }
  }
  tex.refresh();
}

export function buildSprites(scene: Phaser.Scene) {
  // Tractor, facing right. 1.6 x 1.0 cells.
  {
    const w = 1.6 * RES, h = 1.0 * RES;
    const { tex, ctx } = makeCanvas(scene, 'tractor', w, h);
    ctx.fillStyle = '#1f1f1f';
    rrect(ctx, 4, 2, 34, 16, 5); ctx.fill(); // rear wheels
    rrect(ctx, 4, h - 18, 34, 16, 5); ctx.fill();
    rrect(ctx, w - 30, 8, 20, 11, 4); ctx.fill(); // front wheels
    rrect(ctx, w - 30, h - 19, 20, 11, 4); ctx.fill();
    ctx.fillStyle = '#383838';
    for (let i = 0; i < 5; i++) { ctx.fillRect(8 + i * 6, 3, 2, 14); ctx.fillRect(8 + i * 6, h - 17, 2, 14); }
    shadowed(ctx, () => {
      ctx.fillStyle = '#c8392b';
      rrect(ctx, 30, 20, w - 36, h - 40, 6); ctx.fill(); // hood
      ctx.fillStyle = '#e04a3a';
      rrect(ctx, 32, 22, w - 42, 8, 4); ctx.fill();
      ctx.fillStyle = '#a82e22';
      rrect(ctx, 8, 14, 36, h - 28, 6); ctx.fill(); // cab base
      ctx.fillStyle = '#9fd3ea';
      rrect(ctx, 12, 17, 28, h - 34, 5); ctx.fill(); // glass
      ctx.fillStyle = '#f2f2f2';
      rrect(ctx, 15, 20, 22, h - 40, 4); ctx.fill(); // roof
      ctx.fillStyle = '#333';
      ctx.beginPath(); ctx.arc(w - 26, 24, 3, 0, Math.PI * 2); ctx.fill(); // exhaust
      ctx.fillStyle = '#fff7c2';
      ctx.fillRect(w - 8, 22, 4, 5); ctx.fillRect(w - 8, h - 27, 4, 5); // lights
    });
    tex.refresh();
  }
  // Combine body, facing right. 2.4 x 1.5 cells.
  {
    const w = 2.4 * RES, h = 1.5 * RES;
    const { tex, ctx } = makeCanvas(scene, 'combine', w, h);
    ctx.fillStyle = '#1f1f1f';
    rrect(ctx, w - 58, 0, 36, 18, 5); ctx.fill();
    rrect(ctx, w - 58, h - 18, 36, 18, 5); ctx.fill();
    rrect(ctx, 14, 6, 24, 12, 4); ctx.fill();
    rrect(ctx, 14, h - 18, 24, 12, 4); ctx.fill();
    ctx.fillStyle = '#e3a822';
    rrect(ctx, 6, 14, w - 16, h - 28, 10); ctx.fill();
    ctx.fillStyle = '#f2c23c';
    rrect(ctx, 10, 18, w - 26, 10, 5); ctx.fill();
    ctx.fillStyle = '#6b5a2c';
    rrect(ctx, 30, 24, 60, h - 48, 6); ctx.fill(); // grain tank
    ctx.fillStyle = '#8a7640';
    rrect(ctx, 34, 28, 52, h - 56, 4); ctx.fill();
    ctx.fillStyle = '#9fd3ea';
    rrect(ctx, w - 44, 26, 30, h - 52, 6); ctx.fill(); // cab glass
    ctx.fillStyle = '#f5f5f5';
    rrect(ctx, w - 40, 30, 20, h - 60, 4); ctx.fill();
    ctx.fillStyle = '#b8841a';
    rrect(ctx, 24, 10, 70, 7, 3); ctx.fill(); // folded pipe (left side)
    tex.refresh();
  }
  // Wagon, facing right (tongue on right). 2.0 x 1.3 cells.
  {
    const w = 2.0 * RES, h = 1.3 * RES;
    const { tex, ctx } = makeCanvas(scene, 'wagon', w, h);
    ctx.fillStyle = '#1f1f1f';
    rrect(ctx, 30, 0, 26, 12, 4); ctx.fill();
    rrect(ctx, 30, h - 12, 26, 12, 4); ctx.fill();
    rrect(ctx, 62, 0, 26, 12, 4); ctx.fill();
    rrect(ctx, 62, h - 12, 26, 12, 4); ctx.fill();
    ctx.fillStyle = '#444';
    ctx.fillRect(w - 22, h / 2 - 3, 22, 6); // tongue
    ctx.fillStyle = '#2f6e2f';
    rrect(ctx, 4, 6, w - 26, h - 12, 7); ctx.fill();
    ctx.fillStyle = '#3f8a3a';
    rrect(ctx, 8, 10, w - 34, h - 20, 5); ctx.fill();
    ctx.fillStyle = '#28331f';
    rrect(ctx, 12, 14, w - 42, h - 28, 4); ctx.fill(); // empty bin
    tex.refresh();
  }
  {
    const { tex, ctx } = makeCanvas(scene, 'wagonfill', 2.0 * RES - 42, 1.3 * RES - 28);
    ctx.fillStyle = '#ffffff';
    rrect(ctx, 0, 0, 2.0 * RES - 42, 1.3 * RES - 28, 4); ctx.fill();
    const r = rng(3);
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.fillRect(r() * (2 * RES - 42), r() * (1.3 * RES - 28), 3, 2);
    }
    tex.refresh();
  }
  // Round particle.
  {
    const { tex, ctx } = makeCanvas(scene, 'dot', 16, 16);
    const g = ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 16, 16);
    tex.refresh();
  }
  {
    const { tex, ctx } = makeCanvas(scene, 'cloud', 256, 256);
    const g = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256);
    tex.refresh();
  }
  // Tree canopy.
  for (let v = 0; v < 3; v++) {
    const s = 2.2 * RES;
    const { tex, ctx } = makeCanvas(scene, `tree${v}`, s, s);
    const r = rng(50 + v);
    const greens = [['#2f7a33', '#3f9442', '#56ad54'], ['#35803a', '#4a9c45', '#67b85c'], ['#2c6e3a', '#3d8a4b', '#58a764']][v];
    for (let k = 0; k < 3; k++) {
      ctx.fillStyle = greens[k];
      for (let i = 0; i < 7 - k * 2; i++) {
        const a = r() * Math.PI * 2, d = r() * (s * 0.18) * (1 - k * 0.3);
        ctx.beginPath();
        ctx.arc(s / 2 + Math.cos(a) * d - k * 4, s / 2 + Math.sin(a) * d - k * 4, s * (0.3 - k * 0.07), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    tex.refresh();
  }
  // Farm silo (top view).
  {
    const s = 4.8 * RES;
    const { tex, ctx } = makeCanvas(scene, 'silo', s, s);
    const c = s / 2;
    const g = ctx.createRadialGradient(c - 30, c - 30, 10, c, c, c * 0.95);
    g.addColorStop(0, '#f4f6f8'); g.addColorStop(1, '#9aa4ad');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(c, c, c * 0.92, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.15)'; ctx.lineWidth = 2;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(c + Math.cos(a) * 20, c + Math.sin(a) * 20); ctx.lineTo(c + Math.cos(a) * c * 0.9, c + Math.sin(a) * c * 0.9); ctx.stroke();
    }
    ctx.fillStyle = '#7d8790';
    ctx.beginPath(); ctx.arc(c, c, 18, 0, Math.PI * 2); ctx.fill();
    tex.refresh();
  }
  // Machine shed (top view): corrugated roof.
  {
    const w = 5 * RES, h = 3.4 * RES;
    const { tex, ctx } = makeCanvas(scene, 'shed', w, h);
    ctx.fillStyle = '#8c3a2e'; rrect(ctx, 0, 0, w, h, 8); ctx.fill();
    ctx.fillStyle = '#a4473a'; ctx.fillRect(6, 6, w - 12, h / 2 - 8);
    ctx.fillStyle = '#7a3127'; ctx.fillRect(6, h / 2 + 2, w - 12, h / 2 - 8);
    ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 2;
    for (let x = 12; x < w - 6; x += 12) { ctx.beginPath(); ctx.moveTo(x, 6); ctx.lineTo(x, h - 6); ctx.stroke(); }
    ctx.fillStyle = '#5a241c'; ctx.fillRect(4, h / 2 - 2, w - 8, 4);
    tex.refresh();
  }
  // Grain elevator: row of tall bins + office.
  {
    const w = 12 * RES, h = 7 * RES;
    const { tex, ctx } = makeCanvas(scene, 'elevator', w, h);
    ctx.fillStyle = '#9e9e96'; rrect(ctx, 0, 0, w, h, 14); ctx.fill();
    ctx.fillStyle = '#b5b5ad'; rrect(ctx, 8, 8, w - 16, h - 16, 10); ctx.fill();
    for (let i = 0; i < 4; i++) {
      const cx = 1.6 * RES + i * 2.5 * RES, cy = 2.4 * RES, rr = 1.15 * RES;
      const g = ctx.createRadialGradient(cx - 20, cy - 20, 8, cx, cy, rr);
      g.addColorStop(0, '#fbfbfb'); g.addColorStop(1, '#a8b0b6');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#8d959b';
      ctx.beginPath(); ctx.arc(cx, cy, 12, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#3e6fa8'; rrect(ctx, 0.6 * RES, 4.4 * RES, 5 * RES, 2 * RES, 8); ctx.fill();
    ctx.fillStyle = '#5586c0'; ctx.fillRect(0.6 * RES + 8, 4.4 * RES + 8, 5 * RES - 16, 0.8 * RES);
    ctx.fillStyle = '#d7d2c4'; rrect(ctx, 6.4 * RES, 4.3 * RES, 5 * RES, 2.3 * RES, 8); ctx.fill();
    ctx.fillStyle = '#2b2b2b';
    for (let i = 0; i < 3; i++) ctx.fillRect(6.8 * RES + i * 1.5 * RES, 4.9 * RES, 1.1 * RES, 1.4 * RES); // unloading pits
    ctx.fillStyle = '#f2c230';
    ctx.font = `bold ${0.55 * RES}px system-ui, sans-serif`;
    ctx.fillText('GRAIN', 1.2 * RES, 5.05 * RES);
    tex.refresh();
  }
}

/** Width-dependent implement textures, rebuilt when upgrades change. */
export function buildImplement(scene: Phaser.Scene, kind: 'plow' | 'seeder' | 'header', cells: number) {
  const key = `${kind}${cells}`;
  if (scene.textures.exists(key)) return key;
  const depth = kind === 'header' ? 0.75 : 1.1;
  const w = depth * RES, h = cells * RES;
  const { tex, ctx } = makeCanvas(scene, key, w, h);
  if (kind === 'plow') {
    ctx.fillStyle = '#444'; ctx.fillRect(w - 16, h / 2 - 4, 16, 8);
    ctx.fillStyle = '#6d7378'; rrect(ctx, 6, 4, 14, h - 8, 5); ctx.fill();
    ctx.fillStyle = '#3d7fc0'; rrect(ctx, 20, h / 2 - 16, w - 36, 32, 6); ctx.fill();
    for (let i = 0; i < cells * 2; i++) {
      const y = (i + 0.5) * (h / (cells * 2));
      ctx.fillStyle = '#c9cdd0';
      ctx.beginPath(); ctx.ellipse(18, y, 7, 11, 0.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#8e9398';
      ctx.beginPath(); ctx.ellipse(18, y, 3, 6, 0.5, 0, Math.PI * 2); ctx.fill();
    }
  } else if (kind === 'seeder') {
    ctx.fillStyle = '#444'; ctx.fillRect(w - 14, h / 2 - 4, 14, 8);
    ctx.fillStyle = '#555'; ctx.fillRect(6, 4, 8, h - 8);
    ctx.fillStyle = '#2a8a7a'; rrect(ctx, 14, 6, w - 30, h - 12, 7); ctx.fill();
    ctx.fillStyle = '#35a894'; rrect(ctx, 18, 10, w - 38, h - 20, 5); ctx.fill();
    ctx.fillStyle = '#1e6a5e';
    for (let i = 0; i < cells * 2; i++) ctx.fillRect(2, (i + 0.5) * (h / (cells * 2)) - 3, 10, 6);
    ctx.fillStyle = '#f2f2f2';
    for (let i = 0; i < cells; i++) { ctx.beginPath(); ctx.arc(w / 2 - 4, (i + 0.5) * RES, 7, 0, Math.PI * 2); ctx.fill(); }
  } else {
    ctx.fillStyle = '#c28d17'; rrect(ctx, 6, 0, w - 10, h, 8); ctx.fill();
    ctx.fillStyle = '#e3a822'; rrect(ctx, 10, 4, w - 20, h - 8, 6); ctx.fill();
    ctx.fillStyle = '#9aa0a5'; ctx.fillRect(w - 8, 2, 6, h - 4); // cutter bar
    ctx.strokeStyle = '#7a5a10'; ctx.lineWidth = 3;
    for (let y = 10; y < h - 6; y += 12) { ctx.beginPath(); ctx.moveTo(14, y); ctx.lineTo(w - 14, y + 4); ctx.stroke(); } // reel
  }
  tex.refresh();
  return key;
}
