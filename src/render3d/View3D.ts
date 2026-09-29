import * as THREE from 'three';
import {
  COMBINE_LEN, CROP_DEFS, ELEVATOR, HEADER_OFFSET, MAP_H, MAP_W, PARCEL_COLS, PARCEL_H, PARCEL_ORIGIN, PARCEL_ROWS,
  PARCEL_W, ROAD, SELL_UNLOAD, SILO_POS, SILO_RADIUS, SILO_UNLOAD, TOOL_LEN, WAGON_CAP, YARD, parcelPrice,
} from '../game/config';
import { CellState, type Field } from '../game/field';
import type { Pt } from '../game/geometry';
import type { Game, Vehicle } from '../game/sim';
import { PARCEL_COUNT, inRect, parcelRect } from '../game/world';
import { Crops } from './crops';
import { Ground } from './ground';
import { T, buildTiles } from './groundTiles';
import { disposeSprite, textSprite } from './labels';
import {
  buildCombine, buildElevator, buildFarmhouse, buildShed, buildSilo, buildTool, buildTractor, buildTrees, setHeader,
  type ToolModel, type VehicleModel,
} from './models';
import { Particles } from './particles';
import type { TapInfo, ViewControls, ViewHost } from './types';

const PITCH = THREE.MathUtils.degToRad(55);
const FOV = 38;

interface VehicleView { model: VehicleModel; lx: number; ly: number; emitT: number; bubble: THREE.Sprite; pipeAngle: number }

/** Flat strip following a polyline, lying on the ground. */
function ribbon(points: Pt[], closed: boolean, width: number, y: number) {
  const pos: number[] = [];
  const n = points.length;
  const segs = closed ? n : n - 1;
  const hw = width / 2;
  for (let i = 0; i < segs; i++) {
    const a = points[i], b = points[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const px = (-dy / len) * hw, py = (dx / len) * hw;
    const ex = (dx / len) * hw, ey = (dy / len) * hw; // extend ends to close joints
    const A = [a.x - ex + px, y, a.y - ey + py], B = [a.x - ex - px, y, a.y - ey - py];
    const C = [b.x + ex - px, y, b.y + ey - py], D = [b.x + ex + px, y, b.y + ey + py];
    pos.push(...A, ...C, ...B, ...A, ...D, ...C); // counter-clockwise from above
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

export class View3D implements ViewControls {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 500);
  private target = new THREE.Vector3(17, 0, 51);
  private dist = 30;
  private yaw = 0;
  private sun = new THREE.DirectionalLight(0xffffff, 2.6);
  private hemi = new THREE.HemisphereLight(0xcfe8ff, 0x55703a, 1.1);
  private ground: Ground;
  private crops = new Crops();
  private particles = new Particles();
  private stageCache = new Map<number, Int8Array>();
  private vViews = new Map<number, VehicleView>();
  private tViews = new Map<number, ToolModel>();
  private pickables: THREE.Object3D[] = [];
  private fieldGroup = new THREE.Group();
  private parcelGroup = new THREE.Group();
  private draftGroup = new THREE.Group();
  private grid: THREE.LineSegments;
  private draftCells: THREE.InstancedMesh;
  private draftSig = '';
  private firstCorner: THREE.Mesh | null = null;
  private ring: THREE.Mesh;
  private route: THREE.Line;
  private popups: { s: THREE.Sprite; t: number; base: THREE.Vector3 }[] = [];
  private lastSel: number | null = null;
  private time = 0;
  private sweepT = 0;
  private flushT = 0;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private pointers = new Map<number, { x: number; y: number }>();
  private drag: { id: number; sx: number; sy: number; moved: boolean } | null = null;
  private pinch: { d: number; a: number; dist: number; yaw: number } | null = null;
  private skyDay = new THREE.Color(0xa9d6f2);
  private skyDusk = new THREE.Color(0xf2a66e);
  private skyNight = new THREE.Color(0x0e1633);
  private sky = new THREE.Color();

  constructor(parent: HTMLElement, private sim: Game, private host: ViewHost) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    parent.appendChild(this.renderer.domElement);

    this.scene.fog = new THREE.Fog(this.skyDay, 60, 160);
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.02;

    this.ground = new Ground(buildTiles(), this.renderer.capabilities.getMaxAnisotropy());
    this.scene.add(this.ground.group, this.crops.group, this.particles.points, this.fieldGroup, this.parcelGroup, this.draftGroup);
    this.paintAll();
    this.buildScenery();

    this.grid = this.buildGrid();
    this.grid.visible = false;
    this.scene.add(this.grid);
    this.draftCells = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.94, 0.94).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x7dff7a, transparent: true, opacity: 0.35, depthWrite: false }),
      4000,
    );
    this.draftCells.count = 0;
    this.draftCells.frustumCulled = false;
    this.draftCells.renderOrder = 3;
    this.scene.add(this.draftCells);

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1.02, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.95, depthWrite: false }),
    );
    this.ring.renderOrder = 4;
    this.ring.visible = false;
    this.route = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.5, gapSize: 0.35, transparent: true, opacity: 0.8 }));
    this.route.frustumCulled = false;
    this.scene.add(this.ring, this.route);

    this.redrawParcels();
    this.redrawFields();

    sim.events.on('cell', (fid: number, i: number) => {
      const f = sim.world.fields.get(fid);
      if (f) this.paintFieldCell(f, i);
    });
    sim.events.on('fields', () => { this.syncFieldTiles(); this.redrawFields(); });
    sim.events.on('parcels', () => this.redrawParcels());
    sim.events.on('money', (x: number, y: number, amount: number) => this.moneyPopup(x, y, amount));

    this.setupInput();
    window.addEventListener('resize', () => this.resize());
    this.resize();
    // Start with about 26 cells visible across the screen.
    const halfH = Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect);
    this.dist = THREE.MathUtils.clamp(26 / (2 * Math.tan(halfH)), 18, 60);
    host.attach(this);

    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      this.frame(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ---------- ground & crops ----------

  private baseTile(x: number, y: number): number {
    if (inRect(x, y, ROAD)) {
      if (y === ROAD.y) return T.RoadTop;
      if (y === ROAD.y + ROAD.h - 1) return T.RoadBottom;
      return T.Road;
    }
    if (inRect(x, y, YARD) || inRect(x, y, ELEVATOR)) return T.Gravel;
    return T.Grass0 + (((x * 7 + y * 13) ^ (x * y)) & 3);
  }

  private fieldTile(f: Field, i: number, stage: number): number {
    const v = f.axis === 'v';
    switch (f.state[i]) {
      case CellState.Grass: return T.Meadow;
      case CellState.Plowed: return v ? T.PlowV : T.PlowH;
      case CellState.Seeded: return stage <= 0 ? (v ? T.SeedV : T.SeedH) : (v ? T.PlowV : T.PlowH);
      default: {
        const crop = f.cropAt(i);
        const stalks = crop ? CROP_DEFS[crop].look.stalks : false;
        return stalks ? (v ? T.StalkV : T.StalkH) : (v ? T.StrawV : T.StrawH);
      }
    }
  }

  private paintAll() {
    for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) this.ground.set(x, y, this.baseTile(x, y));
    this.syncFieldTiles();
  }

  private syncFieldTiles() {
    this.stageCache.clear();
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        if (this.sim.world.fieldIdAt(x, y) >= 0) continue;
        this.ground.set(x, y, this.baseTile(x, y));
        this.crops.clear(x, y);
      }
    }
    for (const f of this.sim.world.fields.values()) {
      this.stageCache.set(f.id, new Int8Array(f.cells.length).fill(-9));
      for (let i = 0; i < f.cells.length; i++) this.paintFieldCell(f, i);
    }
  }

  private paintFieldCell(f: Field, i: number) {
    const stage = f.stage(i, this.sim.clock);
    const cache = this.stageCache.get(f.id);
    if (cache) cache[i] = f.state[i] === CellState.Seeded ? stage : -1 - f.state[i];
    const c = f.cells[i];
    this.ground.set(c.x, c.y, this.fieldTile(f, i, stage));
    this.crops.update(f, i, stage);
  }

  private sweepGrowth() {
    for (const f of this.sim.world.fields.values()) {
      const cache = this.stageCache.get(f.id);
      if (!cache) continue;
      for (let i = 0; i < f.cells.length; i++) {
        if (f.state[i] !== CellState.Seeded) continue;
        if (cache[i] !== f.stage(i, this.sim.clock)) this.paintFieldCell(f, i);
      }
    }
  }

  // ---------- scenery ----------

  private buildScenery() {
    const silo = buildSilo(SILO_RADIUS * 0.9);
    silo.position.set(SILO_POS.x, 0, SILO_POS.y);
    silo.userData.pick = 'silo';
    const shed = buildShed(4.6, 3);
    shed.position.set(YARD.x + YARD.w - 2.8, 0, YARD.y + 2.2);
    const house = buildFarmhouse();
    house.position.set(YARD.x - 2.2, 0, YARD.y + 3);
    house.rotation.y = Math.PI / 2;
    const elev = buildElevator(ELEVATOR.w, ELEVATOR.h);
    elev.position.set(ELEVATOR.x + ELEVATOR.w / 2, 0, ELEVATOR.y + ELEVATOR.h / 2);
    elev.userData.pick = 'elevator';
    this.scene.add(silo, shed, house, elev);
    this.pickables.push(silo, elev);

    // Fence around the farmyard.
    const fence = new THREE.Group();
    const postMat = new THREE.MeshLambertMaterial({ color: 0x7a5a3a });
    const edges: [number, number, number, number][] = [
      [YARD.x, YARD.y, YARD.x + YARD.w, YARD.y], [YARD.x, YARD.y, YARD.x, YARD.y + YARD.h],
      [YARD.x + YARD.w, YARD.y, YARD.x + YARD.w, YARD.y + YARD.h - 0],
    ];
    for (const [x0, y0, x1, y1] of edges) {
      const len = Math.hypot(x1 - x0, y1 - y0);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.06, 0.05), postMat);
      rail.position.set((x0 + x1) / 2, 0.45, (y0 + y1) / 2);
      rail.rotation.y = -Math.atan2(y1 - y0, x1 - x0);
      rail.castShadow = true;
      fence.add(rail);
      for (let t = 0; t <= len; t += 1.5) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.6, 0.08), postMat);
        p.position.set(x0 + ((x1 - x0) * t) / len, 0.3, y0 + ((y1 - y0) * t) / len);
        p.castShadow = true;
        fence.add(p);
      }
    }
    this.scene.add(fence);

    // Road center dashes.
    const dashGeo = new THREE.PlaneGeometry(1, 0.12).rotateX(-Math.PI / 2);
    const dashes = new THREE.InstancedMesh(dashGeo, new THREE.MeshLambertMaterial({ color: 0xf2d15c }), Math.ceil(MAP_W / 2));
    const m = new THREE.Matrix4();
    for (let i = 0; i < dashes.count; i++) {
      m.makeTranslation(i * 2 + 0.5, 0.01, ROAD.y + ROAD.h / 2);
      dashes.setMatrixAt(i, m);
    }
    dashes.receiveShadow = true;
    this.scene.add(dashes);

    // Trees on the map border.
    let seed = 1234;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const trees: { x: number; z: number; s: number; v: number }[] = [];
    for (let y = -6; y < MAP_H + 6; y += 1.7) {
      for (let x = -6; x < MAP_W + 6; x += 1.7) {
        const inParcels = x >= PARCEL_ORIGIN.x - 0.8 && x < PARCEL_ORIGIN.x + PARCEL_COLS * PARCEL_W + 0.8 &&
          y >= PARCEL_ORIGIN.y - 0.8 && y < PARCEL_ORIGIN.y + PARCEL_ROWS * PARCEL_H + 0.8;
        const onRoad = y >= ROAD.y - 0.8 && y < ROAD.y + ROAD.h + 0.8;
        const nearHouse = x > YARD.x - 5 && x < YARD.x && y > YARD.y && y < YARD.y + 6;
        if (inParcels || onRoad || nearHouse || rnd() < 0.3) continue;
        trees.push({ x: x + (rnd() - 0.5) * 0.9, z: y + (rnd() - 0.5) * 0.9, s: 0.75 + rnd() * 0.6, v: rnd() });
      }
    }
    this.scene.add(buildTrees(trees));

    const label = (x: number, y: number, h: number, text: string) => {
      const s = textSprite(text, 0.7);
      s.position.set(x, h, y);
      this.scene.add(s);
    };
    label(SILO_POS.x, SILO_POS.y, 5.2, 'SILO');
    label(SELL_UNLOAD.x, ELEVATOR.y + 1, 7.6, '💰 SELL POINT');
  }

  private buildGrid() {
    const pos: number[] = [];
    for (let x = 0; x <= MAP_W; x++) pos.push(x, 0.03, 0, x, 0.03, ROAD.y);
    for (let y = 0; y <= ROAD.y; y++) pos.push(0, 0.03, y, MAP_W, 0.03, y);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22 }));
  }

  private clearGroup(g: THREE.Group) {
    for (const child of [...g.children]) {
      if (child instanceof THREE.Sprite) { disposeSprite(child); continue; }
      if (child instanceof THREE.Mesh) child.geometry.dispose();
      g.remove(child);
    }
  }

  redrawParcels() {
    this.clearGroup(this.parcelGroup);
    const shade = new THREE.MeshBasicMaterial({ color: 0x0b1608, transparent: true, opacity: 0.32, depthWrite: false });
    const border = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false });
    for (let i = 0; i < PARCEL_COUNT; i++) {
      const r = parcelRect(i);
      const pts = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
      if (this.sim.owned.has(i)) {
        const b = new THREE.Mesh(ribbon(pts, true, 0.08, 0.025), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, depthWrite: false }));
        this.parcelGroup.add(b);
        continue;
      }
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.h).rotateX(-Math.PI / 2), shade);
      plane.position.set(r.x + r.w / 2, 0.02, r.y + r.h / 2);
      plane.renderOrder = 2;
      this.parcelGroup.add(plane, new THREE.Mesh(ribbon(pts.map(p => ({ x: p.x + (p.x > r.x ? -0.2 : 0.2), y: p.y + (p.y > r.y ? -0.2 : 0.2) })), true, 0.14, 0.03), border));
      const s = textSprite(`🔒 $${parcelPrice(i).toLocaleString()}\nTap to buy`, 1.1);
      s.position.set(r.x + r.w / 2, 1.5, r.y + r.h / 2);
      this.parcelGroup.add(s);
    }
  }

  redrawFields() {
    this.clearGroup(this.fieldGroup);
    const sel = this.host.selectedField;
    for (const f of this.sim.world.fields.values()) {
      const selected = f.id === sel;
      const mat = new THREE.MeshBasicMaterial({ color: selected ? 0xffe066 : 0xffffff, transparent: true, opacity: selected ? 1 : 0.55, depthWrite: false });
      const line = new THREE.Mesh(ribbon(f.poly, true, selected ? 0.22 : 0.12, 0.04), mat);
      line.renderOrder = 3;
      this.fieldGroup.add(line);
      const s = textSprite(`${f.id}`, 0.8, { bg: selected ? 'rgba(120,90,0,0.8)' : 'rgba(0,0,0,0.45)' });
      s.position.set(f.center.x, 1.8, f.center.y);
      this.fieldGroup.add(s);
    }
    this.lastSel = sel;
  }

  private updateDraft() {
    const on = this.host.drawMode;
    this.grid.visible = on;
    const pts = this.host.draft;
    const sig = on ? `${JSON.stringify(pts)}|${this.host.draftValid}|${this.host.draftCells.length}` : '';
    if (sig === this.draftSig) {
      if (this.firstCorner) this.firstCorner.scale.setScalar(1 + Math.sin(this.time * 6) * 0.25);
      return;
    }
    this.draftSig = sig;
    this.clearGroup(this.draftGroup);
    this.firstCorner = null;
    const cells = on ? this.host.draftCells : [];
    const valid = this.host.draftValid;
    (this.draftCells.material as THREE.MeshBasicMaterial).color.setHex(valid ? 0x7dff7a : 0xff6b6b);
    const m = new THREE.Matrix4();
    this.draftCells.count = Math.min(cells.length, 4000);
    for (let i = 0; i < this.draftCells.count; i++) {
      m.makeTranslation(cells[i].x + 0.5, 0.05, cells[i].y + 0.5);
      this.draftCells.setMatrixAt(i, m);
    }
    this.draftCells.instanceMatrix.needsUpdate = true;
    if (!on) return;
    if (pts.length > 1) {
      const mat = new THREE.MeshBasicMaterial({ color: valid ? 0xffffff : 0xffb3b3, depthWrite: false });
      const line = new THREE.Mesh(ribbon(pts, false, 0.14, 0.07), mat);
      line.renderOrder = 4;
      this.draftGroup.add(line);
      if (pts.length >= 4) {
        const close = new THREE.Mesh(ribbon([pts[pts.length - 1], pts[0]], false, 0.08, 0.07), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false }));
        this.draftGroup.add(close);
      }
    }
    pts.forEach((p, i) => {
      const dot = new THREE.Mesh(new THREE.CylinderGeometry(i === 0 ? 0.3 : 0.22, i === 0 ? 0.3 : 0.22, 0.12, 20), new THREE.MeshLambertMaterial({ color: i === 0 ? 0xffe066 : 0xffffff }));
      dot.position.set(p.x, 0.08, p.y);
      this.draftGroup.add(dot);
      if (i === 0 && pts.length >= 4) this.firstCorner = dot;
    });
  }

  // ---------- camera & input ----------

  private resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.fov = w < h ? 52 : FOV; // wider lens in portrait so fields fit
    this.camera.updateProjectionMatrix();
    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.particles.uniforms.uScale.value = buf.y / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
  }

  private updateCamera() {
    this.target.x = THREE.MathUtils.clamp(this.target.x, 0, MAP_W);
    this.target.z = THREE.MathUtils.clamp(this.target.z, 0, MAP_H);
    const d = this.dist;
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * Math.cos(PITCH) * d,
      Math.sin(PITCH) * d,
      this.target.z + Math.cos(this.yaw) * Math.cos(PITCH) * d,
    );
    this.camera.lookAt(this.target);
    const fog = this.scene.fog as THREE.Fog;
    fog.near = d * 1.6;
    fog.far = d * 4.5;
  }

  zoomBy(f: number) { this.dist = THREE.MathUtils.clamp(this.dist / f, 7, 110); }
  rotateBy(r: number) { this.yaw += r; }
  centerOnCells(x: number, y: number) { this.target.set(x, 0, y); }

  private groundAt(sx: number, sy: number): THREE.Vector3 | null {
    this.raycaster.setFromCamera(new THREE.Vector2((sx / window.innerWidth) * 2 - 1, -(sy / window.innerHeight) * 2 + 1), this.camera);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.groundPlane, out);
  }

  /** Grid position to CSS pixels (used by tests). */
  cellsToScreen(x: number, y: number) {
    const v = new THREE.Vector3(x, 0, y).project(this.camera);
    return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight };
  }

  private setupInput() {
    const el = this.renderer.domElement;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', e => {
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d: Math.hypot(b.x - a.x, b.y - a.y), a: Math.atan2(b.y - a.y, b.x - a.x), dist: this.dist, yaw: this.yaw };
        this.drag = null;
      } else if (this.pointers.size === 1) {
        this.drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false };
      }
    });
    el.addEventListener('pointermove', e => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY };
      if (this.pinch && this.pointers.size >= 2) {
        const before = [...this.pointers.values()];
        const midBefore = { x: (before[0].x + before[1].x) / 2, y: (before[0].y + before[1].y) / 2 };
        this.pointers.set(e.pointerId, cur);
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        this.dist = THREE.MathUtils.clamp(this.pinch.dist * (this.pinch.d / d), 7, 110);
        this.yaw = this.pinch.yaw + (ang - this.pinch.a);
        this.updateCamera();
        const midAfter = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this.panBy(midBefore, midAfter);
        return;
      }
      const dr = this.drag;
      if (dr && dr.id === e.pointerId) {
        if (!dr.moved && Math.hypot(cur.x - dr.sx, cur.y - dr.sy) > 8) dr.moved = true;
        if (dr.moved) this.panBy(prev, cur);
      }
      this.pointers.set(e.pointerId, cur);
    });
    const up = (e: PointerEvent) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      if (this.pinch) {
        if (this.pointers.size < 2) this.pinch = null;
        this.drag = null;
        return;
      }
      const dr = this.drag;
      this.drag = null;
      if (dr && dr.id === e.pointerId && !dr.moved) this.handleTap(e.clientX, e.clientY);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', e => {
      e.preventDefault();
      this.zoomBy(e.deltaY > 0 ? 0.88 : 1.14);
    }, { passive: false });
  }

  private panBy(from: { x: number; y: number }, to: { x: number; y: number }) {
    this.updateCamera();
    const a = this.groundAt(from.x, from.y), b = this.groundAt(to.x, to.y);
    if (!a || !b) return;
    this.target.x += a.x - b.x;
    this.target.z += a.z - b.z;
    this.updateCamera();
  }

  private handleTap(sx: number, sy: number) {
    this.raycaster.setFromCamera(new THREE.Vector2((sx / window.innerWidth) * 2 - 1, -(sy / window.innerHeight) * 2 + 1), this.camera);
    let vehicleId: number | null = null;
    let pick: string | undefined;
    const hit = this.raycaster.intersectObjects(this.pickables, true)[0];
    for (let o: THREE.Object3D | null = hit?.object ?? null; o; o = o.parent) {
      if (o.userData.vehicleId != null) { vehicleId = o.userData.vehicleId; break; }
      if (o.userData.toolId != null) {
        const t = this.sim.tool(o.userData.toolId);
        if (t?.attachedTo != null) vehicleId = t.attachedTo;
        break;
      }
      if (o.userData.pick) { pick = o.userData.pick; break; }
    }
    const g = this.groundAt(sx, sy);
    const cx = g ? g.x : -1, cy = g ? g.z : -1;
    if (vehicleId == null && g) vehicleId = this.nearestVehicle(cx, cy);
    const ix = Math.floor(cx), iy = Math.floor(cy);
    const info: TapInfo = {
      cx, cy, vehicleId,
      silo: pick === 'silo' || Math.hypot(cx - SILO_POS.x, cy - SILO_POS.y) < SILO_RADIUS,
      elevator: pick === 'elevator' || inRect(ix, iy, ELEVATOR),
      parcel: this.sim.world.parcelAt(ix, iy),
      fieldId: this.sim.world.fieldIdAt(ix, iy),
    };
    this.host.onTap(info);
  }

  private nearestVehicle(x: number, y: number): number | null {
    let best: number | null = null, bestD = Infinity;
    for (const v of this.sim.vehicles) {
      const d = Math.hypot(v.x - x, v.y - y);
      if (d < (v.kind === 'combine' ? 1.6 : 1.1) && d < bestD) { best = v.id; bestD = d; }
    }
    return best;
  }

  // ---------- per frame ----------

  private frame(dt: number) {
    this.time += dt;
    this.sim.update(dt);
    this.sweepT += dt;
    if (this.sweepT > 0.3) { this.sweepT = 0; this.sweepGrowth(); }
    this.flushT += dt;
    if (this.flushT > 0.06) { this.flushT = 0; this.ground.flush(); }
    if (this.lastSel !== this.host.selectedField) this.redrawFields();
    if (this.host.follow && this.host.selectedVehicle != null) {
      const v = this.sim.vehicle(this.host.selectedVehicle);
      if (v) {
        const k = Math.min(1, dt * 3);
        this.target.x += (v.x - this.target.x) * k;
        this.target.z += (v.y - this.target.z) * k;
      }
    }
    this.updateCamera();
    this.syncTools();
    this.syncVehicles(dt);
    this.updateSelection();
    this.updateDraft();
    this.updateLighting();
    this.updatePopups(dt);
    this.particles.update(dt);
    this.renderer.render(this.scene, this.camera);
    this.host.frame(dt);
  }

  private updateLighting() {
    const h = this.sim.timeOfDay / 60;
    // 0 at night, 1 in full day, with dawn/dusk ramps.
    const day = h < 5 || h >= 21 ? 0 : h < 7.5 ? (h - 5) / 2.5 : h < 18 ? 1 : (21 - h) / 3;
    const dusk = Math.max(0, 1 - Math.abs(day - 0.45) / 0.45) * (h > 12 ? 1 : 0.6);
    this.sky.copy(this.skyNight).lerp(this.skyDay, day).lerp(this.skyDusk, dusk * 0.45);
    this.scene.background = this.sky;
    (this.scene.fog as THREE.Fog).color.copy(this.sky);
    this.sun.intensity = 0.35 + day * 2.4;
    this.sun.color.setHex(0x9fb2ff).lerp(new THREE.Color(0xfff1dc), day).lerp(new THREE.Color(0xffb070), dusk * 0.5);
    this.hemi.intensity = 0.45 + day * 0.8;
    // Sun sweeps across the sky during the day.
    const ang = ((h - 6) / 12) * Math.PI;
    const dir = new THREE.Vector3(-Math.cos(ang) * 0.8, 0.9 + Math.sin(ang) * 0.6, 0.45).normalize();
    this.sun.position.copy(this.target).addScaledVector(dir, 60);
    this.sun.target.position.copy(this.target);
    const s = THREE.MathUtils.clamp(this.dist * 0.95, 14, 55);
    const cam = this.sun.shadow.camera;
    if (cam.right !== s) {
      cam.left = -s; cam.right = s; cam.top = s; cam.bottom = -s;
      cam.near = 1; cam.far = 140;
      cam.updateProjectionMatrix();
    }
    const night = 1 - day;
    for (const v of this.vViews.values()) v.model.lights.emissiveIntensity = night > 0.5 ? 2.5 : 0;
  }

  private syncTools() {
    for (const [id, view] of this.tViews) {
      if (!this.sim.tools.some(t => t.id === id)) { view.root.removeFromParent(); this.tViews.delete(id); }
    }
    for (const t of this.sim.tools) {
      const width = t.kind === 'wagon' ? 1 : this.sim.toolWidth(t.kind);
      let view = this.tViews.get(t.id);
      if (!view || view.width !== width) {
        if (view) { view.root.removeFromParent(); this.pickables.splice(this.pickables.indexOf(view.root), 1); }
        view = buildTool(t.kind, width);
        view.root.userData.toolId = t.id;
        this.scene.add(view.root);
        this.pickables.push(view.root);
        this.tViews.set(t.id, view);
      }
      const moved = Math.hypot(t.x - view.root.position.x, t.y - view.root.position.z);
      view.root.position.set(t.x, 0, t.y);
      view.root.rotation.y = -t.heading;
      for (const w of view.wheels) w.rotation.z -= moved / w.userData.radius;
      if (view.fill) {
        const f = Math.min(1, t.load.amount / WAGON_CAP[this.sim.upgrades.wagon]);
        view.fill.visible = f > 0.01;
        view.fill.scale.y = Math.max(0.01, f * 0.52);
        view.fill.position.y = 0.45 + view.fill.scale.y / 2;
        if (t.load.crop) (view.fill.material as THREE.MeshLambertMaterial).color.setHex(CROP_DEFS[t.load.crop].color);
      }
    }
  }

  private syncVehicles(dt: number) {
    for (const [id, view] of this.vViews) {
      if (!this.sim.vehicles.some(v => v.id === id)) { view.model.root.removeFromParent(); disposeSprite(view.bubble); this.vViews.delete(id); }
    }
    for (const v of this.sim.vehicles) {
      let view = this.vViews.get(v.id);
      if (!view) {
        const model = v.kind === 'tractor' ? buildTractor() : buildCombine(this.sim.toolWidth('header'));
        model.root.userData.vehicleId = v.id;
        const bubble = textSprite('⚠️', 0.9);
        bubble.visible = false;
        this.scene.add(model.root, bubble);
        this.pickables.push(model.root);
        view = { model, lx: v.x, ly: v.y, emitT: 0, bubble, pipeAngle: Math.PI * 0.94 };
        this.vViews.set(v.id, view);
      }
      const m = view.model;
      const moved = Math.hypot(v.x - view.lx, v.y - view.ly);
      view.lx = v.x;
      view.ly = v.y;
      m.root.position.set(v.x, 0, v.y);
      m.root.rotation.y = -v.heading;
      m.body.position.y = v.moving ? Math.abs(Math.sin(this.time * 22 + v.id)) * 0.015 : 0;
      for (const w of m.wheels) w.rotation.z -= moved / w.userData.radius;
      if (v.kind === 'combine') {
        setHeader(m, this.sim.toolWidth('header'));
        if (v.working && m.reel) m.reel.rotation.z -= dt * 5;
        const want = v.unloadingTo != null ? Math.PI / 2 : Math.PI * 0.94;
        view.pipeAngle += (want - view.pipeAngle) * Math.min(1, dt * 3);
        m.pipe!.rotation.y = view.pipeAngle;
      }
      view.bubble.visible = v.waiting;
      view.bubble.position.set(v.x, (v.kind === 'combine' ? 2.8 : 1.9) + Math.sin(this.time * 5) * 0.1, v.y);
      this.emitVehicleFx(v, view, dt);
    }
  }

  private emitVehicleFx(v: Vehicle, view: VehicleView, dt: number) {
    view.emitT += dt;
    if (view.emitT < 0.045) return;
    view.emitT = 0;
    const P = this.particles;
    const dx = Math.cos(v.heading), dz = Math.sin(v.heading);
    const lx = dz, lz = -dx;
    const rand = (s: number) => (Math.random() - 0.5) * s;
    if (v.working === 'harvest') {
      const w = this.sim.toolWidth('header');
      for (let i = 0; i < 2; i++) {
        const o = rand(w);
        P.emit(v.x + dx * HEADER_OFFSET + lx * o, 0.5, v.y + dz * HEADER_OFFSET + lz * o, rand(0.6), 0.6 + Math.random() * 0.6, rand(0.6),
          { color: 0xf0d27a, life: 0.8, size: [0.08, 0.16], alpha: 0.9, gravity: 1.2 });
      }
      // Straw and chaff blown out the back.
      P.emit(v.x - dx * COMBINE_LEN * 0.55, 0.8, v.y - dz * COMBINE_LEN * 0.55, -dx * 1.5 + rand(1), 0.6, -dz * 1.5 + rand(1),
        { color: 0xe6cf8a, life: 1.2, size: [0.12, 0.4], alpha: 0.7, gravity: 0.4 });
    } else if (v.working) {
      const t = this.sim.toolOf(v);
      if (t) {
        const w = this.sim.toolWidth(t.kind);
        const tx = Math.cos(t.heading), tz = Math.sin(t.heading);
        for (let i = 0; i < (v.working === 'plow' ? 3 : 2); i++) {
          const o = rand(w);
          const bx = t.x - tx * TOOL_LEN[t.kind] * 0.5 + tz * o, bz = t.y - tz * TOOL_LEN[t.kind] * 0.5 - tx * o;
          if (v.working === 'plow') {
            P.emit(bx, 0.15, bz, rand(0.5), 0.5 + Math.random() * 0.4, rand(0.5), { color: 0x8a6a48, life: 1.4, size: [0.25, 0.9], alpha: 0.45, gravity: -0.05 });
          } else {
            P.emit(bx, 0.2, bz, rand(0.3), 0.3, rand(0.3), { color: 0xd9c7a0, life: 0.8, size: [0.1, 0.3], alpha: 0.5 });
          }
        }
      }
    } else if (v.moving && Math.random() < 0.35) {
      P.emit(v.x - dx * 0.9, 0.1, v.y - dz * 0.9, rand(0.3), 0.3, rand(0.3), { color: 0xa08a6a, life: 1, size: [0.2, 0.6], alpha: 0.3 });
    }
    if (v.moving && v.kind === 'tractor' && Math.random() < 0.5) {
      P.emit(v.x + dx * 0.58 + lx * 0.14, 1.12, v.y + dz * 0.58 + lz * 0.14, rand(0.1), 0.7, rand(0.1),
        { color: 0x6a6a6a, life: 1.1, size: [0.08, 0.4], alpha: 0.35, gravity: -0.1 });
    }
    // Grain stream from the combine pipe into the wagon.
    if (v.kind === 'combine' && v.unloadingTo != null && Math.abs(view.pipeAngle - Math.PI / 2) < 0.2) {
      const tip = view.model.pipe!.localToWorld(new THREE.Vector3(1.9, -0.15, 0));
      const crop = this.sim.vehicle(v.unloadingTo) && this.sim.toolOf(this.sim.vehicle(v.unloadingTo)!)?.load.crop;
      for (let i = 0; i < 3; i++) {
        P.emit(tip.x + rand(0.08), tip.y, tip.z + rand(0.08), rand(0.2), -0.5, rand(0.2),
          { color: crop ? CROP_DEFS[crop].color : 0xf2c230, life: 0.45, size: [0.12, 0.1], alpha: 1, gravity: 6 });
      }
    }
    const step = v.steps[0];
    if (step?.t === 'unload') {
      const p = step.dest === 'sell' ? SELL_UNLOAD : SILO_UNLOAD;
      const crop = this.sim.cargoOf(v)?.cargo.crop;
      if (crop) {
        for (let i = 0; i < 3; i++) {
          P.emit(p.x + rand(1), 1 + Math.random() * 0.3, p.y + rand(0.6), rand(0.4), -0.3, rand(0.4),
            { color: CROP_DEFS[crop].color, life: 0.5, size: [0.14, 0.1], alpha: 1, gravity: 5 });
        }
      }
    }
  }

  private updateSelection() {
    const sel = this.host.selectedVehicle != null ? this.sim.vehicle(this.host.selectedVehicle) : undefined;
    this.ring.visible = !!sel;
    this.route.visible = false;
    if (!sel) return;
    const r = (sel.kind === 'combine' ? 1.8 : 1.2) * (1 + Math.sin(this.time * 6) * 0.05);
    this.ring.scale.setScalar(r);
    this.ring.position.set(sel.x, 0.06, sel.y);
    const target = this.routeTarget(sel);
    if (target && Math.hypot(target.x - sel.x, target.y - sel.y) > 1) {
      this.route.geometry.setFromPoints([new THREE.Vector3(sel.x, 0.1, sel.y), new THREE.Vector3(target.x, 0.1, target.y)]);
      this.route.computeLineDistances();
      this.route.visible = true;
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

  private moneyPopup(x: number, y: number, amount: number) {
    const pos = amount >= 0;
    const s = textSprite(`${pos ? '+' : '-'}$${Math.round(Math.abs(amount)).toLocaleString()}`, 1, { color: pos ? '#8dff7a' : '#ff8a80' });
    s.position.set(x, 3, y);
    this.scene.add(s);
    this.popups.push({ s, t: 0, base: s.scale.clone() });
  }

  private updatePopups(dt: number) {
    for (const p of this.popups) {
      p.t += dt;
      p.s.position.y += dt * 1.2;
      const k = 0.6 + 0.4 * Math.min(1, p.t / 0.25);
      p.s.scale.set(p.base.x * k, p.base.y * k, 1);
      p.s.material.opacity = p.t < 1.2 ? 1 : Math.max(0, 1 - (p.t - 1.2) / 0.8);
    }
    this.popups = this.popups.filter(p => {
      if (p.t < 2) return true;
      disposeSprite(p.s);
      return false;
    });
  }
}
