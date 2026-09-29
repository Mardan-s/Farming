import Phaser from 'phaser';
import {
  CELL_PX, COMBINE_LEN, COMBINE_WID, CROP_DEFS, ELEVATOR, HEADER_OFFSET, MAP_H, MAP_W, PARCEL_ORIGIN, PARCEL_COLS,
  PARCEL_ROWS, PARCEL_W, PARCEL_H, ROAD, SELL_UNLOAD, SILO_POS, SILO_RADIUS, SILO_UNLOAD, TOOL_LEN, WAGON_CAP, YARD, parcelPrice,
} from '../game/config';
import { CellState, READY_STAGE, type Field } from '../game/field';
import type { Pt } from '../game/geometry';
import type { Game, Tool, Vehicle } from '../game/sim';
import { PARCEL_COUNT, inRect, parcelRect } from '../game/world';
import {
  RES, T_GRASS, T_GRAVEL, T_MEADOW, T_PLOWED_H, T_PLOWED_V, T_ROAD, T_ROAD_EDGE, buildImplement, buildSprites,
  buildTileset, cropTile,
} from './textures';

const S = CELL_PX / RES; // sprite scale
const px = (cells: number) => cells * CELL_PX;

export interface TapInfo {
  cx: number;
  cy: number;
  vehicleId: number | null;
  silo: boolean;
  elevator: boolean;
  parcel: number;
  fieldId: number;
}

/** What the scene needs from the UI layer. */
export interface SceneHost {
  attach(scene: GameScene): void;
  onTap(info: TapInfo): void;
  frame(dt: number): void;
  readonly drawMode: boolean;
  readonly draft: Pt[];
  readonly draftCells: Pt[];
  readonly draftValid: boolean;
  readonly selectedVehicle: number | null;
  readonly selectedField: number | null;
  readonly follow: boolean;
}

interface VehicleView {
  body: Phaser.GameObjects.Image;
  shadow: Phaser.GameObjects.Image;
  header?: Phaser.GameObjects.Image;
  headerShadow?: Phaser.GameObjects.Image;
  bubble: Phaser.GameObjects.Text;
  emitT: number;
}

interface ToolView {
  img: Phaser.GameObjects.Image;
  shadow: Phaser.GameObjects.Image;
  fill?: Phaser.GameObjects.Image;
}

export class GameScene extends Phaser.Scene {
  sim!: Game;
  host!: SceneHost;
  dpr = 1;
  userZoom = 1;

  private layer!: Phaser.Tilemaps.TilemapLayer;
  private stageCache = new Map<number, Int8Array>();
  private fieldGfx!: Phaser.GameObjects.Graphics;
  private fieldLabels = new Map<number, Phaser.GameObjects.Text>();
  private parcelGfx!: Phaser.GameObjects.Graphics;
  private parcelLabels: Phaser.GameObjects.Text[] = [];
  private draftGfx!: Phaser.GameObjects.Graphics;
  private fxGfx!: Phaser.GameObjects.Graphics;
  private vViews = new Map<number, VehicleView>();
  private tViews = new Map<number, ToolView>();
  private clouds: Phaser.GameObjects.Image[] = [];
  private dust!: Phaser.GameObjects.Particles.ParticleEmitter;
  private chaff!: Phaser.GameObjects.Particles.ParticleEmitter;
  private seedFx!: Phaser.GameObjects.Particles.ParticleEmitter;
  private grainFx!: Phaser.GameObjects.Particles.ParticleEmitter;
  private exhaust!: Phaser.GameObjects.Particles.ParticleEmitter;
  private sweepT = 0;
  private lastSel: number | null = null;
  private time0 = 0;

  // Touch state
  private drag: { id: number; sx: number; sy: number; lx: number; ly: number; moved: boolean } | null = null;
  private pinch: { d: number; zoom: number } | null = null;

  constructor() { super('game'); }

  init(data: { sim: Game; host: SceneHost; dpr: number }) {
    this.sim = data.sim;
    this.host = data.host;
    this.dpr = data.dpr;
  }

  create() {
    buildTileset(this);
    buildSprites(this);

    const map = this.make.tilemap({ tileWidth: RES, tileHeight: RES, width: MAP_W, height: MAP_H });
    const ts = map.addTilesetImage('tiles', 'tiles', RES, RES, 0, 0)!;
    this.layer = map.createBlankLayer('ground', ts, 0, 0)!;
    this.layer.setScale(S).setDepth(0);
    this.paintAll();

    this.fieldGfx = this.add.graphics().setDepth(1);
    this.buildDecor();
    this.parcelGfx = this.add.graphics().setDepth(9);
    this.draftGfx = this.add.graphics().setDepth(10);
    this.fxGfx = this.add.graphics().setDepth(5.5);
    this.redrawParcels();
    this.redrawFields();

    const particle = (tint: number, cfg: Phaser.Types.GameObjects.Particles.ParticleEmitterConfig) =>
      this.add.particles(0, 0, 'dot', { tint, emitting: false, ...cfg }).setDepth(6);
    this.dust = particle(0x8a6a48, { lifespan: 1100, speed: { min: 4, max: 22 }, scale: { start: 0.9, end: 2.6 }, alpha: { start: 0.5, end: 0 } });
    this.chaff = particle(0xf0d27a, { lifespan: 800, speed: { min: 8, max: 34 }, scale: { start: 0.5, end: 1.3 }, alpha: { start: 0.8, end: 0 } });
    this.seedFx = particle(0xe2d3a8, { lifespan: 600, speed: { min: 2, max: 10 }, scale: { start: 0.35, end: 0.7 }, alpha: { start: 0.6, end: 0 } });
    this.grainFx = particle(0xf2c230, { lifespan: 350, speed: { min: 2, max: 8 }, scale: { start: 0.6, end: 0.3 }, alpha: { start: 1, end: 0.2 } });
    this.exhaust = particle(0x777777, { lifespan: 900, speed: { min: 3, max: 10 }, scale: { start: 0.3, end: 1.2 }, alpha: { start: 0.3, end: 0 } });

    for (let i = 0; i < 5; i++) {
      const c = this.add.image(Math.random() * px(MAP_W), Math.random() * px(MAP_H), 'cloud')
        .setScale(3 + Math.random() * 3, 2 + Math.random() * 2).setAlpha(0.07).setDepth(8);
      this.clouds.push(c);
    }

    this.sim.events.on('cell', (fid: number, i: number) => {
      const f = this.sim.world.fields.get(fid);
      if (f) this.paintFieldCell(f, i);
    });
    this.sim.events.on('fields', () => { this.syncFieldTiles(); this.redrawFields(); });
    this.sim.events.on('parcels', () => this.redrawParcels());
    this.sim.events.on('money', (x: number, y: number, amount: number) => this.moneyPopup(x, y, amount));

    this.setupCamera();
    this.setupInput();
    this.host.attach(this);
  }

  // ---------- ground ----------

  private baseTile(x: number, y: number): { idx: number; flipY?: boolean } {
    if (inRect(x, y, ROAD)) {
      if (y === ROAD.y) return { idx: T_ROAD_EDGE };
      if (y === ROAD.y + ROAD.h - 1) return { idx: T_ROAD_EDGE, flipY: true };
      return { idx: T_ROAD };
    }
    if (inRect(x, y, YARD) || inRect(x, y, ELEVATOR)) return { idx: T_GRAVEL };
    return { idx: T_GRASS + (((x * 7 + y * 13) ^ (x * y)) & 3) };
  }

  private fieldTile(f: Field, i: number, stage: number) {
    switch (f.state[i]) {
      case CellState.Grass: return T_MEADOW;
      case CellState.Plowed: return f.axis === 'h' ? T_PLOWED_H : T_PLOWED_V;
      case CellState.Seeded: return cropTile(f.crop[i], f.axis, stage);
      default: return cropTile(Math.max(0, f.crop[i]), f.axis, 5);
    }
  }

  private paintAll() {
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const t = this.baseTile(x, y);
        const tile = this.layer.putTileAt(t.idx, x, y);
        tile.flipY = !!t.flipY;
      }
    }
    this.syncFieldTiles();
  }

  /** Repaints every field cell and clears cells whose field was deleted. */
  private syncFieldTiles() {
    this.stageCache.clear();
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        if (this.sim.world.fieldIdAt(x, y) >= 0) continue;
        const base = this.baseTile(x, y);
        if (this.layer.getTileAt(x, y)?.index !== base.idx) this.layer.putTileAt(base.idx, x, y);
      }
    }
    for (const f of this.sim.world.fields.values()) {
      const cache = new Int8Array(f.cells.length).fill(-2);
      this.stageCache.set(f.id, cache);
      for (let i = 0; i < f.cells.length; i++) this.paintFieldCell(f, i);
    }
  }

  private paintFieldCell(f: Field, i: number) {
    const stage = f.stage(i, this.sim.clock);
    const cache = this.stageCache.get(f.id);
    if (cache) cache[i] = f.state[i] === CellState.Seeded ? stage : -1 - f.state[i];
    const c = f.cells[i];
    this.layer.putTileAt(this.fieldTile(f, i, stage), c.x, c.y);
  }

  private sweepGrowth() {
    for (const f of this.sim.world.fields.values()) {
      const cache = this.stageCache.get(f.id);
      if (!cache) continue;
      for (let i = 0; i < f.cells.length; i++) {
        if (f.state[i] !== CellState.Seeded) continue;
        const st = f.stage(i, this.sim.clock);
        if (cache[i] !== st) this.paintFieldCell(f, i);
      }
    }
  }

  // ---------- decor ----------

  private buildDecor() {
    const g = this.add.graphics().setDepth(0.5);
    // Road center dashes.
    g.fillStyle(0xf2d15c, 0.9);
    const cy = px(ROAD.y + ROAD.h / 2);
    for (let x = 0; x < MAP_W; x += 2) g.fillRect(px(x) + 4, cy - 2, CELL_PX, 4);
    // Yard border / fence.
    g.lineStyle(3, 0x6b4f33, 0.9);
    g.strokeRect(px(YARD.x), px(YARD.y), px(YARD.w), px(YARD.h));
    // Parking bays.
    g.lineStyle(2, 0xffffff, 0.35);
    for (let i = 0; i < 4; i++) g.lineBetween(px(YARD.x + 0.5), px(50 + i * 3), px(YARD.x + YARD.w - 0.5), px(50 + i * 3));
    // Driveway from yard to road.
    g.fillStyle(0xb3a58c, 1);
    g.fillRect(px(YARD.x + 2), px(YARD.y + YARD.h), px(4), px(ROAD.y - YARD.y - YARD.h));

    const shadow = (img: Phaser.GameObjects.Image, dx = 6, dy = 8) =>
      this.add.image(img.x + dx, img.y + dy, img.texture.key).setScale(img.scaleX, img.scaleY).setRotation(img.rotation)
        .setTintFill(0x000000).setAlpha(0.25).setDepth(img.depth - 0.1);

    const silo = this.add.image(px(SILO_POS.x), px(SILO_POS.y), 'silo').setScale(S * (SILO_RADIUS * 2 / 4.8) * 1.1).setDepth(5);
    shadow(silo, 10, 12);
    const shed = this.add.image(px(YARD.x + YARD.w - 3), px(YARD.y + 2.2), 'shed').setScale(S).setDepth(5);
    shadow(shed);
    const elev = this.add.image(px(ELEVATOR.x + ELEVATOR.w / 2), px(ELEVATOR.y + ELEVATOR.h / 2), 'elevator').setScale(S).setDepth(2);
    shadow(elev, 8, 10);

    const label = (x: number, y: number, text: string) =>
      this.add.text(px(x), px(y), text, {
        fontFamily: 'system-ui, sans-serif', fontSize: '26px', fontStyle: 'bold', color: '#ffffff',
        stroke: '#2b2b2b', strokeThickness: 6,
      }).setOrigin(0.5).setScale(0.5).setDepth(11);
    label(SILO_POS.x, SILO_POS.y + SILO_RADIUS + 0.6, 'SILO');
    label(SELL_UNLOAD.x, ELEVATOR.y - 0.6, '💰 SELL POINT');
    label(YARD.x + YARD.w / 2, YARD.y + YARD.h + 0.6, 'FARMYARD');

    // Trees on the map border.
    let seed = 1234;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let y = 0.5; y < MAP_H; y += 1.6) {
      for (let x = 0.5; x < MAP_W; x += 1.6) {
        const inParcels = x >= PARCEL_ORIGIN.x - 0.6 && x < PARCEL_ORIGIN.x + PARCEL_COLS * PARCEL_W + 0.6 &&
          y >= PARCEL_ORIGIN.y - 0.6 && y < PARCEL_ORIGIN.y + PARCEL_ROWS * PARCEL_H + 0.6;
        const onRoad = y >= ROAD.y - 0.8 && y < ROAD.y + ROAD.h + 0.8;
        if (inParcels || onRoad || rnd() < 0.35) continue;
        const tx = x + (rnd() - 0.5) * 0.8, ty = y + (rnd() - 0.5) * 0.8;
        const s = S * (0.7 + rnd() * 0.6);
        const t = this.add.image(px(tx), px(ty), `tree${Math.floor(rnd() * 3)}`).setScale(s).setDepth(7).setRotation(rnd() * 6);
        shadow(t, 10, 12).setDepth(1.5);
      }
    }
  }

  redrawParcels() {
    const g = this.parcelGfx;
    g.clear();
    this.parcelLabels.forEach(l => l.destroy());
    this.parcelLabels = [];
    for (let i = 0; i < PARCEL_COUNT; i++) {
      const r = parcelRect(i);
      if (this.sim.owned.has(i)) {
        g.lineStyle(2, 0xffffff, 0.18);
        g.strokeRect(px(r.x), px(r.y), px(r.w), px(r.h));
        continue;
      }
      g.fillStyle(0x0d1a0a, 0.32);
      g.fillRect(px(r.x), px(r.y), px(r.w), px(r.h));
      g.lineStyle(3, 0xffffff, 0.3);
      g.strokeRect(px(r.x) + 2, px(r.y) + 2, px(r.w) - 4, px(r.h) - 4);
      const t = this.add.text(px(r.x + r.w / 2), px(r.y + r.h / 2), `🔒 $${parcelPrice(i).toLocaleString()}\nTap to buy`, {
        fontFamily: 'system-ui, sans-serif', fontSize: '40px', fontStyle: 'bold', color: '#ffffff', align: 'center',
        stroke: '#1b2a14', strokeThickness: 8,
      }).setOrigin(0.5).setScale(0.5).setDepth(9.5).setAlpha(0.9);
      this.parcelLabels.push(t);
    }
  }

  redrawFields() {
    const g = this.fieldGfx;
    g.clear();
    const sel = this.host.selectedField;
    for (const [id, label] of this.fieldLabels) {
      if (!this.sim.world.fields.has(id)) { label.destroy(); this.fieldLabels.delete(id); }
    }
    for (const f of this.sim.world.fields.values()) {
      const pts = f.poly.map(p => new Phaser.Math.Vector2(px(p.x), px(p.y)));
      if (f.id === sel) {
        g.lineStyle(9, 0xffe066, 0.35);
        g.strokePoints(pts, true, true);
        g.lineStyle(4, 0xffe066, 1);
      } else {
        g.lineStyle(3, 0xffffff, 0.5);
      }
      g.strokePoints(pts, true, true);
      let label = this.fieldLabels.get(f.id);
      if (!label) {
        label = this.add.text(px(f.center.x), px(f.center.y), `${f.id}`, {
          fontFamily: 'system-ui, sans-serif', fontSize: '34px', fontStyle: 'bold', color: '#ffffff',
          backgroundColor: 'rgba(0,0,0,0.35)', padding: { x: 12, y: 4 },
        }).setOrigin(0.5).setScale(0.5).setDepth(1.2);
        this.fieldLabels.set(f.id, label);
      }
    }
    this.lastSel = sel;
  }

  // ---------- camera & input ----------

  private setupCamera() {
    const cam = this.cameras.main;
    cam.setBackgroundColor('#4f8a3a');
    const w = this.scale.width / this.dpr, h = this.scale.height / this.dpr;
    this.userZoom = Phaser.Math.Clamp(Math.min(w, h) / (24 * CELL_PX), 0.45, 2);
    cam.setZoom(this.userZoom * this.dpr);
    cam.centerOn(px(15), px(52));
  }

  onResize(dpr: number) {
    this.dpr = dpr;
    this.cameras.main.setSize(this.scale.width, this.scale.height);
    this.cameras.main.setZoom(this.userZoom * dpr);
  }

  private zoomAt(sx: number, sy: number, userZoom: number) {
    const cam = this.cameras.main;
    const z0 = cam.zoom;
    this.userZoom = Phaser.Math.Clamp(userZoom, 0.35, 3);
    const z1 = this.userZoom * this.dpr;
    const w = cam.width, h = cam.height;
    const wx = (sx - w / 2) / z0 + cam.scrollX + w / 2;
    const wy = (sy - h / 2) / z0 + cam.scrollY + h / 2;
    cam.setZoom(z1);
    cam.scrollX = wx - (sx - w / 2) / z1 - w / 2;
    cam.scrollY = wy - (sy - h / 2) / z1 - h / 2;
    this.clampCamera();
  }

  private clampCamera() {
    const cam = this.cameras.main;
    const w = cam.width, h = cam.height;
    const viewW = w / cam.zoom, viewH = h / cam.zoom;
    const cx = Phaser.Math.Clamp(cam.scrollX + w / 2, Math.min(viewW / 2, px(MAP_W) / 2), Math.max(px(MAP_W) - viewW / 2, px(MAP_W) / 2));
    const cy = Phaser.Math.Clamp(cam.scrollY + h / 2, Math.min(viewH / 2, px(MAP_H) / 2) - 120, Math.max(px(MAP_H) - viewH / 2, px(MAP_H) / 2) + 160);
    cam.scrollX = cx - w / 2;
    cam.scrollY = cy - h / 2;
  }

  screenToCells(sx: number, sy: number) {
    const cam = this.cameras.main;
    const w = cam.width, h = cam.height;
    const wx = (sx - w / 2) / cam.zoom + cam.scrollX + w / 2;
    const wy = (sy - h / 2) / cam.zoom + cam.scrollY + h / 2;
    return { x: wx / CELL_PX, y: wy / CELL_PX };
  }

  /** Grid position to CSS pixel position (used by tests and tutorials). */
  cellsToScreen(x: number, y: number) {
    const cam = this.cameras.main;
    const w = cam.width, h = cam.height;
    return {
      x: ((px(x) - cam.scrollX - w / 2) * cam.zoom + w / 2) / this.dpr,
      y: ((px(y) - cam.scrollY - h / 2) * cam.zoom + h / 2) / this.dpr,
    };
  }

  centerOnCells(x: number, y: number, smooth = true) {
    const cam = this.cameras.main;
    if (smooth) cam.pan(px(x), px(y), 450, 'Sine.easeInOut');
    else cam.centerOn(px(x), px(y));
  }

  private setupInput() {
    this.input.addPointer(2);
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      const active = this.activePointers();
      if (active.length >= 2) {
        const [a, b] = active;
        this.pinch = { d: Phaser.Math.Distance.Between(a.x, a.y, b.x, b.y), zoom: this.userZoom };
        this.drag = null;
        return;
      }
      this.drag = { id: p.id, sx: p.x, sy: p.y, lx: p.x, ly: p.y, moved: false };
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      const active = this.activePointers();
      if (this.pinch && active.length >= 2) {
        const [a, b] = active;
        const d = Phaser.Math.Distance.Between(a.x, a.y, b.x, b.y);
        this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, this.pinch.zoom * (d / this.pinch.d));
        return;
      }
      const dr = this.drag;
      if (!dr || dr.id !== p.id || !p.isDown) return;
      if (!dr.moved && Phaser.Math.Distance.Between(dr.sx, dr.sy, p.x, p.y) > 10 * this.dpr) dr.moved = true;
      if (dr.moved) {
        const cam = this.cameras.main;
        cam.scrollX -= (p.x - dr.lx) / cam.zoom;
        cam.scrollY -= (p.y - dr.ly) / cam.zoom;
        this.clampCamera();
      }
      dr.lx = p.x;
      dr.ly = p.y;
    });
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      if (this.pinch) {
        if (this.activePointers().length === 0) this.pinch = null;
        this.drag = null;
        return;
      }
      const dr = this.drag;
      this.drag = null;
      if (!dr || dr.id !== p.id || dr.moved) return;
      this.handleTap(p.x, p.y);
    });
    this.input.on('wheel', (p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => {
      this.zoomAt(p.x, p.y, this.userZoom * (dy > 0 ? 0.88 : 1.14));
    });
  }

  private activePointers() {
    return [this.input.pointer1, this.input.pointer2, this.input.pointer3].filter(p => p && p.isDown);
  }

  zoomBy(f: number) {
    const cam = this.cameras.main;
    this.zoomAt(cam.width / 2, cam.height / 2, this.userZoom * f);
  }

  private handleTap(sx: number, sy: number) {
    const c = this.screenToCells(sx, sy);
    const cx = Math.floor(c.x), cy = Math.floor(c.y);
    const info: TapInfo = {
      cx: c.x, cy: c.y,
      vehicleId: this.pickVehicle(c.x, c.y),
      silo: Math.hypot(c.x - SILO_POS.x, c.y - SILO_POS.y) < SILO_RADIUS + 0.3,
      elevator: inRect(cx, cy, { x: ELEVATOR.x - 1, y: ELEVATOR.y - 1, w: ELEVATOR.w + 2, h: ELEVATOR.h + 3 }),
      parcel: this.sim.world.parcelAt(cx, cy),
      fieldId: this.sim.world.fieldIdAt(cx, cy),
    };
    this.host.onTap(info);
  }

  private pickVehicle(x: number, y: number): number | null {
    let best: number | null = null;
    let bestD = Infinity;
    for (const v of this.sim.vehicles) {
      const r = v.kind === 'combine' ? 1.7 : 1.2;
      const d = Math.hypot(v.x - x, v.y - y);
      if (d < r && d < bestD) { best = v.id; bestD = d; }
    }
    for (const t of this.sim.tools) {
      if (t.attachedTo == null) continue;
      const d = Math.hypot(t.x - x, t.y - y);
      if (d < 1.0 && d < bestD) { best = t.attachedTo; bestD = d; }
    }
    return best;
  }

  // ---------- per-frame ----------

  update(_time: number, deltaMs: number) {
    const dt = Math.min(deltaMs / 1000, 0.1);
    this.time0 += dt;
    this.sim.update(dt);
    this.sweepT += dt;
    if (this.sweepT > 0.3) { this.sweepT = 0; this.sweepGrowth(); }
    if (this.lastSel !== this.host.selectedField) this.redrawFields();
    this.syncTools();
    this.syncVehicles(dt);
    this.drawFx();
    this.drawDraft();
    for (const c of this.clouds) {
      c.x += dt * 14;
      if (c.x > px(MAP_W) + 400) { c.x = -400; c.y = Math.random() * px(MAP_H); }
    }
    if (this.host.follow && this.host.selectedVehicle != null) {
      const v = this.sim.vehicle(this.host.selectedVehicle);
      const cam = this.cameras.main;
      if (v) {
        const tx = px(v.x) - cam.width / 2, ty = px(v.y) - cam.height / 2;
        cam.scrollX += (tx - cam.scrollX) * Math.min(1, dt * 4);
        cam.scrollY += (ty - cam.scrollY) * Math.min(1, dt * 4);
      }
    }
    this.host.frame(dt);
  }

  private makeShadow(key: string) {
    return this.add.image(0, 0, key).setScale(S).setTintFill(0x000000).setAlpha(0.28);
  }

  private toolKey(t: Tool) {
    if (t.kind === 'wagon') return 'wagon';
    return buildImplement(this, t.kind, this.sim.toolWidth(t.kind));
  }

  private syncTools() {
    for (const [id, view] of this.tViews) {
      if (!this.sim.tools.some(t => t.id === id)) {
        view.img.destroy(); view.shadow.destroy(); view.fill?.destroy();
        this.tViews.delete(id);
      }
    }
    for (const t of this.sim.tools) {
      const key = this.toolKey(t);
      let view = this.tViews.get(t.id);
      if (!view) {
        view = {
          img: this.add.image(0, 0, key).setScale(S).setDepth(3),
          shadow: this.makeShadow(key).setDepth(2),
        };
        if (t.kind === 'wagon') view.fill = this.add.image(0, 0, 'wagonfill').setScale(S).setDepth(3.1);
        this.tViews.set(t.id, view);
      }
      if (view.img.texture.key !== key) { view.img.setTexture(key); view.shadow.setTexture(key); }
      view.img.setPosition(px(t.x), px(t.y)).setRotation(t.heading);
      view.shadow.setPosition(px(t.x) + 3, px(t.y) + 4).setRotation(t.heading);
      if (view.fill) {
        const cap = WAGON_CAP[this.sim.upgrades.wagon];
        const f = Math.min(1, t.load.amount / cap);
        const cx = px(t.x) - Math.cos(t.heading) * 5.5, cy = px(t.y) - Math.sin(t.heading) * 5.5;
        view.fill.setVisible(f > 0.01).setPosition(cx, cy).setRotation(t.heading)
          .setScale(S * (0.35 + 0.65 * f), S * (0.55 + 0.45 * f))
          .setTint(t.load.crop ? CROP_DEFS[t.load.crop].color : 0xffffff);
      }
    }
  }

  private syncVehicles(dt: number) {
    for (const [id, view] of this.vViews) {
      if (!this.sim.vehicles.some(v => v.id === id)) {
        view.body.destroy(); view.shadow.destroy(); view.header?.destroy(); view.headerShadow?.destroy(); view.bubble.destroy();
        this.vViews.delete(id);
      }
    }
    for (const v of this.sim.vehicles) {
      let view = this.vViews.get(v.id);
      if (!view) {
        view = {
          body: this.add.image(0, 0, v.kind).setScale(S).setDepth(5),
          shadow: this.makeShadow(v.kind).setDepth(4),
          bubble: this.add.text(0, 0, '⚠️', { fontSize: '40px' }).setOrigin(0.5).setScale(0.5).setDepth(12),
          emitT: 0,
        };
        this.vViews.set(v.id, view);
      }
      const x = px(v.x), y = px(v.y);
      const bob = v.moving ? Math.sin(this.time0 * 40 + v.id) * 0.4 : 0;
      view.body.setPosition(x, y + bob).setRotation(v.heading);
      view.shadow.setPosition(x + 4, y + 5).setRotation(v.heading);
      if (v.kind === 'combine') {
        const key = buildImplement(this, 'header', this.sim.toolWidth('header'));
        if (!view.header) {
          view.header = this.add.image(0, 0, key).setScale(S).setDepth(5.1);
          view.headerShadow = this.makeShadow(key).setDepth(4);
        }
        if (view.header.texture.key !== key) { view.header.setTexture(key); view.headerShadow!.setTexture(key); }
        const hx = x + Math.cos(v.heading) * px(HEADER_OFFSET), hy = y + Math.sin(v.heading) * px(HEADER_OFFSET);
        view.header.setPosition(hx, hy + bob).setRotation(v.heading);
        view.headerShadow!.setPosition(hx + 4, hy + 5).setRotation(v.heading);
      }
      view.bubble.setVisible(v.waiting).setPosition(x, y - px(1.4) + Math.sin(this.time0 * 5) * 3);
      this.emitVehicleFx(v, view, dt);
    }
  }

  private emitVehicleFx(v: Vehicle, view: VehicleView, dt: number) {
    view.emitT += dt;
    if (view.emitT < 0.05) return;
    view.emitT = 0;
    const dx = Math.cos(v.heading), dy = Math.sin(v.heading);
    const lx = dy, ly = -dx;
    if (v.working === 'harvest') {
      const w = this.sim.toolWidth('header');
      for (let i = 0; i < 2; i++) {
        const o = (Math.random() - 0.5) * w;
        this.chaff.emitParticleAt(px(v.x + dx * HEADER_OFFSET + lx * o), px(v.y + dy * HEADER_OFFSET + ly * o), 1);
      }
      this.chaff.emitParticleAt(px(v.x - dx * COMBINE_LEN * 0.55), px(v.y - dy * COMBINE_LEN * 0.55), 2);
    } else if (v.working) {
      const t = this.sim.toolOf(v);
      if (t) {
        const w = this.sim.toolWidth(t.kind);
        const tx = Math.cos(t.heading), ty = Math.sin(t.heading);
        for (let i = 0; i < (v.working === 'plow' ? 3 : 2); i++) {
          const o = (Math.random() - 0.5) * w;
          const bx = t.x - tx * TOOL_LEN[t.kind] * 0.5 + ty * o, by = t.y - ty * TOOL_LEN[t.kind] * 0.5 - tx * o;
          (v.working === 'plow' ? this.dust : this.seedFx).emitParticleAt(px(bx), px(by), 1);
        }
      }
    } else if (v.moving && Math.random() < 0.4) {
      this.dust.emitParticleAt(px(v.x - dx * 0.8), px(v.y - dy * 0.8), 1);
    }
    if (v.moving && v.kind === 'tractor' && Math.random() < 0.5) {
      this.exhaust.emitParticleAt(px(v.x + dx * 0.25 + lx * 0.2), px(v.y + dy * 0.25 + ly * 0.2), 1);
    }
    const step = v.steps[0];
    if (step?.t === 'unload') {
      const p = step.dest === 'sell' ? SELL_UNLOAD : SILO_UNLOAD;
      const crop = this.sim.cargoOf(v)?.cargo.crop;
      if (crop) {
        this.grainFx.setParticleTint(CROP_DEFS[crop].color);
        this.grainFx.emitParticleAt(px(p.x + (Math.random() - 0.5)), px(p.y + (Math.random() - 0.5) * 0.6), 3);
      }
    }
  }

  private drawFx() {
    const g = this.fxGfx;
    g.clear();
    // Combine unloading pipes with grain stream.
    for (const c of this.sim.vehicles) {
      if (c.kind !== 'combine' || c.unloadingTo == null) continue;
      const t = this.sim.vehicle(c.unloadingTo);
      const wagon = t && this.sim.toolOf(t);
      if (!wagon) continue;
      const dx = Math.cos(c.heading), dy = Math.sin(c.heading);
      const bx = c.x + dy * (COMBINE_WID / 2 - 0.1), by = c.y - dx * (COMBINE_WID / 2 - 0.1);
      g.lineStyle(6, 0xb8841a, 1);
      g.lineBetween(px(bx), px(by), px(wagon.x), px(wagon.y));
      g.fillStyle(0x8a6210, 1);
      g.fillCircle(px(wagon.x), px(wagon.y), 4);
      const crop = wagon.load.crop;
      if (crop) {
        this.grainFx.setParticleTint(CROP_DEFS[crop].color);
        this.grainFx.emitParticleAt(px(wagon.x), px(wagon.y), 1);
      }
    }
    // Selection ring and planned route.
    const sel = this.host.selectedVehicle != null ? this.sim.vehicle(this.host.selectedVehicle) : undefined;
    if (sel) {
      const r = px(sel.kind === 'combine' ? 1.8 : 1.2) + Math.sin(this.time0 * 6) * 3;
      g.lineStyle(4, 0xffe066, 0.95);
      g.strokeCircle(px(sel.x), px(sel.y), r);
      g.lineStyle(10, 0xffe066, 0.25);
      g.strokeCircle(px(sel.x), px(sel.y), r);
      const target = this.routeTarget(sel);
      if (target) {
        g.lineStyle(3, 0xffffff, 0.6);
        const d = Math.hypot(target.x - sel.x, target.y - sel.y);
        const n = Math.floor(d / 0.8);
        for (let i = 1; i < n; i += 2) {
          const a = i / n, b = Math.min(1, (i + 1) / n);
          g.lineBetween(px(sel.x + (target.x - sel.x) * a), px(sel.y + (target.y - sel.y) * a),
            px(sel.x + (target.x - sel.x) * b), px(sel.y + (target.y - sel.y) * b));
        }
        g.fillStyle(0xffffff, 0.8);
        g.fillCircle(px(target.x), px(target.y), 5);
      }
    }
  }

  private routeTarget(v: Vehicle): Pt | null {
    const s = v.steps[0];
    if (!s) return null;
    if (s.t === 'goto') return s;
    if (s.t === 'work' && s.path && s.idx != null && s.path[s.idx]) return s.path[s.idx];
    if (s.t === 'follow') { const c = this.sim.vehicle(s.combineId); return c ? this.sim.unloadSpot(c) : null; }
    return null;
  }

  private drawDraft() {
    const g = this.draftGfx;
    g.clear();
    if (!this.host.drawMode) return;
    const cam = this.cameras.main;
    const view = cam.worldView;
    const x0 = Math.max(0, Math.floor(view.x / CELL_PX)), x1 = Math.min(MAP_W, Math.ceil(view.right / CELL_PX));
    const y0 = Math.max(0, Math.floor(view.y / CELL_PX)), y1 = Math.min(MAP_H, Math.ceil(view.bottom / CELL_PX));
    g.lineStyle(1, 0xffffff, 0.18);
    for (let x = x0; x <= x1; x++) g.lineBetween(px(x), px(y0), px(x), px(y1));
    for (let y = y0; y <= y1; y++) g.lineBetween(px(x0), px(y), px(x1), px(y));
    const valid = this.host.draftValid;
    g.fillStyle(valid ? 0x7dff7a : 0xff6b6b, 0.3);
    for (const c of this.host.draftCells) g.fillRect(px(c.x), px(c.y), CELL_PX, CELL_PX);
    const pts = this.host.draft;
    if (pts.length > 1) {
      g.lineStyle(4, valid ? 0xffffff : 0xffb3b3, 0.95);
      for (let i = 1; i < pts.length; i++) g.lineBetween(px(pts[i - 1].x), px(pts[i - 1].y), px(pts[i].x), px(pts[i].y));
      if (pts.length >= 4) {
        g.lineStyle(3, 0xffffff, 0.45);
        g.lineBetween(px(pts[pts.length - 1].x), px(pts[pts.length - 1].y), px(pts[0].x), px(pts[0].y));
      }
    }
    pts.forEach((p, i) => {
      g.fillStyle(i === 0 ? 0xffe066 : 0xffffff, 1);
      g.fillCircle(px(p.x), px(p.y), i === 0 ? 9 : 7);
      g.lineStyle(2, 0x333333, 0.8);
      g.strokeCircle(px(p.x), px(p.y), i === 0 ? 9 : 7);
    });
    if (pts.length >= 4) {
      g.lineStyle(3, 0xffe066, 0.6 + Math.sin(this.time0 * 6) * 0.3);
      g.strokeCircle(px(pts[0].x), px(pts[0].y), 16);
    }
  }

  private moneyPopup(x: number, y: number, amount: number) {
    const pos = amount >= 0;
    const t = this.add.text(px(x), px(y), `${pos ? '+' : '-'}$${Math.round(Math.abs(amount)).toLocaleString()}`, {
      fontFamily: 'system-ui, sans-serif', fontSize: '44px', fontStyle: 'bold',
      color: pos ? '#7dff7a' : '#ff8080', stroke: '#14320f', strokeThickness: 8,
    }).setOrigin(0.5).setScale(0.3).setDepth(13);
    this.tweens.add({ targets: t, scale: 0.6, duration: 250, ease: 'Back.easeOut' });
    this.tweens.add({ targets: t, y: t.y - 70, alpha: 0, delay: 900, duration: 900, onComplete: () => t.destroy() });
  }

  /** True if the field has any cell ready to harvest (used for pulsing hints). */
  fieldReady(f: Field) {
    for (let i = 0; i < f.cells.length; i++) if (f.stage(i, this.sim.clock) === READY_STAGE) return true;
    return false;
  }
}
